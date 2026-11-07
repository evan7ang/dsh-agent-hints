// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Out-of-band status event channel: the agent
 * framework reports lifecycle state transitions — `pause` (awaiting tool
 * executions; every tool call counts as "waiting on something external"),
 * `running` (back to generation), `finalize` (session end) — as state
 * events, separate from the per-request `X-Agent-Hint` header.
 *
 * `finalize` is SESSION-scoped (RFC §3.3): it means "this session is over,
 * session-level resources may be released" (consumers drop session-affinity
 * pins on it). It therefore fires exactly once per session from
 * `session/disposed` — never per turn. A multi-turn session emits one
 * `finalize` at the end of its lifetime, and it is always that session's
 * last event (no events follow a disposal).
 *
 * The four-value contract folds `tool` into `pause` at the sender, so no
 * `tool` state ever reaches the wire; diagnostics (`reason`, `tools[]`,
 * `child_session_id`) ride the event channel only.
 *
 * v1 sinks: a local JSONL file (append-only, per-emission order) and an HTTP
 * endpoint sink (`HttpStatusSink`, the scheduler/Motor status endpoint) — both
 * fire from the same `emit()` seam in emission order; a gateway client
 * replaces the HTTP sink there. Emission order is per-session by construction
 * (the firehose is ordered); append failures warn rather than queue (a local
 * file sink has no meaningful retry — the gateway implementation owns retry
 * policy).
 *
 * Parallel tool calls: `running` is reported only when the LAST pending call
 * settles; every `tool/call` re-reports the full pending set, with
 * `state_since_ms` pinned to when the pause episode began. Subagent
 * delegation: pending entries for delegation tools are named `agent:<toolName>`
 * and gain `child_session_id` when the child session first surfaces on the
 * firehose (FIFO binding to the oldest unbound entry).
 *
 * @module dsh-agent-hints/status
 */
import { appendFileSync } from 'node:fs';
import { toolResultCallId } from './hint.js';
/** Append one status event to the JSONL sink; single retry, then warn. */
export function appendStatusEvent(sinkPath, event, warn) {
    const line = JSON.stringify(event) + '\n';
    try {
        appendFileSync(sinkPath, line);
    }
    catch (firstError) {
        try {
            appendFileSync(sinkPath, line);
        }
        catch (error) {
            warn?.(`agent-hints: status sink append failed: ${String(error)} (first: ${String(firstError)})`);
        }
    }
}
/* ------------------------------------------------------------------ *
 * HTTP sink: POST StatusEvents to the scheduler endpoint (Motor Phase 4)
 * ------------------------------------------------------------------ */
const HTTP_RETRY_DELAYS_MS = [200, 400, 800];
const HTTP_TIMEOUT_MS = 5_000;
/**
 * One HTTP status sink: POSTs each event to the configured endpoint. A single
 * emitter instance owns one serial queue, so events reach the endpoint in
 * emission order (the firehose order = per-session order) even under retries;
 * a failing delivery retries with bounded backoff, then WARNs and drops that
 * event — the queue never blocks indefinitely and later events keep flowing
 * (a stuck scheduler must not stall the agent). Replace with a gateway client
 * for richer delivery semantics; `send()` is the seam.
 */
export class HttpStatusSink {
    endpoint;
    warn;
    queue = Promise.resolve();
    constructor(endpoint, warn) {
        this.endpoint = endpoint;
        this.warn = warn;
    }
    /** Enqueue one event; returns immediately (ordering and retries happen on the queue). */
    send(event) {
        this.queue = this.queue.then(() => this.deliver(event));
    }
    /** Wait for the queue to drain (test/teardown convenience). */
    drain() {
        return this.queue;
    }
    async deliver(event) {
        const body = JSON.stringify(event);
        for (let attempt = 0;; attempt += 1) {
            try {
                const response = await fetch(this.endpoint, {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body,
                    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
                });
                if (response.ok)
                    return;
                throw new Error(`HTTP ${response.status}`);
            }
            catch (error) {
                const delay = HTTP_RETRY_DELAYS_MS[attempt];
                if (delay === undefined) {
                    this.warn?.(`agent-hints: status endpoint ${this.endpoint} delivery failed after`
                        + ` ${HTTP_RETRY_DELAYS_MS.length + 1} attempts, event dropped: ${String(error)}`);
                    return;
                }
                await new Promise(resolve => setTimeout(resolve, delay));
            }
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
    emit;
    subagentToolNames;
    pending = new Map();
    /** When each session's current pause episode began (the empty → non-empty pending transition). */
    pauseSince = new Map();
    constructor(emit, subagentToolNames) {
        this.emit = emit;
        this.subagentToolNames = subagentToolNames;
    }
    /** Firehose entry: track pending tool calls, bind delegation children, and report completion. */
    onEvent(session, event) {
        const header = session.header;
        if (header.parentSession !== undefined && header.origin === 'subagent') {
            this.bindChild(header.parentSession, session.id);
        }
        if (event.type === 'tool/call') {
            const callId = event.data?.callId;
            const name = event.data?.name;
            if (callId === undefined || name === undefined)
                return;
            const calls = this.pendingOf(session.id);
            if (calls.size === 0)
                this.pauseSince.set(session.id, event.time);
            const displayName = this.subagentToolNames.has(name) ? `agent:${name}` : name;
            calls.set(callId, { name: displayName });
            this.reportPause(session.id);
            return;
        }
        if (event.type === 'tool/result') {
            const callId = toolResultCallId(event);
            if (callId === undefined)
                return;
            const calls = this.pendingOf(session.id);
            if (!calls.delete(callId))
                return;
            if (calls.size === 0) {
                // Parallel tools: report `running` only when the LAST result settles.
                this.pending.delete(session.id);
                this.pauseSince.delete(session.id);
                this.emit({
                    session: { session_id: session.id },
                    agent_status: { state: 'running', state_since_ms: event.time },
                });
            }
            return;
        }
        if (event.type === 'turn/end') {
            // A finished turn cannot leave live tool waits behind. A completed turn
            // is NOT finalize: `finalize` is session-scoped and fires from
            // `session/disposed` (see `onDispose`); DSH's `agent/status` `idle` is
            // not finalize either.
            this.pending.delete(session.id);
            this.pauseSince.delete(session.id);
        }
    }
    /**
     * Session teardown: the one and only `finalize` trigger. The disposal is
     * the session's end of life (store retirement), so the event is always the
     * session's last — exactly one per session lifetime. Sessions that never
     * close legitimately never finalize; header-only sessions (requests but no
     * tool waits) still need the release signal, so disposal finalizes every
     * session unconditionally.
     */
    onDispose(session) {
        this.pending.delete(session.id);
        this.pauseSince.delete(session.id);
        this.emit({
            session: { session_id: session.id },
            agent_status: { state: 'finalize', state_since_ms: Date.now() },
        });
    }
    pendingOf(sessionId) {
        const existing = this.pending.get(sessionId);
        if (existing !== undefined)
            return existing;
        const created = new Map();
        this.pending.set(sessionId, created);
        return created;
    }
    /** Report the pause episode: state pinned to when the episode began. */
    reportPause(sessionId) {
        const calls = this.pending.get(sessionId);
        const since = this.pauseSince.get(sessionId);
        if (calls === undefined || calls.size === 0 || since === undefined)
            return;
        const entries = [...calls.entries()];
        this.emit({
            session: { session_id: sessionId },
            agent_status: {
                state: 'pause',
                state_since_ms: since,
                reason: 'await_tool',
                tools: entries.map(([callId, entry]) => ({
                    name: entry.name,
                    call_id: callId,
                    ...entry.childSessionId !== undefined ? { child_session_id: entry.childSessionId } : {},
                })),
            },
        });
    }
    bindChild(parentSessionId, childSessionId) {
        const calls = this.pending.get(parentSessionId);
        if (calls === undefined)
            return;
        for (const entry of calls.values()) {
            if (!entry.name.startsWith('agent:') || entry.childSessionId !== undefined)
                continue;
            entry.childSessionId = childSessionId;
            this.reportPause(parentSessionId);
            return;
        }
    }
}
