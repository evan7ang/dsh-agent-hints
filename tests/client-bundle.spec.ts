import { describe, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { Context } from '@deepseek-ai/cordis'
import * as React from 'react'
import { create, act } from 'react-test-renderer'
import { Peer } from '@deepseek-ai/dsh-client-connection'
import { TypertRegistry } from '@deepseek-ai/dsh-typert-registry'
import { TypertGatewayService } from '@deepseek-ai/dsh-api-gateway'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import { AgentHintSignals } from '../lib/types/composing-service.js'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import { composerDom } from './helpers/composer-dom.ts'

type Reply = { ok: boolean; value?: unknown }
async function fixture(answer: () => Reply | Promise<Reply> = () => ({ ok: true, value: true }),
  forward?: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<Reply>) {
  let registration: { id: string; factory: (require: (id: string) => unknown) => { apply: (ctx: Context) => void; inject: string[] } } | undefined
  runInNewContext(await readFile('lib/client.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (value: typeof registration) => { registration = value } } }, AbortController, AbortSignal,
  })
  expect(registration?.id).toBe('dsh-agent-hints')
  const face = registration!.factory(id => { if (id !== 'react') throw new Error(`Unexpected browser external: ${id}`); return React })
  const ctx = new Context(), calls: unknown[][] = [], listeners = new Set<() => void>()
  let generation: { id: number } | undefined
  ctx.provide('connection', {
    generation: { getSnapshot: () => generation, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn) } },
    rpc: { call: async (...args: unknown[]) => { calls.push(args); return forward !== undefined
      ? await forward(args[1] as string, args[2], args[3] as AbortSignal)
      : args[1] === 'agentHintSignals/available' ? await answer() : { ok: true } } },
  } as never)
  let renderer: { factory: (require: NodeJS.Require) => { SlotRegistry: typeof import('@deepseek-ai/dsh-client-ui-renderer/client').SlotRegistry } } | undefined
  runInNewContext(await readFile('node_modules/@deepseek-ai/dsh-client-ui-renderer/lib/client.js', 'utf8'), {
    window: { __ModuleLoader__: { load: (value: typeof renderer) => { renderer = value } } }, queueMicrotask, setTimeout, clearTimeout,
  })
  await ctx.plugin(renderer!.factory(createRequire(import.meta.url)).SlotRegistry)
  ctx.slots.register({ name: 'root', children: { 'conversation.input.overlay': { kind: 'list', scope: 'session' } } } as never, () => null)
  const fiber = await ctx.plugin(face)
  // Composer assertions stay scoped to composer traffic: the browser face now
  // contributes only the composer observer.
  return { ctx, get calls() { return calls.filter(call => String(call[1]).startsWith('agentHintSignals/')) },
    allCalls: calls, fiber, listeners, entries: () => ctx.slots.entries('conversation.input.overlay'),
    publish: (id?: number) => { generation = id === undefined ? undefined : { id }; for (const fn of [...listeners]) fn() } }
}
const tick = () => new Promise(resolve => setImmediate(resolve))

describe('shipped browser factory on stock connection services', () => {
  it('probes the host without an invented remote namespace and sends only session identity', async () => {
    const f = await fixture(); let tree: ReturnType<typeof create> | undefined
    try {
      expect(f.entries()).toHaveLength(0); expect(f.calls).toHaveLength(0)
      expect(f.ctx.get('remote.agentHintSignals')).toBeUndefined()
      f.publish(1)
      await vi.waitFor(() => expect(f.entries()).toHaveLength(1))
      expect(f.calls[0].slice(0, 3)).toEqual(['/api', 'agentHintSignals/available', { args: {} }])
      expect(f.allCalls.filter(call => String(call[1]).startsWith('agentHintTrace/'))).toHaveLength(0)
      const entry = f.entries()[0], component = entry.component as React.ComponentType<any>
      let draft = ''; const dom = composerDom()
      const props = { sessionId: 'private-session', useInput: (select: (s: { draft: string }) => unknown) => select({ draft }), ...entry.inject!() }
      act(() => { tree = create(React.createElement(component, props), { createNodeMock: () => dom.marker }) })
      expect(f.calls).toHaveLength(1)
      draft = 'private draft text'; act(() => tree!.update(React.createElement(component, props)))
      dom.editor.textContent = draft; act(() => dom.fire())
      expect(f.calls).toHaveLength(2)
      expect(f.calls[1].slice(0, 3)).toEqual(['/api', 'agentHintSignals/composing', { args: { request: { sessionId: 'private-session' } } }])
      draft += ' continues'; act(() => tree!.update(React.createElement(component, props)))
      dom.editor.textContent = draft; act(() => dom.fire())
      expect(f.calls).toHaveLength(2)
      act(() => tree!.update(React.createElement(component, { ...props, sessionId: 'revisit-session' })))
      expect(f.calls).toHaveLength(2)
      draft = draft.replace('private', 'changed'); act(() => tree!.update(React.createElement(component, { ...props, sessionId: 'revisit-session' })))
      dom.editor.textContent = draft; act(() => dom.fire())
      expect(f.calls).toHaveLength(3)
      expect(f.calls[2].slice(0, 3)).toEqual(['/api', 'agentHintSignals/composing', { args: { request: { sessionId: 'revisit-session' } } }])
      expect(JSON.stringify(f.calls)).not.toContain('draft text')
      await f.fiber.dispose(); expect(f.entries()).toHaveLength(0); expect(f.listeners.size).toBe(0)
      draft = ''; act(() => tree!.update(React.createElement(component, props)))
      draft = 'after unload'; act(() => tree!.update(React.createElement(component, props)))
      dom.editor.textContent = draft; act(() => dom.fire())
      expect(f.calls).toHaveLength(3)
    } finally { act(() => tree?.unmount()); await f.ctx.fiber.dispose() }
  })
  it.each([{ ok: false }, { ok: true, value: false }, { ok: true }])('leaves controls unavailable without mounting an observer: %j', async reply => {
    const f = await fixture(() => reply)
    try { f.publish(1); await tick(); expect(f.entries()).toHaveLength(0); expect(f.calls).toHaveLength(1) }
    finally { await f.ctx.fiber.dispose() }
  })
  it('contains capability transport failures and remains usable', async () => {
    const f = await fixture(() => Promise.reject(new Error('offline')))
    try { f.publish(1); await tick(); expect(f.entries()).toHaveLength(0) }
    finally { await f.ctx.fiber.dispose() }
  })
  it('withdraws on disconnect and ignores stale probes across reconnects', async () => {
    let release!: (reply: Reply) => void
    let attempt = 0
    const f = await fixture(() => ++attempt === 1 ? new Promise(resolve => { release = resolve }) : { ok: true, value: true })
    try {
      f.publish(1); await tick(); const oldSignal = f.calls[0][3] as AbortSignal
      f.publish(); expect(oldSignal.aborted).toBe(true)
      f.publish(2); await vi.waitFor(() => expect(f.entries()).toHaveLength(1))
      release({ ok: true, value: true }); await tick(); expect(f.entries()).toHaveLength(1)
      f.publish(); expect(f.entries()).toHaveLength(0)
      f.publish(3); await vi.waitFor(() => expect(f.entries()).toHaveLength(1))
    } finally { await f.ctx.fiber.dispose() }
  })
  it('aborts a pending probe on unload and cannot resurrect its slot later', async () => {
    let release!: (reply: Reply) => void
    const f = await fixture(() => new Promise(resolve => { release = resolve }))
    try {
      f.publish(1); await tick(); const signal = f.calls[0][3] as AbortSignal
      await f.fiber.dispose(); expect(signal.aborted).toBe(true); expect(f.listeners.size).toBe(0)
      release({ ok: true, value: true }); await tick(); expect(f.entries()).toHaveLength(0)
    } finally { await f.ctx.fiber.dispose() }
  })
  it('passes the shipped browser payload through the stock Gateway carrier boundary', async () => {
    const host = new Context(), controls: string[] = []
    const bridge = new LifecycleBridge({ pendingOpAwaitMs: 50, client: { send: async (verb: string) => {
      controls.push(verb); return { status: 'accepted', httpStatus: 200 }
    } } as never })
    let dispatch!: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<Reply>
    let f: Awaited<ReturnType<typeof fixture>> | undefined
    try {
      // 0.2.2 admits every call through a Peer (the former single OperatorPeer is gone)
      // and intercepts the shared channel by an endpoint-ownership test.
      const peer = new Peer(host, { principal: { kind: 'owner' } })
      host.provide('connection', { rpc: { intercept: (_channel: string, _matches: (endpoint: string) => boolean,
        handler: (endpoint: string, payload: unknown, signal: AbortSignal, peer: unknown) => Promise<Reply>) => {
        dispatch = (endpoint, payload, signal) => handler(endpoint, payload, signal, peer); return async () => {}
      } } } as never)
      await host.plugin(TypertRegistry)
      // The Gateway now depends on method-level access control.
      await host.plugin(RemoteAccessService); await host.plugin(TypertGatewayService)
      await host.plugin(AgentHintSignals, bridge)
      bridge.noteOrdinaryRequest('wire-a' as never, 'm'); bridge.noteOrdinaryRequest('wire-b' as never, 'm')
      await bridge.awaitPendingOp('wire-a' as never); controls.length = 0
      // invoke() alone would bypass this exact Remote request-envelope validation.
      expect(await dispatch('agentHintSignals/available', {}, AbortSignal.timeout(1000))).toMatchObject({ ok: false })
      f = await fixture(undefined, (endpoint, payload, signal) => dispatch(endpoint, JSON.parse(JSON.stringify(payload)), signal)); f.publish(1)
      await vi.waitFor(() => expect(f!.entries()).toHaveLength(1))
      f.entries()[0].inject!().notify('wire-a')
      await vi.waitFor(() => expect(controls).toEqual(['resume']))
    } finally { await f?.ctx.fiber.dispose(); bridge.dispose(); await host.fiber.dispose() }
  })
})