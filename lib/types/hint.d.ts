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
/** Session lifecycle state carried on the wire. */
export type SessionState = 'start' | 'append' | 'pause' | 'resume' | 'stop' | 'compact';
/** Lifecycle verbs that own a manage request (never `start` / `append`). */
export type ManageState = 'pause' | 'resume' | 'stop' | 'compact';
/** Context edit action, derived from the lifecycle verb. */
export type ContextEditType = 'offload' | 'prefetch' | 'evict';
/** Session block: who is calling, from which lineage, at which call, in which state. */
export interface AgentHintSession {
    /** Session id; stable within one context. */
    session_id: string;
    /** Parent session id; root sessions omit the field. */
    parent_session_id?: string;
    /** Call index inside the session, starting at 1. */
    call_index: number;
    /** Context version; bumped after a context rewrite (compaction). */
    epoch: number;
    /** Lifecycle state of this request. */
    state: SessionState;
}
/** One context edit. Only whole-session edits are emitted by a harness. */
export interface AgentHintEdit {
    type: ContextEditType;
    target: 'session';
}
/** Context management block: manage-request marker plus its edits. */
export interface AgentHintContextManagement {
    /** True: the request body is not executed, only the edits are processed. */
    manage_request: boolean;
    edits: AgentHintEdit[];
}
/** `priority_control.priority` block. */
export interface AgentHintPriority {
    level: number;
    reason: string;
}
/** `cache_control` block: one ephemeral declaration for the current prefix. */
export interface AgentHintCacheControl {
    type: 'ephemeral';
    /** Retention seconds for the current prefix. */
    ttl_s: number;
    /** 1-based effective message offset; equals the request's wire message count. */
    msg_offset: number;
}
/** The complete AgentHint object encoded into the `X-Agent-Hint` header value. */
export interface AgentHint {
    session: AgentHintSession;
    context_management?: AgentHintContextManagement;
    priority_control?: {
        priority: AgentHintPriority;
    };
    cache_control?: AgentHintCacheControl;
}
/** Verb → edit map shared by both adapters and the control client. */
export declare const STATE_EDIT: Readonly<Record<ManageState, ContextEditType>>;
/** Encode one AgentHint as the `X-Agent-Hint` header value (base64url, no padding). */
export declare function encodeAgentHintHeader(hint: AgentHint): string;
/** Facts for one ordinary request's hint. */
export interface OrdinaryHintFacts {
    sessionId: string;
    parentSessionId?: string | undefined;
    callIndex: number;
    epoch: number;
    /** `start` on a fresh session's first ordinary request, `append` afterwards. */
    state: 'start' | 'append';
    priority?: AgentHintPriority | undefined;
    cacheControl?: AgentHintCacheControl | undefined;
}
/** Build the hint for one ordinary (main-line) request. */
export declare function buildOrdinaryHint(facts: OrdinaryHintFacts): AgentHint;
/** Facts for one manage request's hint. */
export interface ManageHintFacts {
    sessionId: string;
    parentSessionId?: string | undefined;
    callIndex: number;
    /** For `compact`: the epoch of the context being evicted; otherwise the current one. */
    epoch: number;
    state: ManageState;
}
/**
 * Build the hint for one manage request: the verb plus the edit it asks for.
 * The request body is a placeholder (`messages: []`, `stream: false`) and the
 * consumer must not execute it as inference.
 */
export declare function buildManageHint(facts: ManageHintFacts): AgentHint;
/** One session-log event view the derivation reads (structural `Session.ownEvents`). */
export interface DerivationEvent {
    type: string;
    time: number;
    /** Event payload; read defensively because the harness vocabulary is merge-extensible. */
    data?: unknown;
}
/**
 * Read the tool-call id settled by one `tool/result` event. Two payload
 * vocabularies exist in the wild: harness ≥ 0.2.2 appends a first-class
 * tool-role message whose top-level `toolCallId` settles the call; earlier
 * versions wrapped the result in a `tool-result` content block on a user
 * message.
 */
export declare function toolResultCallId(event: DerivationEvent): string | undefined;
/** The minimal session-log view the derivation reads. */
export interface DerivationSession {
    ownEvents(): readonly DerivationEvent[];
}
/** Serving facts derived from the durable event log; all survive process restarts. */
export interface ServingFacts {
    /** Main-line model calls so far, INCLUDING the current one (`step/start` precedes dispatch). */
    callIndex: number;
    /** Context version: completions of compaction rewrites. */
    epoch: number;
    /** True when the in-flight call is the first of its turn (the two-level priority signal). */
    turnOpening: boolean;
    /** Last response-end → this request-start gap, when observed (the cache TTL source). */
    intervalMs?: number;
    /** A compaction rewrite completed after the previous main-line response (suppresses cache declarations). */
    afterCompaction: boolean;
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
export declare function deriveServingFacts(session: DerivationSession): ServingFacts;
