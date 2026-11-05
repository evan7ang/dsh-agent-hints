// SPDX-License-Identifier: MulanPSL-2.0
/**
 * AgentHint construction: the schema is the protocol contract, the values are
 * derived from DSH runtime
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

/**
 * `agent_status` block as carried on the request header: the four-value
 * lifecycle contract, and ONLY `state` + `state_since_ms` (diagnostic fields
 * stay on the out-of-band event channel). DSH never sends `finalize` on the
 * header — a completed run has no closing request — so it rides the
 * `turn/end(completed)` status event instead.
 */
export interface AgentHintAgentStatus {
  state: 'running' | 'pause' | 'resume' | 'finalize'
  /** Unix epoch milliseconds when the current state was entered. */
  state_since_ms: number
}

/** `priority` / `strict_priority` block. `strict_priority` is never sent by an agent: it is reserved for a trusted control plane. */
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

/**
 * `prediction` block: pre-event estimates for the serving engine (field
 * definition §2.6); actual state is whatever the following `agent_status`
 * reports. The prediction family is unchanged by the four-value convergence —
 * its `next_action.state` keeps the full protocol vocabulary.
 */
export interface AgentHintPrediction {
  latency_ms?: number
  remaining_calls?: number
  output_tokens?: number
  interval_ms?: number
  remaining_time_ms?: number
  expected_resume_s?: number
  next_action?: {
    state: 'running' | 'tool' | 'pause' | 'suspend' | 'finalize'
    tools?: Array<{ name: string; expected_duration_s?: number }>
    prob?: number
  }
}

/** The complete AgentHint object encoded into the `X-Agent-Hint` header value. */
export interface AgentHint {
  session: AgentHintSession
  agent_status?: AgentHintAgentStatus
  priority?: AgentHintPriority
  strict_priority?: AgentHintPriority
  cache_control?: AgentHintCacheControl | AgentHintCacheControl[]
  prediction?: AgentHintPrediction
}

/** Runtime facts for one request, gathered by the plugin from DSH services. */
export interface HintRequestFacts {
  /** Session identity stamped by the agent loop. */
  sessionId: string
  /** Per-session call counter, already incremented for this request. */
  callIndex: number
  /** Per-session context version. */
  epoch: number
  /** Request-time lifecycle state (DSH never sends `finalize` on the header). */
  state: 'running' | 'pause' | 'resume'
  /** When the current state was entered; `undefined` for `running` with no observed entry (falls back to the request time). */
  stateSinceMs?: number
  /** Parent session id from the live session header, when resolvable. */
  parentSession?: string
  /** `origin` from the live session header (`'subagent'` under delegation). */
  parentOrigin?: string
  /** Parent's wait mode for this context, derived from the delegating tool call's `run_in_background`. */
  derivationJoin?: 'sync' | 'async'
  /** Per-request soft priority (dynamic two-level or a static override); `undefined` omits the field. */
  priority?: AgentHintPriority
  /** Per-request cache control entries; `undefined` omits the field. */
  cacheControl?: AgentHintCacheControl[]
  /** Resolved `prediction` block for this request; `undefined` omits the block. */
  prediction?: AgentHintPrediction
}

/** Static per-composition behavior. */
export interface HintOptions {
  /** Agent type identifier reported in `session.agent_type`. */
  agentType: string
}

/**
 * Build one AgentHint for a main-line model request. Status and intent come
 * from the per-request facts: the status is the tracked four-value state, the
 * priority is the dynamic two-level value (or a static override), and cache
 * control is the derived single ephemeral declaration.
 * @param facts - runtime facts gathered for this request.
 * @param options - static composition behavior.
 * @param nowMs - wall clock for an unobserved `state_since_ms` fallback.
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
      state: facts.state,
      state_since_ms: facts.stateSinceMs ?? nowMs,
    },
  }
  if (facts.priority !== undefined) hint.priority = { ...facts.priority }
  if (facts.cacheControl !== undefined) {
    hint.cache_control = facts.cacheControl.map(entry => ({
      ...entry,
      ...entry.range !== undefined ? { range: { ...entry.range } } : {},
    }))
  }
  if (facts.prediction !== undefined) hint.prediction = { ...facts.prediction }
  return hint
}

/**
 * Encode one AgentHint as the `X-Agent-Hint` header value: UTF-8 JSON,
 * base64url (base64 with a URL-safe alphabet; no `=` padding on the wire
 * since Buffer's base64url omits it).
 * @param hint - the assembled hint object.
 */
export function encodeAgentHintHeader(hint: AgentHint): string {
  return Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url')
}

/* ------------------------------------------------------------------ *
 * Durable serving-fact derivation from the session event log
 * ------------------------------------------------------------------ */

/** One session-log event view the derivation reads (structural `Session.ownEvents`). */
export interface DerivationEvent {
  type: string
  time: number
  data?: {
    /** `tool/call`: provider-issued call id pairing call with result. */
    callId?: unknown
    /** `tool/result`: the result message whose content blocks carry the settled `toolCallId`. */
    message?: { content?: Array<{ type?: unknown; toolCallId?: unknown }> }
  }
}

/** The minimal session-log view the derivation reads. */
export interface DerivationSession {
  ownEvents(): DerivationEvent[]
}

/** Serving facts derived from the durable event log; all survive process restarts (the log replays on restore). */
export interface ServingFacts {
  /** Main-line model calls so far, INCLUDING the current one: `step/start` is appended before each dispatch, so the count is the ordinal of the in-flight call. Auxiliary calls (compaction/session-title) run outside loop steps and never append `step/start`. */
  callIndex: number
  /** Context version: completions of compaction rewrites. */
  epoch: number
  /** Request-time lifecycle state (four-value contract minus `finalize`, which never rides the header in DSH). */
  state: 'running' | 'pause' | 'resume'
  /** When the current state was entered; `undefined` for `running` with no observed entry (request time fallback). */
  stateSinceMs?: number
  /** True when the in-flight call is the first of its turn — the user-intervention signal for the two-level priority. */
  turnOpening: boolean
  /** Last response-end → this request-start gap, when observed (the cache TTL source). */
  intervalMs?: number
  /** A compaction rewrite completed between the previous and the current main-line call (suppresses cache declarations for that round). */
  afterCompaction: boolean
}

function resultCallId(event: DerivationEvent): string | undefined {
  const block = event.data?.message?.content?.find(candidate => candidate?.type === 'tool-result')
  const id = block?.toolCallId
  return typeof id === 'string' ? id : undefined
}

/**
 * Derive per-request serving facts from the session's own event log — the
 * durable, restart-safe basis (restored sessions replay their log).
 *
 * Lifecycle state (per the handoff contract): an unpaired `tool/call` means
 * the agent is paused awaiting the tool; the first call after the pending set
 * last emptied is `resume`; everything else is `running`. Any `turn/end`
 * closes the resume window (the next turn opens as `running`).
 *
 * Priority signal: `turnOpening` is the first call after the latest
 * `turn/start` (falling back to `callIndex === 1` when the log has no turn
 * boundary events).
 *
 * Cache signals: `intervalMs` is the previous response end (`step/end`) to
 * this request start; `afterCompaction` flags a rewrite between the previous
 * and the current call.
 * @param session - the live session handle (structural `Session`).
 */
export function deriveServingFacts(session: DerivationSession): ServingFacts {
  let callIndex = 0
  let epoch = 0
  const pending = new Map<string, number>()
  let pauseSinceMs: number | undefined
  let releaseAt: number | undefined
  let stepsAfterRelease = 0
  let turnEndAfterRelease = false
  let latestTurnStartAt: number | undefined
  let turnStartSeen = false
  let stepsSinceTurnStart = 0
  let lastStepStartAt: number | undefined
  let lastStepEndAt: number | undefined
  let stepEndBeforeLastStepStart: number | undefined
  let lastCompactionAt: number | undefined

  for (const event of session.ownEvents()) {
    switch (event.type) {
      case 'turn/start':
        turnStartSeen = true
        latestTurnStartAt = event.time
        stepsSinceTurnStart = 0
        break
      case 'step/start':
        callIndex += 1
        stepsSinceTurnStart += 1
        stepsAfterRelease += 1
        lastStepStartAt = event.time
        stepEndBeforeLastStepStart = lastStepEndAt
        break
      case 'step/end':
        lastStepEndAt = event.time
        break
      case 'compaction/end':
        epoch += 1
        lastCompactionAt = event.time
        break
      case 'tool/call': {
        const callId = typeof event.data?.callId === 'string' ? event.data.callId : undefined
        if (callId !== undefined) {
          if (pending.size === 0) pauseSinceMs = event.time
          pending.set(callId, event.time)
        }
        break
      }
      case 'tool/result': {
        const callId = resultCallId(event)
        if (callId !== undefined && pending.delete(callId) && pending.size === 0) {
          pauseSinceMs = undefined
          releaseAt = event.time
          stepsAfterRelease = 0
          turnEndAfterRelease = false
        }
        break
      }
      case 'turn/end':
        pending.clear()
        pauseSinceMs = undefined
        turnEndAfterRelease = true
        break
    }
  }

  let state: ServingFacts['state']
  let stateSinceMs: number | undefined
  if (pending.size > 0) {
    state = 'pause'
    stateSinceMs = pauseSinceMs
  } else if (releaseAt !== undefined && !turnEndAfterRelease && stepsAfterRelease === 1) {
    state = 'resume'
    stateSinceMs = releaseAt
  } else {
    state = 'running'
    stateSinceMs = latestTurnStartAt !== undefined && releaseAt !== undefined
      ? Math.max(latestTurnStartAt, releaseAt)
      : latestTurnStartAt ?? releaseAt
  }

  const turnOpening = turnStartSeen ? stepsSinceTurnStart === 1 : callIndex === 1
  const intervalMs = lastStepStartAt !== undefined && stepEndBeforeLastStepStart !== undefined
    && lastStepStartAt > stepEndBeforeLastStepStart
    ? lastStepStartAt - stepEndBeforeLastStepStart
    : undefined
  // A compaction rewrite after the previous response end (between steps, or
  // mid-step for an overflow-recovery retry) changed the prefix this round.
  const afterCompaction = lastCompactionAt !== undefined
    && lastCompactionAt > (stepEndBeforeLastStepStart ?? Number.NEGATIVE_INFINITY)

  return { callIndex, epoch, state, stateSinceMs, turnOpening, intervalMs, afterCompaction }
}
