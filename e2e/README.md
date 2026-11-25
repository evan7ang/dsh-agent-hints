# Headless end-to-end verification

Proves — without a GPU, an engine, or a gateway — that the plugin emits the
normalized Agent Hint contract on the wire: hint fields only in the
`X-Agent-Hint` header, `start`/`append` on ordinary requests, and lifecycle
verbs on dedicated placeholder manage requests.

The trick is a local mock upstream: point `baseURL` at it and it records the
exact requests the plugin sends. That is stronger evidence than a real engine,
because the assertion runs against a copy of the bytes that left the process.

## What it does and does not cover

| Covered | Not covered |
|---|---|
| `X-Agent-Hint` shape, six-value state, call index and epoch | KV reuse or any speedup (needs a real engine) |
| `start` on the fresh session, `append` after adoption | `pause` (needs a second live session) |
| `resume` manage request captured with its `prefetch` edit | `compact` (needs a compaction) |
| `stop` manage request dispatched at session disposal | `composing` early resume (needs a browser) |
| Request bodies carry no hint field | Priority admission or KV effects at the consumer |
| Title requests stay hint-free | Gateway transparency (needs the real gateway) |

## Run it

Prerequisite: a DSH **0.2.2-rc.1** installation. The runner resolves it from
`DSH_BIN`, else from this repository's cached installation:

```bash
npm install --prefix ~/.cache/dsh-agent-hints-e2e/dsh-0.2.2-rc.1 @deepseek-ai/dsh@0.2.2-rc.1
bash e2e/run.sh
```

The script creates a scratch `DSH_HOME`, installs the local package into a
scratch profile, drives two headless runs (a fresh session, then the same
session adopted), and asserts the capture.

## What a passing run shows

```text
ordinary, run 1: {"session":{"session_id":"…","call_index":1,"epoch":0,"state":"start"},
                  "priority_control":{"priority":{"level":3,"reason":"user_waiting"}},
                  "cache_control":{"type":"ephemeral","ttl_s":600,"msg_offset":4}}
manage, run 2:   {"session":{"session_id":"…","call_index":2,"epoch":0,"state":"resume"},
                  "context_management":{"manage_request":true,"edits":[{"type":"prefetch","target":"session"}]}}
ordinary, run 2: {"session":{"session_id":"…","call_index":2,"epoch":0,"state":"append"},
                  "priority_control":{…}}
```

and no `agent_hint` field in any request body.

## Two behaviours worth knowing

**The manage request sends `messages: []`.** It is a placeholder: `manage_request`
tells the consumer not to execute it as inference. A backend that validates
messages as non-empty must be taught to accept an empty body for manage
requests before the lifecycle verbs can work.

**A `stop` issued during process exit may lose the delivery race.** The plugin
constructs and dispatches it (the trace proves that), but the process teardown
can abort the local fetch before the mock receives it. The check therefore
accepts either the capture or the dispatched trace record; `resume` covers the
delivered manage path.
