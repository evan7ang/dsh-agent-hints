// SPDX-License-Identifier: MulanPSL-2.0
/**
 * AgentHint construction: the schema is the protocol contract, the values are
 * derived from DSH runtime
 * facts (sessionId, session header lineage, session event tracking). Pure and
 * side-effect free so the wire shape is unit-testable without a harness.
 *
 * @module dsh-agent-hints/hint
 */
/**
 * Build one AgentHint for a main-line model request. Status and intent come
 * from the per-request facts: the status is the tracked four-value state, the
 * priority is the dynamic two-level value (or a static override), and cache
 * control is the derived single ephemeral declaration.
 * @param facts - runtime facts gathered for this request.
 * @param options - static composition behavior.
 * @param nowMs - wall clock for an unobserved `state_since_ms` fallback.
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
            state: facts.state,
            state_since_ms: facts.stateSinceMs ?? nowMs,
        },
    };
    if (facts.priority !== undefined)
        hint.priority = { ...facts.priority };
    if (facts.cacheControl !== undefined) {
        hint.cache_control = facts.cacheControl.map(entry => ({
            ...entry,
            ...entry.range !== undefined ? { range: { ...entry.range } } : {},
        }));
    }
    if (facts.prediction !== undefined)
        hint.prediction = { ...facts.prediction };
    return hint;
}
/**
 * Encode one AgentHint as the `X-Agent-Hint` header value: UTF-8 JSON,
 * base64url (base64 with a URL-safe alphabet; no `=` padding on the wire
 * since Buffer's base64url omits it).
 * @param hint - the assembled hint object.
 */
export function encodeAgentHintHeader(hint) {
    return Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url');
}
function resultCallId(event) {
    const block = event.data?.message?.content?.find(candidate => candidate?.type === 'tool-result');
    const id = block?.toolCallId;
    return typeof id === 'string' ? id : undefined;
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
export function deriveServingFacts(session) {
    let callIndex = 0;
    let epoch = 0;
    const pending = new Map();
    let pauseSinceMs;
    let releaseAt;
    let stepsAfterRelease = 0;
    let turnEndAfterRelease = false;
    let latestTurnStartAt;
    let turnStartSeen = false;
    let stepsSinceTurnStart = 0;
    let lastStepStartAt;
    let lastStepEndAt;
    let stepEndBeforeLastStepStart;
    let lastCompactionAt;
    for (const event of session.ownEvents()) {
        switch (event.type) {
            case 'turn/start':
                turnStartSeen = true;
                latestTurnStartAt = event.time;
                stepsSinceTurnStart = 0;
                break;
            case 'step/start':
                callIndex += 1;
                stepsSinceTurnStart += 1;
                stepsAfterRelease += 1;
                lastStepStartAt = event.time;
                stepEndBeforeLastStepStart = lastStepEndAt;
                break;
            case 'step/end':
                lastStepEndAt = event.time;
                break;
            case 'compaction/end':
                epoch += 1;
                lastCompactionAt = event.time;
                break;
            case 'tool/call': {
                const callId = typeof event.data?.callId === 'string' ? event.data.callId : undefined;
                if (callId !== undefined) {
                    if (pending.size === 0)
                        pauseSinceMs = event.time;
                    pending.set(callId, event.time);
                }
                break;
            }
            case 'tool/result': {
                const callId = resultCallId(event);
                if (callId !== undefined && pending.delete(callId) && pending.size === 0) {
                    pauseSinceMs = undefined;
                    releaseAt = event.time;
                    stepsAfterRelease = 0;
                    turnEndAfterRelease = false;
                }
                break;
            }
            case 'turn/end':
                pending.clear();
                pauseSinceMs = undefined;
                turnEndAfterRelease = true;
                break;
        }
    }
    let state;
    let stateSinceMs;
    if (pending.size > 0) {
        state = 'pause';
        stateSinceMs = pauseSinceMs;
    }
    else if (releaseAt !== undefined && !turnEndAfterRelease && stepsAfterRelease === 1) {
        state = 'resume';
        stateSinceMs = releaseAt;
    }
    else {
        state = 'running';
        stateSinceMs = latestTurnStartAt !== undefined && releaseAt !== undefined
            ? Math.max(latestTurnStartAt, releaseAt)
            : latestTurnStartAt ?? releaseAt;
    }
    const turnOpening = turnStartSeen ? stepsSinceTurnStart === 1 : callIndex === 1;
    const intervalMs = lastStepStartAt !== undefined && stepEndBeforeLastStepStart !== undefined
        && lastStepStartAt > stepEndBeforeLastStepStart
        ? lastStepStartAt - stepEndBeforeLastStepStart
        : undefined;
    // A compaction rewrite after the previous response end (between steps, or
    // mid-step for an overflow-recovery retry) changed the prefix this round.
    const afterCompaction = lastCompactionAt !== undefined
        && lastCompactionAt > (stepEndBeforeLastStepStart ?? Number.NEGATIVE_INFINITY);
    return { callIndex, epoch, state, stateSinceMs, turnOpening, intervalMs, afterCompaction };
}
