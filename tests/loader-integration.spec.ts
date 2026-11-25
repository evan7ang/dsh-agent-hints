import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'

// Actual stock Loader, LLM service, credential provider and Messages transport.
// Only the model HTTP endpoint and the secret store are fixtures.
describe('stock DSH loader and HTTP integration', () => {
  const ctx = new Context()
  const requests: { path: string; body: any; authorization: string | undefined; key: string | undefined; hint: string | undefined }[] = []
  const server = createServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk
    const body = JSON.parse(text)
    requests.push({ path: req.url!, body, authorization: req.headers.authorization, key: req.headers['x-api-key'] as string | undefined, hint: typeof req.headers['x-agent-hint'] === 'string' ? req.headers['x-agent-hint'] : undefined })
    if (req.url!.endsWith('/chat/completions')) { res.end('{}'); return }
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'fixture', type: 'message', role: 'assistant', model: body.model, content: [], usage: { input_tokens: 1, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'OK' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]
    res.end(events.map(e => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''))
  })
  let baseURL: string, source: Record<string, unknown>, plugin: Record<string, unknown> = { transport: 'messages' }
  let sourcePresent = true, sourceDisabled = false
  const oldHome = process.env.DSH_HOME
  const update = async () => {
    await ctx.loader.root.update([
      { id: 'llm', name: '@deepseek-ai/dsh-llm' },
      { id: 'extensions', name: '@deepseek-ai/dsh-deepseek-llm-api-extensions' },
      ...sourcePresent ? [{ id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key', disabled: sourceDisabled, config: source }] : [],
      { id: 'hint', name: pathToFileURL(join(process.cwd(), 'lib/types/index.js')).href, config: { transport: 'messages', ...plugin } },
    ])
    await ctx.loader.await()
    await new Promise(resolve => setImmediate(resolve))
  }
  const run = async (id = 'loader-fixture') => {
    const result = []
    for await (const chunk of ctx.llm.stream({ provider: 'deepseek-hint', model: 'fixture',
      sessionId: SessionId(id), messages: [{ role: 'user', content: [{ type: 'text', text: 'local fixture' }] }],
      signal: AbortSignal.timeout(3000) })) result.push(chunk)
    expect(result.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'stop' } })
    return requests.filter(r => r.path.endsWith('/messages')).at(-1)!
  }
  beforeAll(async () => {
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    source = { baseURL, models: [{ id: 'fixture' }], apiKeyEnv: 'FIXTURE_KEY', thinking: 'disabled', maxTokens: 64 }
    process.env.DSH_HOME = await mkdtemp(join(tmpdir(), 'agenthint-regression-'))
    await ctx.plugin(SessionStore)
    ctx.provide('credentials', { resolve: async () => ({ value: 'fixture-only-secret' }) } as never)
    await ctx.plugin(Loader, { baseUrl: pathToFileURL(process.cwd() + '/').href })
    await update()
  })
  afterAll(async () => {
    await ctx.fiber.dispose()
    server.closeAllConnections()
    await new Promise<void>(resolve => server.close(() => resolve()))
    if (oldHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = oldHome
  })
  it('inherits endpoint, generation parameters and the source credential header', async () => {
    const request = await run()
    expect(request).toMatchObject({ path: '/v1/messages', key: 'fixture-only-secret', authorization: undefined,
      body: { max_tokens: 64, thinking: { type: 'disabled' } } })
    expect(request.body.agent_hint).toBeUndefined()
    const hint = JSON.parse(Buffer.from(String(request.hint), 'base64url').toString('utf8'))
    expect(hint).toMatchObject({ session: { session_id: 'loader-fixture', state: 'start' },
      priority_control: { priority: { level: 3, reason: 'user_waiting' } } })
    expect(await ctx.llm.listModels('deepseek-hint')).toMatchObject([{ id: 'fixture' }])
  })
  it('tracks source default models and subsequent volatile endpoint/catalog updates', async () => {
    delete source.models; await update()
    expect(await ctx.llm.listModels('deepseek-hint')).toEqual(
      (await ctx.llm.listModels('deepseek-official')).map(model => ({ ...model, provider: 'deepseek-hint' })))
    source = { ...source, baseURL: `${baseURL}/changed`, models: [{ id: 'new-fixture' }], maxTokens: 32 }
    await update()
    expect(await run()).toMatchObject({ path: '/changed/v1/messages', body: { max_tokens: 32 }, key: 'fixture-only-secret' })
    expect(await ctx.llm.listModels('deepseek-hint')).toMatchObject([{ id: 'new-fixture' }])
  })
  it('clears the catalog on source removal/disable and restores it on reactivation', async () => {
    sourcePresent = false; await update()
    expect(await ctx.llm.listModels('deepseek-hint')).toEqual([])
    sourcePresent = true; await update()
    expect(await ctx.llm.listModels('deepseek-hint')).toMatchObject([{ id: 'new-fixture' }])
    sourceDisabled = true; await update()
    expect(await ctx.llm.listModels('deepseek-hint')).toEqual([])
    sourceDisabled = false; await update()
    expect(await ctx.llm.listModels('deepseek-hint')).toMatchObject([{ id: 'new-fixture' }])
  })
  it('respects explicit empty catalog, generation override and credential opt-out', async () => {
    plugin = { inheritCredentials: false, maxTokens: 16, models: [] }; await update()
    expect(await ctx.llm.listModels('deepseek-hint')).toEqual([])
    expect(await run()).toMatchObject({ body: { max_tokens: 16 }, key: undefined, authorization: undefined })
  })
  it('does not inherit secrets for a different endpoint path; explicit references use Bearer', async () => {
    plugin = { baseURL, models: [{ id: 'fixture' }] }; await update()
    expect(await run()).toMatchObject({ path: '/v1/messages', key: undefined, authorization: undefined })
    plugin = { ...plugin, apiKeyEnv: 'EXPLICIT_KEY' }; await update()
    expect(await run()).toMatchObject({ key: undefined, authorization: 'Bearer fixture-only-secret' })
  })
  it('keeps per-request hints isolated across concurrent Messages requests', async () => {
    const drain = async (id: string) => {
      for await (const _chunk of ctx.llm.stream({ provider: 'deepseek-hint', model: 'fixture',
        sessionId: SessionId(id), messages: [{ role: 'user', content: [{ type: 'text', text: 'concurrent' }] }],
        signal: AbortSignal.timeout(3000) })) { /* drain */ }
    }
    await Promise.all([drain('concurrent-a'), drain('concurrent-b')])
    const hintOfSession = (id: string) => {
      const row = requests.find(request => request.path.endsWith('/messages') && request.hint !== undefined
        && JSON.parse(Buffer.from(String(request.hint), 'base64url').toString('utf8')).session.session_id === id)
      if (row === undefined) throw new Error(`missing hinted request for ${id}`)
      return JSON.parse(Buffer.from(String(row.hint), 'base64url').toString('utf8'))
    }
    expect(hintOfSession('concurrent-a').session.state).toBe('start')
    expect(hintOfSession('concurrent-b').session.state).toBe('start')
    expect(hintOfSession('concurrent-a').session.call_index).toBe(1)
    expect(hintOfSession('concurrent-b').session.call_index).toBe(1)
  })
  it('refuses to send model credentials to a different control origin', async () => {
    plugin = { agentHint: { sessionControl: { endpoint: 'http://127.0.0.1:1/control' } } }; await update()
    await run('control-source')
    const before = requests.length
    // A second ordinary request makes the accepted previous session eligible for pause.
    await run('control-other')
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(requests.slice(before).every(request => request.path.endsWith('/messages'))).toBe(true)
  })
})
