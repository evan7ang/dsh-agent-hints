import type { AgentHint } from './hint.js';
import type { HintTraceRecord } from './trace-record.ts';
export interface HintTraceFacts {
    plane: HintTraceRecord['plane'];
    transport: HintTraceRecord['transport'];
    model: string;
    hint: AgentHint;
    attempt?: number;
    requestId?: string;
}
export interface HintTraceAttempt {
    readonly requestId?: string;
    dispatch(): void;
    finish(outcome: Extract<HintTraceRecord['outcome'], 'accepted' | 'rejected' | 'unknown' | 'cancelled' | 'not-dispatched'>, details?: {
        httpStatus?: number;
        dispatched?: boolean;
    }): void;
}
export declare class HintTrace {
    private readonly options;
    private readonly records;
    constructor(options?: {
        enabled?: boolean;
        maxRecords?: number;
        log?: (record: HintTraceRecord) => void;
        /**
         * Durable mirror into the Session log. Called only for each attempt's
         * terminal `result` record, so the log gains one line per attempt. The sink
         * must not throw; `emit` contains it regardless.
         */
        writeSessionRecord?: (record: HintTraceRecord) => void;
    });
    /**
     * Records this process holds for one session, in emission order.
     *
     * The window keeps every attempt phase, unlike the Session log, which carries
     * only the terminal record; read it for in-process diagnosis and tests.
     * @param sessionId - session whose records to return.
     * @returns a detached copy; mutating it cannot alter retained records.
     */
    recordsOf(sessionId: string): HintTraceRecord[];
    begin(facts: HintTraceFacts, phase?: 'prepared' | 'dispatch'): HintTraceAttempt;
    private get limit();
    private emit;
}
