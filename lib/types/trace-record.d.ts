/** Content-free diagnostic records written to stdout and the DSH Session log. */
/** The normalized wire fields worth diagnosing, with no prompts or payload text. */
export interface HintTraceSummary {
    session_id: string;
    state: string;
    call_index?: number;
    epoch?: number;
    parent_session_id?: string;
    context_management?: {
        manage_request: boolean;
        edits: string[];
    };
    priority_control?: {
        level: number;
        reason: string;
    };
    cache_control?: {
        ttl_s: number;
        msg_offset: number;
    };
}
export interface HintTraceRecord {
    schemaVersion: 2;
    requestId: string;
    time: string;
    sessionId: string;
    plane: 'data' | 'control';
    transport: 'chat' | 'messages';
    model: string;
    attempt: number;
    phase: 'prepared' | 'dispatch' | 'result';
    outcome: 'prepared' | 'dispatching' | 'accepted' | 'rejected' | 'unknown' | 'cancelled' | 'not-dispatched';
    /** HTTP acceptance is never proof of KV completion or successful generation. */
    httpStatus?: number;
    durationMs?: number;
    dispatched?: boolean;
    hint: HintTraceSummary;
}
