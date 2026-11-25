/**
 * The same bounded, content-free Hint trace, mirrored into the DSH Session log
 * through the 0.2.2 `appendPluginRecord` channel.
 *
 * Why this is allowed now: DSH 0.2.2-rc.1 publishes an official experimental
 * channel for plugin-owned events. A plugin record is an event marked
 * `ignorable`; a reader that does not know the type retains and skips it, and
 * the record never enters the model-visible surface (no `surfaceOp`). Fork and
 * resume carry the records along with the rest of the log, which is exactly the
 * retention this diagnostic wants.
 *
 * Deliberate trade-off (reviewed and accepted): `appendPluginRecord` documents
 * that "only production source under `packages/experimental/` may call this
 * function". That rule is a repository policy gate on DSH's own sources, not a
 * runtime check — nothing here is rejected or degraded at runtime. This package
 * is intentionally outside that policy scope and uses the channel anyway, so an
 * upgrade must re-confirm three things: that the function still exists, that its
 * `PluginRecordMap` augmentation point is unchanged, and that an unrecognized
 * `ignorable` record is still retained and skipped rather than rejected.
 *
 * @module @deepseek-ai/dsh-agent-hints/session-trace
 */
import * as dshSession from '@deepseek-ai/dsh-session';
/**
 * The record name this package owns: `plugin:` plus the package-derived
 * segments (`dsh-agent-hints` / `trace`), so no other plugin can
 * collide with it. The grammar is lowercase slash-separated segments, which is
 * why the package/topic separator is `/` and not `:`.
 */
export const HINT_TRACE_RECORD_TYPE = 'plugin:dsh-agent-hints/trace';
/** Per-session append budget; mirrors the trace window bound. */
const DEFAULT_MAX_RECORDS = 2000;
/**
 * Build the session-log sink the trace calls on each attempt's terminal record.
 *
 * The returned function never throws: a missing store, a missing primitive, an
 * exhausted budget or a rejected append all degrade to "stdout only", because a
 * diagnostic write must never fail or delay inference.
 * @param options - session lookup, budget, append primitive and warning sink.
 * @returns a sink that appends at most one record per attempt terminal state.
 */
export function createSessionTraceSink(options = {}) {
    const limit = options.maxRecords ?? DEFAULT_MAX_RECORDS;
    const written = new Map();
    const saturated = new Set();
    const failed = new Set();
    const warn = (message, error) => {
        try {
            options.warn?.(message, error);
        }
        catch { /* diagnostic sink only */ }
    };
    return record => {
        // Only the terminal record is durable: `prepared`/`dispatch` stay process-local
        // so the log grows by one line per attempt instead of three.
        if (record.phase !== 'result' || record.sessionId.length === 0)
            return;
        try {
            const append = 'append' in options ? options.append : dshSession.appendPluginRecord;
            if (typeof append !== 'function')
                return; // Host predates the plugin record channel.
            const count = written.get(record.sessionId) ?? 0;
            if (count >= limit) {
                if (!saturated.has(record.sessionId)) {
                    saturated.add(record.sessionId);
                    warn(`agent-hint: session trace budget of ${limit} records reached for session ${record.sessionId}; further records go to stdout only`);
                }
                return;
            }
            const session = options.resolveSession?.(record.sessionId);
            if (session === undefined)
                return; // No live Session (no store, or a session this process does not own).
            append(session, HINT_TRACE_RECORD_TYPE, record);
            written.set(record.sessionId, count + 1);
        }
        catch (error) {
            if (!failed.has(record.sessionId)) {
                failed.add(record.sessionId);
                warn(`agent-hint: cannot append a trace record to the session log of ${record.sessionId}; continuing with stdout only`, error);
            }
        }
    };
}
