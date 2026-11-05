// SPDX-License-Identifier: MulanPSL-2.0
// Unit tests for the dynamic cache-control value policy (TTL clamping, the
// 128-token floor, the single ephemeral entry, prefix signature) — running
// against the committed built JS (lib/).
import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  buildCacheControl,
  cacheSignature,
  deriveTtlS,
  estimatePrefixTokens,
  TTL_MAX_S,
  TTL_MIN_S,
} from '../lib/cache.js'

test('deriveTtlS doubles the gap and clamps to [60, 3600]', () => {
  assert.equal(deriveTtlS(undefined), 600, 'no sample → 300 s fallback ×2')
  assert.equal(deriveTtlS(0), 600, 'a zero/absent sample uses the fallback')
  assert.equal(deriveTtlS(1_000), TTL_MIN_S, 'a short gap clamps up')
  assert.equal(deriveTtlS(120_000), 240, '120 s gap → 240 s TTL (not 120)')
  assert.equal(deriveTtlS(10_000_000), TTL_MAX_S, 'a long gap truncates, never drops')
})

test('estimatePrefixTokens counts CJK chars as one token and others as one per four', () => {
  assert.equal(estimatePrefixTokens(['中'.repeat(10)]), 10)
  assert.equal(estimatePrefixTokens(['abcd']), 1)
  assert.equal(estimatePrefixTokens(['abcde']), 2, 'rounds up')
  const nested = [{ role: 'user', content: [{ type: 'text', text: '中中中中' }] }]
  assert.ok(estimatePrefixTokens(nested) >= 4)
})

test('buildCacheControl emits one ephemeral entry, or nothing below the block floor', () => {
  assert.deepEqual(buildCacheControl(3, 500, 60_000), [{
    type: 'ephemeral',
    ttl_s: 120,
    range: { end: 3, unit: 'message' },
  }])
  assert.equal(buildCacheControl(0, 500, undefined), undefined, 'no logical input → no declaration')
  assert.equal(buildCacheControl(3, 50, undefined), undefined, 'prefix below 128 tokens → no declaration')
  assert.equal(buildCacheControl(3, 0, undefined)?.length, 1, 'an unestimated prefix does not block')
})

test('cacheSignature is model-plus-tool-set and order-insensitive', () => {
  assert.equal(cacheSignature('m', ['a', 'b']), cacheSignature('m', ['b', 'a']))
  assert.notEqual(cacheSignature('m', ['a']), cacheSignature('m2', ['a']))
  assert.notEqual(cacheSignature('m', ['a']), cacheSignature('m', ['a', 'b']))
  assert.equal(cacheSignature('m', undefined), cacheSignature('m', []))
})
