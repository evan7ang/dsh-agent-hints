import { describe, expect, it } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type {
  DeepSeekLlmApiExtensionRequest,
  PreparedDeepSeekLlmApiExtensions,
} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { agentHintAcceptExtensions } from '../src/extension.ts'
import { LifecycleBridge } from '../src/lifecycle-bridge.ts'
import type { SessionControlClient } from '../src/control-client.ts'
import type { ManageState } from '../src/hint.ts'

declare module '@deepseek-ai/dsh-deepseek-llm-api-extensions' {
  interface DeepSeekLlmApiExtensionMap {
    agent_hint_test_field: { value: string }
  }
}

const SID = SessionId('session-1')

const emptyChain = (): Promise<PreparedDeepSeekLlmApiExtensions> =>
  Promise.resolve({ fields: {}, accept: () => Promise.resolve() })

function request(overrides: {
  sessionId?: string | undefined
  purpose?: DeepSeekLlmApiExtensionRequest['purpose']
} = {}): DeepSeekLlmApiExtensionRequest {
  const sessionId = 'sessionId' in overrides ? overrides.sessionId : 'session-1'
  return {
    body: { model: 'model-a', messages: [] },
    signal: AbortSignal.timeout(5_000),
    ...sessionId === undefined ? {} : { sessionId },
    ...overrides.purpose === undefined ? {} : { purpose: overrides.purpose },
  }
}

function sessionOf(overrides: { seeded?: boolean } = {}): Session {
  const stub: Pick<Session, 'id' | 'header' | 'surface'> = {
    id: SID,
    header: {
      version: SESSION_FORMAT_VERSION,
      id: SID,
      createdAt: 1,
      isSeeded: overrides.seeded === true,
    },
    surface: {
      nodes: overrides.seeded === true ? [SessionSeq(0)] : [],
      replaceGeneration: 0,
      contentGeneration: 0,
    },
  }
  return stub as Session
}

interface RecordedCall {
  verb: ManageState
  sessionId: string
  model: string | undefined
}

function makeBridge(gate?: Promise<void>, pendingOpAwaitMs = 50): { bridge: LifecycleBridge; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const client = {
    send: (verb: ManageState, sessionId: string, model?: string) => {
      calls.push({ verb, sessionId, model })
      return gate ?? Promise.resolve()
    },
  } as SessionControlClient
  return { bridge: new LifecycleBridge({ client, pendingOpAwaitMs }), calls }
}

describe('agentHintAcceptExtensions', () => {
  it('contributes no hint field and notes start only on accept', async () => {
    const { bridge } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    const prepare = agentHintAcceptExtensions({ chained: emptyChain, bridge })

    const prepared = await prepare(request())
    expect(prepared.fields).toEqual({})
    expect(bridge.facts(SID).firstOrdinarySent).toBe(false)
    await prepared.accept()
    expect(bridge.facts(SID).firstOrdinarySent).toBe(true)
  })

  it('merges chained fields and settles the chained accept before noting', async () => {
    const { bridge } = makeBridge()
    bridge.onSessionCreated(sessionOf())
    const order: string[] = []
    const chained = (): Promise<PreparedDeepSeekLlmApiExtensions> => Promise.resolve({
      fields: { agent_hint_test_field: { value: 'chained' } },
      accept: () => {
        order.push('chained-accept')
        return Promise.resolve()
      },
    })
    const prepare = agentHintAcceptExtensions({ chained, bridge })
    const prepared = await prepare(request())
    expect(prepared.fields).toEqual({ agent_hint_test_field: { value: 'chained' } })
    await prepared.accept()
    expect(order).toEqual(['chained-accept'])
    expect(bridge.facts(SID).firstOrdinarySent).toBe(true)
  })

  it('skips control-plane bookkeeping for background purposes', async () => {
    const { bridge, calls } = makeBridge()
    bridge.onSessionCreated(sessionOf({ seeded: true }))
    const prepare = agentHintAcceptExtensions({ chained: emptyChain, bridge })

    const prepared = await prepare(request({ purpose: 'compaction' }))
    expect(prepared.fields).toEqual({})
    expect(calls).toEqual([])
    await prepared.accept()
    expect(bridge.facts(SID).firstOrdinarySent).toBe(false)
  })

  it('does nothing without a bridge', async () => {
    const prepare = agentHintAcceptExtensions({ chained: emptyChain })
    const prepared = await prepare(request())
    expect(prepared.fields).toEqual({})
    await expect(prepared.accept()).resolves.toBeUndefined()
  })

  it('leaves anonymous requests untouched', async () => {
    const { bridge } = makeBridge()
    const prepare = agentHintAcceptExtensions({ chained: emptyChain, bridge })
    const prepared = await prepare(request({ sessionId: undefined }))
    expect(prepared.fields).toEqual({})
    await expect(prepared.accept()).resolves.toBeUndefined()
  })
})
