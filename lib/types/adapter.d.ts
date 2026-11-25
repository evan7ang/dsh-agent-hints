/**
 * The hinted Messages route: the official DeepSeek Messages adapter with a
 * request-scoped `X-Agent-Hint` header and a whole-stream mutation lease.
 *
 * The official adapter builds the request headers inside its own `request()`
 * and exposes no per-request header hook; the one seam it offers is
 * `resolveAuth(connection)`, whose returned headers are spread into every
 * request. This adapter therefore carries the per-request hint through an
 * AsyncLocalStorage scope that `resolveAuth` reads, and re-enters that scope on
 * every generator resumption so concurrent requests cannot observe each
 * other's hint. Replace this seam with a first-class host hook when one exists.
 *
 * The hint never enters the request body: no extension field is contributed.
 *
 * @module @deepseek-ai/dsh-agent-hints/adapter
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek';
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek';
import type { GenerateOptions, StreamChunk, PreparedAdapterCall } from '@deepseek-ai/dsh-llm';
import type { LifecycleBridge } from './lifecycle-bridge.js';
import type { AgentHint } from './hint.js';
/**
 * The hint of the request currently executing on this async chain. Read by the
 * route's `resolveAuth`, written by {@link AgentHintAdapter}.
 */
export declare const agentHintScope: AsyncLocalStorage<AgentHint | undefined>;
/** Facts the Messages adapter can observe before serialization. */
export interface MessagesHintFacts {
    sessionId: string | undefined;
    purpose: string | undefined;
    model: string;
    /** Logical model input count (system + messages) for the cache declaration. */
    wireMessageCount: number;
    /** Estimated prefix size of the logical input, in tokens. */
    prefixTokens: number;
    /** Offered tool names (cache suppression signature). */
    toolNames: string[];
}
/** Adapter dependencies plus the hint builder. */
export interface AgentHintAdapterOptions<C extends DeepSeekConnectionOptions> extends DeepSeekAdapterOptions<C> {
    prepareHint?(facts: MessagesHintFacts): AgentHint | undefined;
}
export declare class AgentHintAdapter<C extends DeepSeekConnectionOptions> extends DeepSeekAdapter<C> {
    private readonly hintOptions;
    private readonly bridge?;
    private readonly lifetime?;
    constructor(hintOptions: AgentHintAdapterOptions<C>, bridge?: LifecycleBridge | undefined, lifetime?: AbortSignal | undefined);
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions<string>): AsyncIterable<StreamChunk>;
    private leased;
}
