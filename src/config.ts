// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Plugin configuration normalization: raw patch-row config (plain JSON) into
 * validated runtime options. The config is a pure OVERRIDE layer over the DSH
 * host's endpoint/credential facts — absent fields inherit, so the plugin
 * works with zero config. Invalid shapes fail at composition with a field
 * path — never per request. No schemastery: this is an out-of-tree plugin with
 * zero harness runtime dependencies.
 *
 * @module dsh-agent-hints/config
 */

import type { AgentHintCacheControl, AgentHintPriority } from './hint.js'
import type { PredictionStatic } from './prediction.js'

/** One advisory catalog entry for `resolveModel`. */
export interface ModelCatalogEntry {
  id: string
  name: string
  contextWindow: number
  maxTokens: number
}

/** Priority emission mode: dynamic two-level (default), a static override, or omitted entirely. */
export type PriorityConfig = 'dynamic' | 'omit' | AgentHintPriority

/** Cache-control emission mode: dynamic single ephemeral entry (default), a static override, or omitted entirely. */
export type CacheControlConfig = 'dynamic' | 'omit' | AgentHintCacheControl[]

/** Validated plugin configuration. Every field carries an inherited default; the patch-row config only overrides. */
export interface PluginConfig {
  /** Upstream endpoint base; every chat request posts to `${baseURL}/chat/completions`. Inherits `$DEEPSEEK_BASE_URL` → the public API default. */
  baseURL: string
  /** Credential reference (environment-variable name) resolved per request; inherits `DEEPSEEK_API_KEY`. */
  apiKeyEnv: string
  /** Agent type reported as `session.agent_type`. */
  agentType: string
  /**
   * Soft priority. `dynamic` (default): level 3 + `user_waiting` on turn-opening
   * requests, level 1 + `critical_path` everywhere else. A static object is a
   * constant override folded into the two-level domain {1, 3}. `omit` never
   * sends the field.
   */
  priority: PriorityConfig
  /**
   * Cache control. `dynamic` (default): one `ephemeral` entry whose TTL is
   * derived from the last request interval. A static array overrides the
   * policy (ephemeral only, explicit `ttl_s`, at most one entry); an entry
   * without an explicit `range` declares this request's wire message count
   * (`{end: messages.length, unit: "message"}`) at send time. `omit` never
   * sends the field.
   */
  cacheControl: CacheControlConfig
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
  /** Local JSONL sink path for out-of-band status events; unset disables the file sink (the gateway client will replace the sink). */
  statusSink?: string
  /** Full status-event endpoint URL; overrides the `statusAuto` derivation when set (non-default paths or a separate status service). */
  statusEndpoint?: string
  /** Derive the status endpoint from `baseURL`'s origin (`<origin>/agent-status`, the Motor-coordinator convention) when no explicit `statusEndpoint` is set. */
  statusAuto?: boolean
  /** Offline prediction trie file path (built by `scripts/build-prediction-trie.mjs`); enables the `prediction` hint block's distribution values. */
  predictionTrie?: string
  /** Static per-field fallbacks for the `prediction` block (dynamo `OptimizableField` analog); configuring this or `predictionTrie` turns the block on. */
  predictionStatic?: PredictionStatic
  /** Minimum node sample count for a trie distribution to be trusted over the static value. */
  predictionMinSamples: number
  /** Tool names treated as subagent delegation for `derivation.join` and `agent:<name>` status naming. */
  subagentToolNames: string[]
}

export const DEFAULT_AGENT_TYPE = 'agent'

/** Built-in advisory catalog, aligned with the official adapter's deepseek-flash family metadata. */
export const DEFAULT_MODELS: ModelCatalogEntry[] = [
  { id: 'deepseek-flash', name: 'DeepSeek-V41-Flash', contextWindow: 1_000_000, maxTokens: 256_000 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash', contextWindow: 1_000_000, maxTokens: 256_000 },
  { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro', contextWindow: 1_000_000, maxTokens: 256_000 },
]

const DEFAULT_REASONING_EFFORT = 'high'
const DEFAULT_CONTEXT_WINDOW = 1_000_000
const DEFAULT_MAX_TOKENS = 256_000
const DEFAULT_API_KEY_ENV = 'DEEPSEEK_API_KEY'
const DEFAULT_PREDICTION_MIN_SAMPLES = 5

/**
 * The inherited endpoint chain, mirroring the official llm-deepseek adapter's
 * own resolution: its settings-section `baseURL` is NOT readable from another
 * plugin (the settings section reader is private to the registrant), but the
 * public fallback sources are — `$DEEPSEEK_BASE_URL` (the official trusted-env
 * knob) then the public API default. Endpoint/credential facts therefore live
 * in the DSH host (launch environment + credentials service) and this plugin's
 * own config becomes a pure per-field override.
 */
function inheritedBaseURL(): string {
  return process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'
}

function inheritedApiKeyEnv(): string {
  return process.env.DEEPSEEK_API_KEY_ENV ?? DEFAULT_API_KEY_ENV
}

function fail(field: string, expectation: string): never {
  throw new Error(`agent-hints: config${field} ${expectation}`)
}

/**
 * Fold one soft-priority level onto the two-level contract domain {1, 3}
 * (admission anchor: 3 = user-intervened, 1 = everything else). Legacy {2, 4}
 * fold to their nearest value and out-of-range values collapse onto the
 * admission line, so the admission verdict never changes.
 */
export function foldPriorityLevel(level: number): 1 | 3 {
  return level >= 3 ? 3 : 1
}

function normalizePriority(raw: unknown, field: string): AgentHintPriority {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail(field, 'must be an object')
  const { level, reason } = raw as Record<string, unknown>
  if (typeof level !== 'number' || !Number.isFinite(level)) fail(`${field}.level`, 'must be a finite number')
  if (typeof reason !== 'string') fail(`${field}.reason`, 'must be a string')
  return { level: foldPriorityLevel(level), reason }
}

/**
 * Validate one static cache-control override under the retired-`pin` rules:
 * ephemeral only, explicit positive `ttl_s`, at most one entry (single
 * breakpoint), and `message` as the only supported range unit.
 */
function normalizeCacheEntries(raw: unknown, field: string): 'omit' | AgentHintCacheControl[] {
  if (!Array.isArray(raw)) fail(field, 'must be an array')
  if (raw.length === 0) return 'omit'
  if (raw.length > 1) fail(field, 'must contain at most one entry (a single breakpoint)')
  return raw.map((entry, index) => {
    const path = `${field}[${index}]`
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) fail(path, 'must be an object')
    const { type, ttl_s: ttlS, range } = entry as Record<string, unknown>
    if (type !== 'ephemeral') fail(`${path}.type`, 'must be "ephemeral" ("pin" is retired)')
    if (typeof ttlS !== 'number' || !Number.isFinite(ttlS) || ttlS <= 0) {
      fail(`${path}.ttl_s`, 'must be a positive number (a declaration needs an explicit TTL)')
    }
    const normalized: AgentHintCacheControl = { type, ttl_s: ttlS }
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
        if (unit !== 'message') fail(`${path}.range.unit`, 'must be "message"')
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

/**
 * Validate one raw config (patch-row `config` value) into runtime options.
 * The config is a pure OVERRIDE layer: absent fields inherit the DSH host's
 * endpoint/credential facts (`$DEEPSEEK_BASE_URL` → public API default;
 * `DEEPSEEK_API_KEY` credential ref), so the plugin works with ZERO config.
 * Provided-but-invalid values still throw with a field path.
 */
export function normalizeConfig(raw: unknown): PluginConfig {
  const record: Record<string, unknown> = raw === undefined || raw === null
    ? {}
    : (() => {
      if (typeof raw !== 'object' || Array.isArray(raw)) fail('', 'must be an object')
      return raw as Record<string, unknown>
    })()
  const baseURL = record.baseURL === undefined ? inheritedBaseURL() : record.baseURL
  if (typeof baseURL !== 'string' || !/^https?:\/\//.test(baseURL)) {
    fail('.baseURL', 'must be an http(s) URL')
  }
  const apiKeyEnv = record.apiKeyEnv === undefined ? inheritedApiKeyEnv() : record.apiKeyEnv
  if (typeof apiKeyEnv !== 'string' || apiKeyEnv.length === 0) fail('.apiKeyEnv', 'must be a non-empty string')
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
  const priority: PriorityConfig = record.priority === undefined
    ? 'dynamic'
    : record.priority === null ? 'omit' : normalizePriority(record.priority, '.priority')
  const cacheControl: CacheControlConfig = record.cacheControl === undefined
    ? 'dynamic'
    : record.cacheControl === null ? 'omit' : normalizeCacheEntries(record.cacheControl, '.cacheControl')
  return {
    baseURL: baseURL.replace(/\/+$/, ''),
    apiKeyEnv,
    agentType,
    priority,
    cacheControl,
    thinking: record.thinking as PluginConfig['thinking'],
    reasoningEffort,
    models,
    defaultContextWindow,
    defaultMaxTokens,
    statusSink: record.statusSink === undefined ? undefined : normalizeSinkPath(record.statusSink),
    statusEndpoint: record.statusEndpoint === undefined ? undefined : normalizeEndpoint(record.statusEndpoint),
    statusAuto: record.statusAuto === undefined ? false : normalizeBoolean(record.statusAuto),
    predictionTrie: record.predictionTrie === undefined ? undefined : normalizePath(record.predictionTrie, '.predictionTrie'),
    predictionStatic: record.predictionStatic === undefined ? undefined : normalizePredictionStatic(record.predictionStatic),
    predictionMinSamples: record.predictionMinSamples === undefined ? DEFAULT_PREDICTION_MIN_SAMPLES : normalizePositiveInteger(record.predictionMinSamples, '.predictionMinSamples'),
    subagentToolNames: record.subagentToolNames === undefined
      ? ['subagent']
      : normalizeStringList(record.subagentToolNames, '.subagentToolNames'),
  }
}

function normalizeSinkPath(raw: unknown): string {
  if (typeof raw !== 'string' || raw.length === 0) fail('.statusSink', 'must be a non-empty string')
  return raw
}

function normalizePath(raw: unknown, field: string): string {
  if (typeof raw !== 'string' || raw.length === 0) fail(field, 'must be a non-empty string')
  return raw
}

function normalizePredictionStatic(raw: unknown): PredictionStatic {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) fail('.predictionStatic', 'must be an object')
  const record = raw as Record<string, unknown>
  const normalized: PredictionStatic = {}
  for (const field of ['latency_ms', 'remaining_calls', 'output_tokens', 'interval_ms', 'remaining_time_ms'] as const) {
    const value = record[field]
    if (value === undefined) continue
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      fail(`.predictionStatic.${field}`, 'must be a non-negative finite number')
    }
    normalized[field] = value
  }
  return normalized
}

function normalizePositiveInteger(raw: unknown, field: string): number {
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw <= 0) fail(field, 'must be a positive integer')
  return raw
}

function normalizeEndpoint(raw: unknown): string {
  if (typeof raw !== 'string' || !/^https?:\/\//.test(raw)) fail('.statusEndpoint', 'must be an http(s) URL')
  return raw
}

function normalizeBoolean(raw: unknown): boolean {
  if (typeof raw !== 'boolean') fail('', 'boolean fields must be true or false')
  return raw
}

function normalizeStringList(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) fail(field, 'must be an array')
  return raw.map((entry, index) => {
    if (typeof entry !== 'string' || entry.length === 0) fail(`${field}[${index}]`, 'must be a non-empty string')
    return entry
  })
}
