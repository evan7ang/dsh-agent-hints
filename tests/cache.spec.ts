import { describe, expect, it } from 'vitest'
import {
  buildCacheControl, cacheSignature, deriveTtlS, estimatePrefixTokens, TTL_MAX_S, TTL_MIN_S,
} from '../src/cache.ts'

describe('dynamic cache-control policy', () => {
  it('doubles the gap and clamps the TTL to [60, 3600]', () => {
    expect(deriveTtlS(undefined)).toBe(600)
    expect(deriveTtlS(0)).toBe(600)
    expect(deriveTtlS(1_000)).toBe(TTL_MIN_S)
    expect(deriveTtlS(120_000)).toBe(240)
    expect(deriveTtlS(10_000_000)).toBe(TTL_MAX_S)
  })

  it('counts CJK chars as one token and others as one per four', () => {
    expect(estimatePrefixTokens(['中'.repeat(10)])).toBe(10)
    expect(estimatePrefixTokens(['abcd'])).toBe(1)
    expect(estimatePrefixTokens(['abcde'])).toBe(2)
    expect(estimatePrefixTokens([{ role: 'user', content: [{ type: 'text', text: '中中中中' }] }])).toBeGreaterThanOrEqual(4)
  })

  it('emits one ephemeral declaration with the wire count as msg_offset', () => {
    expect(buildCacheControl(3, 500, 60_000)).toEqual({ type: 'ephemeral', ttl_s: 120, msg_offset: 3 })
    expect(buildCacheControl(0, 500, undefined)).toBeUndefined()
    expect(buildCacheControl(3, 50, undefined)).toBeUndefined()
    expect(buildCacheControl(3, 0, undefined)).toEqual({ type: 'ephemeral', ttl_s: 600, msg_offset: 3 })
  })

  it('keys the suppression signature on model plus the order-insensitive tool set', () => {
    expect(cacheSignature('m', ['a', 'b'])).toBe(cacheSignature('m', ['b', 'a']))
    expect(cacheSignature('m', ['a'])).not.toBe(cacheSignature('m2', ['a']))
    expect(cacheSignature('m', ['a'])).not.toBe(cacheSignature('m', ['a', 'b']))
    expect(cacheSignature('m', undefined)).toBe(cacheSignature('m', []))
  })
})
