import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

let ctx: Context | undefined
let server: ReturnType<typeof createServer> | undefined
afterEach(async () => {
  await ctx?.fiber.dispose(); ctx = undefined
  await new Promise<void>(resolve => server === undefined ? resolve() : server.close(() => resolve()))
  server = undefined; vi.unstubAllEnvs()
})

describe('built plugin on the stock Loader and services', () => {
  it('sends start/pause/resume/compact/stop through real transports without core events', async () => {
    vi.stubEnv('DSH_HOME', await mkdtemp(join(tmpdir(), 'dsh-agenthint-test-')))
    const requests: { path: string; key?: string; body: Record<string, any>; hint?: string }[] = []
    server = createServer(async (req, res) => {
      const chunks = []; for await (const chunk of req) chunks.push(chunk)
      const body = JSON.parse(Buffer.concat(chunks).toString())
      requests.push({ path: req.url!, key: req.headers.authorization, body, hint: typeof req.headers['x-agent-hint'] === 'string' ? req.headers['x-agent-hint'] : undefined })
      if (req.url?.endsWith('/v1/chat/completions')) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{}'); return
      }
      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      const events = [
        { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: 'fixture', content: [], usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
        { type: 'message_stop' },
      ]
      res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
    const address = server.address()!
    if (typeof address === 'string') throw new Error('Expected TCP listener')
    const baseURL = `http://127.0.0.1:${address.port}`
    ctx = new Context()
    ctx.provide('credentials', { resolve: async (ref: string) => ({ value: `fixture-${ref}` }) } as never)
    await ctx.plugin(SessionStore)
    // The external durable medium is controlled; archive logic and its Cordis
    // service receiver are the actual published WorkspaceRegistry implementation.
    let durable = { initialized: true, workspaceIds: [], archivedSessionIds: [], pinnedSessionIds: [] }
    ctx.provide('storageDomain', {
      open: async () => ({ table: () => new Map(), close: async () => {},
        global: { get: () => durable, set: async (next: typeof durable) => { durable = next } } }),
    } as never)
    ctx.provide('sessionPersistence', { list: async () => [] } as never)
    await ctx.plugin(WorkspaceRegistry)
    const originalArchive = Object.getPrototypeOf(ctx.workspaceRegistry).archiveSession
    await ctx.plugin(TypertRegistry)
    // 0.2.2 made the Gateway depend on method-level access control, so every
    // composition that mounts it mounts RemoteAccessService too.
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(TypertGatewayService)
    // 0.2.2 requires every in-process call to name the Peer it speaks for.
    const peer = new Peer(ctx, { principal: { kind: 'owner' } })
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(process.cwd() + '/').href })
    const loader = ctx.loader
    const entries = [
      { id: 'llm', name: '@deepseek-ai/dsh-llm' },
      { id: 'hint', name: pathToFileURL(join(process.cwd(), 'lib/types/index.js')).href,
        config: { baseURL, apiKeyEnv: 'A', models: [{ id: 'fixture' }], thinking: 'disabled', transport: 'messages',
          agentHint: { sessionControl: { retries: 0 } } } },
    ]
    await loader.root.update(entries)
    await loader.await()
    expect(ctx.llm.listProviders().some(p => p.id === 'deepseek-hint')).toBe(true)
    const a = ctx.sessions.create(SessionId('fixture-a'))
    const b = ctx.sessions.create(SessionId('fixture-b'))
    const run = async (id: SessionId, purpose?: 'compaction') => {
      const output = []
      for await (const chunk of ctx!.llm.stream({
        provider: 'deepseek-hint', model: 'fixture', sessionId: id,
        messages: [{ role: 'user', content: [{ type: 'text', text: 'fixture input' }] }],
        signal: AbortSignal.timeout(3000), maxTokens: 8, purpose,
      })) output.push(chunk)
      expect(output.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    }
    const hintOf = (request: { hint?: string }) => request.hint === undefined ? undefined
      : JSON.parse(Buffer.from(request.hint, 'base64url').toString('utf8'))
    const statesOf = (state: string) => requests.filter(r => hintOf(r)?.session?.state === state)
    await run(a.id)
    await run(b.id)
    await vi.waitFor(() => expect(statesOf('pause')).toHaveLength(1))
    await ctx.typertGateway.invoke({ namespace: 'agentHintSignals', method: 'composing', args: { request: { sessionId: a.id } }, peer })
    await run(a.id)
    await run(a.id, 'compaction')
    ctx.emit('session/event', a, { type: 'compaction/end', data: { compactionId: 'fixture-c', turn: 1 }, time: 1, seq: 1 } as never)
    await vi.waitFor(() => expect(statesOf('compact').length).toBeGreaterThan(0))
    await ctx.workspaceRegistry.archiveSession(a.id)
    expect(durable.archivedSessionIds).toContain(a.id)
    await vi.waitFor(() => expect(statesOf('stop').some(r => hintOf(r)?.session?.session_id === a.id)).toBe(true))
    const data = requests.filter(r => r.path === '/v1/messages')
    expect(hintOf(data[0])).toMatchObject({ session: { session_id: a.id, state: 'start' } })
    expect(hintOf(data[2])).toMatchObject({ session: { session_id: a.id, state: 'append' } })
    expect(hintOf(data[3])).toBeUndefined()
    expect(data.every(r => r.body.agent_hint === undefined)).toBe(true)
    const controls = requests.filter(r => r.path === '/v1/chat/completions')
    expect(statesOf('resume')).toHaveLength(1)
    expect(statesOf('pause')[0] && hintOf(statesOf('pause')[0])).toMatchObject({
      context_management: { manage_request: true, edits: [{ type: 'offload', target: 'session' }] } })
    expect(controls.every(r => r.body.messages.length === 0)).toBe(true)
    expect(controls.every(r => r.body.agent_hint === undefined)).toBe(true)
    // Public registry operations queued concurrently must preserve both transitions.
    await ctx.workspaceRegistry.unarchiveSession(a.id)
    await Promise.all([ctx.workspaceRegistry.archiveSession(a.id), ctx.workspaceRegistry.unarchiveSession(a.id)])
    expect(ctx.workspaceRegistry.archivedSessionIds).not.toContain(a.id)
    const resumesBefore = statesOf('resume').length
    await ctx.typertGateway.invoke({ namespace: 'agentHintSignals', method: 'composing', args: { request: { sessionId: a.id } }, peer })
    await vi.waitFor(() => expect(statesOf('resume').length).toBe(resumesBefore + 1))
    // Volatile connection changes must keep endpoint and credential together.
    const updated = entries.map(entry => entry.id === 'hint'
      ? { ...entry, config: { ...entry.config, baseURL: `${baseURL}/changed`, apiKeyEnv: 'B' } }
      : entry)
    await loader.root.update(updated); await loader.await()
    await run(a.id)
    ctx.emit('session/event', a, { type: 'compaction/end', data: { compactionId: 'fixture-d', turn: 2 }, time: 2, seq: 2 } as never)
    await vi.waitFor(() => expect(requests.some(r => r.path === '/changed/v1/chat/completions'
      && r.key === 'Bearer fixture-B' && hintOf(r)?.session?.state === 'compact')).toBe(true))
    expect(requests.some(r => !r.path.startsWith('/changed/') && r.key === 'Bearer fixture-B')).toBe(false)
    loader.remove('hint'); await loader.await()
    await vi.waitFor(() => expect(ctx!.get('agentHintSignals')).toBeUndefined())
    expect(Object.hasOwn(ctx.workspaceRegistry, 'archiveSession')).toBe(false)
    expect(Object.getPrototypeOf(ctx.workspaceRegistry).archiveSession).toBe(originalArchive)
    expect(ctx.llm.listProviders().some(p => p.id === 'deepseek-agent-hint')).toBe(false)
  }, 15000)
})
