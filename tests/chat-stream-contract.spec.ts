import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Llm, { BlockAssembler, isTokenDelta } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChatCompletionsAdapter } from '../src/chat-adapter.ts'

const options: GenerateOptions = { provider: 'review', model: 'fixture',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture' }] }] }
const event = (delta: unknown, finish?: string) => ({ choices: [{ delta, ...finish ? { finish_reason: finish } : {} }] })
const encode = (frame: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(frame)}\n\n`)
const tool = (index: number, id?: string, name?: string, args?: string) => ({ index, ...id === undefined ? {} : { id },
  function: { ...name === undefined ? {} : { name }, ...args === undefined ? {} : { arguments: args } } })
let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; vi.unstubAllGlobals() })
async function host() {
  ctx = new Context()
  await ctx.plugin(Llm)
  ctx.llm.registerAdapter(['review'], new ChatCompletionsAdapter({
    options: () => ({ baseURL: 'http://fixture.invalid', defaults: { thinking: 'disabled' }, models: [{ id: 'fixture' }] }),
    resolveAuth: async () => ({ headers: {} }),
  }))
  return ctx.llm
}
function respond(frames: unknown[]) {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(frames.map(f => `data: ${JSON.stringify(f)}\n\n`).join('') + 'data: [DONE]\n\n')))
}
async function collect(stream: AsyncIterable<StreamChunk>) {
  const chunks: StreamChunk[] = []; for await (const chunk of stream) chunks.push(chunk); return chunks
}
// DSH 0.2.2 removed the package-owned invariant plugin framework
// (@deepseek-ai/dsh-invariants and dsh-llm/invariant no longer exist), so the
// stream-contract checks below are exercised directly against the assembled chunks
// and BlockAssembler instead of through a plugged-in invariant companion.
describe('Chat stream contract as assembled by the stock runtime', () => {
  it.each([
    { name: 'text and usage', frames: [event({ content: 'OK' }, 'stop'), { choices: [], usage: { prompt_tokens: 3, completion_tokens: 1 } }], kind: 'stop', blocks: [{ type: 'text', text: 'OK' }] },
    { name: 'interleaved reasoning/text', frames: [event({ reasoning_content: 'think' }), event({ content: 'O' }), event({ reasoning_content: ' more', content: 'K' }, 'stop')], kind: 'stop', blocks: [{ type: 'reasoning', text: 'think more' }, { type: 'text', text: 'OK' }] },
    { name: 'parallel fragmented tool identities', frames: [event({ tool_calls: [tool(0), tool(1, 'b', 'write', '{')] }), event({ tool_calls: [tool(0, 'a', 're', '{"p":'), tool(1, undefined, undefined, '"x":2}')] }), event({ tool_calls: [tool(0, undefined, 'ad', '1}')] }, 'tool_calls')], kind: 'tool-calls', blocks: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{"p":1}' }, { type: 'tool-call', id: 'b', name: 'write', arguments: '{"x":2}' }] },
    { name: 'argumentless tool default', frames: [event({ tool_calls: [tool(0, 'a', 'read')] }, 'tool_calls')], kind: 'tool-calls', blocks: [{ type: 'tool-call', id: 'a', name: 'read', arguments: '{}' }] },
    { name: 'length truncation with provisional arguments', frames: [event({ content: 'partial', tool_calls: [tool(0, 'a', 'read', '{')] }, 'length')], kind: 'max-tokens', blocks: [{ type: 'text', text: 'partial' }] },
    { name: 'length truncation before tool identity', frames: [event({ tool_calls: [tool(0)] }, 'length')], kind: 'max-tokens', blocks: [] },
  ])('closes all blocks: $name', async ({ frames, kind, blocks }) => {
    respond(frames)
    const llm = await host(), chunks = await collect(llm.stream(options)), assembler = new BlockAssembler()
    for (const chunk of chunks) assembler.push(chunk)
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind } })
    expect(chunks.filter(c => c.type === 'block-end')).toHaveLength(chunks.filter(c => c.type === 'block-start').length)
    expect(assembler.blocks()).toEqual(blocks)
    const usageAt = chunks.findIndex(c => c.type === 'usage')
    if (usageAt !== -1) expect(chunks.slice(usageAt + 1).every(c => c.type === 'finish')).toBe(true)
  })
  it.each([
    [tool(0, 'a', 'read', '{')],
    [tool(0, 'a', undefined, '{}')],
    [tool(0, 'a', 'read', '{}'), tool(1, 'a', 'write', '{}')],
  ])('rejects invalid tools without completing any tool block: %j', async (...tools) => {
    respond([event({ tool_calls: tools }, 'tool_calls')])
    const llm = await host(), chunks = await collect(llm.stream(options))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { code: 'MALFORMED_RESPONSE' } } })
    expect(chunks.some(c => c.type === 'block-end')).toBe(false)
  })
  it('exposes the first tool token while the producer is still waiting to finish', async () => {
    let controller!: ReadableStreamDefaultController<Uint8Array>, finishSent = false
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ start(c) {
      controller = c; c.enqueue(encode(event({ tool_calls: [tool(0, 'a', 're', '{"p":')] })))
    } }))))
    const llm = await host(), iterator = llm.stream(options)[Symbol.asyncIterator]()
    try {
      expect((await iterator.next()).value).toMatchObject({ type: 'block-start', blockType: 'tool-call' })
      const first = (await iterator.next()).value!
      expect(isTokenDelta(first)).toBe(true)
      expect(first).toMatchObject({ type: 'tool-call-delta', name: 're', argumentsDelta: '{"p":' })
      expect(finishSent).toBe(false)
      controller.enqueue(encode(event({ tool_calls: [tool(0, undefined, 'ad', '1}')] }, 'tool_calls')))
      finishSent = true; controller.close()
      const rest = await collect({ [Symbol.asyncIterator]: () => iterator })
      expect(rest.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'tool-calls' } })
      expect(rest).toContainEqual({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'a', name: 'read', arguments: '{"p":1}' } })
    } finally { await iterator.return?.() }
  })
  it('keeps buffered arguments until a real tool id arrives without duplicating them', async () => {
    respond([event({ tool_calls: [tool(0, undefined, 'read', '{"p":')] }), event({ tool_calls: [tool(0, 'a', undefined, '1}')] }, 'tool_calls')])
    const llm = await host(), chunks = await collect(llm.stream(options))
    expect(chunks.filter(c => c.type === 'tool-call-delta')).toEqual([
      { type: 'tool-call-delta', index: 0, id: 'a', name: 'read', argumentsDelta: '{"p":1}' },
    ])
  })
  it('reports stream cancellation after provisional tool output without completing a tool', async () => {
    let cancelled = 0
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({ start(c) {
      c.enqueue(encode(event({ tool_calls: [tool(0, 'a', 'read', '{')] })))
    }, cancel() { cancelled++ } }))))
    const llm = await host(), abort = new AbortController(), iterator = llm.stream({ ...options, signal: abort.signal })[Symbol.asyncIterator]()
    await iterator.next(); await iterator.next(); abort.abort()
    const rest = await collect({ [Symbol.asyncIterator]: () => iterator })
    expect(rest.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'aborted' } })
    expect(rest.some(c => c.type === 'block-end')).toBe(false)
    expect(cancelled).toBe(1)
  })
})
