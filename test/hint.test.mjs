// SPDX-License-Identifier: MulanPSL-2.0
// Unit tests for the hint builder, the X-Agent-Hint header encoding, and the
// durable serving-fact derivation (four-value lifecycle, turn opening,
// interval, compaction), running against the committed built JS (lib/).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { buildAgentHint, encodeAgentHintHeader, deriveServingFacts } from '../lib/hint.js'

const OPTIONS = { agentType: 'agent' }

const call = (time, callId, name = 't') => ({ type: 'tool/call', time, data: { callId, name } })
const result = (time, callId) => ({
  type: 'tool/result',
  time,
  data: { message: { content: [{ type: 'tool-result', toolCallId: callId }] } },
})
const factsOf = events => deriveServingFacts({ ownEvents: () => events })

test('buildAgentHint maps session identity, status, priority, and cache intent', () => {
  const hint = buildAgentHint(
    {
      sessionId: 'session-9',
      callIndex: 2,
      epoch: 1,
      state: 'resume',
      stateSinceMs: 1000,
      parentSession: 'session-root',
      parentOrigin: 'subagent',
      priority: { level: 1, reason: 'critical_path' },
      cacheControl: [{ type: 'ephemeral', ttl_s: 600, range: { end: 3, unit: 'message' } }],
    },
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
    agent_status: { state: 'resume', state_since_ms: 1000 },
    priority: { level: 1, reason: 'critical_path' },
    cache_control: [{ type: 'ephemeral', ttl_s: 600, range: { end: 3, unit: 'message' } }],
  })
  assert.equal('strict_priority' in hint, false)
  assert.equal('prediction' in hint, false)
})

test('buildAgentHint falls back to the request time for an unobserved running entry', () => {
  const hint = buildAgentHint({ sessionId: 's', callIndex: 1, epoch: 0, state: 'running' }, OPTIONS, 7)
  assert.equal(hint.agent_status.state, 'running')
  assert.equal(hint.agent_status.state_since_ms, 7)
  assert.equal('priority' in hint, false)
  assert.equal('cache_control' in hint, false)
})

test('buildAgentHint derives fork for an inherited parent and omits lineage for roots', () => {
  const forked = buildAgentHint({ sessionId: 's', callIndex: 1, epoch: 0, state: 'running', parentSession: 'root' }, OPTIONS, 0)
  assert.equal(forked.session.derivation.relation, 'fork')
  const root = buildAgentHint({ sessionId: 's', callIndex: 1, epoch: 0, state: 'running' }, OPTIONS, 0)
  assert.equal('parent_session_id' in root.session, false)
  assert.equal('derivation' in root.session, false)
})

test('buildAgentHint carries derivation.join from the delegating tool call', () => {
  const base = { sessionId: 'c', callIndex: 1, epoch: 0, state: 'running', parentSession: 'root', parentOrigin: 'subagent' }
  const sync = buildAgentHint({ ...base, derivationJoin: 'sync' }, OPTIONS, 0)
  assert.deepEqual(sync.session.derivation, { relation: 'spawn', join: 'sync' })
  const async = buildAgentHint({ ...base, derivationJoin: 'async' }, OPTIONS, 0)
  assert.deepEqual(async.session.derivation, { relation: 'spawn', join: 'async' })
  const unjoined = buildAgentHint({ sessionId: 'c', callIndex: 1, epoch: 0, state: 'running', parentSession: 'root' }, OPTIONS, 0)
  assert.deepEqual(unjoined.session.derivation, { relation: 'fork' })
})

test('deriveServingFacts counts step/start and compaction/end and returns the empty-log shape', () => {
  const facts = factsOf([
    { type: 'request/header', time: 1 },
    { type: 'step/start', time: 2 },
    { type: 'compaction/end', time: 3 },
    { type: 'step/start', time: 4 },
  ])
  assert.equal(facts.callIndex, 2)
  assert.equal(facts.epoch, 1)
  assert.equal(facts.state, 'running')
  assert.deepEqual(factsOf([]), {
    callIndex: 0,
    epoch: 0,
    state: 'running',
    stateSinceMs: undefined,
    turnOpening: false,
    intervalMs: undefined,
    afterCompaction: false,
  })
})

test('an unanswered tool call is pause, pinned to the first pending call', () => {
  const facts = factsOf([
    { type: 'turn/start', time: 0 },
    { type: 'step/start', time: 1 },
    { type: 'step/end', time: 2 },
    call(3, 'c1'),
    call(4, 'c2'),
  ])
  assert.equal(facts.state, 'pause')
  assert.equal(facts.stateSinceMs, 3, 'the pause episode began at the first pending call')
})

test('the first request after the pending set empties is a one-shot resume; the next is running', () => {
  const upToResume = [
    { type: 'turn/start', time: 0 },
    { type: 'step/start', time: 1 },
    { type: 'step/end', time: 2 },
    call(3, 'c1'),
    result(5, 'c1'),
    { type: 'step/start', time: 6 },
  ]
  const resume = factsOf(upToResume)
  assert.equal(resume.state, 'resume')
  assert.equal(resume.stateSinceMs, 5)

  const continuation = factsOf([...upToResume, { type: 'step/end', time: 7 }, { type: 'step/start', time: 8 }])
  assert.equal(continuation.state, 'running')
  assert.equal(continuation.stateSinceMs, 5, 'running since the release')
})

test('a turn boundary closes the resume window', () => {
  const facts = factsOf([
    { type: 'turn/start', time: 0 },
    { type: 'step/start', time: 1 },
    { type: 'step/end', time: 2 },
    call(3, 'c1'),
    result(5, 'c1'),
    { type: 'step/start', time: 6 },
    { type: 'step/end', time: 7 },
    { type: 'turn/end', time: 8, data: { reason: { kind: 'completed' } } },
    { type: 'turn/start', time: 9 },
    { type: 'step/start', time: 10 },
  ])
  assert.equal(facts.state, 'running')
  assert.equal(facts.stateSinceMs, 9, 'the new turn opened after the release')
})

test('parallel tools stay paused until the last result settles', () => {
  const paused = factsOf([
    { type: 'turn/start', time: 0 },
    { type: 'step/start', time: 1 },
    call(3, 'c1'),
    call(4, 'c2'),
    result(5, 'c1'),
  ])
  assert.equal(paused.state, 'pause')
  assert.equal(paused.stateSinceMs, 3)

  const released = factsOf([
    { type: 'turn/start', time: 0 },
    { type: 'step/start', time: 1 },
    call(3, 'c1'),
    call(4, 'c2'),
    result(5, 'c1'),
    result(6, 'c2'),
  ])
  assert.equal(released.state, 'running')
  assert.equal(released.stateSinceMs, 6)
})

test('turnOpening marks the first call of a turn and falls back to call_index 1', () => {
  const turn = [
    { type: 'turn/start', time: 0 },
    { type: 'step/start', time: 1 },
  ]
  assert.equal(factsOf(turn).turnOpening, true)
  assert.equal(factsOf([...turn, { type: 'step/end', time: 2 }, { type: 'step/start', time: 3 }]).turnOpening, false)
  const secondTurn = factsOf([...turn, { type: 'step/end', time: 2 }, { type: 'turn/end', time: 3 }, { type: 'turn/start', time: 4 }, { type: 'step/start', time: 5 }])
  assert.equal(secondTurn.turnOpening, true)

  assert.equal(factsOf([{ type: 'step/start', time: 1 }]).turnOpening, true, 'no turn events: the first call counts')
  assert.equal(factsOf([{ type: 'step/start', time: 1 }, { type: 'step/start', time: 2 }]).turnOpening, false)
})

test('intervalMs is the previous response end to this request start', () => {
  const facts = factsOf([
    { type: 'step/start', time: 1000 },
    { type: 'step/end', time: 3000 },
    { type: 'step/start', time: 5000 },
  ])
  assert.equal(facts.intervalMs, 2000)
  assert.equal(factsOf([{ type: 'step/start', time: 1 }]).intervalMs, undefined)
})

test('afterCompaction flags a rewrite since the previous response end', () => {
  assert.equal(factsOf([
    { type: 'step/start', time: 1 },
    { type: 'step/end', time: 2 },
    { type: 'compaction/end', time: 3 },
    { type: 'step/start', time: 4 },
  ]).afterCompaction, true, 'between-step rewrite')
  assert.equal(factsOf([
    { type: 'step/start', time: 1 },
    { type: 'step/end', time: 2 },
    { type: 'step/start', time: 4 },
    { type: 'compaction/end', time: 5 },
  ]).afterCompaction, true, 'mid-step rewrite (overflow recovery retry)')
  assert.equal(factsOf([
    { type: 'step/start', time: 1 },
    { type: 'step/end', time: 2 },
    { type: 'compaction/end', time: 3 },
    { type: 'step/start', time: 4 },
    { type: 'step/end', time: 5 },
    { type: 'step/start', time: 6 },
  ]).afterCompaction, false, 'the rewrite suppresses only the following round')
})

test('encodeAgentHintHeader produces base64url of the UTF-8 JSON', () => {
  const hint = buildAgentHint({ sessionId: 's-1', callIndex: 1, epoch: 0, state: 'running' }, OPTIONS, 42)
  const encoded = encodeAgentHintHeader(hint)
  assert.equal(encoded, Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url'))
  assert.equal(/[-_]/.test(encoded) || /^[A-Za-z0-9]+$/.test(encoded), true, 'base64url alphabet')
  assert.equal(encoded.includes('+'), false)
  assert.equal(encoded.includes('/'), false)
  const decoded = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))
  assert.deepEqual(decoded, hint)
})
