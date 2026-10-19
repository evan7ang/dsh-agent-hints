// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Prediction statistics source for the `prediction` hint block: an OFFLINE
 * trie (built from session logs by `scripts/build-prediction-trie.mjs`,
 * dynamo/NAT `prediction_trie` isomorph) queried per request by longest-prefix
 * match over the session's tool-call sequence, with per-field static fallback.
 *
 * Value policy (protocol field definition §3): distributions (mean/p90/count)
 * live inside the trie; one number per metric is selected at emission — p90
 * for resource-reservation quantities (latency, output tokens), mean for pace
 * quantities (interval, remaining calls/time). A field emits only when its
 * node sample count reaches `minSamples`, else the configured static value;
 * `next_action` has no static semantics (a tool cannot be guessed) and only
 * emits from trie transitions. With neither source configured the whole block
 * is omitted — deployments that opt out keep the exact prior wire shape.
 *
 * @module dsh-agent-hints/prediction
 */

import { readFileSync } from 'node:fs'
import type { AgentHintPrediction } from './hint.js'

/* ------------------------------------------------------------------ *
 * Trie file schema (prediction-trie.json, format v1)
 * ------------------------------------------------------------------ */

/** One aggregated distribution: `mean` for pace metrics, `p90` for reservation metrics, always with the sample count. */
export interface PredictionDistribution {
  mean?: number
  p90?: number
  count: number
}

/** One observed transition from this prefix: a tool call or a session finalize. */
export interface PredictionTransition {
  state: 'running' | 'tool' | 'pause' | 'suspend' | 'finalize'
  prob: number
  count: number
  /** Present on `tool` transitions: the called tool(s) with mean duration. */
  tools?: Array<{ name: string; expected_duration_s: number }>
}

/** Aggregated what-happens-after-this-prefix statistics. */
export interface PredictionNodeStats {
  remaining_calls?: PredictionDistribution
  output_tokens?: PredictionDistribution
  interval_ms?: PredictionDistribution
  latency_ms?: PredictionDistribution
  remaining_time_ms?: PredictionDistribution
  next?: { transitions: PredictionTransition[] }
}

/** One trie node = one tool-sequence prefix state; children extend by one more tool call. */
export interface PredictionTrieNode {
  stats?: PredictionNodeStats
  children?: Record<string, PredictionTrieNode>
}

/** The whole trie file; one file serves one `agent_type` partition. */
export interface PredictionTrie {
  version: number
  built_at?: string
  agent_type?: string
  root: PredictionTrieNode
}

/** Static per-deployment fallback values (dynamo `OptimizableField` analog); `next_action` has none. */
export interface PredictionStatic {
  latency_ms?: number
  remaining_calls?: number
  output_tokens?: number
  interval_ms?: number
  remaining_time_ms?: number
}

/** Resolved sources: an optional trie plus optional statics; both absent → no block. */
export interface PredictionSource {
  trie?: PredictionTrie
  statics?: PredictionStatic
  minSamples: number
}

/** Structural session view for the tool sequence (the plugin already replays `ownEvents`). */
export interface PredictionSession {
  ownEvents(): Array<{ type: string; data?: { name?: unknown } }>
}

/**
 * Load and shape-check one trie file. Any problem (unreadable, unparsable,
 * wrong version, missing root) warns once and yields `undefined` — the
 * resolver then falls back per field, never throwing into the request path.
 */
export function loadPredictionTrie(path: string, warn?: (message: string) => void): PredictionTrie | undefined {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    warn?.(`agent-hints: prediction trie ${path} unavailable, static fallback applies: ${String(error)}`)
    return undefined
  }
  if (typeof raw !== 'object' || raw === null) {
    warn?.(`agent-hints: prediction trie ${path} is not an object, static fallback applies`)
    return undefined
  }
  const trie = raw as PredictionTrie
  if (trie.version !== 1 || typeof trie.root !== 'object' || trie.root === null) {
    warn?.(`agent-hints: prediction trie ${path} has unsupported format (version ${String(trie.version)}), static fallback applies`)
    return undefined
  }
  return trie
}

/**
 * Longest-prefix match: walk the tool sequence from the root, one child per
 * called tool name, and return the deepest reached node (the root itself is a
 * valid — empty-prefix — node).
 */
export function lookupTrieNode(trie: PredictionTrie, toolSequence: readonly string[]): PredictionTrieNode | undefined {
  let node: PredictionTrieNode | undefined = trie.root
  for (const name of toolSequence) {
    const child: PredictionTrieNode | undefined = node?.children?.[name]
    if (child === undefined) break
    node = child
  }
  return node
}

/** Ordered tool names from the session's durable log (`tool/call` events); the trie's lookup key. */
export function toolSequenceOf(session: PredictionSession): string[] {
  const sequence: string[] = []
  for (const event of session.ownEvents()) {
    if (event.type === 'tool/call' && typeof event.data?.name === 'string') sequence.push(event.data.name)
  }
  return sequence
}

function emitNumber(value: number | undefined, minimum: number, integer: (v: number) => number): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return undefined
  return Math.max(minimum, integer(value))
}

/** `remaining_calls` is the one field where 0 is meaningful (the final call) — floor at 0, round to integer. */
function emitRemainingCalls(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return undefined
  return Math.max(0, Math.round(value))
}

function emitProbability(value: number | undefined): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.round(Math.min(1, Math.max(0, value)) * 100) / 100
}

/**
 * Resolve one `prediction` block for a request: trie node first (longest
 * prefix), per-field static fallback for scalars, `next_action` only from
 * trie transitions. Returns `undefined` when nothing resolved — the block is
 * omitted entirely rather than sent empty.
 */
export function resolvePredictionBlock(source: PredictionSource, toolSequence: readonly string[]): AgentHintPrediction | undefined {
  const block: AgentHintPrediction = {}
  let resolved = false
  const assign = (field: 'latency_ms' | 'output_tokens' | 'interval_ms' | 'remaining_time_ms', dist: PredictionDistribution | undefined, stat: number | undefined, select: (d: PredictionDistribution) => number | undefined): void => {
    const fromDistribution = dist !== undefined && dist.count >= source.minSamples
      ? emitNumber(select(dist), 1, Math.ceil)
      : undefined
    const value = fromDistribution ?? emitNumber(stat, 1, Math.ceil)
    if (value !== undefined) {
      block[field] = value
      resolved = true
    }
  }
  const node = source.trie !== undefined ? lookupTrieNode(source.trie, toolSequence) : undefined
  const stats = node?.stats
  assign('latency_ms', stats?.latency_ms, source.statics?.latency_ms, d => d.p90)
  assign('output_tokens', stats?.output_tokens, source.statics?.output_tokens, d => d.p90)
  assign('interval_ms', stats?.interval_ms, source.statics?.interval_ms, d => d.mean)
  assign('remaining_time_ms', stats?.remaining_time_ms, source.statics?.remaining_time_ms, d => d.mean)
  // remaining_calls keeps zero as a meaningful value (the final call).
  const remainingFromTrie = stats?.remaining_calls !== undefined && stats.remaining_calls.count >= source.minSamples
    ? emitRemainingCalls(stats.remaining_calls.mean)
    : undefined
  const remainingCalls = remainingFromTrie
    ?? (typeof source.statics?.remaining_calls === 'number' && Number.isFinite(source.statics.remaining_calls) && source.statics.remaining_calls >= 0
      ? Math.round(source.statics.remaining_calls)
      : undefined)
  if (remainingCalls !== undefined) {
    block.remaining_calls = remainingCalls
    resolved = true
  }
  // next_action: highest-probability converged transition; tool transitions
  // carry their tool list, finalize stands alone.
  const transitions = stats?.next?.transitions?.filter(entry => entry.count >= source.minSamples) ?? []
  const best = transitions.reduce<PredictionTransition | undefined>((winner, entry) => {
    const prob = emitProbability(entry.prob)
    if (prob === undefined) return winner
    if (winner === undefined || prob > (winner.prob ?? 0)) return { ...entry, prob }
    return winner
  }, undefined)
  if (best !== undefined && (best.state !== 'tool' || (best.tools?.length ?? 0) > 0)) {
    block.next_action = {
      state: best.state,
      ...(best.state === 'tool' && best.tools !== undefined
        ? { tools: best.tools.map(tool => ({ name: tool.name, expected_duration_s: emitNumber(tool.expected_duration_s, 1, Math.ceil) ?? 1 })) }
        : {}),
      prob: best.prob,
    }
    resolved = true
  }
  return resolved ? block : undefined
}
