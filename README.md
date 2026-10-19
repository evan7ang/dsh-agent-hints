# dsh-agent-hints

Per-request serving-intent hints for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): every main-line model request carries a structured **AgentHint on the `X-Agent-Hint` HTTP header** (UTF-8 JSON, base64url) — session identity, agent status, priority, and cache control — so a serving engine (your inference gateway) can observe and act on what the agent is doing, per the "agent signals, engine consumes" pattern.

The plugin registers an **independent provider route `deepseek-hint`** backed by its own chat-completions adapter. The official `deepseek-official` route stays mounted and remains the fallback; deployment switches via `agent-default-model.provider`. Zero harness source modification, zero harness runtime dependencies (cordis is touched as a structural duck type only).

English | [中文](README.zh.md) · Design notes: [docs/design.md](docs/design.md) ([中文](docs/design.zh.md))

## How it works

The harness `LlmAdapter` contract is thin (only `stream()` is required), and the official adapter constructs its HTTP headers inside its `request()` implementation with no extension point. This plugin therefore ships a self-contained adapter that implements the contract structurally and adds one header:

```http
POST {baseURL}/chat/completions
authorization: Bearer …
content-type: application/json
x-deepseek-harness-session-id: session-…          ← identity signal, aligned with the official adapter
x-agent-hint: eyJzZXNzaW9uIjp7InNlc3Npb25faWQi…   ← base64url of a UTF-8 JSON AgentHint
```

The request body stays in the provider's original chat-completions format and **never carries hint fields**. To an endpoint that does not understand the header, it is a harmless unknown header.

This differs from static header-injection approaches (e.g. wrapping `fetch` to set fixed headers like a `user-agent`): here the hint value is **derived per request** from the session's durable event log (call index, compaction epoch, last tool result time) and the session lineage — there is nothing static to configure.

### Header emission rules

- **Main-line requests only**: auxiliary calls (`compaction`, `session-title` purposes) and requests without a session identity carry no hint.
- `strict_priority` is **never sent** by an agent (trusted-control-plane field).
- `prediction` rides the same header when a source is configured (`predictionTrie` and/or `predictionStatic`); with no source configured the block is omitted and the wire shape is unchanged. Values come from an offline trie (longest tool-sequence-prefix match) with per-field static fallback.
- Session identity mirrors the official adapter: `x-deepseek-harness-session-id` (when a session id exists) and `x-deepseek-harness-compact: 1` (on compaction) are sent as-is.

### The `X-Agent-Hint` payload

```jsonc
{
  "session": {
    "session_id": "session-…",
    "agent_type": "agent",
    "call_index": 7,          // derived from the session's durable log (step/start count); restart-safe
    "epoch": 0                // derived from compaction/end count; restart-safe
    // "parent_session_id" / "derivation": {"relation": "spawn"|"fork", "join": "sync"|"async"} — lineage sessions only
  },
  "agent_status": { "state": "running", "state_since_ms": 1760000000000 },
  "priority": { "level": 3, "reason": "user_waiting" },          // configured; null omits
  "cache_control": [{ "type": "pin", "range": { "end": 1 } }],   // configured; null omits
  // "prediction": { "latency_ms": 8251, "remaining_calls": 2, "output_tokens": 640,
  //   "interval_ms": 251, "remaining_time_ms": 42000,
  //   "next_action": { "state": "tool", "tools": [{"name": "web_search", "expected_duration_s": 9}], "prob": 0.8 } }
  //   — only when predictionTrie/predictionStatic is configured; trie miss falls back per field
}
```

Out-of-band status events (`tool` → `running` → `finalize` per working session, incl. awaited tool names and call ids) are reported to the optional `statusSink` (local JSONL file); the `emit()` seam is where a gateway client takes over.

## Install

Built JS is committed to this repository (`lib/`), so installing from GitHub needs **no build-script permission**:

```sh
dsh plugin add github:evan7ang/dsh-agent-hints
```

Pin a commit for reproducibility: `dsh plugin add github:evan7ang/dsh-agent-hints#<sha>`. An npm package (`dsh plugin add dsh-agent-hints`) is planned but not yet published.

## Configure and deploy

The plugin is inert until you point it at an upstream. Override the `agent-hints` row in your profile's `cordis.patch.yml` (later layers replace the row's entire `config` value, so restate every key you need):

```yaml
- id: agent-hints
  config:
    baseURL: https://your-gateway.example.com
    apiKeyEnv: MY_GATEWAY_KEY
```

Then switch the model route:

```yaml
# $DSH_HOME/settings.yaml
agent-default-model:
  provider: deepseek-hint
  model: deepseek-flash
```

The API key resolves per request: credentials service first (`$DSH_HOME/.credentials.yaml` / Models page), then the environment variable named by `apiKeyEnv` — the same order as the official adapter.

### Configuration reference

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `baseURL` | string | inherits `$DEEPSEEK_BASE_URL` → `https://api.deepseek.com` | Upstream base; every chat request posts to `${baseURL}/chat/completions` |
| `apiKeyEnv` | string | inherits `$DEEPSEEK_API_KEY_ENV` → `DEEPSEEK_API_KEY` | Environment-variable name resolved per request (credentials service first) |
| `agentType` | string | `agent` | Reported as `session.agent_type` |
| `priority` | `{level, reason}` or `null` | `{level: 3, reason: "user_waiting"}` | Soft priority; `null` omits the field |
| `cacheControl` | array or `null` | `[{type: "pin", range: {end: 1}}]` | Cache control entries; `null` omits |
| `thinking` | `"enabled"` / `"disabled"` | enabled | `disabled` limits every conversation request to `off` |
| `reasoningEffort` | `"off"/"low"/"high"/"max"` | `high` | Default reasoning effort when a request carries none |
| `models` | `{id, name, contextWindow, maxTokens}[]` | DeepSeek-V4 family catalog | Advisory model catalog for `resolveModel`; **provide real limits when pointing at your own gateway** (they feed compaction decisions) |
| `defaultContextWindow` | positive integer | `1000000` | Context window assumed for models absent from the catalog |
| `defaultMaxTokens` | positive integer | `256000` | Per-request output cap materialized when callers omit one |
| `statusSink` | string | unset (file sink off) | Local JSONL path for out-of-band status events |
| `statusEndpoint` | string | unset | Full status-event endpoint URL (Motor scheduler); overrides `statusAuto` |
| `statusAuto` | boolean | `false` | Derive the status endpoint from `baseURL`'s origin (`<origin>/agent-status`) |
| `predictionTrie` | string | unset (block off) | Offline prediction trie (built by `scripts/build-prediction-trie.mjs`); enables trie-sourced `prediction` values |
| `predictionStatic` | object | unset | Static per-field fallbacks (`latency_ms`/`remaining_calls`/`output_tokens`/`interval_ms`/`remaining_time_ms`); configuring this or `predictionTrie` turns the `prediction` block on |
| `predictionMinSamples` | positive integer | `5` | Minimum node sample count for a trie distribution to be trusted over the static value |
| `expectedResumeS` | positive number | unset | Expected seconds until resume, carried on `pause`/`suspend` status events (business callbacks provide the trigger) |
| `subagentToolNames` | string[] | `["subagent"]` | Tool names treated as subagent delegation for `derivation.join` and status naming |

Invalid config aborts composition at load time with a field path — request-time hint construction has no failure path.

## Known limits (v1)

- Chat-completions wire only; subset: text + tools + thinking + usage + abort. Image/file content is rejected explicitly (`UNSUPPORTED_CONTENT`), never silently degraded.
- The protocol subset must be kept in sync with the official adapter manually (the deployment target is your own gateway, so the subset is under control).
- `call_index`/`epoch`/`state_since_ms` are derived from the session's event log and depend on harness event semantics (`step/start` precedes dispatch; auxiliary calls do not count as loop steps).
- `derivation.join` reads the parent's most recent delegating tool call — parallel delegations share the latest value (accepted approximation).
- Switching providers back to `deepseek-official` silently drops hints; the e2e wire assertions below are the safety net.
- **Always-thinking models**: the session-title auxiliary call forces `thinking: {type: "disabled"}` (official convention). Gateways backed by always-thinking models (e.g. `glm-5.3-flash` on Volcengine) reject it with an error; the harness tolerates the failure — the task itself is unaffected — but such sessions get no generated title. Prefer a model that supports thinking-off for auxiliary calls, or accept untitled sessions (verified on a real gateway: main-line requests with `thinking: enabled` + `reasoning_effort` are accepted, the task completes exit 0, and the hint header reaches the gateway).

## Development

```sh
npm install
npm run build        # src/ → lib/ (built JS is committed)
npm test             # node --test against the built JS
e2e/run.sh           # keyless wire e2e: local SSE capture stub + hinted route + report assertions
```

The e2e resolves the `dsh` runtime from `DSH_BIN`, `PATH`, or a deepseek-harness checkout (`DSH_CHECKOUT` or the sibling directory).

## License

[MulanPSL-2.0](LICENSE)
