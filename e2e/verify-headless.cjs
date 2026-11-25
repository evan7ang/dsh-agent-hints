#!/usr/bin/env node
/**
 * Golden assertions for the normalized Agent Hint wire contract.
 *
 * Reads the mock upstream's captures and checks what actually left the process:
 * the ordinary requests carry `start`/`append` in the header with priority and
 * cache declarations, lifecycle verbs ride dedicated placeholder manage requests
 * with explicit session-targeted edits, the body never carries a hint, and
 * auxiliary (title) requests stay hint-free.
 *
 * `stop` is issued during process exit, where the local fetch may be aborted
 * before it reaches the mock (`session/disposed` and plugin teardown race).
 * The assertion therefore accepts either a captured stop request or the
 * plugin's own control trace proving the manage request was constructed and
 * dispatched. Delivery itself is covered by the captured `resume`.
 *
 * Usage: node verify-headless.cjs <captures.jsonl> [expected-session-id] [trace-file...]
 */
const fs = require('node:fs')

const [, , capturesPath, expectedSession, ...tracePaths] = process.argv
if (!capturesPath) {
  console.error('usage: verify-headless.cjs <captures.jsonl> [expected-session-id]')
  process.exit(2)
}

const failures = []
const check = (ok, label, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === undefined ? '' : `  [${detail}]`}`)
  if (!ok) failures.push(label)
}
const decode = value => JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))

const captures = fs.readFileSync(capturesPath, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
check(captures.length >= 2, 'captured at least the ordinary and one manage request', captures.length)

const STATES = new Set(['start', 'append', 'pause', 'resume', 'stop', 'compact'])
const EDITS = { pause: 'offload', resume: 'prefetch', stop: 'evict', compact: 'evict' }
const hinted = captures.filter(row => typeof row.headers['x-agent-hint'] === 'string')
const hintless = captures.filter(row => typeof row.headers['x-agent-hint'] !== 'string')
const hintOf = row => decode(row.headers['x-agent-hint'])

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

// 3. Ordinary requests: start first, append after adoption; priority always present.
const ordinary = captures.filter(row => row.body?.stream === true && (row.body?.messages ?? []).length > 0
  && typeof row.headers['x-agent-hint'] === 'string')
check(ordinary.length >= 2, 'captured two ordinary hinted requests', ordinary.length)
const states = ordinary.map(row => hintOf(row).session.state)
check(states.includes('start'), 'the ordinary request opens the session with start', states.join(','))
check(states.includes('append'), 'the adopted session continues with append', states.join(','))
check(states.filter(state => state === 'start').length === 1, 'start appears exactly once', states.join(','))
check(ordinary.every(row => hintOf(row).priority_control !== undefined),
  'every ordinary request carries priority_control')

// 4. Manage requests: placeholder body, explicit edit, matching verb.
const manage = captures.filter(row => row.body?.stream !== true && typeof row.headers['x-agent-hint'] === 'string')
check(manage.length >= 1, 'captured at least one manage request', manage.length)
for (const row of manage) {
  const hint = hintOf(row)
  check(row.body?.stream === false || row.body?.stream === undefined,
    `manage ${hint.session.state} is non-streaming`)
  check(Array.isArray(row.body?.messages) && row.body.messages.length === 0,
    `manage ${hint.session.state} carries a placeholder body`)
  check(typeof row.body?.model === 'string' && row.body.model.length > 0,
    `manage ${hint.session.state} names the model`)
  check(hint.context_management?.manage_request === true,
    `manage ${hint.session.state} marks manage_request`)
  check(EDITS[hint.session.state] !== undefined && hint.context_management?.edits?.length === 1
    && hint.context_management.edits[0].type === EDITS[hint.session.state]
    && hint.context_management.edits[0].target === 'session',
  `manage ${hint.session.state} asks for ${EDITS[hint.session.state]} on the session`,
  JSON.stringify(hint.context_management?.edits))
}
const manageStates = manage.map(row => hintOf(row).session.state)
check(manageStates.includes('resume'), 'adopting a seeded session sends resume', manageStates.join(','))

// A stop issued at process exit may lose the delivery race; the trace still
// proves it was constructed and dispatched.
const stopDispatched = manageStates.includes('stop') || tracePaths.some(path => {
  if (!fs.existsSync(path)) return false
  return fs.readFileSync(path, 'utf8').split('\n').some(line => {
    if (!line.startsWith('agent-hint/trace ')) return false
    let row
    try { row = JSON.parse(line.slice('agent-hint/trace '.length)) } catch { return false }
    return row.plane === 'control' && row.hint?.state === 'stop'
      && row.hint?.context_management?.edits?.includes('evict') && row.dispatched === true
  })
})
check(stopDispatched, 'session disposal sends stop (captured or dispatched in the trace)',
  manageStates.join(','))

// 5. Auxiliary work stays hint-free.
const titles = hintless.filter(row => JSON.stringify(row.body?.messages ?? '').includes('Create a concise title'))
check(titles.length >= 1, 'a harness-generated title request happened in this run', titles.length)
for (const row of titles) check(row.headers['x-agent-hint'] === null, 'the title request carries no hint')

console.log('')
if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s):`)
  for (const failure of new Set(failures)) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('ALL CHECKS PASSED')
