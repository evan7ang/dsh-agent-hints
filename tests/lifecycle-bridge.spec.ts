import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import type { SessionControlClient } from '../src/control-client.ts'
import type { SessionControlVerb } from '../src/types.ts'

const SID = SessionId('session-1')
const OTHER = SessionId('session-2')
const PARENT = SessionId('parent-1')

/** Minimal session shape the bridge reads: identity, surface history, lineage. */
function sessionOf(overrides: {
  id?: SessionId
  seeded?: boolean
  parentSession?: SessionId
  origin?: 'subagent'
} = {}): Session {
  const id = overrides.id ?? SID
  const stub: Pick<Session, 'id' | 'header' | 'surface'> = {
    id,
    header: {
      version: SESSION_FORMAT_VERSION,
      id,
      createdAt: 1,
      isSeeded: overrides.seeded === true,
      ...overrides.parentSession === undefined ? {} : { parentSession: overrides.parentSession },
      ...overrides.origin === undefined ? {} : { origin: overrides.origin },
    },
    surface: {
      nodes: overrides.seeded === true ? [SessionSeq(0)] : [],
      replaceGeneration: 0,
      contentGeneration: 0,
    },
  }
  return stub as Session
}

function compactionEnd(error?: string): SessionEvent<'compaction/end'> {
  return {
    type: 'compaction/end',
    seq: SessionSeq(1),
    time: 1,
    data: { compactionId: CompactionId('c-1'), turn: 1, ...error === undefined ? {} : { error } },
  }
}

interface RecordedCall {
  verb: SessionControlVerb
  sessionId: string
  model: string | undefined
}

function makeBridge(): { bridge: LifecycleBridge; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client = {
    send: (verb: SessionControlVerb, sessionId: string, model?: string) => {
      calls.push({ verb, sessionId, model })
      return Promise.resolve({ status: 'accepted', httpStatus: 200 })
    },
  } as SessionControlClient
  return { bridge: new LifecycleBridge({ client, pendingOpAwaitMs: 50 }), calls }
}

describe('LifecycleBridge', () => {
  it('queues resume after a delayed pause and waits for the entire session queue', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: string[] = []
    const bridge = new LifecycleBridge({ pendingOpAwaitMs: 1000, client: {
      send: async (verb: string) => {
        calls.push(`begin:${verb}`)
        if (verb === 'pause') await gate
        calls.push(`end:${verb}`)
        return { status: 'accepted', httpStatus: 200 }
      },
    } as SessionControlClient })
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.onSessionComposing(SID)
    let dataAllowed = false
    const barrier = bridge.awaitPendingOp(SID).then(() => { dataAllowed = true })
    await Promise.resolve()
    expect(calls).toEqual(['begin:pause'])
    expect(dataAllowed).toBe(false)
    release(); await barrier
    expect(calls).toEqual(['begin:pause', 'end:pause', 'begin:resume', 'end:resume'])
    expect(dataAllowed).toBe(true)
  })

  it('does not delete a reopened session when its old stop settles', async () => {
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const calls: string[] = []
    const bridge = new LifecycleBridge({ pendingOpAwaitMs: 1000, client: {
      send: async (verb: string) => { calls.push(verb); if (verb === 'stop') await gate; return { status: 'accepted', httpStatus: 200 } },
    } as SessionControlClient })
    bridge.onSessionCreated(sessionOf())
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionDisposed(sessionOf())
    bridge.onSessionCreated(sessionOf({ seeded: true, parentSession: PARENT }))
    bridge.ensureResume(SID, 'model-a')
    expect(calls).toEqual(['stop'])
    release(); await bridge.awaitPendingOp(SID)
    expect(calls).toEqual(['stop', 'resume'])
    expect(bridge.facts(SID)).toMatchObject({ seeded: true, parentSessionId: PARENT })
  })
  it('records a seeded session without sending resume until the first ordinary request', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    expect(calls).toEqual([])
    bridge.ensureResume(SID, 'deepseek-v4-flash')
    expect(calls).toEqual([{ verb: 'resume', sessionId: 'session-1', model: 'deepseek-v4-flash' }])
  })

  it('keeps fork lineage visible to the data plane', () => {
    const { bridge } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: true, parentSession: PARENT }))
    expect(bridge.facts(SID)).toEqual({
      seeded: true,
      firstOrdinarySent: false,
      parentSessionId: PARENT,
    })
  })

  describe('compaction parent under the 0.2.2 header semantics', () => {
    const FORKED = SessionId('forked')

    it('never reports a subagent lineage as a compaction parent', () => {
      const { bridge } = makeBridge()
      bridge.onSessionCreated(sessionOf({ seeded: true, parentSession: PARENT, origin: 'subagent' }))
      expect(bridge.facts(SID).parentSessionId).toBeUndefined()
    })

    it('does not attribute an unrelated reopened session to a recently compacted one', () => {
      const { bridge } = makeBridge()
      bridge.onSessionEvent(sessionOf({ id: PARENT }), compactionEnd())
      bridge.onSessionCreated(sessionOf({ id: OTHER, seeded: true }))
      expect(bridge.facts(OTHER)).toMatchObject({ seeded: true, parentSessionId: undefined })
    })

    it('does not infer lineage from a failed compaction', () => {
      const { bridge } = makeBridge()
      bridge.onSessionEvent(sessionOf({ id: PARENT }), compactionEnd('fixture failure'))
      bridge.onSessionCreated(sessionOf({ id: FORKED, seeded: true }))
      expect(bridge.facts(FORKED).parentSessionId).toBeUndefined()
    })
  })

  it('does nothing on a fresh (unseeded) session creation', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    expect(calls).toEqual([])
    expect(bridge.facts(SID)).toMatchObject({ seeded: false })
  })

  it('treats a blank persisted session without surface history as fresh', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: false }))
    bridge.ensureResume(SID, 'deepseek-v4-flash')
    expect(calls).toEqual([])
    expect(bridge.facts(SID)).toMatchObject({ seeded: false, firstOrdinarySent: false })
  })

  it('requests a compact after a successful compaction', () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'deepseek-v4-flash')
    bridge.onSessionEvent(sessionOf(), compactionEnd())
    expect(calls).toEqual([{ verb: 'compact', sessionId: 'session-1', model: 'deepseek-v4-flash' }])
  })

  it('skips the compact when compaction failed', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionEvent(sessionOf(), compactionEnd('boom'))
    expect(calls).toEqual([])
  })

  it('requests a terminal stop on disposal and drops the state', async () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'deepseek-v4-flash')
    bridge.onSessionDisposed(sessionOf())
    // Disposal is fire-and-forget; the send itself is synchronous bookkeeping.
    expect(calls).toEqual([{ verb: 'stop', sessionId: 'session-1', model: 'deepseek-v4-flash' }])
    await new Promise(resolve => setImmediate(resolve))
    expect(bridge.facts(SID)).toEqual({
      seeded: false,
      firstOrdinarySent: false,
      parentSessionId: undefined,
    })
  })

  it('flips firstOrdinarySent so start is declared once per session', () => {
    const { bridge } = makeBridge()
    expect(bridge.facts(SID).firstOrdinarySent).toBe(false)
    bridge.noteOrdinaryRequest(SID, 'm')
    expect(bridge.facts(SID).firstOrdinarySent).toBe(true)
  })

  it('awaits an in-flight manage verb before resolving the barrier', async () => {
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const client = {
      send: (_verb: SessionControlVerb, _sessionId: string, _model?: string) => gate,
    } as SessionControlClient
    const bridge = new LifecycleBridge({ client, pendingOpAwaitMs: 1_000 })
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    bridge.ensureResume(SID, 'deepseek-v4-flash')

    let barrierSettled = false
    const barrier = bridge.awaitPendingOp(SID).then(() => { barrierSettled = true })
    await new Promise(resolve => setImmediate(resolve))
    expect(barrierSettled).toBe(false)
    release?.()
    await barrier
    expect(barrierSettled).toBe(true)
  })

  it('fails open when the barrier cap expires first', async () => {
    const gate = new Promise<void>(() => {})
    const client = {
      send: (_verb: SessionControlVerb, _sessionId: string, _model?: string) => gate,
    } as SessionControlClient
    const bridge = new LifecycleBridge({ client, pendingOpAwaitMs: 10 })
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    bridge.ensureResume(SID, 'deepseek-v4-flash')
    await expect(bridge.awaitPendingOp(SID)).resolves.toBeUndefined()
  })

  it('sends resume once across repeated ordinary requests', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    bridge.ensureResume(SID, 'deepseek-v4-flash')
    bridge.ensureResume(SID, 'deepseek-v4-flash')
    expect(calls).toEqual([{ verb: 'resume', sessionId: 'session-1', model: 'deepseek-v4-flash' }])
  })

  it('does not send resume for an anonymous or fresh session', () => {
    const { bridge, calls } = makeBridge()
    bridge.ensureResume(undefined, 'deepseek-v4-flash')
    bridge.onSessionCreated(sessionOf())
    bridge.ensureResume(SID, 'deepseek-v4-flash')
    expect(calls).toEqual([])
  })

  it('does not send resume between ordinary requests of a live fresh session', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.ensureResume(SID, 'model-a')
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.ensureResume(SID, 'model-a')
    expect(calls).toEqual([])
    expect(bridge.facts(SID)).toMatchObject({ seeded: false, firstOrdinarySent: true })
  })

  it('sends resume for a paused fresh session even without a composer draft', async () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    expect(calls).toEqual([{ verb: 'pause', sessionId: 'session-1', model: 'model-a' }])

    bridge.ensureResume(SID, 'model-a')
    await bridge.awaitPendingOp(SID)
    expect(calls).toEqual([
      { verb: 'pause', sessionId: 'session-1', model: 'model-a' },
      { verb: 'resume', sessionId: 'session-1', model: 'model-a' },
    ])
  })

  it('marks the previous ordinary session for pause and sends it when it becomes idle', () => {
    const { bridge, calls } = makeBridge()
    bridge.onAgentStatus(SID, 'running')
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    expect(calls).toEqual([])

    bridge.onAgentStatus(SID, 'idle')
    expect(calls).toEqual([{ verb: 'pause', sessionId: 'session-1', model: 'model-a' }])
  })

  it('sends pause immediately when the previous session is already idle', () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    expect(calls).toEqual([{ verb: 'pause', sessionId: 'session-1', model: 'model-a' }])
  })

  it('pauses each switched-away session once as the foreground moves on', () => {
    const { bridge, calls } = makeBridge()
    bridge.onAgentStatus(SID, 'running')
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.noteOrdinaryRequest(SessionId('session-3'), 'model-c')
    bridge.onAgentStatus(SID, 'idle')
    expect(calls).toEqual([
      { verb: 'pause', sessionId: 'session-2', model: 'model-b' },
      { verb: 'pause', sessionId: 'session-1', model: 'model-a' },
    ])
  })

  it('cancels a pending pause when the previous session becomes active again', () => {
    const { bridge, calls } = makeBridge()
    bridge.onAgentStatus(SID, 'running')
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onAgentStatus(SID, 'idle')
    expect(calls).toEqual([{ verb: 'pause', sessionId: 'session-2', model: 'model-b' }])

    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    bridge.onAgentStatus(SID, 'idle')
    expect(calls).toEqual([
      { verb: 'pause', sessionId: 'session-2', model: 'model-b' },
      { verb: 'pause', sessionId: 'session-1', model: 'model-a' },
    ])
  })

  it('resumes a paused session once when it starts composing again', () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    bridge.ensureResume(SID, 'model-a')
    bridge.onSessionComposing(SID)
    expect(calls).toEqual([{ verb: 'resume', sessionId: 'session-1', model: 'model-a' }])

    bridge.onSessionComposing(SID)
    expect(calls).toEqual([{ verb: 'resume', sessionId: 'session-1', model: 'model-a' }])
  })

  it('sends a second resume after a pause clears the resume-sent guard', async () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    bridge.ensureResume(SID, 'model-a')
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    await bridge.awaitPendingOp(SID)
    expect(calls).toEqual([
      { verb: 'resume', sessionId: 'session-1', model: 'model-a' },
      { verb: 'pause', sessionId: 'session-1', model: 'model-a' },
    ])

    bridge.onSessionComposing(SID)
    await bridge.awaitPendingOp(SID)
    expect(calls).toEqual([
      { verb: 'resume', sessionId: 'session-1', model: 'model-a' },
      { verb: 'pause', sessionId: 'session-1', model: 'model-a' },
      { verb: 'resume', sessionId: 'session-1', model: 'model-a' },
    ])
  })

  it('resumes a session that started fresh but has run a turn and been paused', async () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.noteOrdinaryRequest(OTHER, 'model-b')
    expect(calls).toEqual([{ verb: 'pause', sessionId: 'session-1', model: 'model-a' }])

    bridge.onSessionComposing(SID)
    await bridge.awaitPendingOp(SID)
    expect(calls).toEqual([
      { verb: 'pause', sessionId: 'session-1', model: 'model-a' },
      { verb: 'resume', sessionId: 'session-1', model: 'model-a' },
    ])
  })

  it('requests a terminal stop when a session is archived', async () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionArchived(SID)
    expect(calls).toEqual([{ verb: 'stop', sessionId: 'session-1', model: 'model-a' }])
    // Archiving is advisory: the session may stay live and be unarchived.
    await new Promise(resolve => setImmediate(resolve))
    expect(bridge.facts(SID)).toMatchObject({ firstOrdinarySent: true })
  })

  it('returns unknown-session facts for anonymous requests', () => {
    const { bridge } = makeBridge()
    expect(bridge.facts(undefined)).toEqual({
      seeded: false,
      firstOrdinarySent: false,
      parentSessionId: undefined,
    })
  })

  it('does not control a session that has never used this provider', () => {
    const { bridge, calls } = makeBridge()
    const unrelated = sessionOf({ seeded: true })
    bridge.onSessionCreated(unrelated)
    bridge.onSessionComposing(SID)
    bridge.onSessionArchived(SID)
    bridge.onSessionEvent(unrelated, compactionEnd())
    bridge.onSessionDisposed(unrelated)
    expect(calls).toEqual([])
  })

  it('deduplicates native/wrapped archive and subsequent disposal', () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionArchived(SID)
    bridge.onSessionArchived(SID)
    bridge.onSessionDisposed(sessionOf())
    expect(calls).toEqual([{ verb: 'stop', sessionId: 'session-1', model: 'model-a' }])
  })

  it('allows resume and another stop after a successful unarchive', async () => {
    const { bridge, calls } = makeBridge()
    bridge.noteOrdinaryRequest(SID, 'model-a')
    bridge.onSessionArchived(SID)
    bridge.onSessionUnarchived(SID)
    bridge.onSessionComposing(SID)
    bridge.onSessionArchived(SID)
    await bridge.awaitPendingOp(SID)
    expect(calls.map(call => call.verb)).toEqual(['stop', 'resume', 'stop'])
  })
})
