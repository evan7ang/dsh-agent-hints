// SPDX-License-Identifier: MulanPSL-2.0
/** Bounded advisory manage transport. HTTP acceptance is not KV completion. */
import { attributionHeaders } from '@deepseek-ai/dsh-llm';
import { buildManageHint, encodeAgentHintHeader } from './hint.js';
export const DEFAULT_CONTROL_TIMEOUT_MS = 5_000;
export const DEFAULT_CONTROL_RETRIES = 1;
async function abortable(promise, signal) {
    signal.throwIfAborted();
    let abort;
    try {
        return await Promise.race([promise, new Promise((_, reject) => {
                abort = () => reject(signal.reason);
                signal.addEventListener('abort', abort, { once: true });
            })]);
    }
    finally {
        if (abort !== undefined)
            signal.removeEventListener('abort', abort);
    }
}
async function sleep(ms, signal) {
    if (signal?.aborted)
        return;
    await new Promise(resolve => {
        const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', finish); resolve(); };
        const timer = setTimeout(finish, ms);
        signal?.addEventListener('abort', finish, { once: true });
    });
}
export class SessionControlClient {
    options;
    constructor(options) {
        this.options = options;
    }
    /** No automatic retry of mutating verbs or ambiguous network outcomes. */
    async send(verb, sessionId, model, signal, canSend = () => true) {
        const cancelled = () => ({ status: 'cancelled', dispatched: false });
        if (verb === 'start') {
            if (signal?.aborted || !canSend())
                return cancelled();
            this.options.warn?.('agent-hint: start must ride an ordinary request');
            return { status: 'failed', retryable: false };
        }
        const facts = this.options.sessionFacts?.(sessionId) ?? { callIndex: 1, epoch: 0 };
        // `compact` evicts the context that was just rewritten, i.e. the previous epoch.
        const epoch = verb === 'compact' ? Math.max(0, facts.epoch - 1) : facts.epoch;
        const hint = buildManageHint({
            sessionId, parentSessionId: facts.parentSessionId,
            callIndex: facts.callIndex, epoch, state: verb,
        });
        const traceFacts = { plane: 'control', transport: 'chat', model: model ?? this.options.model, hint };
        let observation = this.options.trace?.begin(traceFacts, 'prepared');
        const cancel = () => { observation?.finish('cancelled', { dispatched: false }); return cancelled(); };
        if (signal?.aborted || !canSend())
            return cancel();
        let connection;
        try {
            const timeout = AbortSignal.timeout(this.options.timeoutMs);
            const resolving = this.options.resolveConnection === undefined
                ? this.options.resolveApiKey().then(apiKey => ({ endpoint: this.options.endpoint, apiKey }))
                : this.options.resolveConnection();
            connection = await abortable(resolving, signal === undefined ? timeout : AbortSignal.any([signal, timeout]));
        }
        catch (error) {
            if (signal?.aborted)
                return cancel();
            observation?.finish('not-dispatched', { dispatched: false });
            this.options.warn?.('agent-hint: control connection resolution failed', error);
            return { status: 'failed', retryable: false };
        }
        if (signal?.aborted || !canSend())
            return cancel();
        const body = JSON.stringify({ model: model ?? this.options.model, messages: [], stream: false });
        for (let attempt = 0;; attempt++) {
            if (attempt > 0)
                observation = this.options.trace?.begin({ ...traceFacts,
                    ...observation?.requestId === undefined ? {} : { requestId: observation.requestId }, attempt: attempt + 1 }, 'prepared');
            if (signal?.aborted || !canSend())
                return cancel();
            const result = await this.attempt(body, hint, verb, connection, signal, observation);
            if (result.status !== 'accepted')
                this.options.warn?.(`agent-hint: session state ${verb} for ${sessionId}: ${result.status}`
                    + ('httpStatus' in result ? ` HTTP ${result.httpStatus}` : ''));
            // A 5xx/timeout on a mutating request cannot prove it did not execute.
            // Only prefetch retries explicit transient HTTP rejections.
            if (verb !== 'resume' || result.status !== 'failed' || !result.retryable
                || attempt >= this.options.retries)
                return result;
            await sleep(200, signal);
        }
    }
    async attempt(body, hint, verb, connection, signal, observation) {
        const timeout = AbortSignal.timeout(this.options.timeoutMs);
        let httpStatus;
        try {
            const key = connection.apiKey;
            const header = connection.authHeader ?? 'authorization';
            observation?.dispatch();
            const response = await fetch(connection.endpoint, {
                method: 'POST', redirect: 'error',
                headers: { ...key === undefined ? {} : { [header]: header === 'authorization' ? `Bearer ${key}` : key },
                    'content-type': 'application/json', 'x-agent-hint': encodeAgentHintHeader(hint), ...attributionHeaders() },
                body, signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
            });
            httpStatus = response.status;
            if (!response.ok) {
                const transient = response.status === 408 || response.status === 429 || response.status >= 500;
                observation?.finish(verb !== 'resume' && transient ? 'unknown' : 'rejected', { httpStatus, dispatched: true });
                await response.body?.cancel().catch(() => undefined);
                if (verb !== 'resume' && transient)
                    return { status: 'unknown' };
                return { status: 'failed', retryable: transient, httpStatus: response.status };
            }
            // Drain before returning; interrupted bodies retain an unknown outcome.
            await response.arrayBuffer();
            observation?.finish('accepted', { httpStatus, dispatched: true });
            return { status: 'accepted', httpStatus: response.status };
        }
        catch {
            observation?.finish(signal?.aborted ? 'cancelled' : 'unknown', {
                dispatched: true, ...httpStatus === undefined ? {} : { httpStatus }
            });
            return signal?.aborted ? { status: 'cancelled', dispatched: true } : { status: 'unknown' };
        }
    }
}
