/** Bounded, non-authoritative adapter diagnostics; no prompts, credentials or raw errors. */
import { randomUUID } from 'node:crypto';
const text = (value) => value.slice(0, 512);
export class HintTrace {
    options;
    records = [];
    constructor(options = {}) {
        this.options = options;
        const limit = options.maxRecords ?? 2000;
        if (!Number.isInteger(limit) || limit < 1 || limit > 10_000)
            throw new Error('Trace maxRecords must be an integer from 1 to 10000');
    }
    /**
     * Records this process holds for one session, in emission order.
     *
     * The window keeps every attempt phase, unlike the Session log, which carries
     * only the terminal record; read it for in-process diagnosis and tests.
     * @param sessionId - session whose records to return.
     * @returns a detached copy; mutating it cannot alter retained records.
     */
    recordsOf(sessionId) {
        return structuredClone(this.records.filter(record => record.sessionId === sessionId));
    }
    begin(facts, phase = 'dispatch') {
        if (this.options.enabled === false)
            return { dispatch() { }, finish() { } };
        const wire = facts.hint;
        const hint = {
            session_id: text(wire.session.session_id),
            state: wire.session.state,
            call_index: wire.session.call_index,
            epoch: wire.session.epoch,
        };
        if (wire.session.parent_session_id !== undefined)
            hint.parent_session_id = text(wire.session.parent_session_id);
        if (wire.context_management !== undefined)
            hint.context_management = {
                manage_request: wire.context_management.manage_request,
                edits: wire.context_management.edits.map(edit => edit.type),
            };
        if (wire.priority_control !== undefined)
            hint.priority_control = { ...wire.priority_control.priority };
        if (wire.cache_control !== undefined)
            hint.cache_control = {
                ttl_s: wire.cache_control.ttl_s, msg_offset: wire.cache_control.msg_offset,
            };
        const base = { schemaVersion: 2, requestId: facts.requestId ?? randomUUID(), sessionId: text(wire.session.session_id),
            plane: facts.plane, transport: facts.transport, model: text(facts.model), attempt: facts.attempt ?? 1, hint };
        let start = performance.now();
        this.emit({ ...base, time: new Date().toISOString(), phase,
            outcome: phase === 'prepared' ? 'prepared' : 'dispatching' });
        let finished = false;
        let dispatched = phase === 'dispatch';
        return { requestId: base.requestId, dispatch: () => {
                if (finished || dispatched)
                    return;
                dispatched = true;
                start = performance.now();
                this.emit({ ...base, time: new Date().toISOString(), phase: 'dispatch', outcome: 'dispatching' });
            }, finish: (outcome, details = {}) => {
                if (finished)
                    return;
                finished = true;
                this.emit({ ...base, time: new Date().toISOString(), phase: 'result', outcome,
                    durationMs: Math.max(0, Math.round((performance.now() - start) * 1000) / 1000),
                    ...details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus },
                    ...details.dispatched === undefined ? {} : { dispatched: details.dispatched } });
            } };
    }
    get limit() { return Math.max(1, Math.min(10_000, this.options.maxRecords ?? 2000)); }
    emit(record) {
        this.records.push(record);
        while (this.records.length > this.limit)
            this.records.shift();
        // Logging must not fail or mutate requests, lifecycle state, or retained records.
        try {
            this.options.log?.(structuredClone(record));
        }
        catch { /* diagnostic sink only */ }
        // The Session log is a second diagnostic sink: a rejected append, a missing
        // store or an exhausted budget degrades to stdout and never reaches the callers.
        if (record.phase !== 'result')
            return;
        try {
            this.options.writeSessionRecord?.(structuredClone(record));
        }
        catch { /* diagnostic sink only */ }
    }
}
