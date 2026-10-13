// SPDX-License-Identifier: Apache-2.0
/**
 * Plugin configuration normalization: raw patch-row config (plain JSON) into
 * validated runtime options. Invalid shapes fail at composition with a field
 * path — never per request. No schemastery: this is an out-of-tree plugin with
 * zero harness runtime dependencies.
 *
 * @module dsh-agent-hints/config
 */
export const DEFAULT_AGENT_TYPE = 'agent';
/** Interactive work waiting on the user. */
export const DEFAULT_PRIORITY = { level: 3, reason: 'user_waiting' };
/** Pin the system prompt (message range [0, 1)): the byte-stable prefix is already guaranteed by the loop; this declares the intent explicitly. */
export const DEFAULT_CACHE_CONTROL = [{ type: 'pin', range: { end: 1 } }];
/** Built-in advisory catalog, aligned with the official adapter's deepseek-flash family metadata. */
export const DEFAULT_MODELS = [
    { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1_000_000, maxTokens: 256_000 },
    { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, maxTokens: 256_000 },
    { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, maxTokens: 256_000 },
];
const DEFAULT_REASONING_EFFORT = 'high';
const DEFAULT_CONTEXT_WINDOW = 1_000_000;
const DEFAULT_MAX_TOKENS = 256_000;
function fail(field, expectation) {
    throw new Error(`agent-hints: config${field} ${expectation}`);
}
function normalizePriority(raw, field) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        fail(field, 'must be an object');
    const { level, reason } = raw;
    if (typeof level !== 'number' || !Number.isFinite(level))
        fail(`${field}.level`, 'must be a finite number');
    if (typeof reason !== 'string')
        fail(`${field}.reason`, 'must be a string');
    return { level, reason };
}
function normalizeCacheControl(raw, field) {
    if (!Array.isArray(raw))
        fail(field, 'must be an array');
    return raw.map((entry, index) => {
        const path = `${field}[${index}]`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            fail(path, 'must be an object');
        const { type, ttl_s: ttlS, range } = entry;
        if (type !== 'pin' && type !== 'ephemeral')
            fail(`${path}.type`, 'must be "pin" or "ephemeral"');
        const normalized = { type };
        if (ttlS !== undefined) {
            if (typeof ttlS !== 'number' || !Number.isFinite(ttlS) || ttlS <= 0)
                fail(`${path}.ttl_s`, 'must be a positive number');
            normalized.ttl_s = ttlS;
        }
        if (range !== undefined) {
            if (typeof range !== 'object' || range === null || Array.isArray(range))
                fail(`${path}.range`, 'must be an object');
            const { start, end, unit } = range;
            const normalizedRange = {};
            if (start !== undefined) {
                if (typeof start !== 'number' || !Number.isInteger(start))
                    fail(`${path}.range.start`, 'must be an integer');
                normalizedRange.start = start;
            }
            if (end === null)
                normalizedRange.end = null;
            else if (end !== undefined) {
                if (typeof end !== 'number' || !Number.isInteger(end))
                    fail(`${path}.range.end`, 'must be an integer or null');
                normalizedRange.end = end;
            }
            if (unit !== undefined) {
                if (unit !== 'message' && unit !== 'token')
                    fail(`${path}.range.unit`, 'must be "message" or "token"');
                normalizedRange.unit = unit;
            }
            normalized.range = normalizedRange;
        }
        return normalized;
    });
}
function normalizeModels(raw, field) {
    if (!Array.isArray(raw))
        fail(field, 'must be an array');
    return raw.map((entry, index) => {
        const path = `${field}[${index}]`;
        if (typeof entry !== 'object' || entry === null || Array.isArray(entry))
            fail(path, 'must be an object');
        const { id, name, contextWindow, maxTokens } = entry;
        if (typeof id !== 'string' || id.length === 0)
            fail(`${path}.id`, 'must be a non-empty string');
        if (typeof name !== 'string')
            fail(`${path}.name`, 'must be a string');
        for (const key of ['contextWindow', 'maxTokens']) {
            if (typeof entry[key] !== 'number' || !Number.isInteger(entry[key]) || entry[key] <= 0) {
                fail(`${path}.${key}`, 'must be a positive integer');
            }
        }
        return { id, name, contextWindow: contextWindow, maxTokens: maxTokens };
    });
}
/** Validate one raw config (patch-row `config` value) into runtime options; throws with a field path on shape violations. */
export function normalizeConfig(raw) {
    if (raw === undefined || raw === null)
        fail('', 'is required: baseURL and apiKeyEnv must be provided');
    if (typeof raw !== 'object' || Array.isArray(raw))
        fail('', 'must be an object');
    const record = raw;
    if (typeof record.baseURL !== 'string' || !/^https?:\/\//.test(record.baseURL)) {
        fail('.baseURL', 'must be an http(s) URL');
    }
    if (typeof record.apiKeyEnv !== 'string' || record.apiKeyEnv.length === 0)
        fail('.apiKeyEnv', 'must be a non-empty string');
    const agentType = record.agentType === undefined ? DEFAULT_AGENT_TYPE : record.agentType;
    if (typeof agentType !== 'string' || agentType.length === 0)
        fail('.agentType', 'must be a non-empty string');
    if (record.thinking !== undefined && record.thinking !== 'enabled' && record.thinking !== 'disabled') {
        fail('.thinking', 'must be "enabled" or "disabled"');
    }
    const reasoningEffort = record.reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : record.reasoningEffort;
    if (reasoningEffort !== 'off' && reasoningEffort !== 'low' && reasoningEffort !== 'high' && reasoningEffort !== 'max') {
        fail('.reasoningEffort', 'must be "off", "low", "high", or "max"');
    }
    const models = record.models === undefined ? DEFAULT_MODELS : normalizeModels(record.models, '.models');
    const defaultContextWindow = record.defaultContextWindow === undefined ? DEFAULT_CONTEXT_WINDOW : record.defaultContextWindow;
    if (typeof defaultContextWindow !== 'number' || !Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
        fail('.defaultContextWindow', 'must be a positive integer');
    }
    const defaultMaxTokens = record.defaultMaxTokens === undefined ? DEFAULT_MAX_TOKENS : record.defaultMaxTokens;
    if (typeof defaultMaxTokens !== 'number' || !Number.isInteger(defaultMaxTokens) || defaultMaxTokens <= 0) {
        fail('.defaultMaxTokens', 'must be a positive integer');
    }
    return {
        baseURL: record.baseURL.replace(/\/+$/, ''),
        apiKeyEnv: record.apiKeyEnv,
        agentType,
        priority: record.priority === undefined
            ? { ...DEFAULT_PRIORITY }
            : record.priority === null ? undefined : normalizePriority(record.priority, '.priority'),
        cacheControl: record.cacheControl === undefined
            ? DEFAULT_CACHE_CONTROL
            : record.cacheControl === null ? undefined : normalizeCacheControl(record.cacheControl, '.cacheControl'),
        thinking: record.thinking,
        reasoningEffort,
        models,
        defaultContextWindow,
        defaultMaxTokens,
        statusSink: record.statusSink === undefined ? undefined : normalizeSinkPath(record.statusSink),
        subagentToolNames: record.subagentToolNames === undefined
            ? ['subagent']
            : normalizeStringList(record.subagentToolNames, '.subagentToolNames'),
    };
}
function normalizeSinkPath(raw) {
    if (typeof raw !== 'string' || raw.length === 0)
        fail('.statusSink', 'must be a non-empty string');
    return raw;
}
function normalizeStringList(raw, field) {
    if (!Array.isArray(raw))
        fail(field, 'must be an array');
    return raw.map((entry, index) => {
        if (typeof entry !== 'string' || entry.length === 0)
            fail(`${field}[${index}]`, 'must be a non-empty string');
        return entry;
    });
}
