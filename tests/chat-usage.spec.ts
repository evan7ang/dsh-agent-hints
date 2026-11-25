/** Missing provider measurements must not become authoritative zero-token samples. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ChatCompletionsAdapter } from '../src/chat-adapter.ts'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'

afterEach(() => vi.unstubAllGlobals())
async function collect(samples: unknown[]): Promise<StreamChunk[]> {
  const frames = [{ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] },
    ...samples.map(usage => ({ choices: [], usage }))]
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') + 'data: [DONE]\n\n')))
  const adapter = new ChatCompletionsAdapter({ options: () => ({ baseURL: 'http://fixture.invalid' }),
    resolveAuth: async () => ({ headers: {} }) })
  const chunks: StreamChunk[] = []
  for await (const chunk of adapter.stream({ provider: 'p', model: 'm', messages: [{ role: 'user', content: 'hi' }] })) chunks.push(chunk)
  return chunks
}
describe('Chat provider usage integrity', () => {
  it.each([{}, { prompt_tokens: 100 }, { completion_tokens: 8 },
    { prompt_tokens: null, completion_tokens: 8 }, { prompt_tokens: 100, completion_tokens: null }, null])(
    'keeps an incomplete sample unknown: %j', async sample => {
      const chunks = await collect([sample])
      expect(chunks.some(chunk => chunk.type === 'usage')).toBe(false)
      expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    })
  it('preserves a complete sample when a later event has no complete measurement', async () => {
    const chunks = await collect([{ prompt_tokens: 100, completion_tokens: 8, total_tokens: 108 }, {}])
    expect(chunks.filter(chunk => chunk.type === 'usage')).toEqual([
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 8, totalTokens: 108 } },
    ])
  })
  it('accepts explicitly measured zero values', async () => {
    expect(await collect([{ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }])).toContainEqual(
      { type: 'usage', usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } })
  })
  it('keeps cached inputs disjoint from uncached input and reasoning within output', async () => {
    expect(await collect([{ prompt_tokens: 100, completion_tokens: 8, total_tokens: 108,
      prompt_tokens_details: { cached_tokens: 40 }, completion_tokens_details: { reasoning_tokens: 6 } }])).toContainEqual(
      { type: 'usage', usage: { inputTokens: 60, cacheReadTokens: 40, outputTokens: 8, totalTokens: 108, reasoningTokens: 6 } })
  })
  it('accepts a complete measurement without optional total/reasoning fields', async () => {
    expect(await collect([{ prompt_tokens: 100, completion_tokens: 8 }])).toContainEqual(
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 8 } })
  })
  it.each([
    { prompt_tokens: 100, completion_tokens: 8, total_tokens: 1 },
    { prompt_tokens: 100, completion_tokens: 8, completion_tokens_details: { reasoning_tokens: 9 } },
    { prompt_tokens: 100, completion_tokens: 8, prompt_tokens_details: { cached_tokens: 101 } },
    { prompt_tokens: -1, completion_tokens: 8 },
    { prompt_tokens: '100', completion_tokens: 8 },
    { prompt_tokens: 1.5, completion_tokens: 8 },
    { prompt_tokens: 100, completion_tokens_details: { reasoning_tokens: -1 } },
  ])('rejects invalid or contradictory counters: %j', async sample => {
    await expect(collect([sample])).rejects.toMatchObject({ code: 'MALFORMED_RESPONSE' })
  })
})
