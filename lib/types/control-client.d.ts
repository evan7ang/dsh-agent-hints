import { type ManageState } from './hint.js';
import type { HintTrace } from './trace.js';
export type ControlResult = {
    status: 'accepted';
    httpStatus: number;
} | {
    status: 'failed';
    retryable: boolean;
    httpStatus?: number;
} | {
    status: 'unknown';
} | {
    status: 'cancelled';
    dispatched: boolean;
};
export interface ControlWarnSink {
    (message: string, error?: unknown): void;
}
export interface ControlConnection {
    endpoint: string;
    apiKey: string | undefined;
    authHeader?: 'authorization' | 'x-api-key';
}
/** Durable per-session facts a manage request carries. */
export interface ManageSessionFacts {
    callIndex: number;
    epoch: number;
    parentSessionId?: string | undefined;
}
export interface SessionControlClientOptions {
    resolveConnection?: () => Promise<ControlConnection>;
    endpoint: string;
    resolveApiKey: () => Promise<string | undefined>;
    model: string;
    timeoutMs: number;
    retries: number;
    /** Durable facts of the target session; absence still sends the verb with call_index 1 / epoch 0. */
    sessionFacts?: (sessionId: string) => ManageSessionFacts | undefined;
    warn?: ControlWarnSink;
    trace?: HintTrace;
}
export declare const DEFAULT_CONTROL_TIMEOUT_MS = 5000;
export declare const DEFAULT_CONTROL_RETRIES = 1;
export declare class SessionControlClient {
    private readonly options;
    constructor(options: SessionControlClientOptions);
    /** No automatic retry of mutating verbs or ambiguous network outcomes. */
    send(verb: ManageState | 'start', sessionId: string, model?: string, signal?: AbortSignal, canSend?: () => boolean): Promise<ControlResult>;
    private attempt;
}
