// SPDX-License-Identifier: MulanPSL-2.0
// Unit tests for the plugin wiring (index.apply): the firehose-derived
// derivation.join, log-derived serving facts, and the status channel
// activation — running against the committed built JS (lib/).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../lib/index.js'
import { normalizeConfig } from '../lib/config.js'

function fakeContext({ sessions, credentials } = {}) {
  const adapters = []
  const listeners = []
  const infos = []
  const warns = []
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
    logger: {
      info(message) { infos.push(message) },
      warn(message) { warns.push(message) },
    },
  }
  return { ctx, adapters, listeners, infos, warns }
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
    { type: 'tool/call', time: 2, data: { name: 'probe_tool', callId: 'c1' } },
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
  let lastUrl
  let authorization
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    headerCapture = init.headers['x-agent-hint']
    lastUrl = String(url)
    authorization = init.headers.authorization
    return sseResponse(EVENTS)
  }
  try {
    const chunks = []
    for await (const chunk of streamChunks) chunks.push(chunk)
    return { chunks, headerCapture, lastUrl, authorization }
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

test('unconfigured apply inherits the host endpoint and activates', async () => {
  const originalBaseURL = process.env.DEEPSEEK_BASE_URL
  process.env.DEEPSEEK_BASE_URL = 'http://motor.local:18201/v1'
  try {
    const { ctx, adapters, listeners, infos } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk' }) } })
    apply(ctx)
    assert.equal(adapters.length, 1, 'zero-config: adapter registers with inherited facts')
    assert.match(infos[0], /inheriting the DSH host endpoint/)
    assert.equal(listeners.filter(([event]) => event === 'session/event').length, 1)
    const run = await collect(adapters[0].stream({ provider: 'deepseek-hint', model: 'm', messages: [], sessionId: 's1' }))
    assert.equal(run.lastUrl, 'http://motor.local:18201/v1/chat/completions', 'inherited baseURL')
    assert.equal(run.authorization, 'Bearer sk', 'credential service resolves the inherited ref')
  } finally {
    if (originalBaseURL === undefined) delete process.env.DEEPSEEK_BASE_URL
    else process.env.DEEPSEEK_BASE_URL = originalBaseURL
  }
})

test('config normalization: absent fields inherit the host chain, provided-invalid throws', () => {
  const originalBaseURL = process.env.DEEPSEEK_BASE_URL
  process.env.DEEPSEEK_BASE_URL = 'http://motor.local:18201/v1'
  try {
    const inherited = normalizeConfig(undefined)
    assert.equal(inherited.baseURL, 'http://motor.local:18201/v1', 'inherits $DEEPSEEK_BASE_URL')
    assert.equal(inherited.apiKeyEnv, 'DEEPSEEK_API_KEY', 'credential ref inherits the official default')
    assert.throws(() => normalizeConfig({ baseURL: 'not-a-url' }), /baseURL/)
    assert.throws(() => normalizeConfig({ baseURL: 'http://gw.local/v1', apiKeyEnv: '' }), /apiKeyEnv/)
  } finally {
    if (originalBaseURL === undefined) delete process.env.DEEPSEEK_BASE_URL
    else process.env.DEEPSEEK_BASE_URL = originalBaseURL
  }
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

test('prediction block: static source emits on main-line requests; absent source keeps the prior wire shape', async () => {
  const { ctx, adapters } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-test' }) } })
  apply(ctx, { baseURL: 'http://stub.local', apiKeyEnv: 'K', predictionStatic: { latency_ms: 4000, remaining_calls: 3 } })
  const options = { provider: 'deepseek-hint', model: 'm', messages: [], sessionId: 's1' }
  const withPrediction = JSON.parse(Buffer.from((await collect(adapters[0].stream(options))).headerCapture, 'base64url').toString('utf8'))
  assert.deepEqual(withPrediction.prediction, { latency_ms: 4000, remaining_calls: 3 }, 'scalars only: next_action has no static semantics')

  const { ctx: ctx2, adapters: adapters2 } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk-test' }) } })
  apply(ctx2, { baseURL: 'http://stub.local', apiKeyEnv: 'K' })
  const without = JSON.parse(Buffer.from((await collect(adapters2[0].stream(options))).headerCapture, 'base64url').toString('utf8'))
  assert.equal('prediction' in without, false, 'no prediction sources configured → block omitted')
})

test('statusAuto derives the HTTP endpoint from baseURL origin; explicit override wins; default off', async () => {
  const originalFetch = globalThis.fetch
  try {
    // Derivation strips any baseURL path (/v1) and appends the conventional path.
    const derivedUrls = []
    const { ctx, listeners } = fakeContext({ credentials: { resolve: async () => ({ value: 'sk' }) } })
    apply(ctx, { baseURL: 'http://motor.local:18201/v1', apiKeyEnv: 'K', statusAuto: true })
    const eventListeners = listeners.filter(([event]) => event === 'session/event').map(([, listener]) => listener)
    eventListeners[1](
      { id: 's1', header: {}, ownEvents: () => [] },
      { type: 'tool/call', time: 1, data: { name: 't', callId: 'c1' } },
    )
    globalThis.fetch = async url => {
      derivedUrls.push(String(url))
      return new Response('{"ok":true}', { status: 200 })
    }
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(derivedUrls, ['http://motor.local:18201/agent-status'])

    // Explicit statusEndpoint overrides the derivation.
    const overrideUrls = []
    const { ctx: ctx2, listeners: listeners2 } = fakeContext()
    apply(ctx2, { baseURL: 'http://motor.local:18201/v1', apiKeyEnv: 'K', statusAuto: true, statusEndpoint: 'http://other.local/status' })
    listeners2.filter(([event]) => event === 'session/event').map(([, listener]) => listener)[1](
      { id: 's1', header: {}, ownEvents: () => [] },
      { type: 'tool/call', time: 1, data: { name: 't', callId: 'c1' } },
    )
    globalThis.fetch = async url => {
      overrideUrls.push(String(url))
      return new Response('{"ok":true}', { status: 200 })
    }
    await new Promise(resolve => setTimeout(resolve, 10))
    assert.deepEqual(overrideUrls, ['http://other.local/status'])

    // Default off: no status observer beyond join tracking.
    const { ctx: ctx3, listeners: listeners3 } = fakeContext()
    apply(ctx3, { baseURL: 'http://motor.local:18201/v1', apiKeyEnv: 'K' })
    assert.equal(listeners3.filter(([event]) => event === 'session/event').length, 1, 'join tracking only')
  } finally {
    globalThis.fetch = originalFetch
  }
})
