// SPDX-License-Identifier: MulanPSL-2.0
// Unit tests for the out-of-band status channel: the pending-call state
// machine (tool → running on the last parallel result), subagent naming and
// child binding, finalize on session disposal, and the JSONL sink — running
// against the committed built JS (lib/).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { StatusObserver, appendStatusEvent, HttpStatusSink } from '../lib/status.js'

function session(id, header = {}) {
  return { id, header }
}

function harness(subagentToolNames = ['subagent']) {
  const events = []
  const observer = new StatusObserver(event => events.push(event), new Set(subagentToolNames))
  return { observer, events }
}

test('tool/call reports tool state; running only after the LAST parallel result', () => {
  const { observer, events } = harness()
  const s = session('s1')

  observer.onEvent(s, { type: 'tool/call', time: 10, data: { name: 'probe_tool', callId: 'c1' } })
  observer.onEvent(s, { type: 'tool/call', time: 11, data: { name: 'inspect_files', callId: 'c2' } })
  assert.deepEqual(events[0].agent_status, {
    state: 'tool', state_since_ms: 10, reason: 'await_tool',
    tools: [{ name: 'probe_tool', call_id: 'c1' }],
  })
  assert.equal(events.at(-1).agent_status.tools.length, 2)

  observer.onEvent(s, { type: 'tool/result', time: 12, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } })
  assert.equal(events.length, 2, 'running waits for the last result')
  observer.onEvent(s, { type: 'tool/result', time: 13, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2' }] } } })
  assert.deepEqual(events.at(-1).agent_status, { state: 'running', state_since_ms: 13 })
})

test('delegation calls are named agent:<tool> and bind child_session_id on first child sighting', () => {
  const { observer, events } = harness()
  const parent = session('parent')
  observer.onEvent(parent, { type: 'tool/call', time: 10, data: { name: 'subagent', callId: 'd1' } })
  assert.equal(events.at(-1).agent_status.tools[0].name, 'agent:subagent')

  observer.onEvent(session('child', { parentSession: 'parent', origin: 'subagent' }), { type: 'request/header', time: 11 })
  assert.equal(events.at(-1).agent_status.tools[0].child_session_id, 'child')
  assert.equal(events.at(-1).session.session_id, 'parent')

  // A second child sighting must not re-bind.
  const before = events.length
  observer.onEvent(session('child', { parentSession: 'parent', origin: 'subagent' }), { type: 'tool/result', time: 12, data: { message: { content: [] } } })
  assert.equal(events.length, before, 'bound entries are not re-reported')
})

test('turn completion reports finalize and clears pending state', () => {
  const { observer, events } = harness()
  const s = session('s1')
  observer.onEvent(s, { type: 'tool/call', time: 10, data: { name: 't', callId: 'c1' } })
  observer.onEvent(s, { type: 'turn/end', time: 11, data: { reason: { kind: 'completed' } } })
  assert.equal(events.at(-1).agent_status.state, 'finalize')
  // Completed sessions must not leak later reports.
  observer.onEvent(s, { type: 'tool/result', time: 12, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } })
  assert.equal(events.length, 2)
})

test('non-completed turn ends do not report finalize', () => {
  const { observer, events } = harness()
  const s = session('s1')
  observer.onEvent(s, { type: 'turn/end', time: 10, data: { reason: { kind: 'aborted', reason: 'user' } } })
  observer.onEvent(s, { type: 'turn/end', time: 11, data: { reason: { kind: 'blocked' } } })
  assert.equal(events.length, 0)
})

test('appendStatusEvent writes protocol-shaped JSONL lines in order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hints-status-'))
  const sink = join(dir, 'status.jsonl')
  const warns = []
  appendStatusEvent(sink, { session: { session_id: 's1' }, agent_status: { state: 'tool', state_since_ms: 1, reason: 'await_tool', tools: [{ name: 't', call_id: 'c1' }] } }, w => warns.push(w))
  appendStatusEvent(sink, { session: { session_id: 's1' }, agent_status: { state: 'finalize', state_since_ms: 2 } }, w => warns.push(w))
  const lines = readFileSync(sink, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(lines.length, 2)
  assert.equal(lines[0].agent_status.state, 'tool')
  assert.equal(lines[1].agent_status.state, 'finalize')
  assert.equal('agent_hints' in lines[0], false)
  rmSync(dir, { recursive: true, force: true })
})

const EVENT_A = { session: { session_id: 's1' }, agent_status: { state: 'tool', state_since_ms: 1 } }
const EVENT_B = { session: { session_id: 's1' }, agent_status: { state: 'running', state_since_ms: 2 } }
const EVENT_C = { session: { session_id: 's1' }, agent_status: { state: 'finalize', state_since_ms: 3 } }

test('HttpStatusSink posts events in emission order', async () => {
  const originalFetch = globalThis.fetch
  const received = []
  globalThis.fetch = async (_url, init) => {
    received.push(JSON.parse(init.body))
    return new Response('{"ok":true}', { status: 200 })
  }
  try {
    const sink = new HttpStatusSink('http://motor.local/agent-status')
    sink.send(EVENT_A)
    sink.send(EVENT_B)
    sink.send(EVENT_C)
    await sink.drain()
    assert.deepEqual(received, [EVENT_A, EVENT_B, EVENT_C])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('HttpStatusSink retries a failing delivery then succeeds, preserving order', async () => {
  const originalFetch = globalThis.fetch
  let attempts = 0
  const received = []
  globalThis.fetch = async (_url, init) => {
    attempts += 1
    if (attempts <= 2) return new Response('boom', { status: 503 })
    received.push(JSON.parse(init.body))
    return new Response('{"ok":true}', { status: 200 })
  }
  try {
    const sink = new HttpStatusSink('http://motor.local/agent-status')
    sink.send(EVENT_A)
    sink.send(EVENT_B)
    await sink.drain()
    assert.equal(attempts, 4, 'EVENT_A retries twice then succeeds (3 calls), EVENT_B succeeds on the first (1 call)')
    assert.deepEqual(received, [EVENT_A, EVENT_B])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('HttpStatusSink warns and drops after retries are exhausted, then keeps flowing', async () => {
  const originalFetch = globalThis.fetch
  const warns = []
  const delivered = []
  let calls = 0
  globalThis.fetch = async (_url, init) => {
    calls += 1
    if (calls <= 4) return new Response('down', { status: 503 })
    delivered.push(JSON.parse(init.body))
    return new Response('{"ok":true}', { status: 200 })
  }
  try {
    const sink = new HttpStatusSink('http://motor.local/agent-status', w => warns.push(w))
    sink.send(EVENT_A)
    sink.send(EVENT_B)
    sink.send(EVENT_C)
    await sink.drain()
    assert.equal(warns.length, 1, 'first event exhausts retries and warns once')
    assert.deepEqual(delivered, [EVENT_B, EVENT_C], 'later events keep flowing after a drop')
  } finally {
    globalThis.fetch = originalFetch
  }
})
