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
import { AsyncLocalStorage } from 'node:async_hooks';
import { DeepSeekAdapter } from '@deepseek-ai/dsh-llm-deepseek';
import { estimatePrefixTokens } from './cache.js';
/**
 * The hint of the request currently executing on this async chain. Read by the
 * route's `resolveAuth`, written by {@link AgentHintAdapter}.
 */
export const agentHintScope = new AsyncLocalStorage();
/** Re-enter the scope on every resumption so the store stays bound to the request. */
async function* runWithHint(store, value, factory) {
    const inner = factory();
    while (true) {
        const next = await store.run(value, () => inner[Symbol.asyncIterator]().next());
        if (next.done === true)
            return;
        yield next.value;
    }
}
export class AgentHintAdapter extends DeepSeekAdapter {
    hintOptions;
    bridge;
    lifetime;
    constructor(hintOptions, bridge, lifetime) {
        super(hintOptions);
        this.hintOptions = hintOptions;
        this.bridge = bridge;
        this.lifetime = lifetime;
    }
    async prepareCall(provider, model, signal) {
        const prepared = await super.prepareCall(provider, model, signal);
        // `PreparedAdapterCall.stream` is not purpose-generic, while this adapter accepts any
        // declared purpose; the concrete DeepSeek signature does accept `GenerateOptions<string>`.
        return { model: prepared.model, stream: options => this.leased(options, scoped => prepared.stream(scoped)) };
    }
    async *stream(options) {
        yield* this.leased(options, scoped => super.stream(scoped));
    }
    async *leased(options, stream) {
        const bridge = this.bridge;
        const signals = [options.signal, bridge?.signal, this.lifetime].filter((value) => value !== undefined);
        const signal = signals.length ? AbortSignal.any(signals) : undefined;
        signal?.throwIfAborted();
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
            : undefined;
        const release = options.purpose === undefined ? await bridge?.beginOrdinary(options.sessionId, options.model, signal) : undefined;
        try {
            yield* runWithHint(agentHintScope, hint, () => stream({ ...options, signal }));
        }
        finally {
            release?.();
        }
    }
}
