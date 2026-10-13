#!/usr/bin/env node
// Assert the captured wire requests from agent-hints-stub-server.mjs: the
// hinted adapter must carry the AgentHint on the `X-Agent-Hint` HTTP header
// (UTF-8 JSON, base64url) with the exact schema shape, only on main-line
// requests, with the request body free of any hint field. When a status-sink
// path is given as the second argument, the out-of-band status event sequence
// is asserted as well (tool → running → finalize per working session).
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
const hintRequests = requests.filter(entry => typeof entry.headers['x-agent-hint'] === 'string')
if (hintRequests.length !== 2) {
  fail(`expected exactly 2 main-line requests carrying X-Agent-Hint (tool call + final answer), got ${hintRequests.length}`
    + ` (${requests.length} total requests captured)`)
}

const seenSessionIds = new Set()
hintRequests.forEach((entry, index) => {
  const hint = JSON.parse(Buffer.from(entry.headers['x-agent-hint'], 'base64url').toString('utf8'))
  const session = hint.session
  if (!isPlainObject(session)) fail(`request ${index}: session block missing`)
  if (typeof session.session_id !== 'string' || session.session_id.length === 0) fail(`request ${index}: session_id missing`)
  seenSessionIds.add(session.session_id)
  if (session.agent_type !== 'agent') fail(`request ${index}: agent_type must be "agent", got ${JSON.stringify(session.agent_type)}`)
  if (session.call_index !== index + 1) fail(`request ${index}: call_index must be ${index + 1}, got ${JSON.stringify(session.call_index)}`)
  if (session.epoch !== 0) fail(`request ${index}: epoch must be 0 in this flow, got ${JSON.stringify(session.epoch)}`)
  if ('parent_session_id' in session || 'derivation' in session) fail(`request ${index}: root session must not carry lineage fields`)

  if (!isPlainObject(hint.agent_status) || hint.agent_status.state !== 'running') fail(`request ${index}: agent_status must be {state: "running"}`)
  if (typeof hint.agent_status.state_since_ms !== 'number' || !Number.isFinite(hint.agent_status.state_since_ms)) {
    fail(`request ${index}: agent_status.state_since_ms must be a finite number`)
  }

  if (JSON.stringify(hint.priority) !== JSON.stringify({ level: 3, reason: 'user_waiting' })) {
    fail(`request ${index}: priority must be {level:3, reason:"user_waiting"}, got ${JSON.stringify(hint.priority)}`)
  }
  if (JSON.stringify(hint.cache_control) !== JSON.stringify([{ type: 'pin', range: { end: 1 } }])) {
    fail(`request ${index}: cache_control must be [{type:"pin",range:{end:1}}], got ${JSON.stringify(hint.cache_control)}`)
  }
  if ('strict_priority' in hint) fail(`request ${index}: strict_priority must never be agent-sent`)
  if ('prediction' in hint) fail(`request ${index}: prediction must not be sent in v1`)

  // Body stays in the provider's original format: no hint field anywhere.
  if (Object.hasOwn(entry.body, 'agent_hints')) {
    fail(`request ${index}: request body must not carry hint fields (header-only protocol)`)
  }

  const headerSessionId = entry.headers['x-deepseek-harness-session-id']
  if (headerSessionId !== session.session_id) {
    fail(`request ${index}: session_id ${JSON.stringify(session.session_id)} must equal the transport header`
      + ` x-deepseek-harness-session-id ${JSON.stringify(headerSessionId)}`)
  }

  const hasToolMessage = Array.isArray(entry.body.messages) && entry.body.messages.some(message => message?.role === 'tool')
  if (index === 0 && hasToolMessage) fail('request 0 must precede the tool call (no role:"tool" message)')
  if (index === 1 && !hasToolMessage) fail('request 1 must follow the tool call (role:"tool" message expected)')
})

if (seenSessionIds.size !== 1) fail(`both main-line requests must share one session, got ${seenSessionIds.size}`)

const auxiliary = requests.length - hintRequests.length

let sinkNote = ''
const sinkPath = process.argv[3]
if (sinkPath !== undefined) {
  if (!existsSync(sinkPath)) fail(`status sink ${sinkPath} was not written — the status channel did not activate`)
  const statusEvents = readFileSync(sinkPath, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .map(line => JSON.parse(line))
  // Group per session; every working session must show tool → running →
  // finalize (the SOP tool round trip), auxiliary sessions finalize only.
  const bySession = new Map()
  for (const event of statusEvents) {
    const id = event.session?.session_id
    if (typeof id !== 'string' || id.length === 0) fail(`status event without session_id: ${JSON.stringify(event)}`)
    if (!bySession.has(id)) bySession.set(id, [])
    bySession.get(id).push(event.agent_status?.state)
  }
  const mainId = [...seenSessionIds][0]
  const mainStates = bySession.get(mainId)
  if (mainStates === undefined) fail(`status sink has no events for the working session ${mainId}`)
  if (JSON.stringify(mainStates) !== JSON.stringify(['tool', 'running', 'finalize'])) {
    fail(`working session status sequence must be ["tool","running","finalize"], got ${JSON.stringify(mainStates)}`)
  }
  const toolEvent = statusEvents.find(event => event.session?.session_id === mainId && event.agent_status?.state === 'tool')
  const tool = toolEvent?.agent_status?.tools?.[0]
  if (tool?.name !== 'e2e_probe' || typeof tool.call_id !== 'string' || tool.call_id.length === 0) {
    fail(`tool status must name the awaited tool with its call_id, got ${JSON.stringify(tool)}`)
  }
  for (const [sessionId, states] of bySession) {
    if (sessionId === mainId) continue
    if (states.at(-1) !== 'finalize') fail(`session ${sessionId} must finalize, got ${JSON.stringify(states)}`)
  }
  sinkNote = `, status sink: ${statusEvents.length} event(s) over ${bySession.size} session(s)`
}

console.log(`agent-hints-capture-check: PASS — ${hintRequests.length} main-line requests with X-Agent-Hint`
  + ` (call_index 1→2, one session, identity matches transport header, body hint-free)`
  + `${auxiliary > 0 ? `, ${auxiliary} auxiliary request(s) without hint` : ''}${sinkNote}`)
