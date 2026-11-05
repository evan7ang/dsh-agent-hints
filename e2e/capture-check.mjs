#!/usr/bin/env node
// Field-by-field assertions over the requests captured from the real harness
// runs (see run.sh): root turn 1 (probe → subagent delegation → final), the
// spawned child (probe → final), and root turn 2 (adopted session, fresh
// process). Verifies session identity/lineage/call_index/epoch, the four-value
// status (running/resume on the header, pause→running→finalize events), the
// two-level dynamic priority, and the dynamic cache declaration (interval TTL,
// wire-sized range, post-restart suppression).
//
// Usage: agent-hints-capture-check.mjs <capture.jsonl> [status-sink.jsonl]
import { readFileSync, existsSync } from 'node:fs'

function fail(message) {
  console.error(`agent-hints-capture-check: FAIL: ${message}`)
  process.exit(1)
}

const capturePath = process.argv[2]
if (capturePath === undefined) fail('usage: agent-hints-capture-check.mjs <capture.jsonl>')

const requests = readFileSync(capturePath, 'utf8')
  .split('\n')
  .filter(line => line.trim().length > 0)
  .map(line => JSON.parse(line))
if (requests.length === 0) fail('capture is empty — the adapter never reached the stub')

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)
const hintEntries = requests.filter(entry => typeof entry.headers['x-agent-hint'] === 'string')
const decoded = hintEntries.map(entry => ({
  entry,
  hint: JSON.parse(Buffer.from(entry.headers['x-agent-hint'], 'base64url').toString('utf8')),
}))
const rootItems = decoded.filter(item => item.hint.session.parent_session_id === undefined)
const childItems = decoded.filter(item => item.hint.session.parent_session_id !== undefined)

if (rootItems.length !== 4) {
  fail(`expected 4 root main-line requests (probe call, delegation call, turn-1 final, turn-2 opening), got ${rootItems.length}`
    + ` (${requests.length} total requests captured)`)
}
if (childItems.length !== 2) fail(`expected 2 child main-line requests (probe call + final), got ${childItems.length}`)

const rootIds = new Set(rootItems.map(item => item.hint.session.session_id))
if (rootIds.size !== 1) fail(`the root requests must share one session across both runs, got ${rootIds.size}`)
const rootId = [...rootIds][0]
const childIds = new Set(childItems.map(item => item.hint.session.session_id))
if (childIds.size !== 1) fail(`the child requests must share one session, got ${childIds.size}`)
const childId = [...childIds][0]
if (childId === rootId) fail('the child session must differ from the root session')

const byCallIndex = items => [...items].sort((a, b) => a.hint.session.call_index - b.hint.session.call_index)

const USER_WAITING = { level: 3, reason: 'user_waiting' }
const CONTINUATION = { level: 1, reason: 'critical_path' }

function verifyRequest(item, label, expect) {
  const { entry, hint } = item
  const session = hint.session
  if (!isPlainObject(session)) fail(`${label}: session block missing`)
  if (session.session_id !== expect.sessionId) fail(`${label}: session_id must be ${expect.sessionId}, got ${JSON.stringify(session.session_id)}`)
  if (session.agent_type !== 'agent') fail(`${label}: agent_type must be "agent", got ${JSON.stringify(session.agent_type)}`)
  if (session.call_index !== expect.callIndex) fail(`${label}: call_index must be ${expect.callIndex}, got ${JSON.stringify(session.call_index)}`)
  if (session.epoch !== expect.epoch) fail(`${label}: epoch must be ${expect.epoch}, got ${JSON.stringify(session.epoch)}`)

  if (expect.parentSessionId === undefined) {
    if ('parent_session_id' in session || 'derivation' in session) fail(`${label}: a root session must not carry lineage fields`)
  } else {
    if (session.parent_session_id !== expect.parentSessionId) {
      fail(`${label}: parent_session_id must be ${expect.parentSessionId}, got ${JSON.stringify(session.parent_session_id)}`)
    }
    const derivation = session.derivation
    if (!isPlainObject(derivation)) fail(`${label}: derivation block missing`)
    if (derivation.relation !== expect.relation) fail(`${label}: derivation.relation must be "${expect.relation}", got ${JSON.stringify(derivation.relation)}`)
    if (derivation.join !== expect.join) fail(`${label}: derivation.join must be "${expect.join}", got ${JSON.stringify(derivation.join)}`)
    if ('fork_point' in derivation) fail(`${label}: fork_point must not be emitted`)
    if (JSON.stringify(Object.keys(derivation).sort()) !== JSON.stringify(['join', 'relation'])) {
      fail(`${label}: derivation must carry only relation + join, got ${JSON.stringify(derivation)}`)
    }
  }

  if (!isPlainObject(hint.agent_status)) fail(`${label}: agent_status block missing`)
  if (JSON.stringify(Object.keys(hint.agent_status).sort()) !== JSON.stringify(['state', 'state_since_ms'])) {
    fail(`${label}: header agent_status must carry only state + state_since_ms, got ${JSON.stringify(hint.agent_status)}`)
  }
  if (hint.agent_status.state !== expect.state) fail(`${label}: state must be "${expect.state}", got ${JSON.stringify(hint.agent_status.state)}`)
  if (typeof hint.agent_status.state_since_ms !== 'number' || !Number.isFinite(hint.agent_status.state_since_ms)) {
    fail(`${label}: agent_status.state_since_ms must be a finite number`)
  }

  if (JSON.stringify(hint.priority) !== JSON.stringify(expect.priority)) {
    fail(`${label}: priority must be ${JSON.stringify(expect.priority)}, got ${JSON.stringify(hint.priority)}`)
  }
  if ('strict_priority' in hint) fail(`${label}: strict_priority must never be agent-sent`)

  const cache = hint.cache_control
  if (expect.ttlS === undefined) {
    if (cache !== undefined) fail(`${label}: cache_control must be suppressed this round, got ${JSON.stringify(cache)}`)
  } else {
    if (!Array.isArray(cache) || cache.length !== 1) fail(`${label}: cache_control must be exactly one entry, got ${JSON.stringify(cache)}`)
    if (cache[0].type !== 'ephemeral') fail(`${label}: cache_control.type must be "ephemeral", got ${JSON.stringify(cache[0].type)}`)
    if (cache[0].ttl_s !== expect.ttlS) fail(`${label}: cache_control.ttl_s must be ${expect.ttlS}, got ${JSON.stringify(cache[0].ttl_s)}`)
    if (cache[0].range?.unit !== 'message') fail(`${label}: cache_control.range.unit must be "message"`)
    if (cache[0].range?.end !== entry.body.messages.length) {
      fail(`${label}: cache_control.range.end must equal the wire message count ${entry.body.messages.length}, got ${JSON.stringify(cache[0].range?.end)}`)
    }
  }

  // The e2e overlay configures `predictionStatic`: the block stays byte-identical.
  if (JSON.stringify(hint.prediction) !== JSON.stringify({ latency_ms: 4000, output_tokens: 512, remaining_calls: 3 })) {
    fail(`${label}: prediction must be the configured static block, got ${JSON.stringify(hint.prediction)}`)
  }

  if (Object.hasOwn(entry.body, 'agent_hints')) fail(`${label}: request body must not carry hint fields (header-only protocol)`)
  if (entry.headers['x-deepseek-harness-session-id'] !== session.session_id) {
    fail(`${label}: session_id ${JSON.stringify(session.session_id)} must equal the transport header`
      + ` x-deepseek-harness-session-id ${JSON.stringify(entry.headers['x-deepseek-harness-session-id'])}`)
  }
}

const roots = byCallIndex(rootItems)
const ROOT_EXPECT = [
  // Turn 1 opening: running, user intervention, first prefix declaration (no interval sample → 600 s).
  { sessionId: rootId, epoch: 0, callIndex: 1, state: 'running', priority: USER_WAITING, ttlS: 600 },
  // First call after the probe release: resume (one-shot), continuation priority, interval-clamped TTL.
  { sessionId: rootId, epoch: 0, callIndex: 2, state: 'resume', priority: CONTINUATION, ttlS: 60 },
  // First call after the delegation release: resume again.
  { sessionId: rootId, epoch: 0, callIndex: 3, state: 'resume', priority: CONTINUATION, ttlS: 60 },
  // Turn 2 opening in a fresh process: running, user intervention, and the conservative
  // signature-unknown suppression (call_index > 1 after a restart).
  { sessionId: rootId, epoch: 0, callIndex: 4, state: 'running', priority: USER_WAITING, ttlS: undefined },
]
roots.forEach((item, index) => verifyRequest(item, `root call ${index + 1}`, ROOT_EXPECT[index]))

const children = byCallIndex(childItems)
const CHILD_EXPECT = [
  { sessionId: childId, epoch: 0, callIndex: 1, state: 'running', priority: USER_WAITING, ttlS: 600, parentSessionId: rootId, relation: 'spawn', join: 'sync' },
  { sessionId: childId, epoch: 0, callIndex: 2, state: 'resume', priority: CONTINUATION, ttlS: 60, parentSessionId: rootId, relation: 'spawn', join: 'sync' },
]
children.forEach((item, index) => verifyRequest(item, `child call ${index + 1}`, CHILD_EXPECT[index]))

const auxiliary = requests.length - hintEntries.length
if (auxiliary < 1) fail('expected at least one auxiliary request (session-title) without a hint')

let sinkNote = ''
const sinkPath = process.argv[3]
if (sinkPath !== undefined) {
  if (!existsSync(sinkPath)) fail(`status sink ${sinkPath} was not written — the status channel did not activate`)
  const statusEvents = readFileSync(sinkPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
  for (const event of statusEvents) {
    if (typeof event.session?.session_id !== 'string') fail(`status event without session_id: ${JSON.stringify(event)}`)
    if (!['running', 'pause', 'finalize'].includes(event.agent_status?.state)) {
      fail(`status event state outside the folded vocabulary: ${JSON.stringify(event.agent_status)}`)
    }
  }
  const eventsOf = id => statusEvents.filter(event => event.session.session_id === id)
  const statesOf = id => eventsOf(id).map(event => event.agent_status.state)

  const rootEvents = eventsOf(rootId)
  const rootStates = statesOf(rootId)
  if (rootStates[0] !== 'pause') fail(`root status must open with the probe pause, got ${JSON.stringify(rootStates)}`)
  if (rootStates.filter(state => state === 'finalize').length !== 2) {
    fail(`root must finalize each of its two turns, got ${JSON.stringify(rootStates)}`)
  }
  const rootPauses = rootEvents.filter(event => event.agent_status.state === 'pause')
  if (rootPauses.length < 2) fail(`root must report the probe and delegation pauses, got ${rootPauses.length}`)
  if (rootPauses[0].agent_status.reason !== 'await_tool' || rootPauses[0].agent_status.tools?.[0]?.name !== 'e2e_probe') {
    fail(`the first root pause must be the awaited probe tool, got ${JSON.stringify(rootPauses[0].agent_status)}`)
  }
  const delegationPause = rootPauses.at(-1).agent_status
  if (delegationPause.reason !== 'await_tool') fail(`delegation pause must carry reason "await_tool", got ${JSON.stringify(delegationPause.reason)}`)
  const delegationTool = delegationPause.tools?.[0]
  if (delegationTool?.name !== 'agent:subagent') fail(`delegation pause must name "agent:subagent", got ${JSON.stringify(delegationTool)}`)
  if (typeof delegationTool?.call_id !== 'string' || delegationTool.call_id.length === 0) {
    fail(`delegation pause must carry the awaited call_id, got ${JSON.stringify(delegationTool)}`)
  }
  if (delegationTool?.child_session_id !== childId) {
    fail(`delegation pause must bind child_session_id ${childId}, got ${JSON.stringify(delegationTool?.child_session_id)}`)
  }

  const childStates = statesOf(childId)
  if (JSON.stringify(childStates) !== JSON.stringify(['pause', 'running', 'finalize'])) {
    fail(`child status sequence must be ["pause","running","finalize"], got ${JSON.stringify(childStates)}`)
  }
  const childPause = eventsOf(childId).find(event => event.agent_status.state === 'pause')
  if (childPause?.agent_status?.reason !== 'await_tool') {
    fail(`child pause must carry reason "await_tool", got ${JSON.stringify(childPause?.agent_status?.reason)}`)
  }
  if (childPause?.agent_status?.tools?.[0]?.name !== 'e2e_probe') {
    fail(`child pause must name e2e_probe, got ${JSON.stringify(childPause?.agent_status?.tools)}`)
  }

  // Cross-channel: a resume request pins the release moment, which is exactly
  // the matching running event's state_since_ms.
  const resumeTimes = items => byCallIndex(items)
    .filter(item => item.hint.agent_status.state === 'resume')
    .map(item => item.hint.agent_status.state_since_ms)
  const runningTimes = id => eventsOf(id)
    .filter(event => event.agent_status.state === 'running')
    .map(event => event.agent_status.state_since_ms)
  const rootResumeTimes = resumeTimes(rootItems)
  const rootRunningTimes = runningTimes(rootId)
  if (JSON.stringify(rootResumeTimes) !== JSON.stringify(rootRunningTimes)) {
    fail(`root resume state_since_ms ${JSON.stringify(rootResumeTimes)} must match the running event times ${JSON.stringify(rootRunningTimes)}`)
  }
  const childResumeTimes = resumeTimes(childItems)
  const childRunningTimes = runningTimes(childId)
  if (JSON.stringify(childResumeTimes) !== JSON.stringify(childRunningTimes)) {
    fail(`child resume state_since_ms ${JSON.stringify(childResumeTimes)} must match the running event times ${JSON.stringify(childRunningTimes)}`)
  }

  // Auxiliary sessions (if any) must still end with a finalize event.
  const seenIds = new Set(statusEvents.map(event => event.session.session_id))
  for (const id of seenIds) {
    if (id === rootId || id === childId) continue
    const states = statesOf(id)
    if (states.at(-1) !== 'finalize') fail(`session ${id} must finalize, got ${JSON.stringify(states)}`)
  }
  sinkNote = `, status sink: ${statusEvents.length} event(s) over ${seenIds.size} session(s)`
}

console.log(`agent-hints-capture-check: PASS — ${hintEntries.length} hinted main-line requests`
  + ` (root call_index 1→4 across a session adoption, child 1→2, running/resume, priority 3/1,`
  + ` dynamic cache incl. post-restart suppression, spawn lineage with join sync)`
  + `, ${auxiliary} auxiliary request(s) without hint${sinkNote}`)
