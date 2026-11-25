import { describe, expect, it } from 'vitest'
import { deriveServingFacts, encodeAgentHintHeader, toolResultCallId } from '../src/hint.ts'

const call = (time: number, callId: string, name = 't') => ({ type: 'tool/call', time, data: { callId, name } })
// Legacy vocabulary: user message carrying a tool-result content block.
const result = (time: number, callId: string) => ({
  type: 'tool/result',
  time,
  data: { message: { content: [{ type: 'tool-result', toolCallId: callId }] } },
})
// Current vocabulary (harness ≥ 0.2.2): first-class tool-role message, top-level toolCallId.
const toolMessageResult = (time: number, callId: string) => ({
  type: 'tool/result',
  time,
  data: { message: { role: 'tool', toolCallId: callId, content: [{ type: 'text', text: 'ok' }] } },
})
const factsOf = (events: { type: string; time: number; data?: unknown }[]) => deriveServingFacts({ ownEvents: () => events })

describe('deriveServingFacts', () => {
  it('counts step/start and compaction/end and returns the empty-log shape', () => {
    const facts = factsOf([
      { type: 'request/header', time: 1 },
      { type: 'step/start', time: 2 },
      { type: 'compaction/end', time: 3 },
      { type: 'step/start', time: 4 },
    ])
    expect(facts.callIndex).toBe(2)
    expect(facts.epoch).toBe(1)
    expect(factsOf([])).toEqual({
      callIndex: 0, epoch: 0, turnOpening: false, intervalMs: undefined, afterCompaction: false,
    })
  })

  it('marks the first call of a turn and falls back to call_index 1', () => {
    const turn = [{ type: 'turn/start', time: 0 }, { type: 'step/start', time: 1 }]
    expect(factsOf(turn).turnOpening).toBe(true)
    expect(factsOf([...turn, { type: 'step/end', time: 2 }, { type: 'step/start', time: 3 }]).turnOpening).toBe(false)
    const secondTurn = factsOf([...turn, { type: 'step/end', time: 2 }, { type: 'turn/end', time: 3 },
      { type: 'turn/start', time: 4 }, { type: 'step/start', time: 5 }])
    expect(secondTurn.turnOpening).toBe(true)
    expect(factsOf([{ type: 'step/start', time: 1 }]).turnOpening).toBe(true)
    expect(factsOf([{ type: 'step/start', time: 1 }, { type: 'step/start', time: 2 }]).turnOpening).toBe(false)
  })

  it('reports the previous response end to this request start as intervalMs', () => {
    expect(factsOf([
      { type: 'step/start', time: 1000 },
      { type: 'step/end', time: 3000 },
      { type: 'step/start', time: 5000 },
    ]).intervalMs).toBe(2000)
    expect(factsOf([{ type: 'step/start', time: 1 }]).intervalMs).toBeUndefined()
  })

  it('flags a compaction rewrite since the previous response end, for one round only', () => {
    expect(factsOf([
      { type: 'step/start', time: 1 }, { type: 'step/end', time: 2 },
      { type: 'compaction/end', time: 3 }, { type: 'step/start', time: 4 },
    ]).afterCompaction).toBe(true)
    expect(factsOf([
      { type: 'step/start', time: 1 }, { type: 'step/end', time: 2 },
      { type: 'step/start', time: 4 }, { type: 'compaction/end', time: 5 },
    ]).afterCompaction).toBe(true)
    expect(factsOf([
      { type: 'step/start', time: 1 }, { type: 'step/end', time: 2 },
      { type: 'compaction/end', time: 3 }, { type: 'step/start', time: 4 },
      { type: 'step/end', time: 5 }, { type: 'step/start', time: 6 },
    ]).afterCompaction).toBe(false)
  })
})

describe('toolResultCallId', () => {
  it('reads both result vocabularies', () => {
    expect(toolResultCallId(result(1, 'legacy'))).toBe('legacy')
    expect(toolResultCallId(toolMessageResult(1, 'modern'))).toBe('modern')
  })

  it('ignores unrelated events', () => {
    expect(toolResultCallId({ type: 'turn/end', time: 1 })).toBeUndefined()
    expect(toolResultCallId(call(1, 'x'))).toBeUndefined()
    expect(toolResultCallId({ type: 'tool/result', time: 1, data: { message: { content: [] } } })).toBeUndefined()
  })
})

describe('encodeAgentHintHeader', () => {
  it('produces base64url of the UTF-8 JSON', () => {
    const hint = { session: { session_id: 's-1', call_index: 1, epoch: 0, state: 'append' as const } }
    const encoded = encodeAgentHintHeader(hint)
    expect(encoded).toBe(Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url'))
    expect(encoded).not.toContain('+')
    expect(encoded).not.toContain('/')
    expect(encoded).not.toContain('=')
    expect(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'))).toEqual(hint)
  })
})
