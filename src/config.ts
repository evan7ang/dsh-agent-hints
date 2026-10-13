// SPDX-License-Identifier: Apache-2.0
/**
 * Plugin configuration normalization: raw patch-row config (plain JSON) into
 * validated runtime options. Invalid shapes fail at composition with a field
 * path — never per request. No schemastery: this is an out-of-tree plugin with
 * zero harness runtime dependencies.
 *
 * @module dsh-agent-hints/config
 */

import type { AgentHintCacheControl, AgentHintPriority } from './hint.js'

/** One advisory catalog entry for `resolveModel`. */
export interface ModelCatalogEntry {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** Validated plugin configuration. */
export interface PluginConfig {
  /** Upstream endpoint base; every chat request posts to `${baseURL}/chat/completions`. */
  baseURL: string
  /** Credential reference (environment-variable name) resolved per request. */
  apiKeyEnv: string
  /** Agent type reported as `session.agent_type`. */
  agentType: string
  /** Soft priority; `undefined` omits the field. */
  priority?: AgentHintPriority
  /** Cache control entries; `undefined` omits the field. */
  cacheControl?: AgentHintCacheControl[]
  /** Deployment thinking policy; `disabled` limits every conversation request to `off`. */
  thinking?: 'enabled' | 'disabled'
  /** Default reasoning effort when a request carries none. */
  reasoningEffort: 'off' | 'low' | 'high' | 'max'
  /** Advisory model catalog for `resolveModel`; unknown ids fall back to generic metadata. */
  models: ModelCatalogEntry[]
  /** Context window assumed for models absent from the catalog. */
  defaultContextWindow: number
  /** Per-request output cap materialized when callers omit one. */
  defaultMaxTokens: number
  /** Local JSONL sink path for out-of-band status events; unset disables the status channel (the gateway client will replace the sink). */
  statusSink?: string
  /** Tool names treated as subagent delegation for `derivation.join` and `agent:<name>` status naming. */
  subagentToolNames: string[]
}

export const DEFAULT_AGENT_TYPE = 'agent'

/** Interactive work waiting on the user. */
export const DEFAULT_PRIORITY: AgentHintPriority = { level: 3, reason: 'user_waiting' }

/** Pin the system prompt (message range [0, 1)): the byte-stable prefix is already guaranteed by the loop; this declares the intent explicitly. */
export const DEFAULT_CACHE_CONTROL: AgentHintCacheControl[] = [{ type: 'pin', range: { end: 1 } }]

/** Built-in advisory catalog, aligned with the official adapter's deepseek-flash family metadata. */
export const DEFAULT_MODELS: ModelCatalogEntry[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1_000_000, maxTokens: 256_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, maxTokens: 256_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, maxTokens: 256_000 },
]

const DEFAULT_REASONING_EFFORT = 'high'
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 256_000

function fail(field: string, expectation: string): never {
  throw new Error(`agent-hints: config${field} ${expectation}`)
}

function normalizePriority(raw: unknown, field: string): AgentHintPriority {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(field, 'must be an object')
  const { level, reason } = raw as Record<string, unknown>
  if (typeof level !== 'number' || !Number.isFinite(level)) fail(`${field}.level`, 'must be a finite number')
  if (typeof reason !== 'string') fail(`${field}.reason`, 'must be a string')
  return { level, reason }
}

function normalizeCacheControl(raw: unknown, field: string): AgentHintCacheControl[] {
  if (!Array.isArray(raw)) fail(field, 'must be an array')
  return raw.map((entry, index) => {
    const path = `${field}[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(path, 'must be an object')
    const { type, ttl_s: ttlS, range } = entry as Record<string, unknown>
    if (type !== 'pin' && type !== 'ephemeral') fail(`${path}.type`, 'must be "pin" or "ephemeral"')
    const normalized: AgentHintCacheControl = { type }
    if (ttlS !== undefined) {
      if (typeof ttlS !== 'number' || !Number.isFinite(ttlS) || ttlS <= 0) fail(`${path}.ttl_s`, 'must be a positive number')
      normalized.ttl_s = ttlS
    }
    if (range !== undefined) {
      if (typeof range !== 'object' || range === null || Array.isArray(range)) fail(`${path}.range`, 'must be an object')
      const { start, end, unit } = range as Record<string, unknown>
      const normalizedRange: AgentHintCacheControl['range'] = {}
      if (start !== undefined) {
        if (typeof start !== 'number' || !Number.isInteger(start)) fail(`${path}.range.start`, 'must be an integer')
        normalizedRange.start = start
      }
      if (end === null) normalizedRange.end = null
      else if (end !== undefined) {
        if (typeof end !== 'number' || !Number.isInteger(end)) fail(`${path}.range.end`, 'must be an integer or null')
        normalizedRange.end = end
      }
      if (unit !== undefined) {
        if (unit !== 'message' && unit !== 'token') fail(`${path}.range.unit`, 'must be "message" or "token"')
        normalizedRange.unit = unit
      }
      normalized.range = normalizedRange
    }
    return normalized
  })
}

function normalizeModels(raw: unknown, field: string): ModelCatalogEntry[] {
  if (!Array.isArray(raw)) fail(field, 'must be an array')
  return raw.map((entry, index) => {
    const path = `${field}[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(path, 'must be an object')
    const { id, name, contextWindow, maxTokens } = entry as Record<string, unknown>
    if (typeof id !== 'string' || id.length === 0) fail(`${path}.id`, 'must be a non-empty string')
    if (typeof name !== 'string') fail(`${path}.name`, 'must be a string')
    for (const key of ['contextWindow', 'maxTokens'] as const) {
      if (typeof entry[key] !== 'number' || !Number.isInteger(entry[key]) || (entry[key] as number) <= 0) {
        fail(`${path}.${key}`, 'must be a positive integer')
      }
    }
    return { id, name, contextWindow: contextWindow as number, maxTokens: maxTokens as number }
  })
}

/** Validate one raw config (patch-row `config` value) into runtime options; throws with a field path on shape violations. */
export function normalizeConfig(raw: unknown): PluginConfig {
  if (raw === undefined || raw === null) fail('', 'is required: baseURL and apiKeyEnv must be provided')
  if (typeof raw !== 'object' || Array.isArray(raw)) fail('', 'must be an object')
  const record = raw as Record<string, unknown>
  if (typeof record.baseURL !== 'string' || !/^https?:\/\//.test(record.baseURL)) {
    fail('.baseURL', 'must be an http(s) URL')
  }
  if (typeof record.apiKeyEnv !== 'string' || record.apiKeyEnv.length === 0) fail('.apiKeyEnv', 'must be a non-empty string')
  const agentType = record.agentType === undefined ? DEFAULT_AGENT_TYPE : record.agentType
  if (typeof agentType !== 'string' || agentType.length === 0) fail('.agentType', 'must be a non-empty string')
  if (record.thinking !== undefined && record.thinking !== 'enabled' && record.thinking !== 'disabled') {
    fail('.thinking', 'must be "enabled" or "disabled"')
  }
  const reasoningEffort = record.reasoningEffort === undefined ? DEFAULT_REASONING_EFFORT : record.reasoningEffort
  if (reasoningEffort !== 'off' && reasoningEffort !== 'low' && reasoningEffort !== 'high' && reasoningEffort !== 'max') {
    fail('.reasoningEffort', 'must be "off", "low", "high", or "max"')
  }
  const models = record.models === undefined ? DEFAULT_MODELS : normalizeModels(record.models, '.models')
  const defaultContextWindow = record.defaultContextWindow === undefined ? DEFAULT_CONTEXT_WINDOW : record.defaultContextWindow
  if (typeof defaultContextWindow !== 'number' || !Number.isInteger(defaultContextWindow) || defaultContextWindow <= 0) {
    fail('.defaultContextWindow', 'must be a positive integer')
  }
  const defaultMaxTokens = record.defaultMaxTokens === undefined ? DEFAULT_MAX_TOKENS : record.defaultMaxTokens
  if (typeof defaultMaxTokens !== 'number' || !Number.isInteger(defaultMaxTokens) || defaultMaxTokens <= 0) {
    fail('.defaultMaxTokens', 'must be a positive integer')
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
    thinking: record.thinking as PluginConfig['thinking'],
    reasoningEffort,
    models,
    defaultContextWindow,
    defaultMaxTokens,
    statusSink: record.statusSink === undefined ? undefined : normalizeSinkPath(record.statusSink),
    subagentToolNames: record.subagentToolNames === undefined
      ? ['subagent']
      : normalizeStringList(record.subagentToolNames, '.subagentToolNames'),
  }
}

function normalizeSinkPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) fail('.statusSink', 'must be a non-empty string')
  return raw
}

function normalizeStringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) fail(field, 'must be an array')
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) fail(`${field}[${index}]`, 'must be a non-empty string')
    return entry
  })
}
