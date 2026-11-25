#!/usr/bin/env bash
# Keyless wire verification for the normalized Agent Hint contract.
#
# Installs the local plugin into a scratch profile, points the route at a local
# capture stub, drives two headless runs (a fresh session, then the same session
# adopted), and asserts what left the process:
#
#   run 1: ordinary request carries `start` in the X-Agent-Hint header
#   run 2: the adopted session emits `resume` (manage request) then `append`
#   exit:  session disposal emits `stop` (manage request)
#
# The body must never carry a hint; auxiliary (title) requests stay hint-free.
# No API key, no harness-source modification.
#
# DSH runtime resolution: DSH_BIN (exact command) > the cached 0.2.2-rc.1
# installation used by this repository's checks. Install it with:
#   npm install --prefix ~/.cache/dsh-agent-hints-e2e/dsh-0.2.2-rc.1 @deepseek-ai/dsh@0.2.2-rc.1
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d /tmp/dsh-agent-hints-e2e-XXXXXX)"
CACHED_DSH="$HOME/.cache/dsh-agent-hints-e2e/dsh-0.2.2-rc.1/node_modules/@deepseek-ai/dsh/lib/bin.js"
cleanup() {
  if [ -n "${STUB_PID:-}" ] && kill -0 "$STUB_PID" 2> /dev/null; then kill "$STUB_PID" 2> /dev/null || true; fi
  rm -rf "$SCRATCH"
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

echo "== agent-hints e2e scratch: $SCRATCH (DSH: $DSH)"

echo "== [1/6] start capture stub"
node "$ROOT/e2e/mock-upstream.cjs" "$SCRATCH/capture.jsonl" "$SCRATCH/stub.port" > "$SCRATCH/stub.log" 2>&1 &
STUB_PID=$!
for _ in $(seq 1 50); do [ -f "$SCRATCH/stub.port" ] && break; sleep 0.1; done
[ -f "$SCRATCH/stub.port" ] || { echo "stub did not start" >&2; cat "$SCRATCH/stub.log" >&2; exit 1; }
STUB_URL="http://127.0.0.1:$(cat "$SCRATCH/stub.port")"
echo "  stub on $STUB_URL"

echo "== [2/6] create profile and install the local plugin"
$DSH --profile "$PROFILE" --from-default-profile headless < /dev/null > /dev/null 2>&1 || true
$DSH plugin --profile "$PROFILE" add "$ROOT" > "$SCRATCH/install.log" 2>&1
$DSH --profile "$PROFILE" --dump-config 2> /dev/null | grep -q "id: agent-hints" \
  || { echo "agent-hints row is not mounted" >&2; tail -20 "$SCRATCH/install.log" >&2; exit 1; }
echo "  agent-hints row mounted"

echo "== [3/6] wire overlay (model binding rides the overlay; settings.yaml is import-once)"
cat > "$SCRATCH/patch.yml" <<YAML
- id: agent-hints
  config:
    baseURL: $STUB_URL
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

echo "== [4/6] headless run 1: fresh session"
set +e
$DSH --profile "$PROFILE" --patch "$SCRATCH/patch.yml" --json "Reply with the single word pong." \
  > "$SCRATCH/run1.jsonl" 2> "$SCRATCH/run1.stderr"
RUN1_EXIT=$?
set -e
if [ "$RUN1_EXIT" -ne 0 ]; then
  echo "run 1 exited $RUN1_EXIT; stderr:" >&2
  tail -20 "$SCRATCH/run1.stderr" >&2
  exit 1
fi
SESSION_ID="$(node -e '
const fs = require("node:fs")
for (const line of fs.readFileSync(process.argv[1], "utf8").split("\n")) {
  if (line.trim().length === 0) continue
  let event
  try { event = JSON.parse(line) } catch { continue }
  if (event.type === "session") { process.stdout.write(String(event.sessionId)); break }
}
' "$SCRATCH/run1.jsonl")"
[ -n "$SESSION_ID" ] || { echo "run 1 emitted no session id" >&2; exit 1; }
echo "  run 1 completed (exit 0, session $SESSION_ID)"

echo "== [5/6] headless run 2: adopt the session"
set +e
$DSH --profile "$PROFILE" --patch "$SCRATCH/patch.yml" --json --session-id "$SESSION_ID" \
  "Reply with a one-line acknowledgment." \
  > "$SCRATCH/run2.jsonl" 2> "$SCRATCH/run2.stderr"
RUN2_EXIT=$?
set -e
if [ "$RUN2_EXIT" -ne 0 ]; then
  echo "run 2 exited $RUN2_EXIT; stderr:" >&2
  tail -20 "$SCRATCH/run2.stderr" >&2
  exit 1
fi
echo "  run 2 completed (exit 0, adopted session)"

echo "== [6/6] assert the captured wire contract"
# The disposal `stop` is issued during exit; give the local fetch a moment to land.
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
  if (hint.session?.state === "stop") process.exit(0)
}
process.exit(1)
' "$SCRATCH/capture.jsonl" 2> /dev/null; then break; fi
  sleep 0.1
done
node "$ROOT/e2e/verify-headless.cjs" "$SCRATCH/capture.jsonl" "$SESSION_ID" "$SCRATCH/run1.jsonl" "$SCRATCH/run2.jsonl"

echo "agent-hints e2e PASS"
