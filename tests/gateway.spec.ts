import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { SessionId } from '@deepseek-ai/dsh-session'
// Exercise the shipped decorator output, as plain Node and the host Loader do.
import { AgentHintSignals } from '../lib/types/composing-service.js'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import type { SessionControlClient } from '../src/control-client.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined })
describe('stock Gateway', () => {
  it('discovers a third-party Remote method at runtime and withdraws it on unload', async () => {
    ctx = new Context()
    const calls: string[] = []
    const client = { send: (verb: string, id: string) => { calls.push(`${verb}:${id}`); return Promise.resolve({ status: 'accepted', httpStatus: 200 }) } } as SessionControlClient
    const bridge = new LifecycleBridge({ client, pendingOpAwaitMs: 20 })
    const a = SessionId('owned-a'), b = SessionId('owned-b')
    bridge.noteOrdinaryRequest(a, 'model')
    bridge.noteOrdinaryRequest(b, 'model')
    calls.length = 0
    await ctx.plugin(TypertRegistry)
    // 0.2.2 made the Gateway depend on method-level access control, so every
    // composition that mounts it mounts RemoteAccessService too.
    await ctx.plugin(RemoteAccessService)
    await ctx.plugin(TypertGatewayService)
    const fiber = await ctx.plugin(AgentHintSignals, bridge)
    const gateway = ctx.get('typertGateway')!
    // 0.2.2 requires every in-process call to name the Peer it speaks for; this
    // composition calls in as the Host owner.
    const peer = new Peer(ctx, { principal: { kind: 'owner' } })
    const invoke = (method: string, args: Record<string, unknown>) => gateway.invoke({ namespace: 'agentHintSignals', method, args, peer })
    expect(await invoke('available', {})).toBe(true)
    expect(calls).toEqual([])
    await invoke('activated', { request: { sessionId: 'owned-a' } })
    await invoke('composing', { request: { sessionId: 'owned-a' } })
    expect(calls).toEqual(['resume:owned-a'])
    for (const request of [{ sessionId: 'unrelated' }, { sessionId: 'owned-a', draft: 'private text' }, null]) {
      for (const method of ['activated', 'composing']) {
        await invoke(method, { request })
      }
    }
    expect(calls).toEqual(['resume:owned-a'])
    bridge.onSessionArchived(a)
    const beforeArchivedActivation = calls.slice()
    await invoke('activated', { request: { sessionId: a } })
    expect(calls).toEqual(beforeArchivedActivation)
    await fiber.dispose()
    await expect(invoke('available', {})).rejects.toThrow()
    for (const method of ['activated', 'composing']) {
      await expect(invoke(method, { request: { sessionId: 'owned-a' } })).rejects.toThrow()
    }
  })
})
