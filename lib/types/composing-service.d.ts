/** Plugin-owned Remote endpoint for advisory composer activity on stock DSH. */
import type { Context } from '@deepseek-ai/cordis';
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol';
import type { LifecycleBridge } from './lifecycle-bridge.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        /** Composer notifications owned by this provider plugin. */
        agentHintSignals: AgentHintSignals;
    }
}
/** A live service discovered through the stock Gateway's Remote markers. */
export declare class AgentHintSignals extends TypertRemoteService {
    private readonly bridge;
    constructor(ctx: Context, bridge: LifecycleBridge);
    /** Read-only capability probe; this service exists only while plugin controls are enabled. */
    available(): boolean;
    /**
     * The visible composer was mounted or switched to this session. Advisory only;
     * the existing bridge ignores unknown/archived sessions and deduplicates resume.
     * No draft text or Agent execution is admitted through this endpoint.
     */
    activated(request: unknown): void;
    /**
     * Note a composer transition; does not create/resume an Agent or accept draft text.
     * The bridge acts only on sessions already known to this provider route.
     * @param request - wire object containing only a nonempty sessionId (at most 512 characters).
     */
    composing(request: unknown): void;
}
