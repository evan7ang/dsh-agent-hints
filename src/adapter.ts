// SPDX-License-Identifier: MulanPSL-2.0
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

import { AsyncLocalStorage } from 'node:async_hooks'
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekAdapterOptions, DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { GenerateOptions, StreamChunk, PreparedAdapterCall } from '@deepseek-ai/dsh-llm'
import type { LifecycleBridge } from './lifecycle-bridge.js'
import type { AgentHint } from './hint.js'
import { estimatePrefixTokens } from './cache.js'

/**
 * The hint of the request currently executing on this async chain. Read by the
 * route's `resolveAuth`, written by {@link AgentHintAdapter}.
 */
export const agentHintScope = new AsyncLocalStorage<AgentHint | undefined>()

/** Facts the Messages adapter can observe before serialization. */
export interface MessagesHintFacts {
  sessionId: string | undefined
  purpose: string | undefined
  model: string
  /** Logical model input count (system + messages) for the cache declaration. */
  wireMessageCount: number
  /** Estimated prefix size of the logical input, in tokens. */
  prefixTokens: number
  /** Offered tool names (cache suppression signature). */
  toolNames: string[]
}

/** Adapter dependencies plus the hint builder. */
export interface AgentHintAdapterOptions<C extends DeepSeekConnectionOptions> extends DeepSeekAdapterOptions<C> {
  prepareHint?(facts: MessagesHintFacts): AgentHint | undefined
}

/** Re-enter the scope on every resumption so the store stays bound to the request. */
async function* runWithHint<T>(store: AsyncLocalStorage<AgentHint | undefined>, value: AgentHint | undefined,
  factory: () => AsyncIterable<T>): AsyncIterable<T> {
  const inner = factory()
  while (true) {
    const next = await store.run(value, () => inner[Symbol.asyncIterator]().next())
    if (next.done === true) return
    yield next.value
  }
}

export class AgentHintAdapter<C extends DeepSeekConnectionOptions> extends DeepSeekAdapter<C> {
  constructor(private readonly hintOptions: AgentHintAdapterOptions<C>,
    private readonly bridge?: LifecycleBridge, private readonly lifetime?: AbortSignal) {
    super(hintOptions)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    const prepared = await super.prepareCall(provider, model, signal)
    // `PreparedAdapterCall.stream` is not purpose-generic, while this adapter accepts any
    // declared purpose; the concrete DeepSeek signature does accept `GenerateOptions<string>`.
    return { model: prepared.model, stream: options => this.leased(options, scoped => prepared.stream(scoped as GenerateOptions)) }
  }
  override async *stream(options: GenerateOptions<string>): AsyncIterable<StreamChunk> {
    yield* this.leased(options, scoped => super.stream(scoped))
  }
  private async *leased(options: GenerateOptions<string>,
    stream: (options: GenerateOptions<string>) => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    const bridge = this.bridge
    const signals = [options.signal, bridge?.signal, this.lifetime].filter((value): value is AbortSignal => value !== undefined)
    const signal = signals.length ? AbortSignal.any(signals) : undefined
    signal?.throwIfAborted()
    // Auxiliary calls never carry a hint: they must not perturb the live session.
    const hint = options.purpose === undefined
      ? this.hintOptions.prepareHint?.({
        sessionId: options.sessionId === undefined ? undefined : String(options.sessionId),
        purpose: undefined,
        model: options.model,
        wireMessageCount: options.messages.length + (options.system === undefined ? 0 : 1),
        prefixTokens: estimatePrefixTokens([options.system ?? '', ...options.messages]),
        toolNames: options.tools?.map(tool => tool.name) ?? [],
      })
      : undefined
    const release = options.purpose === undefined ? await bridge?.beginOrdinary(options.sessionId, options.model, signal) : undefined
    try { yield* runWithHint(agentHintScope, hint, () => stream({ ...options, signal })) } finally { release?.() }
  }
}
