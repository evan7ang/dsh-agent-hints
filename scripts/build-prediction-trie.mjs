#!/usr/bin/env node
// SPDX-License-Identifier: MulanPSL-2.0
// Offline prediction-trie builder for the agent-hints `prediction` block:
// consumes DSH session logs (JSONL event lines: `{type, time, data}` — one
// file per session), replays each session, and aggregates per-tool-prefix
// distributions into the trie format consumed by `src/prediction.ts`
// (dynamo/NAT `prediction_trie` isomorph, keyed by the session's tool-call
// sequence instead of a workflow function path).
//
// Usage:
//   node scripts/build-prediction-trie.mjs --logs <file-or-dir>[,<file-or-dir>...] \
//     --out prediction-trie.json [--agent-type agent] [--min-count 1]
//
// Session log event vocabulary consumed (all optional per session):
//   step/start{time} → step/end{time}                   one LLM call window → latency_ms
//   assistant/message{data.usage.outputTokens}          output tokens of the in-flight step
//   tool/call{data.name,data.callId,time}               tool-sequence prefix + next transition
//   tool/result{data.message.content[].toolCallId,time} tool duration
//   turn/end{data.reason.kind==='completed'}            session end → remaining_time_ms, finalize
//
// Plain Node, zero dependencies.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** p90 over ascending-sorted samples (nearest-rank). */
export function percentileP90(values) {
  if (values.length === 0) return undefined
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(0.9 * sorted.length) - 1))]
}

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/**
 * Replay one session's durable log into per-call summaries: the tool prefix
 * before each call, observed latency/output, the interval to the next call,
 * the session remainder, and what followed (a tool call or a finalize).
 * `turn/end` outcomes other than `completed` (error/aborted) contribute no
 * finalize transition — the protocol predicts forward progress only.
 */
export function summarizeSession(events) {
  const sorted = [...events]
    .filter(event => typeof event?.time === 'number')
    .sort((a, b) => a.time - b.time || 0)
  const calls = []
  const toolCalls = []
  const toolDurations = new Map()
  let openCall = undefined
  let stepOutputTokens = undefined
  let stepHasUsage = false
  let sessionEndMs
  for (const event of sorted) {
    if (event.type === 'step/start') {
      openCall = { startMs: event.time }
      stepOutputTokens = undefined
      stepHasUsage = false
    } else if (event.type === 'assistant/message' && openCall !== undefined) {
      const output = event.data?.usage?.outputTokens
      if (typeof output === 'number' && Number.isFinite(output)) {
        stepOutputTokens = (stepOutputTokens ?? 0) + output
        stepHasUsage = true
      }
    } else if (event.type === 'step/end' && openCall !== undefined) {
      calls.push({
        startMs: openCall.startMs,
        endMs: event.time,
        latencyMs: Math.max(0, event.time - openCall.startMs),
        outputTokens: stepHasUsage ? stepOutputTokens : undefined,
      })
      openCall = undefined
    } else if (event.type === 'tool/call' && typeof event.data?.name === 'string') {
      toolCalls.push({ name: event.data.name, callId: event.data?.callId, time: event.time })
    } else if (event.type === 'tool/result') {
      const callId = event.data?.message?.content?.find(block => block?.type === 'tool-result')?.toolCallId
      if (callId !== undefined) {
        const call = toolCalls.find(entry => entry.callId === callId)
        if (call !== undefined) toolDurations.set(callId, Math.max(0, event.time - call.time))
      }
    } else if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') {
      sessionEndMs = event.time
    }
  }
  const summaries = []
  for (let index = 0; index < calls.length; index += 1) {
    const call = calls[index]
    const nextCall = calls[index + 1]
    const followingTool = toolCalls.find(entry => entry.time >= call.endMs)
    summaries.push({
      prefix: toolCalls.filter(entry => entry.time < call.startMs).map(entry => entry.name),
      latencyMs: call.latencyMs,
      outputTokens: call.outputTokens,
      intervalMs: nextCall !== undefined ? Math.max(0, nextCall.startMs - call.endMs) : undefined,
      remainingCalls: calls.length - index - 1,
      remainingTimeMs: sessionEndMs !== undefined && sessionEndMs >= call.endMs ? sessionEndMs - call.endMs : undefined,
      next: followingTool !== undefined
        ? { state: 'tool', tool: followingTool.name, durationS: toolDurations.get(followingTool.callId) }
        : sessionEndMs !== undefined && sessionEndMs >= call.endMs
          ? { state: 'finalize' }
          : undefined,
    })
  }
  return summaries
}

/**
 * Build the trie object from per-session summaries. Nodes accumulate raw
 * samples along each call's tool prefix; `finalizeTrie` then collapses them
 * into distributions. `minCount` prunes branches (and per-node stats) below
 * the threshold — the runtime `predictionMinSamples` gate stays independent.
 */
export function buildTrie(sessionSummaries, { agentType = undefined, minCount = 1 } = {}) {
  const root = { stats: {}, children: {} }
  const nodeFor = (prefix) => {
    let node = root
    for (const name of prefix) {
      node.children[name] ??= { stats: {}, children: {} }
      node = node.children[name]
    }
    return node
  }
  const pushStat = (node, field, value) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    ;(node.stats[field] ??= []).push(value)
  }
  for (const summary of sessionSummaries) {
    for (const call of summary) {
      const node = nodeFor(call.prefix)
      pushStat(node, 'remaining_calls', call.remainingCalls)
      pushStat(node, 'latency_ms', call.latencyMs)
      pushStat(node, 'output_tokens', call.outputTokens)
      pushStat(node, 'interval_ms', call.intervalMs)
      pushStat(node, 'remaining_time_ms', call.remainingTimeMs)
      if (call.next !== undefined) {
        node.stats.next ??= []
        const transition = node.stats.next.find(entry => entry.state === call.next.state
          && (call.next.state !== 'tool' || entry.tool === call.next.tool))
        if (transition === undefined) node.stats.next.push(call.next.state === 'tool'
          ? { state: 'tool', tool: call.next.tool, count: 0, durations: [] }
          : { state: call.next.state, count: 0 })
        const entry = node.stats.next[node.stats.next.length - 1]
        entry.count += 1
        if (call.next.state === 'tool' && typeof call.next.durationS === 'number') entry.durations.push(call.next.durationS)
      }
    }
  }
  return finalizeTrie(root, { agentType, minCount })
}

/** Collapse raw accumulation arrays into `{mean|p90, count}` distributions and transition probabilities. */
export function finalizeTrie(rawRoot, { agentType = undefined, minCount = 1 } = {}) {
  const finalizeNode = (raw) => {
    const node = {}
    const stats = {}
    const paceFields = ['remaining_calls', 'interval_ms', 'remaining_time_ms']
    for (const field of ['remaining_calls', 'latency_ms', 'output_tokens', 'interval_ms', 'remaining_time_ms']) {
      const values = raw.stats?.[field]
      if (Array.isArray(values) && values.length >= minCount) {
        stats[field] = paceFields.includes(field)
          ? { mean: mean(values), count: values.length }
          : { p90: percentileP90(values), count: values.length }
      }
    }
    const transitions = raw.stats?.next ?? []
    const totalTransitions = transitions.reduce((sum, entry) => sum + entry.count, 0)
    if (totalTransitions >= minCount) {
      stats.next = {
        transitions: transitions
          .map(entry => ({
            state: entry.state,
            count: entry.count,
            prob: entry.count / totalTransitions,
            ...(entry.state === 'tool'
              ? { tools: [{ name: entry.tool, expected_duration_s: entry.durations.length > 0 ? mean(entry.durations) : 0 }] }
              : {}),
          }))
          .sort((a, b) => b.prob - a.prob),
      }
    }
    if (Object.keys(stats).length > 0) node.stats = stats
    const finalizedChildren = {}
    for (const [name, child] of Object.entries(raw.children ?? {})) {
      const finalized = finalizeNode(child)
      if (finalized !== undefined) finalizedChildren[name] = finalized
    }
    if (Object.keys(finalizedChildren).length > 0) node.children = finalizedChildren
    return Object.keys(node).length > 0 ? node : undefined
  }
  return {
    version: 1,
    ...(agentType !== undefined ? { agent_type: agentType } : {}),
    built_at: new Date().toISOString(),
    root: finalizeNode(rawRoot) ?? {},
  }
}

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

function collectLogs(path, files) {
  const stat = statSync(path)
  if (stat.isDirectory()) {
    for (const name of readdirSync(path)) {
      if (name.endsWith('.jsonl')) collectLogs(join(path, name), files)
    }
  } else {
    files.push(path)
  }
}

async function main() {
  const logs = arg('logs')
  const out = arg('out')
  if (logs === undefined || out === undefined) {
    console.error('usage: build-prediction-trie.mjs --logs <file-or-dir>[,...] --out <trie.json> [--agent-type agent] [--min-count 1]')
    process.exit(1)
  }
  const files = []
  for (const path of logs.split(',').map(entry => entry.trim()).filter(entry => entry.length > 0)) {
    collectLogs(path, files)
  }
  if (files.length === 0) {
    console.error('build-prediction-trie: no session log files found')
    process.exit(1)
  }
  const summaries = []
  for (const file of files) {
    const events = []
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // Malformed lines are skipped: a partial or foreign JSONL must not
        // poison the aggregation.
      }
    }
    summaries.push(summarizeSession(events))
  }
  const trie = buildTrie(summaries, { agentType: arg('agent-type'), minCount: Number(arg('min-count') ?? 1) })
  writeFileSync(out, JSON.stringify(trie, null, 2) + '\n')
  console.log(`build-prediction-trie: ${files.length} session(s) → ${out}`)
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main()
}
