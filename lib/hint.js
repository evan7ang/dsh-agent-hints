// SPDX-License-Identifier: Apache-2.0
/**
 * AgentHint construction per the Agent Hint field definition (字段&实现定义):
 * the schema is the protocol contract, the values are derived from DSH runtime
 * facts (sessionId, session header lineage, session event tracking). Pure and
 * side-effect free so the wire shape is unit-testable without a harness.
 *
 * @module dsh-agent-hints/hint
 */
/**
 * Build one AgentHint for a main-line model request. The request-time state is
 * always `running` (a request is only prepared while the agent generates), so
 * the hint carries the tracked transition instant rather than a tool state:
 * serving-side consumers read it as "this request is interactive work".
 * @param facts - runtime facts gathered for this request.
 * @param options - static composition behavior.
 * @param nowMs - wall clock for the unobserved `state_since_ms` fallback.
 */
export function buildAgentHint(facts, options, nowMs) {
    const session = {
        session_id: facts.sessionId,
        agent_type: options.agentType,
        call_index: facts.callIndex,
        epoch: facts.epoch,
    };
    if (facts.parentSession !== undefined) {
        session.parent_session_id = facts.parentSession;
        session.derivation = {
            relation: facts.parentOrigin === 'subagent' ? 'spawn' : 'fork',
            ...facts.derivationJoin !== undefined ? { join: facts.derivationJoin } : {},
        };
    }
    const hint = {
        session,
        agent_status: {
            state: 'running',
            state_since_ms: facts.runningSinceMs ?? nowMs,
        },
    };
    if (options.priority !== undefined)
        hint.priority = { ...options.priority };
    if (options.cacheControl !== undefined) {
        hint.cache_control = options.cacheControl.map(entry => ({
            ...entry,
            ...entry.range !== undefined ? { range: { ...entry.range } } : {},
        }));
    }
    return hint;
}
/**
 * Encode one AgentHint as the `X-Agent-Hint` header value: UTF-8 JSON,
 * base64url (per the field definition — base64, URL-safe alphabet, no
 * padding symbols on the wire since Buffer's base64url omits `=`).
 * @param hint - the assembled hint object.
 */
export function encodeAgentHintHeader(hint) {
    return Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url');
}
/**
 * Derive per-request serving facts from the session's own event log — the
 * durable, restart-safe basis (restored sessions replay their log, so counts
 * resume instead of resetting). Replaces the v2 in-memory `SessionTrack`.
 * @param session - the live session handle (structural `Session`).
 */
export function deriveServingFacts(session) {
    let callIndex = 0;
    let epoch = 0;
    let runningSinceMs;
    for (const event of session.ownEvents()) {
        if (event.type === 'step/start')
            callIndex += 1;
        else if (event.type === 'compaction/end')
            epoch += 1;
        else if (event.type === 'tool/result')
            runningSinceMs = event.time;
    }
    return { callIndex, epoch, runningSinceMs };
}
