// SPDX-License-Identifier: MulanPSL-2.0
/** Plugin configuration and request-local resolution for the agent-hint route. */
import type { Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef, type CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepSeekConfigFields, plainOptions as protocolOptions, resolveAdapterOptions as resolveProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek'
import type { Config as ProtocolConfig, DeepSeekCatalogModel, DeepSeekConnectionOptions, Options as ProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS } from './control-client.js'
import { DEFAULT_PENDING_OP_AWAIT_MS } from './lifecycle-bridge.js'
import type { AgentHintPriority } from './hint.js'

/** The provider route this plugin owns; read at plugin load. */
export const DEFAULT_PROVIDER = 'deepseek-hint'
/** Last-resort endpoint when neither configuration, a sibling route, nor the environment names one. */
export const DEFAULT_BASE_URL = 'https://api.deepseek.com'
/** Environment variable consulted when neither configuration nor a sibling route names an endpoint. */
export const BASE_URL_ENV = 'DSH_AGENT_HINT_BASE_URL'
/** Environment variable the official route uses; kept as a second fallback for zero-config installs. */
export const INHERITED_BASE_URL_ENV = 'DEEPSEEK_BASE_URL'

/**
 * Connection facts a sibling DeepSeek route already resolved. An operator who
 * can already talk to a model has, by construction, already named the endpoint
 * this plugin needs; asking them to type it again is the entire configuration
 * burden this shape removes.
 */
export interface InheritedConnection {
  /** Endpoint of the sibling route, when it configured one. */
  baseURL?: string | undefined
  /** Model catalog of the sibling route, when it declared one. */
  models?: readonly DeepSeekCatalogModel[] | undefined
  options?: ProtocolOptions | undefined
  /** Reference only; secret material is resolved per request. */
  apiKeyEnv?: string | undefined
}

/** No sibling route contributed anything; the identity value of {@link InheritedConnection}. */
export const NO_INHERITED_CONNECTION: InheritedConnection = {}

/** Session lifecycle control plane configuration. */
export interface SessionControlConfig {
  /** `false` disables manage requests; the static data plane keeps working. */
  enabled: boolean
  /** Install stock-host composer Remote and public archive observers. Default: true. */
  pluginTriggers?: boolean
  /** Full manage-request URL; omission derives `<baseURL>/v1/chat/completions`. */
  endpoint?: string | undefined
  /** Cap on how long an ordinary request waits for an in-flight verb. */
  pendingOpAwaitMs: number
  /** Per-attempt control-request timeout in milliseconds. */
  controlTimeoutMs: number
  /** Retries of explicit transient HTTP rejections for resume only. */
  retries: number
}

/** Priority emission mode: dynamic two-level (default), a static override, or omitted. */
export type PriorityConfig = 'dynamic' | 'omit' | AgentHintPriority

/** Cache-control emission mode: dynamic single ephemeral entry (default), a static override, or omitted. */
export interface StaticCacheControl {
  /** Explicit retention seconds. */
  ttl_s: number
  /** Fixed 1-based message offset; omission follows the request's wire message count. */
  msg_offset?: number | undefined
}
export type CacheControlConfig = 'dynamic' | 'omit' | StaticCacheControl

/** The two hint planes: per-request injection and lifecycle control. */
export interface AgentHintConfig {
  /** Master switch; false retains the selected transport without hints/controls. */
  enabled: boolean
  /** Bounded, content-free Host trace and an optional Session-log mirror. */
  trace?: { enabled: boolean; maxRecords: number; writeToSession: boolean }
  /** Soft priority: dynamic two-level, a static override, or omitted entirely. */
  priority: PriorityConfig
  /** Cache declaration: dynamic derivation, a static override, or omitted entirely. */
  cacheControl: CacheControlConfig
  /** Session lifecycle control plane. */
  sessionControl: SessionControlConfig
}

/** Messages configuration for the agent-hint route, with an optional per-request credential reference. */
export interface Config extends ProtocolConfig {

  /**
   * Credential reference resolved per request. When omitted, a same-endpoint
   * source reference can inherit unless inheritCredentials is false.
   */
  apiKeyEnv: Volatile<string | undefined>
  inheritCredentials: boolean
  /** Provider route id; read at plugin load (changing it requires a reload). */
  provider: string
  /** Chat is the stock coordinator path; Messages requires backend support. */
  transport: 'chat' | 'messages'
  /** The two hint planes. */
  agentHint?: AgentHintConfig | undefined
}

// Preserve omission until inheritance is resolved; defaults belong to the final resolver.
const optionalProtocolFields = Object.fromEntries(Object.entries(deepSeekConfigFields)
  .map(([key, schema]) => [key, schema.default(undefined as never)])) as typeof deepSeekConfigFields

const prioritySchema = z.union([
  z.const('dynamic'),
  z.const('omit'),
  z.object({ level: z.number().required(), reason: z.string().required() }),
])

const cacheControlSchema = z.union([
  z.const('dynamic'),
  z.const('omit'),
  z.object({ ttl_s: z.natural().min(1).required(), msg_offset: z.natural().min(1) }),
])

export const Config = z.object({
  ...optionalProtocolFields,
  apiKeyEnv: z.string().role('credential-ref').volatile(),
  inheritCredentials: z.boolean().default(true),
  provider: z.string().default(DEFAULT_PROVIDER),
  transport: z.union(['chat', 'messages']).default('chat'),
  agentHint: z.object({
    enabled: z.boolean().default(true),
    trace: z.object({
      enabled: z.boolean().default(true),
      maxRecords: z.number().step(1).min(1).max(10_000).default(2000),
      // Mirrors each attempt's terminal record into the Session log through the
      // 0.2.2 plugin record channel; stdout keeps every record either way.
      writeToSession: z.boolean().default(true),
    }),
    priority: prioritySchema.default('dynamic'),
    cacheControl: cacheControlSchema.default('dynamic'),
    sessionControl: z.object({
      enabled: z.boolean().default(true),
      pluginTriggers: z.boolean().default(true),
      endpoint: z.string(),
      pendingOpAwaitMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_PENDING_OP_AWAIT_MS),
      controlTimeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).default(DEFAULT_CONTROL_TIMEOUT_MS),
      retries: z.number().step(1).min(0).max(10).default(DEFAULT_CONTROL_RETRIES),
    }),
  }),
})

/** Plain deployment inputs for the agent-hint route. */
export type Options = ProtocolOptions & { apiKeyEnv?: string; inheritCredentials?: boolean }

/** Endpoint and credential reference captured from the same configuration generation. */
export interface ResolvedAgentHintOptions extends DeepSeekConnectionOptions {
  /** Credential reference used only for this connection snapshot; absent sends unauthenticated requests. */
  apiKeyEnv: CredentialRef | undefined
  credentialInherited: boolean
  authHeader: 'authorization' | 'x-api-key'
}

/** Read one validated provider configuration.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export function plainOptions(config: Config): Options {
  const apiKeyEnv = config.apiKeyEnv.get()
  return { ...protocolOptions(config), ...apiKeyEnv === undefined ? {} : { apiKeyEnv } }
}

/**
 * Resolve the coordinator endpoint through a fixed precedence chain.
 *
 * An explicit operator value always wins. The built-in public default is the
 * last resort, so it must never mask an inherited route or the environment: the
 * whole point of the chain is that a deployment which already reaches a model
 * needs to configure nothing here.
 *
 * @param configured - the resolved plugin configuration value.
 * @param inherited - endpoint facts read from a sibling route.
 * @param environment - application launch environment.
 * @returns the endpoint every request for this route should use.
 */
export function resolveBaseURL(
  configured: string | undefined,
  inherited: InheritedConnection = NO_INHERITED_CONNECTION,
  environment?: LaunchEnvironmentSnapshot,
): string {
  if (configured !== undefined) return configured
  const fromRoute = inherited.baseURL
  if (fromRoute !== undefined && fromRoute.length > 0) return fromRoute
  for (const name of [BASE_URL_ENV, INHERITED_BASE_URL_ENV]) {
    const value = environment?.get(name)?.value ?? process.env[name]
    if (value !== undefined && value.length > 0) return value
  }
  return DEFAULT_BASE_URL
}

/** Resolve the model catalog: explicit configuration, then the sibling route's.
 * @param configured - models declared on this plugin's own entry.
 * @param inherited - model catalog read from a sibling route.
 * @returns the catalog to advertise; empty when neither source declared one.
 */
export function resolveModels(
  configured: DeepSeekCatalogModel[] | undefined,
  inherited: InheritedConnection = NO_INHERITED_CONNECTION,
): DeepSeekCatalogModel[] {
  if (configured !== undefined) return [...configured]
  const fromRoute = inherited.models
  return fromRoute === undefined ? [] : [...fromRoute]
}

/** Resolve route and protocol settings together.
 * @param config - raw deployment settings.
 * @param environment - application launch environment.
 * @param inherited - endpoint facts read from a sibling route.
 * @returns validated endpoint facts and the matching credential reference, or `undefined` when the route names none.
 */
export function resolveAdapterOptions(
  config: Options,
  environment?: LaunchEnvironmentSnapshot,
  inherited: InheritedConnection = NO_INHERITED_CONNECTION,
): ResolvedAgentHintOptions {
  const baseURL = resolveBaseURL(config.baseURL, inherited, environment)
  const sameEndpoint = inherited.baseURL !== undefined
    && new URL(baseURL).href.replace(/\/+$/, '') === new URL(inherited.baseURL).href.replace(/\/+$/, '')
  const credentialInherited = config.apiKeyEnv === undefined && config.inheritCredentials !== false
    && sameEndpoint && inherited.apiKeyEnv !== undefined
  const apiKeyEnv = config.apiKeyEnv ?? (credentialInherited ? inherited.apiKeyEnv : undefined)
  const explicit = Object.fromEntries(Object.entries(config).filter(([, value]) => value !== undefined))
  return {
    ...resolveProtocolOptions({ ...inherited.options, ...explicit, baseURL, models: resolveModels(config.models, inherited) }, environment),
    apiKeyEnv: apiKeyEnv === undefined ? undefined : credentialRef(apiKeyEnv),
    credentialInherited,
    authHeader: credentialInherited ? 'x-api-key' : 'authorization',
  }
}
