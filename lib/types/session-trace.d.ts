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
import type { Session } from '@deepseek-ai/dsh-session';
import type { HintTraceRecord } from './trace-record.ts';
/**
 * The record name this package owns: `plugin:` plus the package-derived
 * segments (`dsh-agent-hints` / `trace`), so no other plugin can
 * collide with it. The grammar is lowercase slash-separated segments, which is
 * why the package/topic separator is `/` and not `:`.
 */
export declare const HINT_TRACE_RECORD_TYPE = "plugin:dsh-agent-hints/trace";
declare module '@deepseek-ai/dsh-session' {
    /**
     * Package-prefixed augmentation of the experimental plugin record catalog.
     * `appendPluginRecord` accepts exactly the keys of this map that widen to
     * {@link PluginRecordType}, so an unregistered name is a compile error rather
     * than a runtime throw.
     */
    interface PluginRecordMap {
        'plugin:dsh-agent-hints/trace': HintTraceRecord;
    }
}
/** Dependencies of {@link createSessionTraceSink}. */
export interface HintTraceSessionSinkOptions {
    /** Resolve the live Session for one session id; omission or `undefined` skips the write. */
    resolveSession?: ((sessionId: string) => Session | undefined) | undefined;
    /**
     * Per-session append budget, reusing the trace window bound (`maxRecords`).
     * The process window is bounded in memory; the log is durable, so it gets the
     * same ceiling per session instead of growing without limit.
     */
    maxRecords?: number | undefined;
    /** Append primitive, injectable so a test can simulate a host that moved or lost it. */
    append?: typeof dshSession.appendPluginRecord | undefined;
    /** Warning sink; every failure here is diagnosis, never control flow. */
    warn?: ((message: string, error?: unknown) => void) | undefined;
}
/**
 * Build the session-log sink the trace calls on each attempt's terminal record.
 *
 * The returned function never throws: a missing store, a missing primitive, an
 * exhausted budget or a rejected append all degrade to "stdout only", because a
 * diagnostic write must never fail or delay inference.
 * @param options - session lookup, budget, append primitive and warning sink.
 * @returns a sink that appends at most one record per attempt terminal state.
 */
export declare function createSessionTraceSink(options?: HintTraceSessionSinkOptions): (record: HintTraceRecord) => void;
