import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChatCompletionsAdapter } from '../src/chat-adapter.ts'
import { resolveAdapterOptions } from '../src/config.ts'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
const event = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`
const normal = event({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] }) + 'data: [DONE]\n\n'
const options = { provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hi' }] } as GenerateOptions
const connection = () => resolveAdapterOptions({ baseURL: 'http://fixture.test', models: [{ id: 'm', name: 'Configured model', contextWindow: 4096, maxTokens: 128 }], thinking: 'disabled' })
const adapter = (extra: Record<string, unknown> = {}) => new ChatCompletionsAdapter({ options: connection, resolveAuth: async () => ({ headers: {} }), ...extra })
async function collect(a: ChatCompletionsAdapter, request = options) { const chunks: StreamChunk[] = []; for await (const c of a.stream(request)) chunks.push(c); return chunks }
function response(body = normal) { vi.stubGlobal('fetch', vi.fn(async () => new Response(body))) }
const tick = () => new Promise(resolve => setImmediate(resolve))
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('Chat request fidelity and host contracts', () => {
  it('preserves loop system/developer roles, tool ids, results and reasoning history', async () => {
    response()
    await collect(adapter(), { ...options, messages: [
      { role: 'system', content: [{ type: 'text', text: 'system rules' }] },
      { role: 'developer', content: [{ type: 'text', text: 'developer rules' }] },
      { role: 'assistant', content: [{ type: 'reasoning', text: 'previous reasoning' }, { type: 'tool-call', id: 'call-1', name: 'read', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'call-1', content: [{ type: 'text', text: 'read result' }] },
    ] as never })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)
    expect(body.messages).toEqual([
      { role: 'system', content: 'system rules' }, { role: 'developer', content: 'developer rules' },
      { role: 'assistant', content: '', reasoning_content: 'previous reasoning', tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'read', arguments: '{}' } }] },
      { role: 'tool', content: 'read result', tool_call_id: 'call-1' },
    ])
  })
  it.each(['image', 'file', 'unknown-block'])('rejects unsupported %s content before HTTP dispatch', async type => {
    response()
    await expect(collect(adapter(), { ...options, messages: [{ role: 'user', content: [{ type }] }] as never })).rejects.toMatchObject({ code: 'UNSUPPORTED_CONTENT' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('projects historical tool changes into current complete declarations, retaining developer instructions', async () => {
    response()
    await collect(adapter(), { ...options, tools: [{ name: 'new-tool', description: '', parameters: {} }], messages: [
      { role: 'developer', content: [{ type: 'tool-addition', toolName: 'new-tool' }, { type: 'text', text: 'follow this rule' }] },
      { role: 'developer', content: [{ type: 'tool-removal', toolName: 'old-tool' }] },
    ] as never })
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)
    expect(body.messages).toEqual([{ role: 'developer', content: 'follow this rule' }])
    expect(body.tools[0].function.name).toBe('new-tool')
  })
  it('returns capacity/output defaults and respects disabled thinking and retry policy', async () => {
    const a = adapter()
    const prepared = await a.prepareCall('p', 'm')
    expect(prepared.model).toMatchObject({ name: 'Configured model', context: { contextWindow: 4096 }, defaultMaxTokens: 128, inputModalities: ['text'], reasoning: { defaultEffort: 'off' } })
    expect(prepared.model.reasoning!.efforts.map(e => e.id)).toEqual(['off'])
    expect(a.providerRetryPolicy('p')).toEqual(connection().retryPolicy)
    response(); for await (const _ of prepared.stream(options)) {}
    const body = JSON.parse(vi.mocked(fetch).mock.calls[0]![1]!.body as string)
    expect(body).toMatchObject({ max_tokens: 128, reasoning_effort: 'none' })
  })
  it('pins endpoint, model metadata and credential reference across prepared-call updates', async () => {
    let current = resolveAdapterOptions({ baseURL: 'http://old.test', models: [{ id: 'm', contextWindow: 1000 }], apiKeyEnv: 'OLD_KEY' })
    const auth = vi.fn(async (c: typeof current) => ({ headers: { authorization: `Bearer fixture-${c.apiKeyEnv}` } }))
    const a = new ChatCompletionsAdapter({ options: () => current, resolveAuth: auth,
      prepareHint: async () => { current = resolveAdapterOptions({ baseURL: 'http://new.test', apiKeyEnv: 'NEW_KEY' }); return undefined } })
    const prepared = await a.prepareCall('p', 'm'); response()
    for await (const _ of prepared.stream(options)) {}
    expect(prepared.model.context!.contextWindow).toBe(1000)
    expect(vi.mocked(fetch).mock.calls[0]![0]).toBe('http://old.test/v1/chat/completions')
    expect(vi.mocked(fetch).mock.calls[0]![1]!.headers).toMatchObject({ authorization: 'Bearer fixture-OLD_KEY' })
  })
})

describe('SSE completion, errors and cancellation', () => {
  it('preserves the non-retryable control barrier code instead of wrapping it as transport failure', async () => {
    const bridge = new LifecycleBridge({ client: { send: async () => ({ status: 'unknown' }) } as never, pendingOpAwaitMs: 10 })
    bridge.noteOrdinaryRequest('s' as never, 'm')
    bridge.onSessionEvent({ id: 's' } as never, { type: 'compaction/end', data: {} } as never)
    await tick(); response()
    await expect(collect(adapter({ bridge }), { ...options, sessionId: 's' as never })).rejects.toMatchObject({ code: 'CONTROL_BARRIER' })
    expect(fetch).not.toHaveBeenCalled(); bridge.dispose()
  })
  it.each(['\n', '\r\n', '\r'])('accepts %j framing across arbitrary byte boundaries and multiline data', async newline => {
    const text = 'data: {"choices":\n' + 'data: [{"delta":{"content":"你好"},"finish_reason":"stop"}]}\n\n' + 'data: [DONE]\n\n'
    const bytes = new TextEncoder().encode(text.replaceAll('\n', newline))
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { for (const byte of bytes) c.enqueue(Uint8Array.of(byte)); c.close() } }))))
    expect(await collect(adapter())).toContainEqual({ type: 'text-delta', index: 0, text: '你好' })
  })
  it.each([
    event({ choices: [{ delta: { content: 'partial' } }] }),
    event({ choices: [{ delta: { content: 'partial' } }] }) + 'data: not-json\n\n',
    event({ choices: [{ delta: { content: 'partial' } }] }) + 'data: {"choices":',
    'data: [DONE]\n\n',
  ])('rejects incomplete/malformed streams instead of reporting success', async body => {
    response(body); await expect(collect(adapter())).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
  it('reports an in-stream backend error after partial content', async () => {
    response(event({ choices: [{ delta: { content: 'partial' } }] }) + event({ error: { type: 'overloaded_error', message: 'backend failed' } }))
    await expect(collect(adapter())).rejects.toMatchObject({ code: 'SERVER' })
  })
  it('finishes on DONE even without connection EOF and cancels the remaining body', async () => {
    let cancellations = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(normal)) }, cancel() { cancellations++ } }))))
    expect((await collect(adapter())).at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    expect(cancellations).toBe(1)
  })
  it('assembles delayed tool names and parallel fragmented arguments for the real BlockAssembler', async () => {
    response(event({ choices: [{ delta: { tool_calls: [{ index: 0 }, { index: 1, id: 'second', function: { name: 'write', arguments: '{' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'first', function: { name: 're', arguments: '{"p":' } }, { index: 1, function: { arguments: '"x":2}' } }] } }] }) +
      event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ad', arguments: '1}' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n')
    const assembler = new BlockAssembler()
    for (const chunk of await collect(adapter())) assembler.push(chunk)
    expect(assembler.blocks()).toEqual([
      { type: 'tool-call', id: 'first', name: 'read', arguments: '{"p":1}' },
      { type: 'tool-call', id: 'second', name: 'write', arguments: '{"x":2}' },
    ])
  })
  it('rejects incomplete tool arguments after provisional deltas without completing the call', async () => {
    response(event({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read', arguments: '{"p":' } }] }, finish_reason: 'tool_calls' }] }) + 'data: [DONE]\n\n')
    const chunks: StreamChunk[] = []
    try { for await (const c of adapter().stream(options)) chunks.push(c) } catch (e) { expect(e).toMatchObject({ code: 'MALFORMED_RESPONSE' }) }
    expect(chunks.some(c => c.type === 'tool-call-delta')).toBe(true)
    expect(chunks.some(c => c.type === 'block-end' || c.type === 'finish')).toBe(false)
  })
  it.each([[401, 'AUTH'], [429, 'RATE_LIMIT'], [503, 'SERVER'], [400, 'CONTEXT_WINDOW_EXCEEDED']])('classifies HTTP %s for host recovery', async (status, code) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { message: status === 400 ? 'maximum context length exceeded' : 'fixture' } }), { status: status as number, headers: { 'retry-after': '2', 'x-request-id': 'fixture-request' } })))
    await expect(collect(adapter())).rejects.toMatchObject({ code, failure: { status, providerRetryAfterMs: 2000, requestId: 'fixture-request' } })
  })
  it('cancels body on consumer iterator return', async () => {
    let cancellations = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(event({ choices: [{ delta: { content: 'part' } }] }))) }, cancel() { cancellations++ } }))))
    const iterator = adapter().stream(options)[Symbol.asyncIterator]()
    await iterator.next(); await iterator.return!()
    expect(cancellations).toBe(1)
  })
  it('times out a silent stream and a stuck credential resolver', async () => {
    const short = () => ({ ...connection(), streamIdleTimeoutMs: 15 })
    let cancellations = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ cancel() { cancellations++ } }))))
    await expect(collect(adapter({ options: short }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(cancellations).toBe(1)
    vi.mocked(fetch).mockClear()
    await expect(collect(adapter({ options: short, resolveAuth: () => new Promise(() => {}) }))).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('cancels while waiting for credentials, without dispatching after resolution', async () => {
    const abort = new AbortController(); let resolve!: (value: unknown) => void
    response()
    const pending = collect(adapter({ resolveAuth: () => new Promise(r => { resolve = r }) }), { ...options, signal: abort.signal })
    await tick(); abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'ABORTED' })
    resolve({ headers: {} }); await tick(); expect(fetch).not.toHaveBeenCalled()
  })
  it('honors plugin unload even with lifecycle controls disabled', async () => {
    const lifetime = new AbortController(); let started!: () => void
    const ready = new Promise<void>(resolve => { started = resolve })
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      started()
      return await new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
    }))
    const operation = collect(adapter({ signal: lifetime.signal }))
    await ready; lifetime.abort()
    await expect(operation).rejects.toMatchObject({ code: 'ABORTED' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})
