// SPDX-License-Identifier: MulanPSL-2.0
// Unit tests for the prediction statistics source: trie loading/lookup, the
// per-field static fallback, and the offline builder — running against the
// committed built JS (lib/, scripts/).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  loadPredictionTrie,
  lookupTrieNode,
  resolvePredictionBlock,
  toolSequenceOf,
} from '../lib/prediction.js'
import { buildTrie, percentileP90, summarizeSession } from '../scripts/build-prediction-trie.mjs'

function writeTrie(dir, trie) {
  const path = join(dir, 'prediction-trie.json')
  writeFileSync(path, JSON.stringify(trie))
  return path
}

const TRIE = {
  version: 1,
  built_at: '2026-10-16T00:00:00.000Z',
  agent_type: 'agent',
  root: {
    stats: {
      latency_ms: { p90: 8250.4, count: 40 },
      output_tokens: { p90: 639.6, count: 38 },
      interval_ms: { mean: 250.2, count: 36 },
      remaining_calls: { mean: 2.4, count: 40 },
      remaining_time_ms: { mean: 42_000, count: 30 },
      next: {
        transitions: [
          { state: 'tool', prob: 0.8, count: 32, tools: [{ name: 'web_search', expected_duration_s: 8.2 }] },
          { state: 'finalize', prob: 0.2, count: 8 },
        ],
      },
    },
    children: {
      web_search: {
        stats: {
          remaining_calls: { mean: 1.1, count: 30 },
          next: { transitions: [{ state: 'finalize', prob: 0.9, count: 27 }] },
        },
        children: {
          read_page: { stats: { remaining_calls: { mean: 0, count: 20 } } },
        },
      },
      sparse_tool: { stats: { remaining_calls: { mean: 9, count: 2 } } },
    },
  },
}

test('loadPredictionTrie: unreadable/unparsable/wrong-version files degrade to undefined with one warning', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hints-prediction-'))
  try {
    const warns = []
    const warn = message => warns.push(message)
    assert.equal(loadPredictionTrie(join(dir, 'missing.json'), warn), undefined)
    const bad = join(dir, 'bad.json')
    writeFileSync(bad, '{not json')
    assert.equal(loadPredictionTrie(bad, warn), undefined)
    const wrong = writeTrie(dir, { version: 99, root: {} })
    assert.equal(loadPredictionTrie(wrong, warn), undefined)
    assert.equal(warns.length, 3)
    const good = writeTrie(dir, TRIE)
    assert.deepEqual(loadPredictionTrie(good, warn), TRIE)
    assert.equal(warns.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('lookupTrieNode walks the longest tool-sequence prefix from the root', () => {
  const trie = TRIE
  assert.equal(lookupTrieNode(trie, []), trie.root)
  assert.equal(lookupTrieNode(trie, ['web_search']), trie.root.children.web_search)
  assert.equal(lookupTrieNode(trie, ['web_search', 'read_page']), trie.root.children.web_search.children.read_page)
  assert.equal(lookupTrieNode(trie, ['web_search', 'unknown_tool']), trie.root.children.web_search, 'stops at the deepest match')
  assert.equal(lookupTrieNode(trie, ['unknown_tool']), trie.root, 'unknown first tool stays at the root')
})

test('toolSequenceOf extracts ordered tool names from the durable log', () => {
  const session = {
    ownEvents: () => [
      { type: 'step/start', time: 1 },
      { type: 'tool/call', time: 2, data: { name: 'web_search', callId: 'c1' } },
      { type: 'tool/call', time: 3, data: { name: 'read_page', callId: 'c2' } },
      { type: 'tool/result', time: 4, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } },
      { type: 'step/start', time: 5 },
    ],
  }
  assert.deepEqual(toolSequenceOf(session), ['web_search', 'read_page'])
})

test('resolvePredictionBlock: trie hit fills p90/mean values with wire rounding and next_action', () => {
  const block = resolvePredictionBlock({ trie: TRIE, minSamples: 5 }, [])
  assert.deepEqual(block, {
    latency_ms: 8251,
    output_tokens: 640,
    interval_ms: 251,
    remaining_calls: 2,
    remaining_time_ms: 42000,
    next_action: { state: 'tool', tools: [{ name: 'web_search', expected_duration_s: 9 }], prob: 0.8 },
  })
})

test('resolvePredictionBlock: deeper prefix narrows the prediction', () => {
  const block = resolvePredictionBlock({ trie: TRIE, minSamples: 5 }, ['web_search'])
  assert.equal(block.remaining_calls, 1)
  assert.deepEqual(block.next_action, { state: 'finalize', prob: 0.9 })
})

test('resolvePredictionBlock: zero remaining_calls is meaningful on the final prefix', () => {
  const block = resolvePredictionBlock({ trie: TRIE, minSamples: 5 }, ['web_search', 'read_page'])
  assert.equal(block.remaining_calls, 0)
  assert.equal(block.next_action, undefined, 'a node without transitions omits next_action')
})

test('resolvePredictionBlock: below-minSamples nodes and missing stats fall back per field to statics', () => {
  const block = resolvePredictionBlock(
    { trie: TRIE, statics: { latency_ms: 5000, remaining_calls: 7, output_tokens: 512 }, minSamples: 5 },
    ['sparse_tool'],
  )
  assert.deepEqual(block, { latency_ms: 5000, remaining_calls: 7, output_tokens: 512 }, 'sparse trie fields skipped, no next_action')
})

test('resolvePredictionBlock: static-only source emits scalars without next_action', () => {
  const block = resolvePredictionBlock(
    { statics: { latency_ms: 4000, remaining_calls: 3, output_tokens: 256, interval_ms: 100, remaining_time_ms: 12_000 }, minSamples: 5 },
    [],
  )
  assert.deepEqual(block, {
    latency_ms: 4000,
    remaining_calls: 3,
    output_tokens: 256,
    interval_ms: 100,
    remaining_time_ms: 12000,
  })
})

test('resolvePredictionBlock: no sources at all yields no block', () => {
  assert.equal(resolvePredictionBlock({ minSamples: 5 }, []), undefined)
  assert.equal(resolvePredictionBlock({ statics: {}, minSamples: 5 }, []), undefined)
})

test('percentileP90 uses nearest-rank over the sorted samples', () => {
  assert.equal(percentileP90([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), 9)
  assert.equal(percentileP90([5]), 5)
  assert.equal(percentileP90([]), undefined)
})

const SESSION_LOG = [
  { type: 'turn/start', time: 0, data: { turn: 1 } },
  { type: 'step/start', time: 1000, data: { turn: 1, step: 1 } },
  { type: 'assistant/message', time: 6000, data: { usage: { inputTokens: 100, outputTokens: 600 } } },
  { type: 'step/end', time: 7000, data: { turn: 1, step: 1 } },
  { type: 'tool/call', time: 7500, data: { name: 'web_search', callId: 'c1' } },
  { type: 'tool/result', time: 15500, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } },
  { type: 'step/start', time: 16000, data: { turn: 1, step: 2 } },
  { type: 'assistant/message', time: 22000, data: { usage: { inputTokens: 200, outputTokens: 400 } } },
  { type: 'step/end', time: 23000, data: { turn: 1, step: 2 } },
  { type: 'turn/end', time: 23100, data: { reason: { kind: 'completed' } } },
]

test('summarizeSession derives per-call windows, intervals, remainders and transitions', () => {
  const summaries = summarizeSession(SESSION_LOG)
  assert.deepEqual(summaries, [
    {
      prefix: [],
      latencyMs: 6000,
      outputTokens: 600,
      intervalMs: 9000,
      remainingCalls: 1,
      remainingTimeMs: 16100,
      next: { state: 'tool', tool: 'web_search', durationS: 8000 },
    },
    {
      prefix: ['web_search'],
      latencyMs: 7000,
      outputTokens: 400,
      intervalMs: undefined,
      remainingCalls: 0,
      remainingTimeMs: 100,
      next: { state: 'finalize' },
    },
  ])
})

test('buildTrie aggregates session summaries into prefix-node distributions and transitions', () => {
  const secondSession = summarizeSession([
    { type: 'step/start', time: 0 },
    { type: 'step/end', time: 8000 },
    { type: 'tool/call', time: 8500, data: { name: 'web_search', callId: 'd1' } },
    { type: 'tool/result', time: 14500, data: { message: { content: [{ type: 'tool-result', toolCallId: 'd1' }] } } },
    { type: 'step/start', time: 15000 },
    { type: 'step/end', time: 22000 },
    { type: 'turn/end', time: 22100, data: { reason: { kind: 'completed' } } },
  ])
  const trie = buildTrie([summarizeSession(SESSION_LOG), secondSession], { agentType: 'agent' })
  assert.equal(trie.version, 1)
  assert.equal(trie.agent_type, 'agent')
  const root = trie.root
  assert.equal(root.stats.remaining_calls.mean, (1 + 1) / 2, 'remaining after the first call across two sessions')
  assert.equal(root.stats.latency_ms.p90, 8000, 'p90 of [6000, 7000, 8000]')
  const viaSearch = root.children.web_search
  assert.equal(viaSearch.stats.remaining_calls.mean, 0)
  assert.deepEqual(viaSearch.stats.next.transitions, [{ state: 'finalize', count: 2, prob: 1 }])
  assert.equal(root.stats.next.transitions[0].state, 'tool')
  assert.equal(root.stats.next.transitions[0].tools[0].name, 'web_search')
  assert.equal(root.stats.next.transitions[0].prob, 1, 'both sessions continue with web_search')
  assert.equal(root.stats.next.transitions[0].tools[0].expected_duration_s, 7000, 'mean of [8000, 6000]')
})

test('buildTrie minCount prunes sparse branches and stats', () => {
  const trie = buildTrie([summarizeSession(SESSION_LOG)], { minCount: 2 })
  assert.deepEqual(trie.root, {}, 'every root stat has a single sample below minCount; the branch is pruned with it')
})

test('summarizeSession replays out-of-order events by time and skips non-completed turns for finalize', () => {
  const shuffled = [
    { type: 'step/end', time: 7000 },
    { type: 'turn/end', time: 23_100, data: { reason: { kind: 'error' } } },
    { type: 'tool/call', time: 7500, data: { name: 'e2e_probe', callId: 'c1' } },
    { type: 'step/start', time: 1000 },
    { type: 'tool/result', time: 15_500, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } },
    { type: 'assistant/message', time: 6000, data: { usage: { outputTokens: 600 } } },
    { type: 'step/start', time: 16_000 },
    { type: 'assistant/message', time: 22_000, data: { usage: { outputTokens: 400 } } },
    { type: 'step/end', time: 23_000 },
  ]
  const summaries = summarizeSession(shuffled)
  assert.equal(summaries.length, 2)
  assert.equal(summaries[0].next.state, 'tool', 'the tool transition survives the error turn')
  assert.equal(summaries[1].next, undefined, 'an errored turn contributes no finalize transition')
  assert.equal(summaries[1].remainingTimeMs, undefined, 'session remainder needs a completed turn/end')
  assert.deepEqual(summaries[1].prefix, ['e2e_probe'])
})

test('buildTrie chains prefix nodes deeper than one level', () => {
  const log = [
    { type: 'step/start', time: 0 },
    { type: 'step/end', time: 1000 },
    { type: 'tool/call', time: 1100, data: { name: 'tool_a', callId: 'c1' } },
    { type: 'tool/result', time: 1200, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c1' }] } } },
    { type: 'step/start', time: 1300 },
    { type: 'step/end', time: 2000 },
    { type: 'tool/call', time: 2100, data: { name: 'tool_b', callId: 'c2' } },
    { type: 'tool/result', time: 2200, data: { message: { content: [{ type: 'tool-result', toolCallId: 'c2' }] } } },
    { type: 'step/start', time: 2300 },
    { type: 'step/end', time: 3000 },
    { type: 'turn/end', time: 3100, data: { reason: { kind: 'completed' } } },
  ]
  const trie = buildTrie([summarizeSession(log)], { agentType: 'agent' })
  const deep = trie.root.children.tool_a.children.tool_b
  assert.equal(deep.stats.remaining_calls.mean, 0)
  assert.deepEqual(deep.stats.next.transitions, [{ state: 'finalize', count: 1, prob: 1 }])
  assert.deepEqual(trie.root.children.tool_a.stats.next.transitions[0].tools, [{ name: 'tool_b', expected_duration_s: 100 }])
})

test('CLI builds a trie from a log directory, skipping malformed lines', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agent-hints-prediction-cli-'))
  try {
    writeFileSync(join(dir, 'good.jsonl'), SESSION_LOG.map(event => JSON.stringify(event)).join('\n') + '\n')
    writeFileSync(join(dir, 'broken.jsonl'), '{not json\n\n{"type": "step/start", "time": 1}\n')
    const out = join(dir, 'trie.json')
    execFileSync(process.execPath, [fileURLToPath(new URL('../scripts/build-prediction-trie.mjs', import.meta.url)), '--logs', dir, '--out', out, '--agent-type', 'agent'], { stdio: 'pipe' })
    const trie = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(trie.version, 1)
    assert.equal(trie.agent_type, 'agent')
    assert.equal(trie.root.stats.latency_ms.count, 1, 'the malformed file contributes its one parsable (unclosed) event only — no call, no stats')
    assert.ok(trie.root.children.web_search, 'the single session keeps its branch at default minCount=1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
