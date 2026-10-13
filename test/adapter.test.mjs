// SPDX-License-Identifier: Apache-2.0
// Unit tests for the hinted DeepSeek adapter: serialization, thinking
// resolution, SSE decoding, chunk translation, HTTP error mapping, and the
// header emission rules — running against the committed built JS (lib/).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import { serializeRequest, resolveThinking, parseSse, translate, HintedDeepSeekAdapter, AdapterError } from '../lib/adapter.js'
import { normalizeConfig } from '../lib/config.js'
import { buildAgentHint } from '../lib/hint.js'

const CONFIG = normalizeConfig({ baseURL: 'http://stub.local', apiKeyEnv: 'TEST_KEY' })

const OPTIONS = { agentType: 'agent', priority: { level: 3, reason: 'user_waiting' }, cacheControl: [{ type: 'pin', range: { end: 1 } }] }

function message(role, content, extra = {}) {
  return { id: `m-${Math.random()}`, role, content, source: { kind: 'plugin' }, ...extra }
}

function textBlock(text) {
  return { type: 'text', text }
}

/* ----------------------------- serialization ----------------------------- */

test('serializeRequest maps system/user/assistant/tool-result messages to the wire', () => {
  const wire = serializeRequest(
    {
      provider: 'deepseek-hint',
      model: 'deepseek-flash',
      system: 'SYS',
      messages: [
        message('system', [textBlock('loop system')]),
        message('user', [textBlock('hello')]),
        message('assistant', [
          { type: 'reasoning', text: 'thinking' },
          textBlock('calling'),
          { type: 'tool-call', id: 'call-1', name: 'probe_tool', arguments: '{"message":"START"}' },
        ]),
        message('user', [{ type: 'tool-result', toolCallId: 'call-1', content: [textBlock('tool out')] }]),
      ],
    },
    CONFIG,
  )
  assert.deepEqual(wire.messages, [
    { role: 'system', content: 'SYS' },
    { role: 'system', content: 'loop system' },
    { role: 'user', content: 'hello' },
    {
      role: 'assistant',
      content: 'calling',
      reasoning_content: 'thinking',
      tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'probe_tool', arguments: '{"message":"START"}' } }],
    },
    { role: 'tool', tool_call_id: 'call-1', content: 'tool out' },
  ])
  assert.equal(wire.stream, true)
  assert.deepEqual(wire.stream_options, { include_usage: true })
  assert.equal('agent_hints' in wire, false, 'body must never carry hint fields')
})

test('serializeRequest omits empty user messages that only carry tool results and pads empty tool output', () => {
  const wire = serializeRequest(
    {
      provider: 'p',
      model: 'm',
      messages: [
        message('user', [{ type: 'tool-result', toolCallId: 'c1', content: [] }]),
        message('user', [{ type: 'tool-result', toolCallId: 'c2', content: [textBlock('ok')] }, textBlock('after')]),
      ],
    },
    CONFIG,
  )
  assert.deepEqual(wire.messages, [
    { role: 'tool', tool_call_id: 'c1', content: '(no output)' },
    { role: 'user', content: 'after' },
    { role: 'tool', tool_call_id: 'c2', content: 'ok' },
  ])
})

test('serializeRequest rejects image content explicitly', () => {
  assert.throws(
    () => serializeRequest({ provider: 'p', model: 'm', messages: [message('user', [{ type: 'image', attachment: {} }])] }, CONFIG),
    error => error.code === 'UNSUPPORTED_CONTENT',
  )
})

test('serializeRequest maps tools, sampling, and thinking defaults', () => {
  const wire = serializeRequest(
    {
      provider: 'p',
      model: 'm',
      messages: [message('user', [textBlock('hi')])],
      tools: [{ name: 't', description: 'd', parameters: { type: 'object' } }],
      temperature: 0.5,
      stop: ['END'],
    },
    CONFIG,
  )
  assert.deepEqual(wire.tools, [{ type: 'function', function: { name: 't', description: 'd', parameters: { type: 'object' } } }])
  assert.equal(wire.temperature, 0.5)
  assert.deepEqual(wire.stop, ['END'])
  assert.deepEqual(wire.thinking, { type: 'enabled' })
  assert.equal(wire.reasoning_effort, 'high')
})

test('session-title purpose forces thinking off; off effort maps to disabled thinking', () => {
  assert.deepEqual(resolveThinking({ purpose: 'session-title' }, CONFIG), { thinking: 'disabled' })
  assert.deepEqual(resolveThinking({ reasoningEffort: 'off' }, CONFIG), { thinking: 'disabled' })
  assert.deepEqual(resolveThinking({ reasoningEffort: 'low' }, CONFIG), { thinking: 'enabled', reasoningEffort: 'low' })
})

/* --------------------------------- SSE ---------------------------------- */

function sseStream(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

test('parseSse decodes events across chunk boundaries and requires [DONE]', async () => {
  const payloads = []
  for await (const data of parseSse(sseStream(['data: {"a"', ':1}\n\ndata: second\r\n\r\n:data: comment\n\ndata: [DONE]\n\n']))) {
    payloads.push(data)
  }
  assert.deepEqual(payloads, ['{"a":1}', 'second', '[DONE]'])
  await assert.rejects(() => collect(parseSse(sseStream(['data: {"a":1}\n\n']))), error => error.code === 'STREAM_CLOSED')
})

async function collect(iterable) {
  const items = []
  for await (const item of iterable) items.push(item)
  return items
}

test('translate emits block-end/usage/finish at [DONE] and defers them from deltas', async () => {
  const chunks = await collect(translate([
    '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
    '{"choices":[{"delta":{"reasoning_content":"think"}}]}',
    '{"choices":[{"delta":{"content":"he"}}]}',
    '{"choices":[{"delta":{"content":"llo"}}]}',
    '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":4,"prompt_tokens_details":{"cached_tokens":3}}}',
    '[DONE]',
  ]))
  assert.deepEqual(chunks, [
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: 'think' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: 'he' },
    { type: 'text-delta', index: 1, text: 'llo' },
    { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'think' } },
    { type: 'block-end', index: 1, block: { type: 'text', text: 'hello' } },
    { type: 'usage', usage: { inputTokens: 7, outputTokens: 4, totalTokens: 14, cacheReadTokens: 3 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
})

test('translate accumulates tool-call deltas by index and maps finish reasons', async () => {
  const chunks = await collect(translate([
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","type":"function","function":{"name":"t","arguments":""}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"a\\""}}]}}]}',
    '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}',
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    '[DONE]',
  ]))
  const ends = chunks.filter(chunk => chunk.type === 'block-end')
  assert.deepEqual(ends[0].block, { type: 'tool-call', id: 'c1', name: 't', arguments: '{"a":1}' })
  assert.deepEqual(chunks.at(-1).reason, { kind: 'tool-calls' })
})

test('translate maps a degenerate stop with no blocks to EMPTY_RESPONSE', async () => {
  const chunks = await collect(translate(['{"choices":[{"delta":{},"finish_reason":"stop"}]}', '[DONE]']))
  assert.deepEqual(chunks.at(-1).reason, { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } })
})

/* ----------------------------- adapter stream ---------------------------- */

function makeAdapter(overrides = {}) {
  let nextCall = 0
  const servingFacts = () => ({ callIndex: ++nextCall, epoch: 0, runningSinceMs: 111 })
  const adapter = new HintedDeepSeekAdapter({
    config: CONFIG,
    hintOptions: OPTIONS,
    servingFacts,
    derivationJoin: () => undefined,
    sessionHeader: sessionId => sessionId === 'child' ? { parentSession: 'root', origin: 'subagent' } : undefined,
    resolveApiKey: async () => 'sk-test',
    ...overrides,
  })
  return { adapter, servingFacts }
}

function okResponse(events) {
  return new Response(sseStream(events.map(event => `data: ${event}\n\n`)), { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

const MAIN_OPTIONS = { provider: 'deepseek-hint', model: 'deepseek-flash', messages: [message('user', [textBlock('hi')])] }

test('stream adds the X-Agent-Hint header on main-line requests only, with a clean body', async () => {
  const originalFetch = globalThis.fetch
  const seen = []
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init })
    return okResponse([
      '{"choices":[{"delta":{"content":"ok"}}]}',
      '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":2,"completion_tokens":1}}',
      '[DONE]',
    ])
  }
  try {
    const { adapter } = makeAdapter()

    const mainChunks = await collect(adapter.stream({ ...MAIN_OPTIONS, sessionId: 's1' }))
    assert.equal(mainChunks.at(-1).type, 'finish')

    await collect(adapter.stream({ ...MAIN_OPTIONS, sessionId: 's1', purpose: 'session-title' }))
    await collect(adapter.stream(MAIN_OPTIONS))

    assert.equal(seen.length, 3)
    const [main, title, anonymous] = seen
    assert.equal(main.url, 'http://stub.local/chat/completions')
    assert.equal(typeof main.init.headers['x-agent-hint'], 'string')
    const hint = JSON.parse(Buffer.from(main.init.headers['x-agent-hint'], 'base64url').toString('utf8'))
    assert.deepEqual(hint, buildAgentHint({ sessionId: 's1', callIndex: 1, epoch: 0, runningSinceMs: 111 }, OPTIONS, hint.agent_status.state_since_ms))
    assert.equal('agent_hints' in JSON.parse(main.init.body), false)
    assert.equal('x-agent-hint' in title.init.headers, false)
    assert.equal('x-agent-hint' in anonymous.init.headers, false)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream hint picks up parent lineage and increments call_index across requests', async () => {
  const originalFetch = globalThis.fetch
  const headers = []
  globalThis.fetch = async (_url, init) => {
    headers.push(init.headers)
    return okResponse(['{"choices":[{"delta":{"content":"x"}}]}', '{"choices":[{"delta":{},"finish_reason":"stop"}]}', '[DONE]'])
  }
  try {
    const { adapter } = makeAdapter()
    await collect(adapter.stream({ ...MAIN_OPTIONS, sessionId: 'child' }))
    await collect(adapter.stream({ ...MAIN_OPTIONS, sessionId: 'child' }))
    const first = JSON.parse(Buffer.from(headers[0]['x-agent-hint'], 'base64url').toString('utf8'))
    const second = JSON.parse(Buffer.from(headers[1]['x-agent-hint'], 'base64url').toString('utf8'))
    assert.equal(first.session.call_index, 1)
    assert.equal(second.session.call_index, 2)
    assert.deepEqual(first.session.derivation, { relation: 'spawn' })
    assert.equal(first.session.parent_session_id, 'root')
    assert.equal('parent_session_id' in second.session, true)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream maps HTTP failures to stable retryable codes', async () => {
  const originalFetch = globalThis.fetch
  const cases = [
    [401, 'AUTH'],
    [429, 'RATE_LIMIT'],
    [500, 'SERVER'],
    [400, 'INVALID_REQUEST'],
  ]
  try {
    for (const [status, code] of cases) {
      globalThis.fetch = async () => new Response(JSON.stringify({ error: { message: 'nope' } }), { status })
      const { adapter } = makeAdapter()
      await assert.rejects(() => collect(adapter.stream({ ...MAIN_OPTIONS, sessionId: 's1' })), error => {
        assert.ok(error instanceof AdapterError)
        assert.equal(error.code, code)
        assert.equal(error.message, 'nope')
        return true
      })
    }
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('stream surfaces transport failures as TRANSPORT', async () => {
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('socket hang up')
  }
  try {
    const { adapter } = makeAdapter()
    await assert.rejects(() => collect(adapter.stream({ ...MAIN_OPTIONS, sessionId: 's1' })), error => error.code === 'TRANSPORT')
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('resolveModel serves catalog entries and a generic fallback', async () => {
  const { adapter } = makeAdapter()
  const known = await adapter.resolveModel('deepseek-hint', 'deepseek-flash')
  assert.equal(known.context.contextWindow, 1_000_000)
  assert.equal(known.defaultMaxTokens, 256_000)
  assert.equal(known.reasoning.defaultEffort, 'high')
  const unknown = await adapter.resolveModel('deepseek-hint', 'custom-model')
  assert.equal(unknown.context.contextWindow, CONFIG.defaultContextWindow)
  assert.equal(unknown.name, 'custom-model')
})
