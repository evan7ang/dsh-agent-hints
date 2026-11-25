# dsh-agent-hints

Per-request Agent Hint for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH): a provider route whose model requests carry one structured **`X-Agent-Hint`** header (UTF-8 JSON, base64url) — session identity, lifecycle state, two-level priority and a cache declaration — and whose session lifecycle drives bounded manage requests. The request body never carries hint fields.

The plugin registers an independent provider route (**default `deepseek-hint`**) over Chat Completions or the official Messages pipeline, inherits endpoint, model catalog and credential reference from the sibling `llm-deepseek` route, and installs the stock-host composer observer that lets a browser draft trigger an early `resume`.

English | [中文](README.zh.md) · Contracts: [transport](docs/transport.md) · [reliability](docs/reliability.md) · [endpoint inheritance](docs/endpoint-inheritance.md) · [trace](docs/trace.md)

## Wire contract

Four blocks, no more:

```jsonc
// Ordinary request: first request of a fresh session
{
  "session": { "session_id": "s-1", "parent_session_id": "p-1", "call_index": 1, "epoch": 0, "state": "start" },
  "priority_control": { "priority": { "level": 3, "reason": "user_waiting" } },
  "cache_control": { "type": "ephemeral", "ttl_s": 600, "msg_offset": 10 }
}

// Ordinary request: every later call
{
  "session": { "session_id": "s-1", "call_index": 5, "epoch": 1, "state": "append" },
  "priority_control": { "priority": { "level": 1, "reason": "critical_path" } },
  "cache_control": { "type": "ephemeral", "ttl_s": 300, "msg_offset": 12 }
}

// Manage request: body is a placeholder ({ model, messages: [], stream: false })
{
  "session": { "session_id": "s-1", "call_index": 5, "epoch": 1, "state": "pause" },
  "context_management": { "manage_request": true,
                          "edits": [{ "type": "offload", "target": "session" }] }
}
```

- `state` has six values: `start` / `append` / `pause` / `resume` / `stop` / `compact`. `start` appears exactly once per fresh session; every other ordinary request is `append`.
- Lifecycle verbs own a manage request: `pause` → `offload`, `resume` → `prefetch`, `stop` → `evict`, `compact` → `evict` on `target: "session"`. `compact` carries the epoch being evicted.
- Auxiliary calls (any declared `purpose`, e.g. compaction summary or session title) carry no hint at all.
- The body is byte-identical to the provider's own request format; the hint lives only in the header.

### Lifecycle triggers

| state | trigger |
| --- | --- |
| `start` | first accepted ordinary request of a fresh (non-seeded) session |
| `append` | every other ordinary request |
| `pause` | another session's ordinary request was accepted while this session is idle and its streams finished |
| `resume` | before the next ordinary request of a seeded/paused session, or on the first non-empty composer edit |
| `stop` | session disposal, or a successful archive |
| `compact` | `compaction/end` without an error |

### Priority and cache

- `priority_control` rides every ordinary request: turn-opening calls are `3` / `user_waiting`, self-driven continuations `1` / `critical_path`. A static `{ level, reason }` is a constant override; `"omit"` suppresses it.
- `cache_control` is one `ephemeral` declaration per qualifying ordinary request: `msg_offset` is the request's wire message count and `ttl_s = clamp(last interval × 2, 60, 3600)`. Declarations are suppressed for a compaction round, a model/tool-set change, and a prefix under 128 estimated tokens. A static `{ ttl_s, msg_offset? }` overrides the policy; `"omit"` suppresses it.

## Transports

- **Chat** (default): the plugin's own Chat Completions adapter writes the header per request and keeps roles, tool-call/result ids and reasoning history. Native images/files are rejected explicitly (`UNSUPPORTED_CONTENT`), never silently dropped.
- **Messages**: the official `DeepSeekAdapter` pipeline (attachments included). It has no per-request header hook, so the plugin binds the request's hint through AsyncLocalStorage and writes it in `resolveAuth`. Replace this seam if the host grows a first-class header hook.

## Install

Built JS is committed to this repository (`lib/`), so installing from GitHub needs no build-script permission:

```bash
dsh plugin --profile <your-profile> add github:<owner>/dsh-agent-hints#<commit>
```

Or build locally and install the tarball:

```bash
npm ci
npm run check
npm pack
dsh plugin --profile <your-profile> add "$PWD"/dsh-agent-hints-0.4.0.tgz
```

Requires Node `^22.19.0 || >=24` and DSH **0.2.2-rc.1**. Restart the instance, then point `agent-default-model.provider` at the route id (`deepseek-hint` by default).

## Configuration

Zero configuration works when the sibling `llm-deepseek` route is configured: endpoint, model catalog and credential reference are inherited. Every field below overrides that inheritance.

```yaml
- id: agent-hints
  config:
    provider: deepseek-hint        # provider route id (reload to change)
    transport: chat                # chat | messages
    baseURL: http://127.0.0.1:1025 # optional; inherited > DSH_AGENT_HINT_BASE_URL > DEEPSEEK_BASE_URL
    apiKeyEnv: MOTOR_API_KEY       # optional credential reference; same-endpoint sources may inherit
    inheritCredentials: true
    models:
      - id: served-model
        name: Served Model
        contextWindow: 32768
        maxTokens: 4096
    agentHint:
      enabled: true
      priority: dynamic            # dynamic | omit | { level, reason }
      cacheControl: dynamic        # dynamic | omit | { ttl_s, msg_offset? }
      sessionControl:
        enabled: true
        pluginTriggers: true       # stock-host composer Remote + public archive observer
        pendingOpAwaitMs: 2000
        controlTimeoutMs: 5000
        retries: 1
      trace:
        enabled: true
        maxRecords: 2000
        writeToSession: true
```

`agentHint.enabled: false` keeps the route as a plain model route without hints or lifecycle control. Invalid values fail at composition with a field path.

## Consumer requirement

The header is additive and harmless to a backend that ignores it — but the lifecycle verbs and priority admission only take effect once the consumer parses the normalized header:

1. Decode `X-Agent-Hint` before request validation and accept an empty `messages` array when `context_management.manage_request` is true.
2. Map `session.state` onto whatever lifecycle vocabulary the consumer uses (`start`/`append` carry no context action).
3. Map `context_management` onto its engine-visible form, and read priority from `priority_control.priority.{level, reason}`.
4. `cache_control.{ttl_s, msg_offset}` replaces the legacy `{ttl, msg_offset}` declaration.

Until then, ordinary requests still carry session identity and cache declarations, while manage requests are rejected and logged as failed.

## Verification

```bash
npm run check                    # typecheck, build, unit/integration tests, package check
bash e2e/run.sh                  # keyless wire e2e against DSH 0.2.2-rc.1
```

The e2e installs the local package into a scratch profile, drives two headless runs (fresh session, then the same session adopted) against a capture stub, and asserts the header shape, `start`/`append`, the `resume` manage request, the dispatched `stop`, the placeholder body and the hint-free title request. Browser typing is covered by component tests; a real browser acceptance run is still pending.

## License

MulanPSL-2.0. Portions are derived from the MIT-licensed `dsh-agenthint` plugin and the DeepSeek Harness AgentHint integration branch; see [NOTICE](NOTICE).
