#!/usr/bin/env node
/**
 * Phase B assertions: a delegated child runs while the parent is idle.
 *
 * Expected (from e2e/run.sh, script `E2E_DELEGATE`):
 *
 *   parent call 1  start   priority 3/user_waiting   probe tool call
 *   parent call 2  append  priority 1/critical_path  subagent tool call
 *   parent call 3  append  priority 1/critical_path  final text of the turn
 *   child  call 1  start   priority 3/user_waiting   (runs while parent is idle)
 *   parent          pause  manage offload           (triggered by the child's request)
 *   child           stop   manage evict             (child session disposed)
 *   parent          resume manage prefetch          (before the notice turn)
 *   parent call 4  append  priority 3/user_waiting  notice-turn opening
 *
 * Usage: node verify-lifecycle.cjs <captures.jsonl> [trace-file...]
 */
const fs = require('node:fs')

const [, , capturesPath, ...tracePaths] = process.argv
if (!capturesPath) {
  console.error('usage: verify-lifecycle.cjs <captures.jsonl> [trace-file...]')
  process.exit(2)
}

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  [${detail}]`}`)
  if (!ok) failures.push(label)
}
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
const captures = fs.readFileSync(capturesPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
const hintOf = row => typeof row.headers['x-agent-hint'] === 'string' ? decode(row.headers['x-agent-hint']) : undefined
const hinted = captures.map(row => ({ row, hint: hintOf(row) })).filter(entry => entry.hint !== undefined)
const isTitle = row => JSON.stringify(row.body?.messages ?? '').includes('concise title')

// 1. Body never carries a hint; auxiliary requests stay hint-free.
for (const row of captures) {
  check(row.body?.agent_hint === undefined && row.body?.session_control === undefined,
    'the request body carries no hint field', `${row.method} ${row.path}`)
}
for (const row of captures.filter(row => hintOf(row) === undefined)) {
  check(row.headers['x-agent-hint'] === null || row.headers['x-agent-hint'] === undefined,
    'a hint-free request really carries no hint header', String(row.headers['x-agent-hint']))
}

// 2. Two sessions: the parent owns the pause; the other is the delegated child.
const sessions = new Map()
for (const entry of hinted) {
  const id = entry.hint.session.session_id
  if (!sessions.has(id)) sessions.set(id, [])
  sessions.get(id).push(entry)
}
check(sessions.size === 2, 'the delegated run has a parent and one child session', [...sessions.keys()].length)
const parentId = [...sessions.keys()].find(id => sessions.get(id).some(entry => entry.hint.session.state === 'pause'))
check(parentId !== undefined, 'one session sends pause')
const childId = [...sessions.keys()].find(id => id !== parentId)
check(childId !== undefined, 'the other session is the child')

const parent = sessions.get(parentId) ?? []
const child = sessions.get(childId) ?? []
const states = list => list.map(entry => entry.hint.session.state)
const ordinaryOf = list => list
  .filter(entry => entry.row.body?.stream === true && (entry.row.body?.messages ?? []).length > 0 && !isTitle(entry.row))
  .map(entry => entry.hint)

// 3. Parent ordinary timeline.
const parentOrdinary = ordinaryOf(parent)
check(parentOrdinary.length === 4, 'the parent issues three turn calls plus the notice turn', parentOrdinary.length)
check(states(parent).filter(state => state === 'start').length === 1
  && parentOrdinary[0]?.session.state === 'start', 'the parent opens with start exactly once')
check(parentOrdinary.slice(1).every(hint => hint.session.state === 'append'),
  'the parent continues with append', parentOrdinary.slice(1).map(hint => hint.session.state).join(','))
check(parentOrdinary.map(hint => hint.session.call_index).join(',') === '1,2,3,4',
  'the parent counts main-line calls in order', parentOrdinary.map(hint => hint.session.call_index).join(','))
check(parentOrdinary.every(hint => hint.session.epoch === 0), 'the parent epoch stays 0 without a rewrite')
check(parentOrdinary.map(hint => `${hint.priority_control?.priority.level}/${hint.priority_control?.priority.reason}`).join(',')
  === '3/user_waiting,1/critical_path,1/critical_path,3/user_waiting',
'the notice turn is a new turn opening (priority 3) after continuations (priority 1)',
parentOrdinary.map(hint => `${hint.priority_control?.priority.level}/${hint.priority_control?.priority.reason}`).join(','))
check(parentOrdinary.every(hint => hint.cache_control !== undefined),
  'the parent declares cache on every ordinary request while the prefix is stable')
for (const hint of parentOrdinary) {
  if (hint.cache_control === undefined) continue
  check(hint.cache_control.msg_offset >= 1, 'cache msg_offset is positive', hint.cache_control.msg_offset)
  check(hint.cache_control.ttl_s >= 60 && hint.cache_control.ttl_s <= 3600, 'cache ttl is clamped', hint.cache_control.ttl_s)
}
check(parentOrdinary[0]?.cache_control?.ttl_s === 600, 'the first call uses the no-sample TTL',
  parentOrdinary[0]?.cache_control?.ttl_s)

// 4. Child timeline.
const childOrdinary = ordinaryOf(child)
check(childOrdinary.length === 1 && childOrdinary[0]?.session.state === 'start',
  'the child opens its own session with start', childOrdinary.map(hint => hint.session.state).join(','))
check(childOrdinary[0]?.session.call_index === 1 && childOrdinary[0]?.session.epoch === 0,
  'the child counts from 1 at epoch 0')
check(childOrdinary[0]?.priority_control?.priority.level === 3
  && childOrdinary[0]?.priority_control?.priority.reason === 'user_waiting',
'the child first call is a turn opening')
check(childOrdinary[0]?.session.parent_session_id === undefined,
  'a subagent child does not claim its creator as a fork parent')

// 5. Manage requests: verbs, edits, placeholder body, ordering.
const manageRows = captures.filter(row => typeof row.headers['x-agent-hint'] === 'string' && row.body?.stream !== true)
const EDITS = { pause: 'offload', resume: 'prefetch', stop: 'evict', compact: 'evict' }
for (const row of manageRows) {
  const hint = hintOf(row)
  check(Array.isArray(row.body?.messages) && row.body.messages.length === 0,
    `manage ${hint.session.state} carries a placeholder body`)
  check(typeof row.body?.model === 'string' && row.body.model.length > 0, `manage ${hint.session.state} names the model`)
  check(hint.context_management?.manage_request === true, `manage ${hint.session.state} marks manage_request`)
  check(hint.context_management?.edits?.length === 1
    && hint.context_management.edits[0].type === EDITS[hint.session.state]
    && hint.context_management.edits[0].target === 'session',
  `manage ${hint.session.state} asks for ${EDITS[hint.session.state]} on the session`,
  JSON.stringify(hint.context_management?.edits))
}
const pauseRow = manageRows.find(row => hintOf(row).session.state === 'pause')
const resumeRow = manageRows.find(row => hintOf(row).session.state === 'resume')
const childStop = manageRows.find(row => hintOf(row).session.state === 'stop'
  && hintOf(row).session.session_id === childId)
const pauseHint = pauseRow === undefined ? undefined : hintOf(pauseRow)
const resumeHint = resumeRow === undefined ? undefined : hintOf(resumeRow)
check(pauseHint !== undefined && pauseHint.session.session_id === parentId,
  'pause targets the parent', pauseHint?.session?.session_id)
check(pauseHint?.session?.call_index === 3, 'pause carries the parent\'s last main-line call',
  pauseHint?.session?.call_index)
check(resumeHint !== undefined && resumeHint.session.session_id === parentId,
  'resume targets the parent before its notice turn')
check(resumeHint?.session?.call_index === 4, 'resume carries the upcoming call index',
  resumeHint?.session?.call_index)
check(childStop !== undefined && hintOf(childStop).session.call_index === 1,
  'the child disposal sends stop with its own call index')

// Ordering: child request accepted before pause; pause before resume; resume
// before the parent's notice-turn request.
const indexOfRow = row => captures.indexOf(row)
const childStartIndex = indexOfRow(child.find(entry => entry.hint.session.state === 'start')?.row)
const pauseIndex = indexOfRow(pauseRow)
const resumeIndex = indexOfRow(resumeRow)
const noticeIndex = indexOfRow(parent.find(entry => entry.hint.session.state === 'append'
  && entry.hint.session.call_index === 4)?.row)
check(childStartIndex >= 0 && pauseIndex > childStartIndex,
  'pause is sent after the child\'s request is accepted', `${childStartIndex} < ${pauseIndex}`)
check(pauseIndex >= 0 && resumeIndex > pauseIndex, 'resume follows the pause', `${pauseIndex} < ${resumeIndex}`)
check(resumeIndex >= 0 && noticeIndex > resumeIndex,
  'resume precedes the parent\'s notice-turn request', `${resumeIndex} < ${noticeIndex}`)

// 6. A stop for the parent may lose the exit race; the trace still records it.
const controlTraces = []
for (const path of tracePaths) {
  if (!fs.existsSync(path)) continue
  for (const line of fs.readFileSync(path, 'utf8').split('\n')) {
    if (!line.startsWith('agent-hint/trace ')) continue
    try { controlTraces.push(JSON.parse(line.slice('agent-hint/trace '.length))) } catch { /* ignore */ }
  }
}
const parentStop = manageRows.some(row => hintOf(row).session.state === 'stop'
  && hintOf(row).session.session_id === parentId)
  || controlTraces.some(row => row.plane === 'control' && row.hint?.state === 'stop'
    && row.sessionId === parentId && row.dispatched === true)
check(parentStop, 'the parent disposal sends stop (captured or dispatched in the trace)')

console.log('')
if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s):`)
  for (const failure of new Set(failures)) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('LIFECYCLE CHECKS PASSED')
