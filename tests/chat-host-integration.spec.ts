import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Llm, { createUserMessage } from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import BasicCompaction from '@deepseek-ai/dsh-compaction-basic'
import type { AgentHandle } from '@deepseek-ai/dsh-agent'

// The actual AgentLoop executes a tool and replays the result through the default
// Chat route. Only model HTTP and credential storage are controlled fixtures.
describe('default Chat on the stock DSH host', () => {
  const ctx = new Context(), requests: { path: string; key?: string; body: any; hint?: string }[] = []
  let toolExecutions = 0, baseURL: string, source: Record<string, unknown>
  let handle: AgentHandle
  const compactions: any[] = []
  const hintOf = (request: { hint?: string }) => request.hint === undefined ? undefined
    : JSON.parse(Buffer.from(request.hint, 'base64url').toString('utf8'))
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    requests.push({ path: req.url!, key: req.headers['x-api-key'] as string | undefined, body, hint: typeof req.headers['x-agent-hint'] === 'string' ? req.headers['x-agent-hint'] : undefined })
    if (!body.stream) { res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const toolLoop = body.messages.some((m: any) => m.role === 'user' && m.content === 'run fixture tool')
    const hasToolResult = body.messages.some((m: any) => m.role === 'tool' && m.tool_call_id === 'host-call' && m.content.includes('fixture tool result'))
    if (toolLoop && !hasToolResult) {
      res.end('data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"host-call","function":{"name":"fixture_read","arguments":"{}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n')
    } else res.end('data: {"choices":[{"delta":{"content":"fixture complete"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
  })
  const update = async () => {
    await ctx.loader.root.update([
      { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', config: source },
      { id: 'hint', name: pathToFileURL(join(process.cwd(), 'lib/types/index.js')).href },
    ])
    await ctx.loader.await(); await new Promise(r => setImmediate(r))
  }
  const run = async (id: string, purpose?: 'session-title') => {
    const chunks = []
    for await (const chunk of ctx.llm.stream({ provider: 'deepseek-hint', model: 'selected-model', sessionId: SessionId(id), purpose,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture request' }] }], signal: AbortSignal.timeout(3000) })) chunks.push(chunk)
    expect(chunks.at(-1), JSON.stringify(chunks.at(-1))).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
  }
  beforeAll(async () => {
    vi.stubEnv('DSH_HOME', await mkdtemp(join(tmpdir(), 'agenthint-host-')))
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    source = { baseURL: `${baseURL}/v1`, models: [{ id: 'first-model' }, { id: 'selected-model', contextWindow: 32768, maxTokens: 128 }], thinking: 'disabled', apiKeyEnv: 'SOURCE_KEY' }
    // 0.2.2 announces Session projections before Agents can activate (the Agents
    // plugin injects sessionProjections), so the registry must mount first.
    await ctx.plugin(SessionStore); await ctx.plugin(Llm); await ctx.plugin(Projections)
    await ctx.plugin(Agents); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
    // 0.2.2 splits tool dispatch out of the registry: a composition must mount an executor.
    await ctx.plugin(NativeToolExecutor)
    ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-source-key' }) } as never)
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(process.cwd() + '/').href }); await update()
    ctx.systemPrompt.section({ name: 'fixture', order: 0, text: 'Use fixture tools and preserve these system instructions.' })
    ctx.tools.register(defineTool({ name: 'fixture_read', description: 'Read fixture', parameters: {},
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      execute: async () => { toolExecutions++; return 'fixture tool result' } }))
    await ctx.plugin(AgentLoop, { agents: [] })
    await ctx.plugin(TokenMeter)
    ctx.on('session/event', (_session, event) => { if (event.type === 'compaction/end') compactions.push(event.data) }, { global: true })
    await ctx.plugin(BasicCompaction, { auto: true, thresholdRatio: 0.1, headroomTokens: 64, retainTokens: 64, maxTokens: 128 })
  })
  afterAll(async () => { await ctx.fiber.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); vi.unstubAllEnvs() })

  it('runs a real two-step AgentLoop tool task with system instructions and associated results', async () => {
    handle = await ctx.agents.create({ sessionId: SessionId('host-agent'), agentOptions: { provider: 'deepseek-hint', model: 'selected-model' } })
    handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run fixture tool' }], source: { kind: 'user' } }))
    await handle.agent.whenIdle()
    const calls = requests.filter(r => r.body.stream && hintOf(r)?.session?.session_id === 'host-agent')
    expect(toolExecutions).toBe(1); expect(calls).toHaveLength(2)
    expect(calls[0].body.messages[0]).toMatchObject({ role: 'system', content: expect.stringContaining('preserve these system instructions') })
    expect(calls[0]).toMatchObject({ path: '/v1/chat/completions', key: 'fixture-source-key', body: { model: 'selected-model', max_tokens: 128, reasoning_effort: 'none' } })
    expect(calls[0].body.agent_hint).toBeUndefined()
    expect(hintOf(calls[0])).toMatchObject({ session: { session_id: 'host-agent', call_index: 1, epoch: 0, state: 'start' } })
    expect(calls[1].body.messages).toContainEqual({ role: 'tool', tool_call_id: 'host-call', content: 'fixture tool result' })
    expect(hintOf(calls[1])).toMatchObject({ session: { session_id: 'host-agent', call_index: 2, epoch: 0, state: 'append' } })
    expect(await ctx.llm.resolveModelInfo('deepseek-hint', 'selected-model')).toMatchObject({ context: { contextWindow: 32768 }, defaultMaxTokens: 128 })
  }, 10000)
  it('feeds the real pressure-compaction consumer and emits compact after a committed summary', async () => {
    const before = requests.length
    // Several balanced turns provide a compactable prefix; a single giant
    // newest node must correctly stay in the retained tail rather than split.
    for (let i = 0; i < 6; i++) {
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: `turn ${i}: ` + 'context data '.repeat(300) }], source: { kind: 'user' } }))
      await handle.agent.whenIdle()
    }
    expect(compactions.some(c => c.error === undefined), JSON.stringify(compactions)).toBe(true)
    expect(requests.slice(before).some(r => r.body.stream && r.hint === undefined)).toBe(true)
    await vi.waitFor(() => expect(requests.some(r => hintOf(r)?.session?.state === 'compact')).toBe(true))
  }, 10000)
  it('does not let a background title change state; ordinary control uses the selected model and normalized URL', async () => {
    ctx.sessions.create(SessionId('background-b'))
    const before = requests.length
    await run('background-b', 'session-title')
    await new Promise(r => setTimeout(r, 10))
    expect(requests.slice(before)).toHaveLength(1)
    expect(requests.at(-1)!.hint).toBeUndefined()
    await run('background-b')
    await vi.waitFor(() => expect(requests.some(r => hintOf(r)?.session?.session_id === 'host-agent'
      && hintOf(r)?.session?.state === 'pause')).toBe(true))
    const ordinary = requests.find(r => r.body.stream && hintOf(r)?.session?.session_id === 'background-b')!
    expect(hintOf(ordinary)?.session?.state).toBe('start')
    const pause = requests.find(r => hintOf(r)?.session?.state === 'pause')!
    expect(hintOf(pause)).toMatchObject({ context_management: { manage_request: true, edits: [{ type: 'offload', target: 'session' }] } })
    expect(pause).toMatchObject({ path: '/v1/chat/completions', body: { model: 'selected-model' } })
  })
  it('refreshes source endpoint, catalog and generation settings through the real Loader', async () => {
    source = { ...source, baseURL: `${baseURL}/changed`, models: [{ id: 'changed-model', contextWindow: 65536 }], maxTokens: 64 }
    await update(); await run('background-b')
    expect(requests.filter(r => r.body.stream).at(-1)).toMatchObject({ path: '/changed/v1/chat/completions', body: { max_tokens: 64, reasoning_effort: 'none' } })
    expect(await ctx.llm.listModels('deepseek-hint')).toMatchObject([{ id: 'changed-model' }])
  })
})
