# Design: serving-intent hints on the `X-Agent-Hint` header

> Status: v1 (2026-10-13). This document records the design of the published `dsh-agent-hints` plugin: an out-of-tree DSH bundle plugin that carries structured serving-intent hints on the `X-Agent-Hint` HTTP header (UTF-8 JSON, base64url) of every main-line model request, so a serving engine (the deployment's inference gateway) can decode and consume them — the "agent signals, engine consumes" pattern. The user-facing summary lives in the [README](../README.md); this document is the design rationale.

## 1. Goals and boundaries

- **Goal**: every main-line request of any DSH agent carries a structured AgentHint on the `X-Agent-Hint` header — session identity, agent status, priority, cache control — as the sending side of "agent signals, engine consumes"; the receiving end (a self-hosted inference gateway) decodes and acts on it.
- **Form**: an independent npm-shaped bundle plugin (`dsh-agent-hints`, mount id `agent-hints`). The plugin is **hint computation + DeepSeek chat-completions transport in one**: it registers the independent provider route `deepseek-hint` (a structural implementation of the harness `LlmAdapter` contract) that coexists with the official `deepseek-official` route; deployment switches via `agent-default-model.provider`, and the official llm-deepseek plugin stays mounted as the fallback. Zero harness source modification, zero harness runtime dependencies (`@deepseek-ai/cordis` is imported as types only and erased at build time; runtime services are touched as structural duck types).
- **Explicitly out of scope (v1)**:
  - `prediction`: requires an observation statistics engine — future item;
  - `strict_priority`: injected by a trusted control plane; this plugin never sends it;
  - gateway-side **sending** of asynchronous status: the event channel is ready (`tool`/`running`/`finalize` in `src/status.ts`), the sink is a local JSONL file (enable via `statusSink`); a gateway client later replaces the `emit()` seam;
  - images/files content: rejected explicitly with `UNSUPPORTED_CONTENT` (v1 text-only subset, never silently degraded).

## 2. Mount point and wire shape

**Why a standalone adapter instead of the extension registry** (verified against the harness source): the official adapter constructs its HTTP headers inside its `request()` implementation — there is no header extension point and no `extraHeaders` configuration; the extension registry only opens **request-body top-level fields**. For an out-of-tree plugin to put a hint into the header per protocol, the only plugin shape that leaves the harness untouched is a self-implemented adapter.

**Wire shape**:

```http
POST {baseURL}/chat/completions
authorization: Bearer …
content-type: application/json
x-deepseek-harness-session-id: session-…     ← identity signal, aligned with the official adapter's convention
x-agent-hint: eyJzZXNzaW9uIjp7InNlc3Npb25faWQi…  ← base64url of a UTF-8 JSON AgentHint
```

The request body is the official-isomorphic chat-completions format (`model`/`messages`/`tools`/`thinking`/`max_tokens`…) and **carries no hint fields**. To an endpoint that does not understand the header, it is a harmless unknown header.

**The header payload** (the schema is the protocol contract):

```jsonc
{
  "session": {
    "session_id": "session-…",
    "agent_type": "agent",
    "call_index": 7,
    "epoch": 0
    // "parent_session_id" / "derivation": {"relation": "spawn"|"fork", "join": "sync"|"async"} — lineage sessions only
  },
  "agent_status": { "state": "running", "state_since_ms": 1760000000000 },
  "priority": { "level": 3, "reason": "user_waiting" },          // configured; null omits
  "cache_control": [{ "type": "pin", "range": { "end": 1 } }]    // configured; null omits
}
```

**Why the contract holds** (verified): the harness `LlmAdapter` abstract contract is thin — the only required method is `stream(options)`; `resolveModel`/`providerInfo`/`prepareCall` have default implementations that a structural implementation must complete; `GenerateOptions` carries `sessionId`/`purpose` directly on its first argument, so the emission rules are synchronously visible inside the adapter; the runtime only calls methods on the adapter (duck typing), and the plugin satisfies the contract with a **structural implementation** with zero runtime imports.

## 3. Field mapping (protocol fields → DSH runtime facts)

| AgentHint field | v1 source | Notes |
| --- | --- | --- |
| `session.session_id` | `options.sessionId` | the session identity stamped by the agent loop |
| `session.agent_type` | config `agentType`, default `agent` | |
| `session.call_index` | `deriveServingFacts`: count of `step/start` events in the session log (including the current step — the loop appends before dispatching; auxiliary calls do not enter a loop step and are not counted) | **restart-safe**: restore replays the log and the count continues |
| `session.epoch` | `deriveServingFacts`: count of `compaction/end` events in the session log | same, restart-safe |
| `session.parent_session_id` / `derivation.relation` / `derivation.join` | `ctx.get('sessions').get(sessionId).header`: carried when `parentSession` exists; `origin === 'subagent'` → `spawn`, otherwise → `fork`; `join` comes from the parent's delegating tool call `run_in_background` (firehose tracking: true→`async`, otherwise `sync`) | omitted when the session/service is unavailable (degrades without failing); `fork_point` needs a message-index mapping and is not emitted |
| `agent_status.state` / `state_since_ms` | constant `running` at request time (requests are only sent while generating); `state_since_ms` = the timestamp of the most recent `tool/result` event in the log, or the request time if none | |
| `priority` | config, default `{level: 3, reason: "user_waiting"}`; `null` omits explicitly | |
| `cache_control` | config, default `[{type: "pin", range: {end: 1}}]` (pin the system prompt); `null` omits explicitly | |
| `prediction` / `strict_priority` | **not sent** | see §1 boundaries |

**Emission rules**: main-line requests only — auxiliary calls with `purpose` `compaction` / `session-title`, and requests without a `sessionId`, construct no hint and add no header. Identity signals align with the official adapter: `x-deepseek-harness-session-id` (when a session id exists) and `x-deepseek-harness-compact: 1` (on compaction) are sent as-is.

**Failure semantics**: config is strictly validated at apply time (invalid shape fails composition with a field path); request-time hint construction has no failure path; session lineage reads degrade optionally; missing credentials throw a `MISSING_CREDENTIAL`-class error at request time (handled by the harness retry/error surface).

## 4. Plugin architecture and runtime touch points

```text
apply(ctx, config)
├── normalizeConfig(config)              # strict validation: baseURL/apiKeyEnv required; invalid shape fails composition
├── firehose listener (persistent)       # tool/call: delegating tool → delegationJoin (run_in_background → sync/async)
├── when statusSink is set: StatusObserver   # out-of-band status channel (src/status.ts)
│   ├── tool/call → {state:'tool', reason:'await_tool', tools:[all pending]}
│   ├── tool/result → report {state:'running'} only when the pending set empties (parallel tools wait for the last)
│   ├── turn/end(completed) → {state:'finalize'}   # one-shot headless task completion verdict; DSH `idle` is NOT mapped
│   └── first sighting of a child session → bind child_session_id to the oldest unbound delegation of the parent
└── ctx.llm.registerAdapter(['deepseek-hint'], HintedDeepSeekAdapter)
    ├── stream(options)                  # hint construction → header injection → fetch → SSE → StreamChunk
    │   ├── deriveServingFacts(session)  # call_index/epoch/runningSinceMs from ownEvents (restart-safe)
    │   ├── serializeRequest()           # official-isomorphic: system/assistant(reasoning_content, tool_calls)/role:'tool' expansion/""-not-null rules
    │   ├── X-Agent-Hint: base64url(JSON)
    │   ├── fetch + parseSse()           # hand-written RFC-lite SSE decoding (zero npm deps), [DONE] terminates, EOF reports STREAM_CLOSED
    │   ├── translate()                  # block-start/delta/block-end deferred to [DONE], usage cache-hit split, finish_reason mapping
    │   └── error code mapping           # 401/403→AUTH, 429→RATE_LIMIT, 5xx→SERVER, 400→INVALID_REQUEST (the harness retry layer routes by code)
    ├── prepareCall/resolveModel         # model catalog (contextWindow feeds compaction decisions)
    └── providerRetryPolicy → undefined  # retries belong to the harness llm-retry layer (default normal/5); the adapter has no built-in retry
```

- **llm service**: touched structurally via `ctx.llm.registerAdapter`; the plugin exports no schemastery Config, so the loader passes the patch-row `config` raw to `apply`'s second parameter. **Deployment knobs**: `baseURL`/`apiKeyEnv` are required; when pointing at a self-hosted gateway, provide the `models` catalog (`maxTokens`/`contextWindow` must match the gateway's real limits; the default catalog aligns with the official deepseek family 256k/1M).
- **credentials**: the credentials service first (home `.credentials.yaml` / Models page), then the environment variable named by `apiKeyEnv` — the same order as the official adapter.
- **sessions service**: read optionally via `ctx.get('sessions')` (cordis inject discipline: property access on an uninjected service throws; `ctx.get` is the optional-peer seam).
- **events**: `ctx.on('session/event', …)` is cleaned up automatically with the fiber lifecycle.

## 5. Verification design

The hint lives in an HTTP header — model-invisible and absent from the durable session log — so **wire evidence is the only reliable functional verification**:

- **Unit tests** (`node --test`, running against the committed built JS, 28 cases): hint construction/encoding (base64url contract), serialize message shapes and image rejection, thinking resolution, SSE decoding (across chunks/CRLF/comment lines/missing [DONE]), translate (delta flow/deferred termination/usage split/EMPTY_RESPONSE), HTTP error code mapping, stream emission rules (fake fetch: main requests carry the header, auxiliary/no-session do not, body carries no hint field, call_index increments, lineage resolution), resolveModel catalog and fallback.
- **Keyless wire e2e (`e2e/run.sh`)**: a local SSE capture stub (`e2e/stub-server.mjs`, two-phase script: `e2e_probe` echo tool call → final answer; the tool is mounted from source via `e2e/fixture-tool.mjs` in the patch overlay) + patch-row config pointing the adapter's `baseURL` at the stub, `apiKeyEnv` at a dummy env var, `statusSink` at a scratch file; model route switched to `deepseek-hint` for one tool round trip → `e2e/capture-check.mjs` asserts: exactly 2 main-line requests carry `X-Agent-Hint`, the base64url-decoded payload matches the schema field by field (**call_index 1→2 is the end-to-end proof of step/start derivation**), `session_id` equals the `x-deepseek-harness-session-id` transport header, the **body carries no hint field**, and the auxiliary request (session-title) carries no hint header; the status sink asserts the working session's `tool → running → finalize` sequence and the `tools[]`/`call_id` shape.
- **Real-machine gate**: the `deepseek-hint` route pointed at a real gateway (`baseURL` config + `apiKeyEnv` credential), a real task exits 0 and its artifacts are read back independently.

## 6. Known limits and future items

- **Protocol subset**: v1 is chat-completions only — text + tools + thinking + usage + abort; images/files are rejected explicitly; the messages protocol and image representation are future items. The subset must be kept in sync with the official adapter manually (the deployment target is a self-hosted gateway, so the subset is under control).
- **Route coexistence**: `deepseek-hint` coexists with the official `deepseek-official`; switching the provider by mistake silently drops hints — the e2e wire assertions are the safety net.
- `call_index`/`epoch`/`runningSinceMs` derive from the session log (restore replays), continuing across restarts; they depend on harness event semantics (`step/start` precedes dispatch, auxiliary calls do not enter a loop step) and must follow its evolution.
- `derivation.join` reads the parent's most recent delegating call's `run_in_background` — parallel delegations share the latest value (accepted approximation); a child session's `child_session_id` binds to the parent's oldest unbound delegation (FIFO).
- `finalize` uses `turn/end(completed)` as the completion verdict (one-shot headless task semantics); session-level endpoints for interactive profiles need a separate verdict. The status channel sink is a local JSONL file; after a gateway client replaces the `emit()` seam it owns retry/ordering semantics.
- `prediction` awaits a statistics engine; `fork_point` and framework-triggered handoff/suspend stay unemitted.
