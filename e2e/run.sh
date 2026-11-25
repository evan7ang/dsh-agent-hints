#!/usr/bin/env bash
# Keyless wire verification for the normalized Agent Hint contract, in three
# phases against one scratch profile and a scripted local upstream:
#
#   A. session framing (two headless runs, one real tool round trip each):
#      start -> append, adoption sends resume, disposal sends stop.
#   B. delegated child (one headless run): a background subagent runs while the
#      parent is idle, so the parent gets pause, its notification turn gets
#      resume, and both sessions emit start/append frames.
#   C. context pressure (one headless run): a synthetic context-window error
#      makes the harness compact and retry the step; epoch bumps, the compact
#      manage request carries the old epoch, and cache is suppressed one round.
#
# Every phase asserts that the request body never carries hint fields and that
# auxiliary (title/compaction) requests stay hint-free.
#
# DSH runtime resolution: DSH_BIN (exact command) > the cached 0.2.2-rc.1
# installation used by this repository's checks. Install it with:
#   npm install --prefix ~/.cache/dsh-agent-hints-e2e/dsh-0.2.2-rc.1 @deepseek-ai/dsh@0.2.2-rc.1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d /tmp/dsh-agent-hints-e2e-XXXXXX)"
CACHED_DSH="$HOME/.cache/dsh-agent-hints-e2e/dsh-0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js"
STUB_PID=""
cleanup() {
  if [ -n "$STUB_PID" ] && kill -0 "$STUB_PID" 2> /dev/null; then kill "$STUB_PID" 2> /dev/null || true; fi
  if [ "${E2E_KEEP:-0}" = "1" ]; then
    echo "e2e scratch kept: $SCRATCH"
  else
    rm -rf "$SCRATCH"
  fi
}
trap cleanup EXIT

resolve_dsh() {
  if [ -n "${DSH_BIN:-}" ]; then printf '%s' "$DSH_BIN"; return 0; fi
  if [ -f "$CACHED_DSH" ]; then printf 'node %s' "$CACHED_DSH"; return 0; fi
  echo "e2e/run.sh: no DSH 0.2.2-rc.1 runtime found (set DSH_BIN, or install $CACHED_DSH)" >&2
  return 1
}

DSH="$(resolve_dsh)"
VERSION="$($DSH --version 2> /dev/null | tail -1)"
if [ "$VERSION" != "0.2.2-rc.1" ]; then
  echo "e2e/run.sh: expected DSH 0.2.2-rc.1, got '${VERSION}' ($DSH)" >&2
  exit 1
fi
PROFILE="agent-hints-e2e"
export DSH_HOME="$SCRATCH/home"
export DEEPSEEK_API_KEY="sk-unused-fixture"
export HINT_E2E_KEY="sk-agent-hints-e2e-dummy"
cd "$SCRATCH"

start_stub() {
  local name="$1"
  STUB_PID=""
  node "$ROOT/e2e/mock-upstream.cjs" "$SCRATCH/capture-$name.jsonl" "$SCRATCH/stub-$name.port" \
    > "$SCRATCH/stub-$name.log" 2>&1 &
  STUB_PID=$!
  for _ in $(seq 1 50); do [ -f "$SCRATCH/stub-$name.port" ] && break; sleep 0.1; done
  [ -f "$SCRATCH/stub-$name.port" ] || { echo "stub $name did not start" >&2; cat "$SCRATCH/stub-$name.log" >&2; exit 1; }
  echo "http://127.0.0.1:$(cat "$SCRATCH/stub-$name.port")"
}

stop_stub() {
  if [ -n "$STUB_PID" ] && kill -0 "$STUB_PID" 2> /dev/null; then kill "$STUB_PID" 2> /dev/null || true; fi
  STUB_PID=""
}

make_patch() {
  local name="$1" base="$2"
  cat > "$SCRATCH/patch-$name.yml" <<YAML
- insert:
    - id: dsh-agent-hints-e2e-probe
      name: $ROOT/e2e/fixture-tool.mjs
- id: agent-hints
  config:
    baseURL: $base
    apiKeyEnv: HINT_E2E_KEY
    models:
      - id: fixture
        name: Fixture
        contextWindow: 8192
        maxTokens: 256
- id: agent-default-model
  config:
    provider: deepseek-hint
    model: fixture
YAML
}

run_headless() {
  local name="$1" prompt="$2"
  shift 2
  set +e
  $DSH --profile "$PROFILE" --patch "$SCRATCH/patch-$name.yml" --json "$@" "$prompt" \
    > "$SCRATCH/run-$name.jsonl" 2> "$SCRATCH/run-$name.stderr"
  local code=$?
  set -e
  if [ "$code" -ne 0 ]; then
    echo "phase $name exited $code; stderr:" >&2
    tail -20 "$SCRATCH/run-$name.stderr" >&2
    exit 1
  fi
}

session_of() {
  node -e '
const fs = require("node:fs")
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (line.trim().length === 0) continue
  let event
  try { event = JSON.parse(line) } catch { continue }
  if (event.type === "session") { process.stdout.write(String(event.sessionId)); break }
}
' "$1"
}

# Wait until the capture holds a manage request with the given state (decoded).
wait_for_state() {
  local capture="$1" state="$2"
  for _ in $(seq 1 50); do
    if node -e '
const fs = require("node:fs")
const rows = fs.readFileSync(process.argv[1], "utf8").trim().split("\n").filter(Boolean)
for (const row of rows) {
  let value
  try { value = JSON.parse(row) } catch { continue }
  const raw = value.headers?.["x-agent-hint"]
  if (typeof raw !== "string") continue
  let hint
  try { hint = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) } catch { continue }
  if (hint.session?.state === process.argv[2]) process.exit(0)
}
process.exit(1)
' "$capture" "$state" 2> /dev/null; then return 0; fi
    sleep 0.1
  done
}

echo "== agent-hints e2e scratch: $SCRATCH (DSH: $DSH)"

echo "== [1/6] create profile and install the local plugin"
$DSH --profile "$PROFILE" --from-default-profile headless < /dev/null > /dev/null 2>&1 || true
$DSH plugin --profile "$PROFILE" add "$ROOT" > "$SCRATCH/install.log" 2>&1
$DSH --profile "$PROFILE" --dump-config 2> /dev/null | grep -q "id: agent-hints" \
  || { echo "agent-hints row is not mounted" >&2; tail -20 "$SCRATCH/install.log" >&2; exit 1; }
echo "  agent-hints row mounted"

echo "== [2/6] phase A: session framing (fresh session, then adoption)"
BASE="$(start_stub a)"; make_patch a "$BASE"
run_headless a "Call e2e_probe with message E2E_PROBE, then reply with the single word done."
SESSION_ID="$(session_of "$SCRATCH/run-a.jsonl")"
[ -n "$SESSION_ID" ] || { echo "phase A emitted no session id" >&2; exit 1; }
run_headless a "Call e2e_probe with message E2E_PROBE, then reply with the single word done." --session-id "$SESSION_ID"
wait_for_state "$SCRATCH/capture-a.jsonl" stop
stop_stub
node "$ROOT/e2e/verify-headless.cjs" "$SCRATCH/capture-a.jsonl" "$SESSION_ID" "$SCRATCH/run-a.jsonl"

echo "== [3/6] phase B: delegated child (pause while idle, resume on the notice turn)"
BASE="$(start_stub b)"; make_patch b "$BASE"
run_headless b "E2E_DELEGATE run the delegated probe scenario, then report."
wait_for_state "$SCRATCH/capture-b.jsonl" pause
wait_for_state "$SCRATCH/capture-b.jsonl" resume
wait_for_state "$SCRATCH/capture-b.jsonl" stop
stop_stub
node "$ROOT/e2e/verify-lifecycle.cjs" "$SCRATCH/capture-b.jsonl" "$SCRATCH/run-b.jsonl"

echo "== [4/6] phase C: context pressure (compact after overflow, epoch bump)"
BASE="$(start_stub c)"; make_patch c "$BASE"
run_headless c "HINT_E2E_OVERFLOW run the compaction scenario, then report."
wait_for_state "$SCRATCH/capture-c.jsonl" compact
stop_stub
node "$ROOT/e2e/verify-compaction.cjs" "$SCRATCH/capture-c.jsonl" "$SCRATCH/run-c.jsonl"

echo "agent-hints e2e PASS"
