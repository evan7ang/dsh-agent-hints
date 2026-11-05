// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Dynamic `cache_control` derivation per the implementation guide: one
 * ephemeral declaration per main-line request declaring "keep the current
 * prefix for N more seconds".
 *
 * TTL policy: `clamp(gap × 2, 60, 3600)` where `gap` is the latest observed
 * request interval (response end → request start); the factor 2 tolerates the
 * real gap being twice the estimate because under-estimation loses the whole
 * prefix while over-estimation only holds memory slightly longer. Without a
 * sample the 300 s fallback applies. A declaration below one engine block
 * (128 tokens) is pointless and therefore omitted. All functions are pure so
 * the value policy is unit-testable without a harness.
 *
 * @module dsh-agent-hints/cache
 */
/** Lower clamp bound: declarations below this are raised (guide §2.3). */
export const TTL_MIN_S = 60;
/** Upper clamp bound: declarations above this are truncated, never dropped (guide §2.3). */
export const TTL_MAX_S = 3600;
/** Gap assumed when no interval sample exists (guide §4.2). */
export const TTL_FALLBACK_GAP_S = 300;
/** Safety factor over the estimated gap (guide §4.3). */
export const TTL_FACTOR = 2;
/** The engine stores whole KV blocks; a shorter prefix cannot be cached (guide §2.3). */
export const MIN_PREFIX_TOKENS = 128;
/**
 * CJK-aware prefix size estimate (guide §6.2): one token per CJK/full-width
 * character, one token per four other characters. Under-estimation is the
 * benign direction (a skipped declaration), over-estimation is clamped by the
 * engine's own block threshold.
 * @param messages - the wire messages actually being sent.
 */
export function estimatePrefixTokens(messages) {
    let cjk = 0;
    let other = 0;
    const walk = (value) => {
        if (typeof value === 'string') {
            for (const char of value) {
                const code = char.codePointAt(0) ?? 0;
                if ((code >= 0x2e80 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) {
                    cjk += 1;
                }
                else {
                    other += 1;
                }
            }
        }
        else if (Array.isArray(value)) {
            for (const entry of value)
                walk(entry);
        }
        else if (typeof value === 'object' && value !== null) {
            for (const entry of Object.values(value))
                walk(entry);
        }
    };
    for (const message of messages)
        walk(message);
    return cjk + Math.ceil(other / 4);
}
/**
 * Derive the declaration TTL from the latest request interval.
 * @param intervalMs - response-end → request-start gap; `undefined` uses the fallback.
 */
export function deriveTtlS(intervalMs) {
    const gapS = intervalMs !== undefined && Number.isFinite(intervalMs) && intervalMs > 0
        ? intervalMs / 1000
        : TTL_FALLBACK_GAP_S;
    return Math.min(TTL_MAX_S, Math.max(TTL_MIN_S, Math.round(gapS * TTL_FACTOR)));
}
/**
 * Assemble the single ephemeral declaration for one request.
 * @param logicalMessageCount - the wire message count of this request (`[system?] + messages`); becomes `range.end`.
 * @param prefixTokens - the estimated prefix size; below one block the declaration is omitted.
 * @param intervalMs - the interval sample feeding the TTL.
 */
export function buildCacheControl(logicalMessageCount, prefixTokens, intervalMs) {
    if (!Number.isSafeInteger(logicalMessageCount) || logicalMessageCount < 1)
        return undefined;
    if (prefixTokens > 0 && prefixTokens < MIN_PREFIX_TOKENS)
        return undefined;
    return [{
            type: 'ephemeral',
            ttl_s: deriveTtlS(intervalMs),
            range: { end: logicalMessageCount, unit: 'message' },
        }];
}
/**
 * The prefix-key signature of one request: the model plus the tool-set names.
 * A declaration from a different signature would pin a prefix the engine
 * cached under another key, so it is suppressed for that round.
 * @param model - the resolved model id on the wire.
 * @param toolNames - the offered tool names (order-insensitive).
 */
export function cacheSignature(model, toolNames) {
    const tools = toolNames === undefined ? [] : [...toolNames].sort();
    return JSON.stringify([model, tools]);
}
