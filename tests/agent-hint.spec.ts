import { describe, expect, it } from 'vitest'
import { buildManageHint, buildOrdinaryHint, STATE_EDIT } from '../src/hint.ts'
import { Config } from '../src/config.ts'

describe('buildOrdinaryHint', () => {
  it('declares start on a fresh session first request', () => {
    expect(buildOrdinaryHint({
      sessionId: 's-1', callIndex: 1, epoch: 0, state: 'start',
      priority: { level: 3, reason: 'user_waiting' },
      cacheControl: { type: 'ephemeral', ttl_s: 600, msg_offset: 10 },
    })).toEqual({
      session: { session_id: 's-1', call_index: 1, epoch: 0, state: 'start' },
      priority_control: { priority: { level: 3, reason: 'user_waiting' } },
      cache_control: { type: 'ephemeral', ttl_s: 600, msg_offset: 10 },
    })
  })

  it('omits optional blocks that have no source', () => {
    expect(buildOrdinaryHint({ sessionId: 's-1', callIndex: 5, epoch: 2, state: 'append' })).toEqual({
      session: { session_id: 's-1', call_index: 5, epoch: 2, state: 'append' },
    })
  })

  it('attaches parent lineage and detaches the cached priority object', () => {
    const priority = { level: 1, reason: 'critical_path' }
    const hint = buildOrdinaryHint({ sessionId: 's-1', parentSessionId: 'p-1', callIndex: 2, epoch: 0, state: 'append', priority })
    expect(hint.session.parent_session_id).toBe('p-1')
    hint.priority_control!.priority.level = 9
    expect(priority.level).toBe(1)
  })

  it('never carries reply-state vocabulary on an ordinary request', () => {
    const hint = buildOrdinaryHint({ sessionId: 's-1', callIndex: 1, epoch: 0, state: 'append' })
    expect(Object.keys(hint)).toEqual(['session'])
    expect(hint.session.state).toBe('append')
  })
})

describe('buildManageHint', () => {
  it.each([
    ['pause', 'offload'],
    ['resume', 'prefetch'],
    ['stop', 'evict'],
    ['compact', 'evict'],
  ] as const)('%s asks for a session-targeted %s', (state, edit) => {
    expect(buildManageHint({ sessionId: 's-1', callIndex: 4, epoch: 1, state })).toEqual({
      session: { session_id: 's-1', call_index: 4, epoch: 1, state },
      context_management: { manage_request: true, edits: [{ type: edit, target: 'session' }] },
    })
  })

  it('keeps the verb-to-edit map total and frozen', () => {
    expect(STATE_EDIT).toEqual({ pause: 'offload', resume: 'prefetch', stop: 'evict', compact: 'evict' })
    expect(Object.isFrozen(STATE_EDIT)).toBe(true)
  })

  it('carries parent lineage on the manage request when known', () => {
    expect(buildManageHint({ sessionId: 's-1', parentSessionId: 'p-1', callIndex: 1, epoch: 0, state: 'pause' })
      .session.parent_session_id).toBe('p-1')
  })
})

describe('Config schema agentHint', () => {
  it('defaults priority and cacheControl to dynamic', () => {
    const resolved = Config({})
    expect(resolved.agentHint?.priority).toBe('dynamic')
    expect(resolved.agentHint?.cacheControl).toBe('dynamic')
  })

  it('accepts a static priority object and omit', () => {
    expect(Config({ agentHint: { priority: { level: 3, reason: 'user_waiting' } } }).agentHint?.priority)
      .toEqual({ level: 3, reason: 'user_waiting' })
    expect(Config({ agentHint: { priority: 'omit' } }).agentHint?.priority).toBe('omit')
  })

  it('accepts a static cache declaration with and without a fixed offset', () => {
    expect(Config({ agentHint: { cacheControl: { ttl_s: 600 } } }).agentHint?.cacheControl).toEqual({ ttl_s: 600 })
    expect(Config({ agentHint: { cacheControl: { ttl_s: 60, msg_offset: 3 } } }).agentHint?.cacheControl)
      .toEqual({ ttl_s: 60, msg_offset: 3 })
  })

  it('rejects a static cache declaration without a positive ttl_s', () => {
    expect(() => Config({ agentHint: { cacheControl: { msg_offset: 3 } } })).toThrow()
    expect(() => Config({ agentHint: { cacheControl: { ttl_s: 0 } } })).toThrow()
  })
})
