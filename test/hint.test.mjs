// SPDX-License-Identifier: Apache-2.0
// Unit tests for the hint builder, the X-Agent-Hint header encoding, and the
// durable serving-fact derivation, running against the committed built JS (lib/).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildAgentHint, encodeAgentHintHeader, deriveServingFacts } from '../lib/hint.js'

const OPTIONS = { agentType: 'agent', priority: { level: 3, reason: 'user_waiting' }, cacheControl: [{ type: 'pin', range: { end: 1 } }] }

test('buildAgentHint maps session identity, status, and configured intent', () => {
  const hint = buildAgentHint(
    { sessionId: 'session-9', callIndex: 2, epoch: 1, runningSinceMs: 1000, parentSession: 'session-root', parentOrigin: 'subagent' },
    OPTIONS,
    5000,
  )
  assert.deepEqual(hint, {
    session: {
      session_id: 'session-9',
      parent_session_id: 'session-root',
      derivation: { relation: 'spawn' },
      agent_type: 'agent',
      call_index: 2,
      epoch: 1,
    },
    agent_status: { state: 'running', state_since_ms: 1000 },
    priority: { level: 3, reason: 'user_waiting' },
    cache_control: [{ type: 'pin', range: { end: 1 } }],
  })
  assert.equal('strict_priority' in hint, false)
  assert.equal('prediction' in hint, false)
})

test('buildAgentHint derives fork for an inherited parent and omits lineage for roots', () => {
  const forked = buildAgentHint({ sessionId: 's', callIndex: 1, epoch: 0, parentSession: 'root' }, OPTIONS, 0)
  assert.equal(forked.session.derivation.relation, 'fork')
  const root = buildAgentHint({ sessionId: 's', callIndex: 1, epoch: 0 }, OPTIONS, 7)
  assert.equal('parent_session_id' in root.session, false)
  assert.equal('derivation' in root.session, false)
  assert.equal(root.agent_status.state_since_ms, 7)
})

test('buildAgentHint carries derivation.join from the delegating tool call', () => {
  const sync = buildAgentHint({ sessionId: 'c', callIndex: 1, epoch: 0, parentSession: 'root', parentOrigin: 'subagent', derivationJoin: 'sync' }, OPTIONS, 0)
  assert.deepEqual(sync.session.derivation, { relation: 'spawn', join: 'sync' })
  const async = buildAgentHint({ sessionId: 'c', callIndex: 1, epoch: 0, parentSession: 'root', parentOrigin: 'subagent', derivationJoin: 'async' }, OPTIONS, 0)
  assert.deepEqual(async.session.derivation, { relation: 'spawn', join: 'async' })
  const unjoined = buildAgentHint({ sessionId: 'c', callIndex: 1, epoch: 0, parentSession: 'root' }, OPTIONS, 0)
  assert.deepEqual(unjoined.session.derivation, { relation: 'fork' })
})

test('deriveServingFacts counts step/start, compaction/end, and the latest tool/result', () => {
  const events = [
    { type: 'request/header', time: 1 },
    { type: 'step/start', time: 2 },
    { type: 'tool/call', time: 3 },
    { type: 'tool/result', time: 4 },
    { type: 'step/start', time: 5 },
    { type: 'compaction/end', time: 6 },
    { type: 'step/start', time: 7 },
    { type: 'tool/result', time: 8 },
  ]
  const facts = deriveServingFacts({ ownEvents: () => events })
  assert.deepEqual(facts, { callIndex: 3, epoch: 1, runningSinceMs: 8 })
})

test('deriveServingFacts returns zeroed facts for an empty log', () => {
  assert.deepEqual(deriveServingFacts({ ownEvents: () => [] }), { callIndex: 0, epoch: 0, runningSinceMs: undefined })
})

test('encodeAgentHintHeader produces base64url of the UTF-8 JSON', () => {
  const hint = buildAgentHint({ sessionId: 's-1', callIndex: 1, epoch: 0 }, OPTIONS, 42)
  const encoded = encodeAgentHintHeader(hint)
  assert.equal(encoded, Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url'))
  assert.equal(/[-_]/.test(encoded) || /^[A-Za-z0-9]+$/.test(encoded), true, 'base64url alphabet')
  assert.equal(encoded.includes('+'), false)
  assert.equal(encoded.includes('/'), false)
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  assert.deepEqual(decoded, hint)
})
