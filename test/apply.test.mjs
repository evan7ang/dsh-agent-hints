// SPDX-License-Identifier: Apache-2.0
// Unit tests for the plugin wiring (index.apply): the firehose-derived
// derivation.join, log-derived serving facts, and the status channel
// activation — running against the committed built JS (lib/).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'

function fakeContext({ sessions, credentials } = {}) {
  const adapters = []
  const listeners = []
  const ctx = {
    llm: {
      registerAdapter(providers, adapter) {
        assert.deepEqual(providers, ['deepseek-hint'])
        adapters.push(adapter)
      },
    },
    get(name) {
      if (name === 'sessions') return sessions
      if (name === 'credentials') return credentials
      return undefined
    },
    on(event, listener) {
      listeners.push([event, listener])
    },
    effect() {},
    logger: { info() {}, warn() {} },
  }
  return { ctx, adapters, listeners }
}

function sseResponse(events) {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${event}\n\n`))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

const EVENTS = [
  '{"choices":[{"delta":{"content":"ok"}}]}',
  '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
  '[DONE]',
]

test('apply derives serving facts from the session log and join from the delegating call', async () => {
  const log = [
    { type: 'step/start', time: 1 },
    { type: 'tool/call', time: 2, data: { name: 'synthesized_process', callId: 'c1' } },
    { type: 'tool/result', time: 3, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } },
    { type: 'step/start', time: 4 },
  ]
  const sessions = {
    get(id) {
      return id === 's1' ? { id, header: {}, ownEvents: () => log } : undefined
    },
  }
  const { ctx, adapters, listeners } = fakeContext({ sessions, credentials: { resolve: async () => ({ value: 'sk-test' }) } })
  apply(ctx, { baseURL: 'http://stub.local', apiKeyEnv: 'K' })
  assert.equal(adapters.length, 1)

  const eventListeners = Object.fromEntries(listeners.map(([event, listener]) => [event, listener]))
  // Parent delegation call: foreground wait → sync.
  eventListeners['session/event'](
    { id: 'parent', header: {}, ownEvents: () => [] },
    { type: 'tool/call', time: 9, data: { name: 'subagent', callId: 'd1', arguments: '{"prompt":"go"}' } },
  )

  const main = await collect(adapters[0].stream({ provider: 'deepseek-hint', model: 'm', messages: [], sessionId: 's1' }))
  const hint = JSON.parse(Buffer.from(main.headerCapture, 'base64url').toString('utf8'))
  assert.equal(hint.session.call_index, 2, 'derived from two step/start events')
  assert.equal(hint.agent_status.state_since_ms, 3, 'latest tool/result time from the log')

  // A child of the delegating parent carries derivation.join.
  sessions.get = id => id === 'child'
    ? { id, header: { parentSession: 'parent', origin: 'subagent' }, ownEvents: () => [] }
    : undefined
  const child = await collect(adapters[0].stream({ provider: 'deepseek-hint', model: 'm', messages: [], sessionId: 'child' }))
  const childHint = JSON.parse(Buffer.from(child.headerCapture, 'base64url').toString('utf8'))
  assert.deepEqual(childHint.session.derivation, { relation: 'spawn', join: 'sync' })
})

async function collect(streamChunks) {
  let headerCapture
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (_url, init) => {
    headerCapture = init.headers['x-agent-hint']
    return sseResponse(EVENTS)
  }
  try {
    const chunks = []
    for await (const chunk of streamChunks) chunks.push(chunk)
    return { chunks, headerCapture }
  } finally {
    globalThis.fetch = originalFetch
  }
}

test('apply without a session store falls back to a per-process ordinal', async () => {
  const { ctx, adapters } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-test' }) } })
  apply(ctx, { baseURL: 'http://stub.local', apiKeyEnv: 'K' })
  const options = { provider: 'deepseek-hint', model: 'm', messages: [], sessionId: 's1' }
  const first = JSON.parse(Buffer.from((await collect(adapters[0].stream(options))).headerCapture, 'base64url').toString('utf8'))
  const second = JSON.parse(Buffer.from((await collect(adapters[0].stream(options))).headerCapture, 'base64url').toString('utf8'))
  assert.equal(first.session.call_index, 1)
  assert.equal(second.session.call_index, 2)
})

test('status sink activates only when configured and records the session lifecycle', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hints-apply-'))
  const sink = join(dir, 'status.jsonl')
  try {
    const { ctx, listeners } = fakeContext()
    apply(ctx, { baseURL: 'http://stub.local', apiKeyEnv: 'K' })
    assert.equal(listeners.filter(([event]) => event === 'session/event').length, 1, 'join tracking only')

    const { ctx: ctx2, listeners: listeners2 } = fakeContext()
    apply(ctx2, { baseURL: 'http://stub.local', apiKeyEnv: 'K', statusSink: sink })
    const eventListeners = listeners2.filter(([event]) => event === 'session/event').map(([, listener]) => listener)
    assert.equal(eventListeners.length, 2, 'join tracking + status observer')
    const observer = eventListeners[1]
    const s = { id: 's1', header: {}, ownEvents: () => [] }
    observer(s, { type: 'tool/call', time: 1, data: { name: 't', callId: 'c1' } })
    observer(s, { type: 'turn/end', time: 2, data: { reason: { kind: 'completed' } } })
    const lines = readFileSync(sink, 'utf8').trim().split('\n').map(JSON.parse)
    assert.deepEqual(lines.map(line => line.agent_status.state), ['tool', 'finalize'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
