/** Session control queue, bounded barriers and ordinary-request leases. */
import type { Context } from '@deepseek-ai/cordis';
import type { AgentStatus } from '@deepseek-ai/dsh-agent';
import type { Session, SessionEvent, SessionId } from '@deepseek-ai/dsh-session';
import type { SessionControlClient } from './control-client.ts';
import { LlmError } from '@deepseek-ai/dsh-llm';
export interface BridgeWarnSink {
    (message: string, error?: unknown): void;
}
export interface LifecycleBridgeOptions {
    client: SessionControlClient;
    pendingOpAwaitMs: number;
    /** How long a disposed-but-unsafe session stays quarantined before its state is dropped. */
    quarantineTtlMs?: number;
    warn?: BridgeWarnSink;
}
export declare const DEFAULT_PENDING_OP_AWAIT_MS = 2000;
export declare const DEFAULT_QUARANTINE_TTL_MS: number;
/** @deprecated Retained for API compatibility. Session lineage is no longer inferred by time. */
export declare const COMPACTION_LINEAGE_WINDOW_MS = 60000;
export declare class ControlBarrierError extends LlmError {
    constructor();
}
export declare class LifecycleBridge {
    private readonly options;
    private readonly states;
    private lastOrdinarySessionId;
    private disposed;
    private readonly lifetime;
    get signal(): AbortSignal;
    constructor(options: LifecycleBridgeOptions);
    subscribe(ctx: Context): void;
    dispose(): void;
    facts(sessionId: SessionId | undefined): {
        seeded: boolean;
        firstOrdinarySent: boolean;
        parentSessionId: SessionId | undefined;
    };
    /** Prefetch is advisory. Pending/unknown mutations must not race new inference. */
    awaitPendingOp(sessionId: SessionId | undefined, signal?: AbortSignal): Promise<void>;
    /** Hold mutations until the actual model stream finishes, errors or is cancelled. */
    beginOrdinary(sessionId: SessionId | undefined, model: string, signal?: AbortSignal): Promise<() => void>;
    noteOrdinaryRequest(sessionId: SessionId | undefined, model: string): void;
    onSessionCreated(session: Session): void;
    ensureResume(sessionId: SessionId | undefined, model: string): void;
    onAgentStatus(sessionId: SessionId, status: AgentStatus): void;
    onSessionComposing(sessionId: SessionId): void;
    onSessionEvent(session: Session, event: SessionEvent): void;
    onSessionDisposed(session: Session): void;
    /**
     * Drop quarantined states whose TTL has elapsed. Runs on every disposal so the
     * map cannot grow without bound in a long-lived host.
     */
    private sweepQuarantine;
    onSessionArchived(sessionId: SessionId): void;
    onSessionUnarchived(sessionId: SessionId): void;
    private markForPause;
    private maybePauseIfIdle;
    private state;
    private track;
}
