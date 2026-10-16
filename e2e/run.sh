#!/usr/bin/env bash
# Keyless agent-hints wire verification for the standalone plugin: the hint
# rides the `X-Agent-Hint` HTTP header (model-invisible), so the durable
# session log cannot show it. This script installs the local plugin package
# into a scratch profile, mounts the hinted adapter (provider route
# `deepseek-hint`) against a local SSE capture stub with one echo tool, runs
# one tool round trip, then asserts the captured requests carry the
# base64url-encoded AgentHint on the header with the request body free of hint
# fields. No API key, no harness-source modification.
#
# DSH runtime resolution: DSH_BIN (exact command) > `dsh` on PATH > a
# deepseek-harness source checkout (DSH_CHECKOUT or the sibling directory).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SCRATCH="$(mktemp -d /tmp/dsh-agent-hints-e2e-XXXXXX)"
cleanup() {
  if [ -n "${STUB_PID:-}" ] && kill -0 "$STUB_PID" 2> /dev/null; then kill "$STUB_PID" 2> /dev/null || true; fi
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

echo "== [1/5] start capture stub"
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

echo "== [2/5] create profile + install the local plugin package"
$DSH --profile "$PROFILE" --from-default-profile headless < /dev/null > /dev/null 2>&1 || true
$DSH plugin --profile "$PROFILE" add "$ROOT" > /dev/null
$DSH --profile "$PROFILE" --dump-config 2> /dev/null | grep -q "^- id: agent-hints"
$DSH --profile "$PROFILE" --dump-config 2> /dev/null | grep -q "name: dsh-agent-hints"
echo "  agent-hints row mounted"

echo "== [3/5] model binding + wire overlay"
printf 'agent-default-model:\n  provider: deepseek-hint\n  model: deepseek-flash\n' > "$DSH_HOME/settings.yaml"
sed -e "s|__STUB_BASE_URL__|$STUB_URL|" \
    -e "s|__STATUS_SINK__|$SCRATCH/status.jsonl|" \
    -e "s|__FIXTURE_TOOL__|$ROOT/e2e/fixture-tool.mjs|" \
    "$ROOT/e2e/e2e.patch.yml" > "$SCRATCH/patch.yml"

echo "== [4/5] headless run through the hinted adapter"
set +e
AGENT_HINTS_E2E_API_KEY=sk-agent-hints-e2e-dummy \
  $DSH --profile "$PROFILE" --patch "$SCRATCH/patch.yml" --json "Call the e2e_probe tool with message START, then report the result." \
  > "$SCRATCH/run.jsonl" 2> "$SCRATCH/run.stderr"
RUN_EXIT=$?
set -e
if [ "$RUN_EXIT" -ne 0 ]; then
  echo "headless run exited $RUN_EXIT; stderr:" >&2
  tail -10 "$SCRATCH/run.stderr" >&2
  exit 1
fi
grep -q 'AGENT_HINTS_E2E_FINAL' "$SCRATCH/run.jsonl"
echo "  probe tool round trip completed (exit 0)"

echo "== [5/5] assert captured request bodies"
# The HTTP sink delivers asynchronously; wait for the finalize event to land.
for _ in $(seq 1 50); do
  [ -f "$SCRATCH/status-http.jsonl" ] && grep -q '"finalize"' "$SCRATCH/status-http.jsonl" 2> /dev/null && break
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

echo "agent-hints e2e PASS"
