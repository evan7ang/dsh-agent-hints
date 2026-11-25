#!/usr/bin/env node
/**
 * Phase C assertions: context pressure forces a compaction and a step retry.
 *
 * Expected (from e2e/run.sh, script `HINT_E2E_OVERFLOW`):
 *
 *   call 1  start   epoch 0  priority 3/user_waiting  cache declared
 *   call 2  append  epoch 0  priority 1/critical_path cache declared   (probe continuation)
 *   aux     compaction summary request (hint-free, x-deepseek-harness-compact: 1)
 *   —       compact manage request: evict, epoch of the rewritten context (0)
 *   call 2  append  epoch 1  priority 1/critical_path cache suppressed (the retried step)
 *   call 3  append  epoch 1  priority 1/critical_path cache declared   (rewrite aged out)
 *
 * Usage: node verify-compaction.cjs <captures.jsonl> [trace-file...]
 */
const fs = require('node:fs')

const [, , capturesPath] = process.argv
if (!capturesPath) {
  console.error('usage: verify-compaction.cjs <captures.jsonl>')
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
const isTitle = row => JSON.stringify(row.body?.messages ?? '').includes('concise title')

for (const row of captures) {
  check(row.body?.agent_hint === undefined && row.body?.session_control === undefined,
    'the request body carries no hint field', `${row.method} ${row.path}`)
}

// 1. One session; ordinary timeline shows the epoch bump on the retried step.
const sessions = new Set(captures.filter(row => hintOf(row) !== undefined).map(row => hintOf(row).session.session_id))
check(sessions.size === 1, 'the compaction run uses one session', [...sessions].join(','))
const ordinaryRows = captures.filter(row => row.body?.stream === true
  && (row.body?.messages ?? []).length > 0 && hintOf(row) !== undefined && !isTitle(row))
const ordinary = ordinaryRows.map(hintOf)
check(ordinary.length === 4, 'the run produces four ordinary requests (probe, overflow, retry, final)', ordinary.length)
check(ordinary.map(hint => hint.session.state).join(',') === 'start,append,append,append',
  'the fresh session opens once with start', ordinary.map(hint => hint.session.state).join(','))
check(ordinary.map(hint => hint.session.call_index).join(',') === '1,2,2,3',
  'the retried step keeps its call index', ordinary.map(hint => hint.session.call_index).join(','))
check(ordinary.map(hint => hint.session.epoch).join(',') === '0,0,1,1',
  'epoch bumps exactly once after compaction', ordinary.map(hint => hint.session.epoch).join(','))
check(ordinary.map(hint => `${hint.priority_control?.priority.level}/${hint.priority_control?.priority.reason}`).join(',')
  === '3/user_waiting,1/critical_path,1/critical_path,1/critical_path',
'the turn opens at priority 3 and continuations stay at priority 1',
ordinary.map(hint => `${hint.priority_control?.priority.level}/${hint.priority_control?.priority.reason}`).join(','))

// 2. Cache: declared, suppressed on the rewrite round, declared again.
const cacheFlags = ordinary.map(hint => hint.cache_control !== undefined)
check(cacheFlags.join(',') === 'true,true,false,true',
  'cache is suppressed only for the post-compaction round', cacheFlags.join(','))
for (const [index, hint] of ordinary.entries()) {
  if (hint.cache_control === undefined) continue
  check(hint.cache_control.msg_offset === (ordinaryRows[index].body?.messages ?? []).length,
    `request ${index + 1}: msg_offset equals the wire message count`, hint.cache_control.msg_offset)
  check(hint.cache_control.ttl_s >= 60 && hint.cache_control.ttl_s <= 3600,
    `request ${index + 1}: ttl is clamped`, hint.cache_control.ttl_s)
}
check(ordinary[0]?.cache_control?.ttl_s === 600, 'the first call uses the no-sample TTL')

// 3. The compaction summary is an auxiliary, hint-free request.
const auxiliary = captures.filter(row => hintOf(row) === undefined && row.body?.stream === true)
const summary = auxiliary.filter(row => row.headers['x-deepseek-harness-compact'] === '1')
check(auxiliary.length >= 2, 'the run has auxiliary requests (title and compaction summary)', auxiliary.length)
check(summary.length >= 1, 'the compaction summary carries the harness compact marker', summary.length)
for (const row of auxiliary) check(row.headers['x-agent-hint'] === null, 'auxiliary requests stay hint-free')

// 4. The compact manage request carries the old epoch and evict edit.
const manage = captures.filter(row => hintOf(row) !== undefined && row.body?.stream !== true)
const compactRow = manage.find(row => hintOf(row).session.state === 'compact')
check(compactRow !== undefined, 'a compact manage request is sent')
if (compactRow !== undefined) {
  const hint = hintOf(compactRow)
  check(hint.session.epoch === 0, 'compact carries the rewritten (old) epoch', hint.session.epoch)
  check(hint.session.call_index === 2, 'compact carries the step being rewritten', hint.session.call_index)
  check(hint.context_management?.manage_request === true && hint.context_management?.edits?.length === 1
    && hint.context_management.edits[0].type === 'evict' && hint.context_management.edits[0].target === 'session',
  'compact asks for evict on the session', JSON.stringify(hint.context_management?.edits))
  check(Array.isArray(compactRow.body?.messages) && compactRow.body.messages.length === 0,
    'the compact manage request carries a placeholder body')
}

// 5. Ordering: summary → compact → retried step.
const summaryIndex = captures.indexOf(summary[0] ?? {})
const compactIndex = captures.indexOf(compactRow ?? {})
const retryIndex = captures.indexOf(ordinaryRows[2] ?? {})
check(summaryIndex >= 0 && compactIndex > summaryIndex,
  'compact is sent after the summary request', `${summaryIndex} < ${compactIndex}`)
check(compactIndex >= 0 && retryIndex > compactIndex,
  'the retried step follows the compact request', `${compactIndex} < ${retryIndex}`)

console.log('')
if (failures.length > 0) {
  console.error(`FAILED ${failures.length} check(s):`)
  for (const failure of new Set(failures)) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('COMPACTION CHECKS PASSED')
