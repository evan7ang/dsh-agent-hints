import { describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { ControlBarrierError, DEFAULT_QUARANTINE_TTL_MS, LifecycleBridge } from '../src/lifecycle-bridge.ts'
import type { SessionControlClient } from '../src/control-client.ts'
import type { SessionControlVerb } from '../src/types.ts'

const SID = SessionId('session-quarantine')
const OTHER = SessionId('session-other')

function sessionOf(id: SessionId = SID, seeded = true): Session {
  const stub: Pick<Session, 'id' | 'header' | 'surface'> = {
    id,
    header: {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      isSeeded: seeded,
    },
    surface: {
      nodes: seeded ? [SessionSeq(0)] : [],
      replaceGeneration: 0,
      contentGeneration: 0,
    },
  }
  return stub as Session
}

/** Resolve once the bridge's detached `.then()` handlers have run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve()
}

/**
 * A client that reports an unknown outcome for mutating verbs, which is how a
 * session becomes `unsafe`. Reads are unaffected.
 */
function unknownClient(): SessionControlClient {
  return {
    send: (verb: SessionControlVerb) =>
      Promise.resolve(verb === 'pause' || verb === 'stop' || verb === 'compact'
        ? { status: 'unknown' as const, dispatched: true }
        : { status: 'accepted' as const, httpStatus: 200 }),
  } as SessionControlClient
}

function acceptedClient(): SessionControlClient {
  return {
    send: () => Promise.resolve({ status: 'accepted' as const, httpStatus: 200 }),
  } as SessionControlClient
}

describe('disposed-session quarantine', () => {
  it('drops the state immediately when the disposal outcome is known', async () => {
    const bridge = new LifecycleBridge({ client: acceptedClient(), pendingOpAwaitMs: 50 })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    await settle()
    // A clean disposal must not leave anything behind.
    expect(bridge.facts(SID).firstOrdinarySent).toBe(false)
    await expect(bridge.beginOrdinary(SID, 'model-a')).resolves.toBeTypeOf('function')
  })

  it('keeps the state while a mutating outcome is unknown', async () => {
    const bridge = new LifecycleBridge({ client: unknownClient(), pendingOpAwaitMs: 50 })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    await settle()
    await expect(bridge.beginOrdinary(SID, 'model-a')).rejects.toBeInstanceOf(ControlBarrierError)
  })

  it('still refuses inference after the session is reopened', async () => {
    const bridge = new LifecycleBridge({ client: unknownClient(), pendingOpAwaitMs: 50 })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    await settle()
    bridge.onSessionCreated(sessionOf())
    await expect(bridge.beginOrdinary(SID, 'model-a')).rejects.toBeInstanceOf(ControlBarrierError)
  })

  it('sweeps the quarantined state once the TTL has elapsed', async () => {
    const warn = vi.fn()
    const bridge = new LifecycleBridge({
      client: unknownClient(), pendingOpAwaitMs: 50, quarantineTtlMs: 0, warn,
    })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    await settle()
    await expect(bridge.beginOrdinary(SID, 'model-a')).rejects.toBeInstanceOf(ControlBarrierError)

    // Any later disposal runs the sweep; with a zero TTL the entry is evicted.
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.onSessionDisposed(sessionOf(OTHER))
    await settle()

    expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped quarantine state'))
    // With the quarantined state gone, a fresh session is usable again.
    bridge.onSessionCreated(sessionOf())
    await expect(bridge.beginOrdinary(SID, 'model-a')).resolves.toBeTypeOf('function')
  })

  it('keeps the quarantine until the TTL actually elapses', async () => {
    const bridge = new LifecycleBridge({ client: unknownClient(), pendingOpAwaitMs: 50 })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    await settle()

    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.onSessionDisposed(sessionOf(OTHER))
    await settle()

    // Default TTL is far in the future, so the quarantine must survive the sweep.
    expect(DEFAULT_QUARANTINE_TTL_MS).toBeGreaterThan(0)
    await expect(bridge.beginOrdinary(SID, 'model-a')).rejects.toBeInstanceOf(ControlBarrierError)
  })

  it('never sweeps a state whose session is live again', async () => {
    const bridge = new LifecycleBridge({
      client: unknownClient(), pendingOpAwaitMs: 50, quarantineTtlMs: 0,
    })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    await settle()

    // Reopening clears the quarantine timer; the retained `unsafe` flag stays.
    bridge.onSessionCreated(sessionOf())
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.onSessionDisposed(sessionOf(OTHER))
    await settle()

    await expect(bridge.beginOrdinary(SID, 'model-a')).rejects.toBeInstanceOf(ControlBarrierError)
  })

  it('does not sweep a quarantined session that still has an active lease', async () => {
    const warn = vi.fn()
    const bridge = new LifecycleBridge({
      client: unknownClient(), pendingOpAwaitMs: 50, quarantineTtlMs: 0, warn,
    })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    // Lease taken before the state turns unsafe; it must keep the sweep away.
    const release = await bridge.beginOrdinary(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    await settle()

    // Any other disposal triggers a sweep; with a zero TTL it would evict SID
    // unless the outstanding lease is honoured.
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.onSessionDisposed(sessionOf(OTHER))
    await settle()

    expect(warn.mock.calls.some(([message]) => String(message).includes(String(SID)))).toBe(false)
    release()
  })
})
