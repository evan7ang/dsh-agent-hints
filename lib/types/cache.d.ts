/**
 * Dynamic `cache_control` derivation: one `ephemeral` declaration per main-line
 * request declaring "keep the current prefix for N more seconds", with the
 * effective point expressed as a 1-based `msg_offset` (the request's wire
 * message count).
 *
 * TTL policy: `clamp(gap × 2, 60, 3600)` where `gap` is the latest observed
 * request interval (response end → request start); the factor 2 tolerates the
 * real gap being twice the estimate because under-estimation loses the whole
 * prefix while over-estimation only holds memory slightly longer. Without a
 * sample the 300 s fallback applies. A declaration below one engine block
 * (128 tokens) is pointless and therefore omitted. All functions are pure so
 * the value policy is unit-testable without a harness.
 *
 * @module @deepseek-ai/dsh-agent-hints/cache
 */
import type { AgentHintCacheControl } from './hint.js';
/** Lower clamp bound: declarations below this are raised. */
export declare const TTL_MIN_S = 60;
/** Upper clamp bound: declarations above this are truncated, never dropped. */
export declare const TTL_MAX_S = 3600;
/** Gap assumed when no interval sample exists. */
export declare const TTL_FALLBACK_GAP_S = 300;
/** Safety factor over the estimated gap. */
export declare const TTL_FACTOR = 2;
/** The engine stores whole KV blocks; a shorter prefix cannot be cached. */
export declare const MIN_PREFIX_TOKENS = 128;
/**
 * CJK-aware prefix size estimate: one token per CJK/full-width character, one
 * token per four other characters. Under-estimation is the benign direction
 * (a skipped declaration), over-estimation is clamped by the engine's own
 * block threshold.
 * @param messages - the wire messages actually being sent.
 */
export declare function estimatePrefixTokens(messages: readonly unknown[]): number;
/**
 * Derive the declaration TTL from the latest request interval.
 * @param intervalMs - response-end → request-start gap; `undefined` uses the fallback.
 */
export declare function deriveTtlS(intervalMs: number | undefined): number;
/**
 * Assemble the single ephemeral declaration for one request.
 * @param logicalMessageCount - the wire message count of this request; becomes `msg_offset`.
 * @param prefixTokens - the estimated prefix size; below one block the declaration is omitted.
 * @param intervalMs - the interval sample feeding the TTL.
 */
export declare function buildCacheControl(logicalMessageCount: number, prefixTokens: number, intervalMs: number | undefined): AgentHintCacheControl | undefined;
/**
 * The prefix-key signature of one request: the model plus the tool-set names.
 * A declaration from a different signature would pin a prefix the engine
 * cached under another key, so it is suppressed for that round.
 * @param model - the resolved model id on the wire.
 * @param toolNames - the offered tool names (order-insensitive).
 */
export declare function cacheSignature(model: string, toolNames: readonly string[] | undefined): string;
