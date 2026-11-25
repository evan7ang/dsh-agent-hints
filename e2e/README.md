# Headless end-to-end verification

Proves — without a GPU, an engine, or a gateway — that the plugin emits the
normalized Agent Hint contract on the wire and that every lifecycle trigger
fires when it should. A local scripted mock upstream records the exact requests
the plugin sends, so the assertions run against a copy of the bytes that left
the process.

## Three phases

| Phase | Scenario | What it proves |
|---|---|---|
| A | fresh session, then the same session adopted; one tool round trip each | `start` once per session, `append` afterwards, `call_index`/`epoch`, turn-opening vs continuation priority, cache declaration/suppression, `resume` before the adopted session's first request, `stop` at disposal, `msg_offset` = wire message count |
| B | one run where the model delegates to a background child (`subagent`) | a child session opens its own `start`; the parent (idle, turn finished) gets `pause` + `offload` after the child's request is accepted; the child's disposal sends `stop` mid-run; the notification turn sends `resume` + `prefetch` before the parent's next request with a new turn-opening priority |
| C | one run where the provider answers a synthetic context-window error | the harness compacts and retries the step: the summary request is hint-free, `compact` + `evict` carries the old epoch, `epoch` bumps exactly once, the retried step keeps its `call_index`, cache is suppressed for the rewrite round and returns afterwards |

Every phase also checks that the request body never carries hint fields and that
auxiliary (title/compaction) requests stay hint-free.

## Run it

Prerequisite: a DSH **0.2.2-rc.1** installation. The runner resolves it from
`DSH_BIN`, else from this repository's cached installation:

```bash
npm install --prefix ~/.cache/dsh-agent-hints-e2e/dsh-0.2.2-rc.1 @deepseek-ai/dsh@0.2.2-rc.1
bash e2e/run.sh                 # E2E_KEEP=1 keeps the scratch captures
```

The script creates a scratch `DSH_HOME`, installs the local package into a
scratch profile, and drives one headless run per phase (phase A runs twice: the
fresh session, then the same session adopted).

## Observed phase A timeline

```text
idx  state    call  epoch  priority          cache        wire msgs
1    start    1     0      3/user_waiting    600s @ 4     4
2    (title)  —     —      —                 —            —
3    append   2     0      1/critical_path   60s @ 6      6
4    resume   3     0      —                 —            0        (manage, prefetch)
5    append   3     0      3/user_waiting    suppressed   8        (new process: signature unknown)
6    append   4     0      1/critical_path   60s @ 10     10
```

## Observed phase B timeline (parent / child)

```text
parent   start    1  0  3/user_waiting  600s @ 4    (probe)
parent   append   2  0  1/critical_path 60s  @ 6    (subagent call)
parent   append   3  0  1/critical_path 60s  @ 8    (turn text)
child    start    1  0  3/user_waiting  600s @ 4    (runs while parent is idle)
parent   pause    3  0  —               —           (manage, offload)
child    stop     1  0  —               —           (manage, evict; delivered mid-run)
parent   resume   4  0  —               —           (manage, prefetch)
parent   append   4  0  3/user_waiting  60s  @ 10   (notification turn)
```

The subagent child carries no `parent_session_id`: a creator is not a fork
parent, so the child looks like a root session on the wire.

## Observed phase C timeline

```text
idx  state    call  epoch  priority          cache
1    start    1     0      3/user_waiting    600s @ 4
2    append   2     0      1/critical_path   60s  @ 6
3    (compaction summary, no hint, x-deepseek-harness-compact: 1)
4    compact  2     0      —                 —            (manage, evict, old epoch)
5    append   2     1      1/critical_path   suppressed   (retried step)
6    append   3     1      1/critical_path   60s  @ 8
```

## Known limits

**The manage request sends `messages: []`.** It is a placeholder: `manage_request`
tells the consumer not to execute it as inference. A backend that validates
messages as non-empty must be taught to accept an empty body for manage
requests before the lifecycle verbs can work.

**A `stop` issued during process exit may lose the delivery race.** The plugin
constructs and dispatches it (the trace proves that), but the process teardown
can abort the local fetch before the mock receives it. Phase A therefore accepts
either the capture or the dispatched trace record; phase B captures a delivered
`stop` for the child and accepts the trace for the parent. Browser typing is
covered by component tests; a real browser acceptance run is still pending.
