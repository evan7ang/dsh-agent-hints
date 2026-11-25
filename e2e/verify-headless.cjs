#!/usr/bin/env node
/**
 * Golden assertions for the normalized Agent Hint wire contract, including the
 * send-timing rules observed through a real DSH run.
 *
 * Scenario driven by run.sh: two headless runs over one session, each with one
 * real tool round trip (prompt `E2E_PROBE`), then session disposal and
 * adoption. Expected ordinary-request timeline:
 *
 *   call 1  start   priority 3/user_waiting  cache declared   (turn opening)
 *   call 2  append  priority 1/critical_path cache declared   (tool continuation)
 *   call 3  append  priority 3/user_waiting  cache suppressed (new process: signature
 *                                                             unknown, call_index > 1)
 *   call 4  append  priority 1/critical_path cache declared   (continuation; signature known)
 *
 * plus a `resume` manage request before the adopted session's first request and
 * a `stop` manage request at disposal.
 *
 * Usage: node verify-headless.cjs <captures.jsonl> [expected-session-id] [trace-file...]
 */
const fs = require('node:fs')

const [, , capturesPath, expectedSession, ...tracePaths] = process.argv
if (!capturesPath) {
  console.error('usage: verify-headless.cjs <captures.jsonl> [expected-session-id] [trace-file...]')
  process.exit(2)
}

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  [${detail}]`}`)
  if (!ok) failures.push(label)
}
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))

const captures = fs.readFileSync(capturesPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
check(captures.length >= 2, 'captured the ordinary and manage requests', captures.length)

const STATES = new Set(['start', 'append', 'pause', 'resume', 'stop', 'compact'])
const EDITS = { pause: 'offload', resume: 'prefetch', stop: 'evict', compact: 'evict' }
const hinted = captures.filter(row => typeof row.headers['x-agent-hint'] === 'string')
const hintless = captures.filter(row => typeof row.headers['x-agent-hint'] !== 'string')
const hintOf = row => decode(row.headers['x-agent-hint'])
const titleOf = row => JSON.stringify(row.body?.messages ?? '').includes('concise title')
  || JSON.stringify(row.body?.messages ?? '').includes('Create a concise title')

// 1. The body never carries a hint field.
for (const row of captures) {
  const body = row.body ?? {}
  check(body.agent_hint === undefined && body.session_control === undefined,
    'the request body carries no hint field', `${row.method} ${row.path}`)
}

// 2. Every hint is a well-formed normalized object.
const sessions = new Set()
for (const row of hinted) {
  const hint = hintOf(row)
  const keys = Object.keys(hint).sort()
  check(keys.every(key => ['session', 'context_management', 'priority_control', 'cache_control'].includes(key)),
    'hint carries only the four normalized blocks', keys.join(','))
  check(typeof hint.session?.session_id === 'string' && hint.session.session_id.length > 0,
    'session.session_id is present')
  check(STATES.has(hint.session?.state), 'session.state is in the six-value vocabulary', hint.session?.state)
  check(Number.isInteger(hint.session?.call_index) && hint.session.call_index >= 1,
    'session.call_index is a positive integer', hint.session?.call_index)
  check(Number.isInteger(hint.session?.epoch) && hint.session.epoch >= 0,
    'session.epoch is a non-negative integer', hint.session?.epoch)
  check(hint.session?.parent_session_id === undefined, 'a root session carries no parent_session_id')
  if (expectedSession !== undefined) {
    check(hint.session.session_id === expectedSession, 'the hint names the running session', hint.session.session_id)
  }
  sessions.add(hint.session.session_id)

  if (hint.priority_control !== undefined) {
    const priority = hint.priority_control.priority
    check(priority.level === 1 || priority.level === 3, 'priority.level is two-level', JSON.stringify(priority.level))
    check(typeof priority.reason === 'string' && priority.reason.length > 0, 'priority.reason is present')
    check((priority.level === 3) === (priority.reason === 'user_waiting'),
      'priority level and reason agree', `${priority.level}/${priority.reason}`)
  }
  if (hint.cache_control !== undefined) {
    check(hint.cache_control.type === 'ephemeral', 'cache_control.type is ephemeral', hint.cache_control.type)
    check(Number.isInteger(hint.cache_control.ttl_s)
      && hint.cache_control.ttl_s >= 60 && hint.cache_control.ttl_s <= 3600,
    'cache_control.ttl_s is clamped to [60, 3600]', hint.cache_control.ttl_s)
    check(Number.isInteger(hint.cache_control.msg_offset)
      && hint.cache_control.msg_offset === (row.body?.messages ?? []).length,
    'cache_control.msg_offset equals the wire message count', hint.cache_control.msg_offset)
  }
}
check(sessions.size === 1, 'every hinted request names one adopted session', [...sessions].join(','))

// 3. Ordinary requests: state, call index and send timing.
const ordinaryRows = captures.filter(row => row.body?.stream === true && (row.body?.messages ?? []).length > 0
  && typeof row.headers['x-agent-hint'] === 'string' && !titleOf(row))
const ordinary = ordinaryRows.map(hintOf)
check(ordinary.length === 4, 'two turns with one tool continuation each produce four ordinary requests', ordinary.length)
check(ordinary[0]?.session.state === 'start', 'the fresh session opens with start', ordinary[0]?.session.state)
check(ordinary.slice(1).every(hint => hint.session.state === 'append'),
  'every later ordinary request is append', ordinary.slice(1).map(hint => hint.session.state).join(','))
check(ordinary.slice(1).filter(hint => hint.session.state === 'start').length === 0,
  'start never repeats within the session')
check(ordinary.map(hint => hint.session.call_index).join(',') === '1,2,3,4',
  'call_index counts main-line calls in order', ordinary.map(hint => hint.session.call_index).join(','))
check(ordinary.every(hint => hint.session.epoch === 0),
  'epoch stays 0 without a compaction rewrite', ordinary.map(hint => hint.session.epoch).join(','))

const expectedPriority = [
  { level: 3, reason: 'user_waiting' },   // turn opening of run 1
  { level: 1, reason: 'critical_path' },  // tool continuation of run 1
  { level: 3, reason: 'user_waiting' },   // turn opening of run 2 (adopted session)
  { level: 1, reason: 'critical_path' },  // tool continuation of run 2
]
for (const [index, expected] of expectedPriority.entries()) {
  const actual = ordinary[index]?.priority_control?.priority
  check(actual?.level === expected.level && actual?.reason === expected.reason,
    `priority of ordinary request ${index + 1} is ${expected.level}/${expected.reason}`,
    `${actual?.level}/${actual?.reason}`)
}

// cache: declared per main-line request, except the round where the restored
// process has no signature for a call_index > 1 session (run 2's first request).
const expectedCache = [true, true, false, true]
for (const [index, present] of expectedCache.entries()) {
  const actual = ordinary[index]?.cache_control !== undefined
  check(actual === present, `cache_control of ordinary request ${index + 1} is ${present ? 'declared' : 'suppressed'}`,
    actual ? `${ordinary[index].cache_control.ttl_s}s/${ordinary[index].cache_control.msg_offset}` : 'absent')
}

// 4. Manage requests: placeholder body, explicit edit, matching verb, and
//    resume sent before the adopted session's first ordinary request.
const manageRows = captures.filter(row => row.body?.stream !== true && typeof row.headers['x-agent-hint'] === 'string')
const manage = manageRows.map(hintOf)
check(manage.length >= 1, 'captured at least one manage request', manage.length)
for (const [index, hint] of manage.entries()) {
  const row = manageRows[index]
  check(row.body?.stream === false || row.body?.stream === undefined, `manage ${hint.session.state} is non-streaming`)
  check(Array.isArray(row.body?.messages) && row.body.messages.length === 0,
    `manage ${hint.session.state} carries a placeholder body`)
  check(typeof row.body?.model === 'string' && row.body.model.length > 0, `manage ${hint.session.state} names the model`)
  check(hint.context_management?.manage_request === true, `manage ${hint.session.state} marks manage_request`)
  check(EDITS[hint.session.state] !== undefined && hint.context_management?.edits?.length === 1
    && hint.context_management.edits[0].type === EDITS[hint.session.state]
    && hint.context_management.edits[0].target === 'session',
  `manage ${hint.session.state} asks for ${EDITS[hint.session.state]} on the session`,
  JSON.stringify(hint.context_management?.edits))
}
const manageStates = manage.map(hint => hint.session.state)
check(manageStates.includes('resume'), 'adopting a seeded session sends resume', manageStates.join(','))
const resumeIndex = captures.findIndex(row => typeof row.headers['x-agent-hint'] === 'string' && hintOf(row).session.state === 'resume')
const adoptedFirstIndex = captures.indexOf(ordinaryRows[2])
check(resumeIndex >= 0 && adoptedFirstIndex > resumeIndex,
  'resume is sent before the adopted session\'s first ordinary request', `${resumeIndex} < ${adoptedFirstIndex}`)

// A stop issued at process exit may lose the delivery race; the trace still
// proves it was constructed and dispatched.
const controlTraces = []
for (const path of tracePaths) {
  if (!fs.existsSync(path)) continue
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('agent-hint/trace ')) continue
    try { controlTraces.push(JSON.parse(line.slice('agent-hint/trace '.length))) } catch { /* ignore */ }
  }
}
const stopDispatched = manageStates.includes('stop') || controlTraces.some(row => row.plane === 'control'
  && row.hint?.state === 'stop' && row.hint?.context_management?.edits?.includes('evict') && row.dispatched === true)
check(stopDispatched, 'session disposal sends stop (captured or dispatched in the trace)', manageStates.join(','))

// The stop must be labelled with the session's last main-line call, even
// though the session has already left the store by then.
const lastCallIndex = ordinary.at(-1)?.session.call_index
const stopCallIndexes = [
  ...manage.filter(hint => hint.session.state === 'stop').map(hint => hint.session.call_index),
  ...controlTraces.filter(row => row.plane === 'control' && row.hint?.state === 'stop').map(row => row.hint.call_index),
]
check(stopCallIndexes.some(index => index === lastCallIndex),
  'the stop of the last run carries the last main-line call index', `${stopCallIndexes.join(',')} vs ${lastCallIndex}`)
check(!stopCallIndexes.some(index => index > lastCallIndex),
  'no stop claims a call index beyond the session', stopCallIndexes.join(','))

// 5. Auxiliary work stays hint-free.
const titles = hintless.filter(titleOf)
check(titles.length >= 1, 'a harness-generated title request happened in this run', titles.length)
for (const row of titles) check(row.headers['x-agent-hint'] === null, 'the title request carries no hint')

// 6. Timeline for human review.
console.log('\n# wire timeline (capture order)')
console.log('# idx  path                  state    call_index epoch priority cache            wire_msgs')
for (const [index, row] of captures.entries()) {
  const raw = row.headers['x-agent-hint']
  if (typeof raw !== 'string') {
    console.log(`  ${String(index + 1).padEnd(4)} ${String(row.path).padEnd(21)} ${'(no hint)'.padEnd(8)}`)
    continue
  }
  const hint = hintOf(row)
  const priority = hint.priority_control?.priority
  const cache = hint.cache_control
  console.log(`  ${String(index + 1).padEnd(4)} ${String(row.path).padEnd(21)} ${hint.session.state.padEnd(8)} `
    + `${String(hint.session.call_index).padEnd(10)} ${String(hint.session.epoch).padEnd(5)} `
    + `${(priority === undefined ? '-' : `${priority.level}/${priority.reason}`).padEnd(14)} `
    + `${(cache === undefined ? '-' : `${cache.ttl_s}s@${cache.msg_offset}`).padEnd(16)} `
    + `${(row.body?.messages ?? []).length}`)
}

console.log('')
if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s):`)
  for (const failure of new Set(failures)) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
