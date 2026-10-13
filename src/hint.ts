// SPDX-License-Identifier: Apache-2.0
/**
 * AgentHint construction per the Agent Hint field definition (字段&实现定义):
 * the schema is the protocol contract, the values are derived from DSH runtime
 * facts (sessionId, session header lineage, session event tracking). Pure and
 * side-effect free so the wire shape is unit-testable without a harness.
 *
 * @module dsh-agent-hints/hint
 */

/** `session` block: who is calling, from which lineage, at which call. */
export interface AgentHintSession {
  /** Session id; stable within one context. */
  session_id: string
  /** Parent session id; root sessions omit the field. */
  parent_session_id?: string
  /** How this context came to exist; only present with a parent. */
  derivation?: {
    relation: 'fork' | 'spawn' | 'handoff'
    /** Whether the parent waits for this context (protocol default `sync`). */
    join?: 'sync' | 'async'
    fork_point?: number
  }
  /** Agent type identifier. */
  agent_type: string
  /** Call index inside the session, starting at 1. */
  call_index: number
  /** Context version; bumped after a context rewrite (compaction). */
  epoch: number
}

/** `agent_status` block: the framework-reported lifecycle state. */
export interface AgentHintAgentStatus {
  state: 'running' | 'tool' | 'pause' | 'suspend' | 'finalize'
  /** Unix epoch milliseconds when the current state was entered. */
  state_since_ms: number
  reason?: string
  tools?: Array<{ name: string; call_id?: string; child_session_id?: string }>
}

/** `priority` / `strict_priority` block. `strict_priority` is never sent by an agent: the field definition reserves it for a trusted control plane. */
export interface AgentHintPriority {
  level: number
  reason: string
}

/** One `cache_control` entry: pin or ephemeral intent over a message/token range. */
export interface AgentHintCacheControl {
  type: 'pin' | 'ephemeral'
  /** Retention seconds; applies to pin or ephemeral. */
  ttl_s?: number
  range?: {
    start?: number
    end?: number | null
    unit?: 'message' | 'token'
  }
}

/** The complete AgentHint object sent under `nvext.agent_hints`. */
export interface AgentHint {
  session: AgentHintSession
  agent_status?: AgentHintAgentStatus
  priority?: AgentHintPriority
  strict_priority?: AgentHintPriority
  cache_control?: AgentHintCacheControl | AgentHintCacheControl[]
  prediction?: {
    latency_ms?: number
    remaining_calls?: number
    output_tokens?: number
    interval_ms?: number
    remaining_time_ms?: number
    expected_resume_s?: number
    next_action?: {
      state: AgentHintAgentStatus['state']
      tools?: Array<{ name: string; expected_duration_s?: number }>
      prob?: number
    }
  }
}

/** Runtime facts for one request, gathered by the plugin from DSH services. */
export interface HintRequestFacts {
  /** Session identity stamped by the agent loop. */
  sessionId: string
  /** Per-session call counter, already incremented for this request. */
  callIndex: number
  /** Per-session context version. */
  epoch: number
  /** When the session last entered `running` (latest tool/result), if observed. */
  runningSinceMs?: number
  /** Parent session id from the live session header, when resolvable. */
  parentSession?: string
  /** `origin` from the live session header (`'subagent'` under delegation). */
  parentOrigin?: string
  /** Parent's wait mode for this context, derived from the delegating tool call's `run_in_background`. */
  derivationJoin?: 'sync' | 'async'
}

/** Static per-composition behavior; every field optional with a default. */
export interface HintOptions {
  /** Agent type identifier reported in `session.agent_type`. */
  agentType: string
  /** Soft priority; `undefined` omits the field. */
  priority?: AgentHintPriority
  /** Cache control entries; `undefined` omits the field. */
  cacheControl?: AgentHintCacheControl[]
}

/**
 * Build one AgentHint for a main-line model request. The request-time state is
 * always `running` (a request is only prepared while the agent generates), so
 * the hint carries the tracked transition instant rather than a tool state:
 * serving-side consumers read it as "this request is interactive work".
 * @param facts - runtime facts gathered for this request.
 * @param options - static composition behavior.
 * @param nowMs - wall clock for the unobserved `state_since_ms` fallback.
 */
export function buildAgentHint(facts: HintRequestFacts, options: HintOptions, nowMs: number): AgentHint {
  const session: AgentHintSession = {
    session_id: facts.sessionId,
    agent_type: options.agentType,
    call_index: facts.callIndex,
    epoch: facts.epoch,
  }
  if (facts.parentSession !== undefined) {
    session.parent_session_id = facts.parentSession
    session.derivation = {
      relation: facts.parentOrigin === 'subagent' ? 'spawn' : 'fork',
      ...facts.derivationJoin !== undefined ? { join: facts.derivationJoin } : {},
    }
  }
  const hint: AgentHint = {
    session,
    agent_status: {
      state: 'running',
      state_since_ms: facts.runningSinceMs ?? nowMs,
    },
  }
  if (options.priority !== undefined) hint.priority = { ...options.priority }
  if (options.cacheControl !== undefined) {
    hint.cache_control = options.cacheControl.map(entry => ({
      ...entry,
      ...entry.range !== undefined ? { range: { ...entry.range } } : {},
    }))
  }
  return hint
}

/**
 * Encode one AgentHint as the `X-Agent-Hint` header value: UTF-8 JSON,
 * base64url (per the field definition — base64, URL-safe alphabet, no
 * padding symbols on the wire since Buffer's base64url omits `=`).
 * @param hint - the assembled hint object.
 */
export function encodeAgentHintHeader(hint: AgentHint): string {
  return Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url')
}

/* ------------------------------------------------------------------ *
 * Durable serving-fact derivation from the session event log
 * ------------------------------------------------------------------ */

/** The minimal session-log view the derivation reads (structural `Session.ownEvents`). */
export interface DerivationSession {
  ownEvents(): Array<{ type: string; time: number }>
}

/** Serving facts derived from the durable event log; all three survive process restarts (the log replays on restore). */
export interface ServingFacts {
  /** Main-line model calls so far, INCLUDING the current one: `step/start` is appended before each dispatch, so the count is the ordinal of the in-flight call. Auxiliary calls (compaction/session-title) run outside loop steps and never append `step/start`. */
  callIndex: number
  /** Context version: completions of compaction rewrites. */
  epoch: number
  /** When the session last entered `running` (latest tool/result), if the log has one. */
  runningSinceMs?: number
}

/**
 * Derive per-request serving facts from the session's own event log — the
 * durable, restart-safe basis (restored sessions replay their log, so counts
 * resume instead of resetting). Replaces the v2 in-memory `SessionTrack`.
 * @param session - the live session handle (structural `Session`).
 */
export function deriveServingFacts(session: DerivationSession): ServingFacts {
  let callIndex = 0
  let epoch = 0
  let runningSinceMs: number | undefined
  for (const event of session.ownEvents()) {
    if (event.type === 'step/start') callIndex += 1
    else if (event.type === 'compaction/end') epoch += 1
    else if (event.type === 'tool/result') runningSinceMs = event.time
  }
  return { callIndex, epoch, runningSinceMs }
}
