/** Chat Completions transport with lossless roles, bounded streams and session leases. */
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, PreparedAdapterCall, StreamChunk, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm';
import type { DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek';
import { type AgentHint } from './hint.js';
import type { LifecycleBridge } from './lifecycle-bridge.ts';
import type { HintTrace } from './trace.ts';
export interface ChatConnectionOptions {
    baseURL: string;
    maxTokens?: number;
    models?: DeepSeekConnectionOptions['models'];
    defaultContextWindow?: number;
    defaults?: DeepSeekConnectionOptions['defaults'];
    streamIdleTimeoutMs?: number;
    retryPolicy?: ResolvedRetryPolicy;
}
export interface ChatRequestFacts {
    sessionId: string | undefined;
    /**
     * Declared request purpose, or `undefined` for an ordinary conversation request.
     * DSH 0.2.2 made purposes an open, declaration-merged key set
     * (`GenerateOptions<Purpose extends string>`), so a forwarding adapter must treat
     * this as a plain string rather than the old `'compaction' | 'session-title'` union.
     */
    purpose: string | undefined;
    model: string;
    signal: AbortSignal;
    /** Wire message count of this request (the cache declaration's msg_offset). */
    wireMessageCount: number;
    /** Estimated prefix size of the serialized request, in tokens. */
    prefixTokens: number;
    /** Offered tool names (cache suppression signature). */
    toolNames: string[];
}
export interface ChatAdapterDependencies<C extends ChatConnectionOptions = ChatConnectionOptions> {
    options(): C;
    providerName?: string;
    /** Authentication must resolve from this exact connection, never current options(). */
    resolveAuth(connection: C): Promise<{
        headers: Record<string, string>;
    }>;
    prepareHint?(request: ChatRequestFacts): AgentHint | undefined | Promise<AgentHint | undefined>;
    onAccepted?(request: ChatRequestFacts): void;
    bridge?: LifecycleBridge;
    /** Plugin lifetime, including when lifecycle controls are disabled. */
    signal?: AbortSignal;
    trace?: HintTrace;
    /** Kept for consumers constructing this adapter directly. */
    discoverModels?(provider: string): readonly LlmModelInfo[] | Promise<readonly LlmModelInfo[]>;
}
/** Shared by data and control planes; a /v1 root is never duplicated. */
export declare function chatCompletionsURL(baseURL: string): string;
export declare class ChatCompletionsAdapter<C extends ChatConnectionOptions = ChatConnectionOptions> extends LlmAdapter {
    private readonly dependencies;
    constructor(dependencies: ChatAdapterDependencies<C>);
    providerInfo(provider: string): {
        id: string;
        name: string;
    };
    providerRetryPolicy(_provider: string): ResolvedRetryPolicy;
    listModels(provider: string): Promise<readonly LlmModelInfo[]>;
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>;
    prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall>;
    stream(options: GenerateOptions<string>): AsyncIterable<StreamChunk>;
    private generate;
    private request;
}
