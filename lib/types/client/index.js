import { DraftObserver } from "./observer.js";
export const name = 'agent-hint-composer';
// A dynamically discovered host @Remote does not create a generated Client
// namespace. Depend only on actual stock services and probe the host explicitly.
export const inject = ['slots', 'connection'];
/**
 * Install advisory notifications through the existing authenticated Connection.
 * Missing services and failed notifications leave composing/submission unaffected.
 * @param ctx - browser plugin context owning the slot contribution and RPC lifetime.
 */
export function apply(ctx) {
    // Client and Host use the same service key with different declared faces.
    const connection = ctx.get('connection');
    if (connection === undefined)
        return;
    const lifetime = new AbortController();
    let generation;
    let probe;
    let withdraw;
    const notify = (sessionId) => {
        if (lifetime.signal.aborted)
            return;
        void connection.rpc.call('/api', 'agentHintSignals/composing', { args: { request: { sessionId } } }, AbortSignal.any([lifetime.signal, AbortSignal.timeout(5_000)]))
            .catch(() => undefined); // Advisory only; drafts and ordinary requests remain usable.
    };
    const refresh = () => {
        const next = connection.generation.getSnapshot();
        if (next === generation || lifetime.signal.aborted)
            return;
        generation = next;
        probe?.abort();
        withdraw?.();
        withdraw = undefined;
        if (next === undefined)
            return;
        const attempt = probe = new AbortController();
        const signal = AbortSignal.any([lifetime.signal, attempt.signal, AbortSignal.timeout(5_000)]);
        // Read-only: no session identity, draft text, model request or KV operation.
        void connection.rpc.call('/api', 'agentHintSignals/available', { args: {} }, signal).then(result => {
            if (signal.aborted || generation !== next || !result.ok || result.value !== true)
                return;
            withdraw = ctx.slots.inject('conversation.input.overlay', () => ctx.slots.register({
                name: 'conversation.input.overlay', id: 'agent-hint-composing', order: 100,
                inject: () => ({ notify }),
            }, DraftObserver));
        }).catch(() => undefined);
    };
    ctx.effect(() => {
        const unsubscribe = connection.generation.subscribe(refresh);
        refresh();
        return () => { lifetime.abort(); probe?.abort(); unsubscribe(); withdraw?.(); };
    }, 'agent-hint: composer capability and RPC lifetime');
}
