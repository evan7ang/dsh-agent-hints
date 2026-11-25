// SPDX-License-Identifier: MulanPSL-2.0
/**
 * AgentHint construction for the normalized protocol: four blocks
 * (`session` / `context_management` / `priority_control` / `cache_control`)
 * encoded as UTF-8 JSON into the `X-Agent-Hint` header (base64url, no padding).
 *
 * The request body never carries hint fields. Ordinary requests carry the
 * session identity, the two-level priority and the dynamic cache declaration;
 * session lifecycle verbs (`pause` / `resume` / `stop` / `compact`) travel on
 * dedicated manage requests together with an explicit session-targeted edit.
 *
 * Pure and side-effect free so the wire shape is unit-testable without a
 * harness. The schema is the protocol contract; the values are derived from
 * DSH runtime facts (session log, session header, config).
 *
 * @module @deepseek-ai/dsh-agent-hints/hint
 */
/** Verb → edit map shared by both adapters and the control client. */
export const STATE_EDIT = Object.freeze({
    pause: 'offload',
    resume: 'prefetch',
    stop: 'evict',
    compact: 'evict',
});
/** Encode one AgentHint as the `X-Agent-Hint` header value (base64url, no padding). */
export function encodeAgentHintHeader(hint) {
    return Buffer.from(JSON.stringify(hint), 'utf8').toString('base64url');
}
/** Build the hint for one ordinary (main-line) request. */
export function buildOrdinaryHint(facts) {
    const session = {
        session_id: facts.sessionId,
        call_index: facts.callIndex,
        epoch: facts.epoch,
        state: facts.state,
    };
    if (facts.parentSessionId !== undefined)
        session.parent_session_id = facts.parentSessionId;
    const hint = { session };
    if (facts.priority !== undefined)
        hint.priority_control = { priority: { ...facts.priority } };
    if (facts.cacheControl !== undefined)
        hint.cache_control = { ...facts.cacheControl };
    return hint;
}
/**
 * Build the hint for one manage request: the verb plus the edit it asks for.
 * The request body is a placeholder (`messages: []`, `stream: false`) and the
 * consumer must not execute it as inference.
 */
export function buildManageHint(facts) {
    const session = {
        session_id: facts.sessionId,
        call_index: facts.callIndex,
        epoch: facts.epoch,
        state: facts.state,
    };
    if (facts.parentSessionId !== undefined)
        session.parent_session_id = facts.parentSessionId;
    return {
        session,
        context_management: {
            manage_request: true,
            edits: [{ type: STATE_EDIT[facts.state], target: 'session' }],
        },
    };
}
/**
 * Read the tool-call id settled by one `tool/result` event. Two payload
 * vocabularies exist in the wild: harness ≥ 0.2.2 appends a first-class
 * tool-role message whose top-level `toolCallId` settles the call; earlier
 * versions wrapped the result in a `tool-result` content block on a user
 * message.
 */
export function toolResultCallId(event) {
    if (typeof event.data !== 'object' || event.data === null)
        return undefined;
    const message = event.data.message;
    if (typeof message !== 'object' || message === null)
        return undefined;
    const settled = message;
    if (typeof settled.toolCallId === 'string')
        return settled.toolCallId;
    if (!Array.isArray(settled.content))
        return undefined;
    for (const block of settled.content) {
        if (typeof block !== 'object' || block === null)
            continue;
        const candidate = block;
        if (candidate.type === 'tool-result' && typeof candidate.toolCallId === 'string')
            return candidate.toolCallId;
    }
    return undefined;
}
/**
 * Derive per-request serving facts from the session's own event log — the
 * durable, restart-safe basis (restored sessions replay their log).
 *
 * - `call_index` counts `step/start` events, appended before each dispatch.
 * - `epoch` counts `compaction/end` events (one history rewrite each).
 * - `turnOpening` is the first call after the latest `turn/start`
 *   (falling back to `callIndex === 1` when the log has no turn boundaries).
 * - `intervalMs` is the previous `step/end` to this request's `step/start`.
 * - `afterCompaction` flags a rewrite after the previous response end.
 * @param session - the live session handle (structural `Session`).
 */
export function deriveServingFacts(session) {
    let callIndex = 0;
    let epoch = 0;
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
        }
    }
    const turnOpening = turnStartSeen ? stepsSinceTurnStart === 1 : callIndex === 1;
    const intervalMs = lastStepStartAt !== undefined && stepEndBeforeLastStepStart !== undefined
        && lastStepStartAt > stepEndBeforeLastStepStart
        ? lastStepStartAt - stepEndBeforeLastStepStart
        : undefined;
    const afterCompaction = lastCompactionAt !== undefined
        && lastCompactionAt > (stepEndBeforeLastStepStart ?? Number.NEGATIVE_INFINITY);
    return { callIndex, epoch, turnOpening, intervalMs, afterCompaction };
}
