#!/usr/bin/env bash
# Keyless agent-hints wire verification for the standalone plugin: the hint
# rides the `X-Agent-Hint` HTTP header (model-invisible), so the durable
# session log cannot show it. This script installs the local plugin package
# into a scratch profile, mounts the hinted adapter (provider route
# `deepseek-hint`) against a local SSE capture stub, and drives two headless
# runs through the real harness:
#
#   run 1: e2e_probe tool round trip → background `subagent` delegation (the
#          ack settles the call; the child does its own probe round trip and
#          its completion notice opens a second turn) → parent final answer
#   run 2: `--session-id` adopts the same session, opening a third turn
#
# The capture assertions then verify every AgentHint field end to end:
# session identity/lineage/call_index/epoch, the four-value status
# (running/resume + the out-of-band pause/running/finalize events), the
# two-level dynamic priority, and the dynamic cache declaration (TTL from the
# observed interval, wire-sized range, and the post-restart suppression).
# No API key, no harness-source modification.
#
# DSH runtime resolution: DSH_BIN (exact command) > `dsh` on PATH > a
# deepseek-harness source checkout (DSH_CHECKOUT or the sibling directory).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d /tmp/dsh-agent-hints-e2e-XXXXXX)"
cleanup() {
  for pid in "${STUB_PID:-}" "${STUB2_PID:-}"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2> /dev/null; then kill "$pid" 2> /dev/null || true; fi
  done
  rm -rf "$SCRATCH"
}
trap cleanup EXIT

resolve_dsh() {
  if [ -n "${DSH_BIN:-}" ]; then printf '%s' "$DSH_BIN"; return 0; fi
  if command -v dsh > /dev/null 2>&1; then command -v dsh; return 0; fi
  local candidates=("${DSH_CHECKOUT:-}" "$(dirname "$ROOT")/deepseek-harness")
  local cand
  for cand in "${candidates[@]}"; do
    if [ -n "$cand" ] && [ -x "$cand/apps/cli/lib/bin.js" ]; then printf 'node %s' "$cand/apps/cli/lib/bin.js"; return 0; fi
  done
  echo "e2e/run.sh: no dsh runtime found (set DSH_BIN or DSH_CHECKOUT, or install dsh on PATH)" >&2
  return 1
}

DSH="$(resolve_dsh)"
PROFILE="agent-hints-e2e"
export DSH_HOME="$SCRATCH/home"
cd "$SCRATCH"

echo "== agent-hints e2e scratch: $SCRATCH (DSH command: $DSH)"

echo "== [1/7] start capture stub"
node "$ROOT/e2e/stub-server.mjs" --capture "$SCRATCH/capture.jsonl" --port-file "$SCRATCH/stub.port" --status-out "$SCRATCH/status-http.jsonl" &
STUB_PID=$!
for _ in $(seq 1 50); do
  [ -f "$SCRATCH/stub.port" ] && break
  sleep 0.1
done
[ -f "$SCRATCH/stub.port" ] || { echo "stub did not start" >&2; exit 1; }
STUB_PORT="$(cat "$SCRATCH/stub.port")"
STUB_URL="http://127.0.0.1:$STUB_PORT"
echo "  stub on $STUB_URL"

echo "== [2/7] create profile + install the local plugin package"
$DSH --profile "$PROFILE" --from-default-profile headless < /dev/null > /dev/null 2>&1 || true
$DSH plugin --profile "$PROFILE" add "$ROOT" > /dev/null
$DSH --profile "$PROFILE" --dump-config 2> /dev/null | grep -q "^- id: agent-hints"
$DSH --profile "$PROFILE" --dump-config 2> /dev/null | grep -q "name: dsh-agent-hints"
echo "  agent-hints row mounted"

echo "== [3/7] wire overlay (model binding rides the overlay — settings.yaml is import-once)"
sed -e "s|__STUB_BASE_URL__|$STUB_URL|" \
    -e "s|__STATUS_SINK__|$SCRATCH/status.jsonl|" \
    -e "s|__FIXTURE_TOOL__|$ROOT/e2e/fixture-tool.mjs|" \
    "$ROOT/e2e/e2e.patch.yml" > "$SCRATCH/patch.yml"

echo "== [4/7] headless run 1: probe round trip + background subagent delegation"
set +e
AGENT_HINTS_E2E_API_KEY=sk-agent-hints-e2e-dummy \
  $DSH --profile "$PROFILE" --patch "$SCRATCH/patch.yml" --json \
  "Call e2e_probe with message START, then delegate a probe to a subagent, then report the outcome." \
  > "$SCRATCH/run1.jsonl" 2> "$SCRATCH/run1.stderr"
RUN1_EXIT=$?
set -e
if [ "$RUN1_EXIT" -ne 0 ]; then
  echo "run 1 exited $RUN1_EXIT; stderr:" >&2
  tail -10 "$SCRATCH/run1.stderr" >&2
  exit 1
fi
grep -q 'AGENT_HINTS_E2E_FINAL' "$SCRATCH/run1.jsonl"
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

echo "== [5/7] headless run 2: adopt the session and open a third turn"
set +e
AGENT_HINTS_E2E_API_KEY=sk-agent-hints-e2e-dummy \
  $DSH --profile "$PROFILE" --patch "$SCRATCH/patch.yml" --json --session-id "$SESSION_ID" \
  "Reply with a one-line acknowledgment." \
  > "$SCRATCH/run2.jsonl" 2> "$SCRATCH/run2.stderr"
RUN2_EXIT=$?
set -e
if [ "$RUN2_EXIT" -ne 0 ]; then
  echo "run 2 exited $RUN2_EXIT; stderr:" >&2
  tail -10 "$SCRATCH/run2.stderr" >&2
  exit 1
fi
grep -q 'AGENT_HINTS_E2E_FINAL' "$SCRATCH/run2.jsonl"
echo "  run 2 completed (exit 0, adopted session, second turn)"

echo "== [6/7] assert the captured wire fields and status events"
# The HTTP sink delivers asynchronously; wait for the run-2 finalize to land
# (three session-scoped finalize events: child + root disposals in run 1,
# root disposal in run 2).
for _ in $(seq 1 80); do
  if [ -f "$SCRATCH/status-http.jsonl" ] \
    && [ "$(grep -c '"finalize"' "$SCRATCH/status-http.jsonl" 2> /dev/null || true)" -ge 3 ]; then
    break
  fi
  sleep 0.1
done
node "$ROOT/e2e/capture-check.mjs" "$SCRATCH/capture.jsonl" "$SCRATCH/status-http.jsonl"
# Both sinks fire from the same emitter in emission order: the JSONL file and
# the HTTP-received sequence must be identical.
node -e "
const fs = require('node:fs')
const read = p => fs.readFileSync(p, 'utf8').trim().split('\n').filter(l => l.length > 0).map(JSON.parse)
const file = read(process.argv[1])
const http = read(process.argv[2])
assert = require('node:assert/strict')
assert.deepEqual(http, file, 'HTTP status events must match the file sink sequence')
console.log('  file sink and HTTP endpoint sequences identical (' + http.length + ' events)')
" "$SCRATCH/status.jsonl" "$SCRATCH/status-http.jsonl"

echo "== [7/7] compaction phase: overflow recovery, epoch bump, cache suppression"
node "$ROOT/e2e/stub-server.mjs" --capture "$SCRATCH/capture-compaction.jsonl" --port-file "$SCRATCH/stub2.port" &
STUB2_PID=$!
for _ in $(seq 1 50); do
  [ -f "$SCRATCH/stub2.port" ] && break
  sleep 0.1
done
[ -f "$SCRATCH/stub2.port" ] || { echo "compaction stub did not start" >&2; exit 1; }
STUB2_URL="http://127.0.0.1:$(cat "$SCRATCH/stub2.port")"
sed -e "s|__STUB_BASE_URL__|$STUB2_URL|" \
    -e "s|__STATUS_SINK__|$SCRATCH/status-compaction.jsonl|" \
    -e "s|__FIXTURE_TOOL__|$ROOT/e2e/fixture-tool.mjs|" \
    "$ROOT/e2e/e2e-compaction.patch.yml" > "$SCRATCH/patch-compaction.yml"
set +e
AGENT_HINTS_E2E_API_KEY=sk-agent-hints-e2e-dummy \
  $DSH --profile "$PROFILE" --patch "$SCRATCH/patch-compaction.yml" --json \
  "HINT_E2E_OVERFLOW call e2e_probe with a huge payload, then report." \
  > "$SCRATCH/run3.jsonl" 2> "$SCRATCH/run3.stderr"
RUN3_EXIT=$?
set -e
if [ "$RUN3_EXIT" -ne 0 ]; then
  echo "compaction run exited $RUN3_EXIT; stderr:" >&2
  tail -10 "$SCRATCH/run3.stderr" >&2
  exit 1
fi
grep -q 'AGENT_HINTS_E2E_FINAL' "$SCRATCH/run3.jsonl"
node "$ROOT/e2e/compaction-check.mjs" "$SCRATCH/capture-compaction.jsonl" "$SCRATCH/status-compaction.jsonl"

echo "agent-hints e2e PASS"
