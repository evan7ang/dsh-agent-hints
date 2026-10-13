// Minimal ambient type stubs for the DSH runtime services this plugin touches.
// The real implementations resolve at runtime through the profile's installed
// package fallback; these declarations exist only so the plugin builds without
// a harness checkout. Keep them exactly as wide as `src/` uses. The adapter
// satisfies the harness `LlmAdapter` contract STRUCTURALLY (only `stream()` is
// required; branding is compile-time phantom typing) so no harness package is
// imported at runtime.

declare module '@deepseek-ai/cordis' {
  /** Harness conversation message: provider-neutral role plus model-facing blocks. */
  export interface HarnessMessage {
    id: string
    role: 'system' | 'user' | 'assistant'
    content: HarnessContentBlock[]
    source: Record<string, unknown>
  }

  /** The content-block subset this adapter serializes or rejects. */
  export type HarnessContentBlock =
    | { type: 'text'; text: string }
    | { type: 'reasoning'; text: string }
    | { type: 'tool-call'; id: string; name: string; arguments: string }
    | { type: 'tool-result'; toolCallId: string; content: HarnessContentBlock[]; isError?: boolean }
    | { type: 'image'; attachment: unknown }
    | { type: string; [key: string]: unknown }

  /** JSON-schema tool description as assembled by the harness. */
  export interface HarnessToolSchema {
    name: string
    description: string
    parameters: Record<string, unknown>
  }

  /** The fully-assembled per-request facts an adapter receives. */
  export interface HarnessGenerateOptions {
    provider: string
    model: string
    reasoningEffort?: string
    messages: HarnessMessage[]
    system?: string
    tools?: HarnessToolSchema[]
    temperature?: number
    maxTokens?: number
    stop?: string[]
    signal?: AbortSignal
    sessionId?: string
    purpose?: 'compaction' | 'session-title'
  }

  /** The chunk vocabulary an adapter's `stream()` yields. */
  export type HarnessStreamChunk =
    | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call' }
    | { type: 'text-delta'; index: number; text: string }
    | { type: 'reasoning-delta'; index: number; text: string }
    | { type: 'tool-call-delta'; index: number; id: string; name?: string; argumentsDelta: string }
    | { type: 'block-end'; index: number; block: HarnessContentBlock }
    | { type: 'usage'; usage: HarnessTokenUsage }
    | { type: 'finish'; reason: { kind: 'stop' | 'tool-calls' | 'max-tokens' | 'aborted' | 'error'; failure?: { message: string; code: string } } }

  /** Disjoint token counts the harness meters on. */
  export interface HarnessTokenUsage {
    inputTokens: number
    outputTokens: number
    totalTokens?: number
    cacheReadTokens?: number
    reasoningTokens?: number
  }

  /** Resolved model metadata the harness reads for capacity and effort decisions. */
  export interface HarnessResolvedModelInfo {
    provider: string
    id: string
    name: string
    context?: { contextWindow: number }
    defaultMaxTokens?: number
    reasoning?: { efforts: ReadonlyArray<{ id: string; name: string }>; defaultEffort?: string }
  }

  /** The structural LlmAdapter subset this plugin implements. */
  export interface HarnessLlmAdapter {
    providerInfo?(provider: string): { id: string; name: string }
    providerRetryPolicy?(provider: string): unknown
    resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<HarnessResolvedModelInfo>
    stream(options: HarnessGenerateOptions): AsyncIterable<HarnessStreamChunk>
  }

  /** Structurally minimal session header subset used for parent lineage. */
  export interface SessionHeaderLike {
    /** Unix epoch milliseconds when the session was created. */
    createdAt?: number
    /** Parent session id for forked or spawned sessions. */
    parentSession?: string
    /** `'subagent'` when the session was created by delegation. */
    origin?: string
  }

  /** Structurally minimal live session handle. */
  export interface SessionLike {
    id: string
    header: SessionHeaderLike
    /** The session's own (non-seed) event log, replayed on restore — the durable derivation basis. */
    ownEvents(): SessionEventLike[]
  }

  /** Structurally minimal session event subset the tracker and derivation consume. */
  export interface SessionEventLike {
    type: string
    /** Unix epoch milliseconds. */
    time: number
    /** Event payload; only the fields below are read (merge-extensible in the harness). */
    data?: {
      /** `tool/call`: the invoked tool name. */
      name?: string
      /** `tool/call`: the provider-issued call id pairing call with result. */
      callId?: string
      /** `tool/call`: raw JSON arguments as produced by the model. */
      arguments?: string
      /** `tool/result`: the result message whose content blocks carry the settled `toolCallId`. */
      message?: { content?: Array<{ type?: string; toolCallId?: string }> }
      /** `turn/end`: why the turn ended (`{kind: 'completed' | …}`). */
      reason?: { kind?: string }
    }
  }

  /** The subset of the cordis context agent-hints touches. */
  export interface Context {
    /** The llm service: adapter registry plus streaming model calls. */
    llm: {
      /** Registers one adapter instance for the given provider routes. */
      registerAdapter(providers: string[], adapter: HarnessLlmAdapter): unknown
    }
    /**
     * Reads one service by name without requiring injection; absent services
     * return `undefined` (the `ctx.get` seam harness plugins use for optional
     * peers — direct property access on a non-injected service throws).
     */
    get(name: 'sessions'): { get(id: string): SessionLike | undefined } | undefined
    get(name: 'credentials'): { resolve(ref: string): Promise<{ value: string } | undefined> } | undefined
    /** Subscribes one listener; fiber-scoped, detached at plugin disposal. */
    on(event: 'session/event', listener: (session: SessionLike, event: SessionEventLike) => void): unknown
    on(event: 'session/disposed', listener: (session: SessionLike) => void): unknown
    /** Registers one effect body whose returned disposer runs at fiber disposal. */
    effect(execute: () => (() => void) | Promise<() => void>): unknown
    logger?: {
      info(message: string): void
      warn(message: string): void
    }
  }
}
