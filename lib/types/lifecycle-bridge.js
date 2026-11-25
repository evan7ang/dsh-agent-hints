import { LlmError } from '@deepseek-ai/dsh-llm';
export const DEFAULT_PENDING_OP_AWAIT_MS = 2_000;
export const DEFAULT_QUARANTINE_TTL_MS = 30 * 60 * 1_000;
/** @deprecated Retained for API compatibility. Session lineage is no longer inferred by time. */
export const COMPACTION_LINEAGE_WINDOW_MS = 60_000;
export class ControlBarrierError extends LlmError {
    constructor() {
        super('AgentHint: a cache-changing control is pending or has an unknown outcome; this session cannot safely start another request. Check the coordinator before continuing.', 'CONTROL_BARRIER');
        this.name = 'ControlBarrierError';
    }
}
export class LifecycleBridge {
    options;
    states = new Map();
    lastOrdinarySessionId;
    disposed = false;
    lifetime = new AbortController();
    get signal() { return this.lifetime.signal; }
    constructor(options) {
        this.options = options;
    }
    subscribe(ctx) {
        ctx.effect(() => () => this.dispose(), 'agent-hint: bridge state');
        ctx.on('session/created', session => this.onSessionCreated(session), { global: true });
        ctx.on('session/event', (session, event) => this.onSessionEvent(session, event), { global: true });
        ctx.on('session/disposed', session => this.onSessionDisposed(session), { global: true });
        ctx.on('workspace/session-archived', id => this.onSessionArchived(id), { global: true });
        ctx.on('agent/status', ({ agent, status }) => this.onAgentStatus(agent.id, status), { global: true });
        ctx.on('session/composing', id => this.onSessionComposing(id), { global: true });
    }
    dispose() {
        this.disposed = true;
        this.lifetime.abort();
        for (const state of this.states.values())
            state.releaseData?.();
        this.states.clear();
        this.lastOrdinarySessionId = undefined;
    }
    facts(sessionId) {
        const state = sessionId === undefined ? undefined : this.states.get(String(sessionId));
        return { seeded: state?.seeded ?? false, firstOrdinarySent: state?.firstOrdinarySent ?? false,
            parentSessionId: state?.parentSessionId };
    }
    /** Prefetch is advisory. Pending/unknown mutations must not race new inference. */
    async awaitPendingOp(sessionId, signal) {
        const state = sessionId === undefined ? undefined : this.states.get(String(sessionId));
        if (state === undefined)
            return;
        const combined = signal === undefined ? this.signal : AbortSignal.any([signal, this.signal]);
        combined.throwIfAborted();
        let timer;
        let onAbort;
        const deadline = new Promise((resolve, reject) => {
            timer = setTimeout(() => resolve('expired'), this.options.pendingOpAwaitMs);
            onAbort = () => reject(combined.reason);
            combined.addEventListener('abort', onAbort, { once: true });
        });
        try {
            while (state.pendingOp !== undefined) {
                const pending = state.pendingOp;
                if (await Promise.race([pending, deadline]) === 'expired') {
                    this.options.warn?.('llm-agent-hint: control barrier timed out; backend outcome remains unknown');
                    if (state.mutations > 0 || state.unsafe)
                        throw new ControlBarrierError();
                    return;
                }
            }
            if (state.unsafe)
                throw new ControlBarrierError();
        }
        finally {
            clearTimeout(timer);
            if (onAbort !== undefined)
                combined.removeEventListener('abort', onAbort);
        }
    }
    /** Hold mutations until the actual model stream finishes, errors or is cancelled. */
    async beginOrdinary(sessionId, model, signal) {
        this.signal.throwIfAborted();
        signal?.throwIfAborted();
        if (sessionId === undefined)
            return () => { };
        this.ensureResume(sessionId, model);
        await this.awaitPendingOp(sessionId, signal);
        this.signal.throwIfAborted();
        signal?.throwIfAborted();
        const state = this.state(String(sessionId));
        // No await between checking the mutation queue and reserving the stream.
        if (state.mutations > 0 || state.unsafe)
            throw new ControlBarrierError();
        state.generation++;
        // Keep the state associated with this lease even if disposal races HTTP acceptance.
        state.lastModel = model;
        if (state.active++ === 0)
            state.dataIdle = new Promise(resolve => { state.releaseData = resolve; });
        let released = false;
        return () => {
            if (released)
                return;
            released = true;
            if (--state.active === 0) {
                state.releaseData?.();
                state.releaseData = undefined;
                state.dataIdle = undefined;
            }
        };
    }
    noteOrdinaryRequest(sessionId, model) {
        if (sessionId === undefined || this.disposed)
            return;
        const id = String(sessionId);
        if (this.lastOrdinarySessionId !== undefined && this.lastOrdinarySessionId !== id)
            this.markForPause(this.lastOrdinarySessionId);
        this.lastOrdinarySessionId = id;
        const state = this.state(id);
        state.archived = false;
        state.firstOrdinarySent = true;
        state.lastModel = model;
        state.pausePending = false;
        state.pauseSent = false;
    }
    onSessionCreated(session) {
        if (this.disposed)
            return;
        const state = this.state(String(session.id));
        // Keep outstanding operations and uncertainty across disposal/reopen.
        state.incarnation = {};
        state.seeded = session.surface.nodes.length > 0;
        state.firstOrdinarySent = false;
        state.resumeSent = false;
        state.resumeAttempt = {};
        state.agentStatus = 'idle';
        state.pausePending = false;
        state.pauseSent = false;
        // Ordinary historical forks may name their source; a subagent names its creator instead.
        state.parentSessionId = session.header.origin === 'subagent' ? undefined : session.header.parentSession;
        // The session is live again, so it must not be swept; the retained `unsafe`
        // flag still refuses new inference until the coordinator is reconciled.
        state.quarantineSince = undefined;
    }
    ensureResume(sessionId, model) {
        if (sessionId === undefined || this.disposed)
            return;
        const id = String(sessionId), state = this.states.get(id);
        if (state === undefined || !(state.seeded || state.pauseSent) || state.resumeSent
            || state.unsafe || Date.now() < state.nextResumeAt)
            return;
        state.resumeSent = true;
        state.resumeAttempt = {};
        state.lastModel = model;
        this.track(id, 'resume', model);
    }
    onAgentStatus(sessionId, status) {
        if (this.disposed)
            return;
        const id = String(sessionId), state = this.state(id);
        state.agentStatus = status;
        if (status === 'idle')
            this.maybePauseIfIdle(id);
    }
    onSessionComposing(sessionId) {
        const state = this.states.get(String(sessionId));
        if (state?.lastModel !== undefined && !state.archived)
            this.ensureResume(sessionId, state.lastModel);
    }
    onSessionEvent(session, event) {
        if (event.type !== 'compaction/end' || event.data.error !== undefined)
            return;
        const state = this.states.get(String(session.id));
        if (state?.lastModel !== undefined)
            this.track(String(session.id), 'compact', state.lastModel);
    }
    onSessionDisposed(session) {
        const id = String(session.id), state = this.states.get(id);
        if (this.lastOrdinarySessionId === id)
            this.lastOrdinarySessionId = undefined;
        this.sweepQuarantine();
        if (state?.lastModel === undefined) {
            this.states.delete(id);
            return;
        }
        const incarnation = state.incarnation;
        const pending = state.archived ? state.pendingOp ?? Promise.resolve() : this.track(id, 'stop', state.lastModel);
        void pending.then(() => {
            if (this.states.get(id) !== state || state.incarnation !== incarnation)
                return;
            if (!state.unsafe) {
                this.states.delete(id);
                return;
            }
            // Unknown mutation outcomes stay quarantined even if the session reopens, but
            // only for a bounded time: an abandoned id must not pin memory forever.
            state.quarantineSince = Date.now();
        });
    }
    /**
     * Drop quarantined states whose TTL has elapsed. Runs on every disposal so the
     * map cannot grow without bound in a long-lived host.
     */
    sweepQuarantine() {
        const ttl = this.options.quarantineTtlMs ?? DEFAULT_QUARANTINE_TTL_MS;
        const now = Date.now();
        for (const [id, state] of this.states) {
            if (state.quarantineSince === undefined)
                continue;
            if (state.active > 0 || state.pendingOp !== undefined)
                continue;
            if (now - state.quarantineSince < ttl)
                continue;
            this.states.delete(id);
            this.options.warn?.(`llm-agent-hint: dropped quarantine state for ${id} after ${ttl}ms`);
        }
    }
    onSessionArchived(sessionId) {
        const id = String(sessionId), state = this.states.get(id);
        if (state?.lastModel === undefined || state.archived)
            return;
        state.archived = true;
        state.pausePending = false;
        state.pauseSent = true;
        state.resumeSent = false;
        if (this.lastOrdinarySessionId === id)
            this.lastOrdinarySessionId = undefined;
        this.track(id, 'stop', state.lastModel);
    }
    onSessionUnarchived(sessionId) {
        const state = this.states.get(String(sessionId));
        if (state !== undefined)
            state.archived = false;
    }
    markForPause(id) {
        const state = this.states.get(id);
        if (state === undefined || state.pauseSent || state.pausePending)
            return;
        state.pausePending = true;
        this.maybePauseIfIdle(id);
    }
    maybePauseIfIdle(id) {
        const state = this.states.get(id);
        if (state === undefined || !state.pausePending || state.agentStatus !== 'idle')
            return;
        state.pausePending = false;
        state.pauseSent = true;
        state.resumeSent = false;
        this.track(id, 'pause', state.lastModel);
    }
    state(id) {
        let state = this.states.get(id);
        if (state === undefined) {
            state = { archived: false, seeded: false, resumeSent: false, resumeAttempt: {}, nextResumeAt: 0,
                agentStatus: 'idle', pausePending: false, pauseSent: false, firstOrdinarySent: false,
                parentSessionId: undefined, lastModel: undefined, pendingOp: undefined, mutations: 0,
                unsafe: false, generation: 0, incarnation: {}, active: 0, dataIdle: undefined, releaseData: undefined,
                quarantineSince: undefined };
            this.states.set(id, state);
        }
        return state;
    }
    track(id, verb, model) {
        if (this.disposed)
            return Promise.resolve();
        const state = this.state(id), generation = state.generation;
        const resumeAttempt = state.resumeAttempt;
        const mutating = verb !== 'resume';
        if (mutating)
            state.mutations++;
        const canSend = () => !this.disposed && !state.unsafe && state.generation === generation;
        const dispatch = () => canSend()
            ? this.options.client.send(verb, id, model, this.signal, canSend)
            : Promise.resolve({ status: 'cancelled', dispatched: false });
        const dependencies = [state.pendingOp, state.dataIdle].filter(value => value !== undefined);
        const promise = dependencies.length === 0 ? dispatch() : Promise.all(dependencies).then(dispatch);
        const tracked = promise.then(result => {
            if (mutating && (result.status === 'unknown' || (result.status === 'cancelled' && result.dispatched)))
                state.unsafe = true;
            // A prefetch can fail after the advisory barrier already let data start.
            // Its own attempt identity, rather than the data generation, owns recovery.
            if (verb === 'resume' && state.resumeAttempt === resumeAttempt
                && (result.status === 'failed' || (result.status === 'cancelled' && !result.dispatched))) {
                state.resumeSent = false;
                state.nextResumeAt = Date.now() + 1000;
            }
        }).catch(error => {
            if (mutating)
                state.unsafe = true;
            this.options.warn?.('llm-agent-hint: control operation failed', error);
        }).finally(() => {
            if (mutating)
                state.mutations--;
            if (state.pendingOp === tracked)
                state.pendingOp = undefined;
        });
        state.pendingOp = tracked;
        return tracked;
    }
}
