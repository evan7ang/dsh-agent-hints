// SPDX-License-Identifier: Apache-2.0
/**
 * Out-of-band status event channel (field definition §4/§5): the agent
 * framework reports lifecycle state transitions — `tool` (awaiting tool
 * executions), `running` (back to generation), `finalize` (task completion) — as
 * state events, separate from the per-request `X-Agent-Hint` header.
 *
 * v1 sink is a local JSONL file (append-only, per-emission order), standing in
 * for the future scheduler gateway; `emit()` is the seam a gateway client
 * replaces. Emission order is per-session by construction (the firehose is
 * ordered); append failures warn rather than queue (a local file sink has no
 * meaningful retry — the gateway implementation owns retry policy).
 *
 * Parallel tool calls: `running` is reported only when the LAST pending call
 * settles (per protocol §5); every `tool/call` re-reports the full pending
 * set. Subagent delegation: pending entries for delegation tools are named
 * `agent:<toolName>` and gain `child_session_id` when the child session first
 * surfaces on the firehose (FIFO binding to the oldest unbound entry).
 *
 * @module dsh-agent-hints/status
 */

import { appendFileSync } from 'node:fs'
import type { SessionEventLike, SessionLike } from '@deepseek-ai/cordis'

/** One wire status event (field definition §4 table rows ②/③/⑤…). */
export interface StatusEvent {
  session: { session_id: string }
  agent_status: {
    state: 'running' | 'tool' | 'pause' | 'suspend' | 'finalize'
    state_since_ms: number
    reason?: string
    tools?: Array<{ name: string; call_id?: string; child_session_id?: string }>
  }
}

interface PendingCall {
  name: string
  childSessionId?: string
}

/** Append one status event to the JSONL sink; single retry, then warn. */
export function appendStatusEvent(sinkPath: string, event: StatusEvent, warn?: (message: string) => void): void {
  const line = JSON.stringify(event) + '\n'
  try {
    appendFileSync(sinkPath, line)
  } catch (firstError) {
    try {
      appendFileSync(sinkPath, line)
    } catch (error) {
      warn?.(`agent-hints: status sink append failed: ${String(error)} (first: ${String(firstError)})`)
    }
  }
}

/**
 * Lifecycle state machine over the session event firehose. One instance
 * serves every session: pending tool-call sets are per session, subagent
 * child binding matches child sessions to their parent's oldest unbound
 * delegation call.
 */
export class StatusObserver {
  private readonly pending = new Map<string, Map<string, PendingCall>>()

  constructor(
    private readonly emit: (event: StatusEvent) => void,
    private readonly subagentToolNames: ReadonlySet<string>,
  ) {}

  /** Firehose entry: track pending tool calls, bind delegation children, and report completion. */
  onEvent(session: SessionLike, event: SessionEventLike): void {
    const header = session.header
    if (header.parentSession !== undefined && header.origin === 'subagent') {
      this.bindChild(header.parentSession, session.id)
    }
    if (event.type === 'tool/call') {
      const callId = event.data?.callId
      const name = event.data?.name
      if (callId === undefined || name === undefined) return
      const calls = this.pendingOf(session.id)
      const displayName = this.subagentToolNames.has(name) ? `agent:${name}` : name
      calls.set(callId, { name: displayName })
      this.reportTool(session.id, event.time)
      return
    }
    if (event.type === 'tool/result') {
      const callId = event.data?.message?.content?.find(block => block?.type === 'tool-result')?.toolCallId
      if (callId === undefined) return
      const calls = this.pendingOf(session.id)
      if (!calls.delete(callId)) return
      if (calls.size === 0) {
        // Parallel tools: report `running` only when the LAST result settles.
        this.pending.delete(session.id)
        this.emit({
          session: { session_id: session.id },
          agent_status: { state: 'running', state_since_ms: event.time },
        })
      }
      return
    }
    if (event.type === 'turn/end' && event.data?.reason?.kind === 'completed') {
      // Business-side completion verdict for the one-shot office bundle: a
      // completed turn means the task finished (headless exit path). DSH's
      // `agent/status` `idle` is NOT mapped (protocol finalize ≠ idle).
      this.pending.delete(session.id)
      this.emit({
        session: { session_id: session.id },
        agent_status: { state: 'finalize', state_since_ms: event.time },
      })
    }
  }

  private pendingOf(sessionId: string): Map<string, PendingCall> {
    const existing = this.pending.get(sessionId)
    if (existing !== undefined) return existing
    const created = new Map<string, PendingCall>()
    this.pending.set(sessionId, created)
    return created
  }

  private reportTool(sessionId: string, time: number): void {
    const calls = this.pending.get(sessionId)
    if (calls === undefined || calls.size === 0) return
    this.emit({
      session: { session_id: sessionId },
      agent_status: {
        state: 'tool',
        state_since_ms: time,
        reason: 'await_tool',
        tools: [...calls.entries()].map(([callId, entry]) => ({
          name: entry.name,
          call_id: callId,
          ...entry.childSessionId !== undefined ? { child_session_id: entry.childSessionId } : {},
        })),
      },
    })
  }

  private bindChild(parentSessionId: string, childSessionId: string): void {
    const calls = this.pending.get(parentSessionId)
    if (calls === undefined) return
    for (const entry of calls.values()) {
      if (!entry.name.startsWith('agent:') || entry.childSessionId !== undefined) continue
      entry.childSessionId = childSessionId
      this.reportTool(parentSessionId, Date.now())
      return
    }
  }
}
