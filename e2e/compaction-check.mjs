#!/usr/bin/env node
// Compaction-phase assertions: one headless run whose second step overflows the
// model context. The harness routes the provider's CONTEXT_WINDOW_EXCEEDED
// through overflow recovery, summarizes via an auxiliary (hint-less,
// x-deepseek-harness-compact) request, and retries the step. Verifies that
// `epoch` bumps after `compaction/end`, that the first post-compaction request
// suppresses the cache declaration (the prefix was rewritten), and that the
// next request declares again.
//
// Usage: agent-hints-compaction-check.mjs <capture.jsonl> [status-sink.jsonl]
import { readFileSync, existsSync } from 'node:fs'

function fail(message) {
  console.error(`agent-hints-compaction-check: FAIL: ${message}`)
  process.exit(1)
}

const capturePath = process.argv[2]
if (capturePath === undefined) fail('usage: agent-hints-compaction-check.mjs <capture.jsonl> [status-sink.jsonl]')

const requests = readFileSync(capturePath, 'utf8')
  .split('\n')
  .filter(line => line.trim().length > 0)
  .map(line => JSON.parse(line))
if (requests.length === 0) fail('capture is empty — the adapter never reached the stub')

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const hinted = requests
  .filter(entry => typeof entry.headers['x-agent-hint'] === 'string')
  .map(entry => ({ entry, hint: JSON.parse(Buffer.from(entry.headers['x-agent-hint'], 'base64url').toString('utf8')) }))
if (hinted.length !== 4) {
  fail(`expected 4 hinted main-line requests (probe, overflow, overflow retry, final), got ${hinted.length}`
    + ` (${requests.length} total requests captured)`)
}

const sessionIds = new Set(hinted.map(item => item.hint.session.session_id))
if (sessionIds.size !== 1) fail(`all requests must share one session, got ${sessionIds.size}`)
const sessionId = [...sessionIds][0]

const USER_WAITING = { level: 3, reason: 'user_waiting' }
const CONTINUATION = { level: 1, reason: 'critical_path' }

const EXPECT = [
  // Step 1: turn opening, first declaration (no interval sample).
  { callIndex: 1, epoch: 0, state: 'running', priority: USER_WAITING, ttlS: 600 },
  // Step 2: resume after the probe release; this request overflows.
  { callIndex: 2, epoch: 0, state: 'resume', priority: CONTINUATION, ttlS: 60 },
  // Same step retried after compaction: epoch bumped, cache suppressed.
  { callIndex: 2, epoch: 1, state: 'resume', priority: CONTINUATION, ttlS: undefined },
  // Step 3 after the retried probe: the rewrite has aged out, cache returns.
  { callIndex: 3, epoch: 1, state: 'resume', priority: CONTINUATION, ttlS: 60 },
]

hinted.forEach((item, index) => {
  const { entry, hint } = item
  const label = `request ${index}`
  const session = hint.session
  const expect = EXPECT[index]
  if (!isPlainObject(session)) fail(`${label}: session block missing`)
  if (session.session_id !== sessionId) fail(`${label}: session_id changed within the run`)
  if (session.agent_type !== 'agent') fail(`${label}: agent_type must be "agent", got ${JSON.stringify(session.agent_type)}`)
  if ('parent_session_id' in session || 'derivation' in session) fail(`${label}: a root session must not carry lineage fields`)
  if (session.call_index !== expect.callIndex) fail(`${label}: call_index must be ${expect.callIndex}, got ${JSON.stringify(session.call_index)}`)
  if (session.epoch !== expect.epoch) fail(`${label}: epoch must be ${expect.epoch}, got ${JSON.stringify(session.epoch)}`)

  if (!isPlainObject(hint.agent_status)) fail(`${label}: agent_status block missing`)
  if (JSON.stringify(Object.keys(hint.agent_status).sort()) !== JSON.stringify(['state', 'state_since_ms'])) {
    fail(`${label}: header agent_status must carry only state + state_since_ms`)
  }
  if (hint.agent_status.state !== expect.state) fail(`${label}: state must be "${expect.state}", got ${JSON.stringify(hint.agent_status.state)}`)
  if (typeof hint.agent_status.state_since_ms !== 'number' || !Number.isFinite(hint.agent_status.state_since_ms)) {
    fail(`${label}: state_since_ms must be a finite number`)
  }
  if (JSON.stringify(hint.priority) !== JSON.stringify(expect.priority)) {
    fail(`${label}: priority must be ${JSON.stringify(expect.priority)}, got ${JSON.stringify(hint.priority)}`)
  }
  if ('strict_priority' in hint) fail(`${label}: strict_priority must never be agent-sent`)

  const cache = hint.cache_control
  if (expect.ttlS === undefined) {
    if (cache !== undefined) fail(`${label}: cache_control must be suppressed after the rewrite, got ${JSON.stringify(cache)}`)
  } else {
    if (!Array.isArray(cache) || cache.length !== 1) fail(`${label}: cache_control must be one entry, got ${JSON.stringify(cache)}`)
    if (cache[0].type !== 'ephemeral') fail(`${label}: cache_control.type must be "ephemeral"`)
    if (cache[0].ttl_s !== expect.ttlS) fail(`${label}: cache_control.ttl_s must be ${expect.ttlS}, got ${JSON.stringify(cache[0].ttl_s)}`)
    if (cache[0].range?.unit !== 'message') fail(`${label}: cache_control.range.unit must be "message"`)
    if (cache[0].range?.end !== entry.body.messages.length) {
      fail(`${label}: cache_control.range.end must equal the wire message count ${entry.body.messages.length}`)
    }
  }

  if (Object.hasOwn(entry.body, 'agent_hints')) fail(`${label}: request body must not carry hint fields`)
  if (entry.headers['x-deepseek-harness-session-id'] !== session.session_id) {
    fail(`${label}: session_id must equal the transport header`)
  }
})

const auxiliary = requests.filter(entry => typeof entry.headers['x-agent-hint'] !== 'string')
const compactionCalls = auxiliary.filter(entry => entry.headers['x-deepseek-harness-compact'] === '1')
if (compactionCalls.length < 1) fail('expected the overflow recovery to issue an auxiliary compaction request (no hint, compact header)')
if (auxiliary.length < 1) fail('expected at least one auxiliary request')

let sinkNote = ''
const sinkPath = process.argv[3]
if (sinkPath !== undefined) {
  if (!existsSync(sinkPath)) fail(`status sink ${sinkPath} was not written`)
  const statusEvents = readFileSync(sinkPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
  const states = statusEvents.map(event => event.agent_status?.state)
  for (const state of states) {
    if (!['running', 'pause', 'finalize'].includes(state)) fail(`status state outside the folded vocabulary: ${JSON.stringify(state)}`)
  }
  if (states.filter(state => state === 'pause').length !== 2) fail(`expected two probe pauses, got ${JSON.stringify(states)}`)
  if (states.at(-1) !== 'finalize') fail(`the session must finalize, got ${JSON.stringify(states)}`)
  sinkNote = `, status sink: ${statusEvents.length} event(s)`
}

console.log(`agent-hints-compaction-check: PASS — epoch 0→1 after compaction/end,`
  + ` post-compaction cache suppressed then restored, ${auxiliary.length} auxiliary request(s)`
  + ` (${compactionCalls.length} compaction call(s) without hint)${sinkNote}`)
