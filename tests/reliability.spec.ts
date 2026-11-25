import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ControlBarrierError, LifecycleBridge } from '../src/lifecycle-bridge.ts'
import { SessionControlClient } from '../src/control-client.ts'
import type { ControlResult } from '../src/control-client.ts'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import { AgentHintAdapter } from '../src/adapter.ts'

const sid = SessionId('reliability-session')
const session = (seeded = false) => ({ id: sid, header: {}, surface: { nodes: seeded ? [0] : [] } }) as unknown as Session
const compact = { type: 'compaction/end', data: {} } as SessionEvent
const accepted: ControlResult = { status: 'accepted', httpStatus: 200 }
const tick = () => new Promise(resolve => setImmediate(resolve))
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}
function client(overrides: Partial<ConstructorParameters<typeof SessionControlClient>[0]> = {}) {
  return new SessionControlClient({ endpoint: 'http://fixture.invalid/control', model: 'm',
    resolveApiKey: async () => undefined, timeoutMs: 1000, retries: 3, ...overrides })
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })

describe('control cancellation and outcome classification', () => {
  it('cancels credential resolution without sending a request later', async () => {
    const key = deferred<string | undefined>(), abort = new AbortController(), fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    const operation = client({ resolveApiKey: () => key.promise }).send('stop', 's', 'm', abort.signal)
    abort.abort()
    expect(await operation).toEqual({ status: 'cancelled', dispatched: false })
    key.resolve('late-secret'); await tick()
    expect(fetch).not.toHaveBeenCalled()
  })
  it('bounds a stalled connection resolver', async () => {
    vi.stubGlobal('fetch', vi.fn())
    expect(await client({ timeoutMs: 10, resolveApiKey: () => new Promise(() => {}) }).send('stop', 's'))
      .toEqual({ status: 'failed', retryable: false })
    expect(fetch).not.toHaveBeenCalled()
  })
  it('cancels a resume retry during backoff', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 503 })), abort = new AbortController()
    vi.stubGlobal('fetch', fetch)
    const operation = client().send('resume', 's', 'm', abort.signal)
    await tick(); abort.abort()
    expect(await operation).toEqual({ status: 'cancelled', dispatched: false })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('reports cancellation after dispatch and aborts the active fetch', async () => {
    const abort = new AbortController(), started = deferred<void>()
    vi.stubGlobal('fetch', vi.fn((_url, init) => new Promise((_resolve, reject) => {
      started.resolve(); init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
    })))
    const operation = client().send('compact', 's', 'm', abort.signal)
    await started.promise; abort.abort()
    expect(await operation).toEqual({ status: 'cancelled', dispatched: true })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each(['pause', 'compact', 'stop'] as const)('never retries ambiguous %s HTTP failures', async verb => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })))
    expect(await client().send(verb, 's')).toEqual({ status: 'unknown' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not retry authentication rejection', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 401 })))
    expect(await client().send('resume', 's')).toEqual({ status: 'failed', retryable: false, httpStatus: 401 })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('treats an interrupted success body as unknown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream({
      start(controller) { controller.error(new Error('body disconnected')) },
    }))))
    expect(await client().send('compact', 's')).toEqual({ status: 'unknown' })
    expect(fetch).toHaveBeenCalledTimes(1)
  })
})

describe('session mutation exclusion', () => {
  it('waits for controls appended while the barrier is already waiting', async () => {
    const first = deferred<ControlResult>(), second = deferred<ControlResult>()
    const send = vi.fn().mockImplementationOnce(() => first.promise).mockImplementationOnce(() => second.promise)
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 1000 })
    bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionEvent(session(), compact)
    let finished = false
    const barrier = bridge.awaitPendingOp(sid).then(() => { finished = true })
    bridge.onSessionEvent(session(), compact)
    first.resolve(accepted); await tick()
    expect(send).toHaveBeenCalledTimes(2); expect(finished).toBe(false)
    second.resolve(accepted); await barrier; expect(finished).toBe(true); bridge.dispose()
  })
  it('holds the Messages prepared-call stream lease too', async () => {
    const gate = deferred<void>()
    vi.spyOn(DeepSeekAdapter.prototype, 'prepareCall').mockResolvedValue({ model: {} as never, stream: async function* () {
      yield { type: 'text-delta', index: 0, text: 'part' } as const; await gate.promise
    } })
    const send = vi.fn().mockResolvedValue(accepted)
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 50 })
    const a = new AgentHintAdapter({} as never, bridge)
    const prepared = await a.prepareCall('p', 'm'), stream = prepared.stream({ model: 'm', sessionId: sid } as never)[Symbol.asyncIterator]()
    await stream.next(); bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionEvent(session(), compact)
    await tick(); expect(send).not.toHaveBeenCalled()
    gate.resolve(); await stream.next(); await bridge.awaitPendingOp(sid)
    expect(send).toHaveBeenCalledTimes(1); bridge.dispose()
  })
  it.each(['finish', 'error', 'return'] as const)('holds the adapter stream lease until %s', async ending => {
    vi.spyOn(DeepSeekAdapter.prototype, 'stream').mockImplementation(async function* () {
      yield { type: 'text', text: 'chunk' } as never
      if (ending === 'error') throw new Error('fixture stream failure')
    })
    const send = vi.fn().mockResolvedValue(accepted)
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 50 })
    const adapter = new AgentHintAdapter({} as never, bridge)
    const stream = adapter.stream({ model: 'm', sessionId: sid } as never)[Symbol.asyncIterator]()
    await stream.next()
    bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionEvent(session(), compact)
    await tick(); expect(send).not.toHaveBeenCalled()
    if (ending === 'return') await stream.return!()
    else if (ending === 'error') await expect(stream.next()).rejects.toThrow('fixture stream failure')
    else await stream.next()
    await bridge.awaitPendingOp(sid); expect(send).toHaveBeenCalledTimes(1); bridge.dispose()
  })
  it('allows a failed resume to recover after cooldown', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const send = vi.fn().mockResolvedValueOnce({ status: 'failed', retryable: true }).mockResolvedValue(accepted)
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 50 })
    bridge.onSessionCreated(session(true)); bridge.ensureResume(sid, 'm'); await bridge.awaitPendingOp(sid)
    bridge.ensureResume(sid, 'm'); expect(send).toHaveBeenCalledTimes(1)
    now += 1001; bridge.ensureResume(sid, 'm'); await bridge.awaitPendingOp(sid)
    expect(send).toHaveBeenCalledTimes(2); bridge.dispose()
  })
  it('does not blindly repeat a resume with unknown outcome', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'unknown' })
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 50 })
    bridge.onSessionCreated(session(true)); bridge.ensureResume(sid, 'm'); await bridge.awaitPendingOp(sid)
    const release = await bridge.beginOrdinary(sid, 'm'); release()
    bridge.onSessionComposing(sid); expect(send).toHaveBeenCalledTimes(1); bridge.dispose()
  })
  it('recovers even when the failed resume settles after the advisory barrier', async () => {
    let now = 1000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    const gate = deferred<ControlResult>()
    const send = vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue(accepted)
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 10 })
    bridge.onSessionCreated(session(true))
    const release = await bridge.beginOrdinary(sid, 'm')
    gate.resolve({ status: 'failed', retryable: true }); await bridge.awaitPendingOp(sid); release()
    now += 1001
    const releaseNext = await bridge.beginOrdinary(sid, 'm'); releaseNext()
    expect(send).toHaveBeenCalledTimes(2); bridge.dispose()
  })
  it('blocks a new ordinary request while compact is slow, then recovers after acceptance', async () => {
    const gate = deferred<ControlResult>(), send = vi.fn(() => gate.promise)
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 10 })
    bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionEvent(session(), compact)
    await expect(bridge.beginOrdinary(sid, 'm')).rejects.toBeInstanceOf(ControlBarrierError)
    gate.resolve(accepted); await bridge.awaitPendingOp(sid)
    const release = await bridge.beginOrdinary(sid, 'm'); release()
    expect(send).toHaveBeenCalledTimes(1); bridge.dispose()
  })
  it('retains an unknown stop quarantine across disposal and reopen', async () => {
    const send = vi.fn().mockResolvedValue({ status: 'unknown' })
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 50 })
    bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionDisposed(session()); await tick()
    bridge.onSessionCreated(session(true))
    await expect(bridge.beginOrdinary(sid, 'm')).rejects.toBeInstanceOf(ControlBarrierError)
    bridge.onSessionComposing(sid); expect(send).toHaveBeenCalledTimes(1); bridge.dispose()
  })
  it('waits for all active streams before dispatching a queued mutation', async () => {
    const send = vi.fn().mockResolvedValue(accepted)
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 10 })
    const releaseA = await bridge.beginOrdinary(sid, 'm'), releaseB = await bridge.beginOrdinary(sid, 'm')
    bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionEvent(session(), compact)
    await tick(); expect(send).not.toHaveBeenCalled()
    releaseA(); releaseA(); await tick(); expect(send).not.toHaveBeenCalled()
    await expect(bridge.beginOrdinary(sid, 'm')).rejects.toBeInstanceOf(ControlBarrierError)
    releaseB(); await bridge.awaitPendingOp(sid); expect(send).toHaveBeenCalledTimes(1); bridge.dispose()
  })
  it('unloading drops queued controls and cancels an active retry', async () => {
    const fetch = vi.fn(async () => new Response('{}', { status: 503 }))
    vi.stubGlobal('fetch', fetch)
    const bridge = new LifecycleBridge({ client: client(), pendingOpAwaitMs: 50 })
    bridge.onSessionCreated(session(true)); bridge.ensureResume(sid, 'm')
    bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionEvent(session(), compact)
    await tick(); bridge.dispose(); await new Promise(resolve => setTimeout(resolve, 230))
    expect(fetch).toHaveBeenCalledTimes(1)
    await expect(bridge.beginOrdinary(sid, 'm')).rejects.toThrow()
  })
  it('cancels a waiting caller without cancelling the shared operation', async () => {
    const gate = deferred<ControlResult>(), send = vi.fn(() => gate.promise), abort = new AbortController()
    const bridge = new LifecycleBridge({ client: { send } as unknown as SessionControlClient, pendingOpAwaitMs: 1000 })
    bridge.noteOrdinaryRequest(sid, 'm'); bridge.onSessionEvent(session(), compact)
    const waiting = bridge.beginOrdinary(sid, 'm', abort.signal); abort.abort()
    await expect(waiting).rejects.toThrow()
    gate.resolve(accepted); await bridge.awaitPendingOp(sid)
    const release = await bridge.beginOrdinary(sid, 'm'); release(); bridge.dispose()
  })
})
