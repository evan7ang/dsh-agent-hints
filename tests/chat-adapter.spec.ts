import { afterEach, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { once } from 'node:events'
import type { AddressInfo } from 'node:net'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { ChatCompletionsAdapter } from '../src/chat-adapter.ts'
import type { AgentHint } from '../src/hint.ts'

const servers: Server[] = []

afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})

/** Serve one scripted SSE body and capture the request it answered. */
async function serve(frames: readonly unknown[]): Promise<{ baseURL: string; received: () => Record<string, unknown>;
  receivedHeaders: () => Record<string, string | string[] | undefined> }> {
  let body: Record<string, unknown> = {}
  let headers: Record<string, string | string[] | undefined> = {}
  const server = createServer((request, response) => {
    headers = request.headers
    const chunks: Buffer[] = []
    request.on('data', chunk => chunks.push(chunk as Buffer))
    request.on('end', () => {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const frame of frames) response.write(`data: ${JSON.stringify(frame)}\n\n`)
      response.end('data: [DONE]\n\n')
    })
  })
  servers.push(server)
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const { port } = server.address() as AddressInfo
  return { baseURL: `http://127.0.0.1:${port}`, received: () => body, receivedHeaders: () => headers }
}

/** Collect one adapter call into a flat chunk list. */
async function collect(adapter: ChatCompletionsAdapter, options: GenerateOptions): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of adapter.stream(options)) out.push(chunk)
  return out
}

const BASE_OPTIONS: GenerateOptions = {
  provider: 'deepseek-agent-hint',
  model: 'fixture',
  messages: [{ role: 'user', content: 'hi' }],
}

function adapterFor(baseURL: string, prepareHint?: () => AgentHint | undefined) {
  return new ChatCompletionsAdapter({
    options: () => ({ baseURL, maxTokens: 32 }),
    resolveAuth: () => Promise.resolve({ headers: {} }),
    ...prepareHint === undefined ? {} : { prepareHint },
  })
}

describe('ChatCompletionsAdapter', () => {
  it('translates reasoning, text and finish into harness chunks', async () => {
    const { baseURL } = await serve([
      { choices: [{ delta: { reasoning_content: 'think' } }] },
      { choices: [{ delta: { content: 'hello' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
    ])
    const chunks = await collect(adapterFor(baseURL), BASE_OPTIONS)
    expect(chunks[0]).toEqual({ type: 'block-start', index: 0, blockType: 'reasoning' })
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'think' })
    expect(chunks).toContainEqual({ type: 'block-start', index: 1, blockType: 'text' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'hello' })
    expect(chunks).toContainEqual({ type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('accepts the bare reasoning field name some coordinators emit', async () => {
    const { baseURL } = await serve([
      { choices: [{ delta: { reasoning: 'think' } }] },
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const chunks = await collect(adapterFor(baseURL), BASE_OPTIONS)
    expect(chunks).toContainEqual({ type: 'reasoning-delta', index: 0, text: 'think' })
    expect(chunks).toContainEqual({ type: 'text-delta', index: 1, text: 'ok' })
  })

  it('maps length to max-tokens and tool_calls to tool-calls', async () => {
    const { baseURL } = await serve([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read', arguments: '{"p":1}' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
    ])
    const chunks = await collect(adapterFor(baseURL), BASE_OPTIONS)
    expect(chunks).toContainEqual({ type: 'block-start', index: 0, blockType: 'tool-call' })
    expect(chunks).toContainEqual({ type: 'tool-call-delta', index: 0, id: 'call_1', name: 'read', argumentsDelta: '{"p":1}' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('sends the hint as a header and maps system, tools and limits', async () => {
    const { baseURL, received, receivedHeaders } = await serve([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const adapter = adapterFor(baseURL, () => ({
      session: { session_id: 's-1', call_index: 1, epoch: 0, state: 'append' },
      priority_control: { priority: { level: 3, reason: 'user_waiting' } },
    }))
    await collect(adapter, {
      ...BASE_OPTIONS,
      system: 'be brief',
      maxTokens: 8,
      temperature: 0.2,
      stop: ['END'],
      tools: [{ name: 'read', description: 'read a file', parameters: { type: 'object' } }],
    })
    const body = received()
    expect(body['agent_hint']).toBeUndefined()
    const raw = receivedHeaders()['x-agent-hint']
    expect(typeof raw).toBe('string')
    expect(JSON.parse(Buffer.from(String(raw), 'base64url').toString('utf8'))).toEqual({
      session: { session_id: 's-1', call_index: 1, epoch: 0, state: 'append' },
      priority_control: { priority: { level: 3, reason: 'user_waiting' } },
    })
    expect(body['max_tokens']).toBe(8)
    expect(body['temperature']).toBe(0.2)
    expect(body['stop']).toEqual(['END'])
    expect((body['messages'] as { role: string }[])[0]).toEqual({ role: 'system', content: 'be brief' })
    expect((body['tools'] as { function: { name: string } }[])[0]?.function.name).toBe('read')
  })

  it('declares reasoning efforts and maps the selected one onto the wire', async () => {
    const { baseURL, received } = await serve([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    const adapter = adapterFor(baseURL)
    const resolved = await adapter.resolveModel('deepseek-agent-hint', 'fixture')
    expect(resolved.reasoning?.efforts.map(e => String(e.id))).toEqual(['off', 'low', 'high', 'max'])
    await collect(adapter, { ...BASE_OPTIONS, reasoningEffort: 'off' as never })
    expect(received()['reasoning_effort']).toBe('none')
  })

  it('always sends a content field, even for a tool-call-only assistant turn', async () => {
    const { baseURL, received } = await serve([
      { choices: [{ delta: { content: 'ok' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ])
    await collect(adapterFor(baseURL), {
      ...BASE_OPTIONS,
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant',
          content: [{
            type: 'tool-call',
            id: 'call_1' as never,
            name: 'read',
            arguments: '{}',
          }] as never,
        },
      ],
    })
    const messages = received()['messages'] as Record<string, unknown>[]
    expect(messages).toHaveLength(2)
    for (const message of messages) {
      expect(message).toHaveProperty('role')
      expect(message).toHaveProperty('content')
    }
    expect(messages[1]?.['tool_calls']).toBeDefined()
  })

  it('fails with EMPTY_RESPONSE when the endpoint returns no content', async () => {
    const { baseURL } = await serve([{ choices: [{ delta: {}, finish_reason: 'stop' }] }])
    await expect(collect(adapterFor(baseURL), BASE_OPTIONS)).rejects.toMatchObject({ code: 'EMPTY_RESPONSE' })
  })
})
