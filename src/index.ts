// SPDX-License-Identifier: MulanPSL-2.0
/**
 * Register the agent-hint route: Chat or DeepSeek Messages aimed at a
 * coordinator or gateway that understands the normalized `X-Agent-Hint` header
 * (session identity, two-level priority, dynamic cache declaration) and whose
 * session lifecycle events plus the first ordinary request of a fresh session
 * drive the `start` / `pause` / `resume` / `stop` / `compact` states through
 * dedicated manage requests.
 *
 * The request body never carries hint fields. The endpoint and model catalog
 * fall back to the sibling DeepSeek route, so an operator using a compatible
 * backend avoids duplicate configuration. Messages uses the official pipeline;
 * Chat owns its protocol mapping and model contract; connection facts resolve
 * per request. Credentials may inherit only for the same endpoint. Prefetch is
 * advisory; pending or unknown cache mutations block new ordinary requests in
 * the affected session.
 *
 * @module @deepseek-ai/dsh-agent-hints
 */

import type { Context } from '@deepseek-ai/cordis'
import { assertUsableApiKey, LlmError, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { catalogModelInfo } from '@deepseek-ai/dsh-llm-deepseek'
import { getOrCreateAnonymousUserId } from '@deepseek-ai/dsh-anonymous-user-id'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-api-gateway'
import { Config, plainOptions, resolveAdapterOptions } from './config.js'
import type { CacheControlConfig, PriorityConfig, ResolvedAgentHintOptions } from './config.js'
import { AgentHintAdapter, agentHintScope } from './adapter.js'
import { ChatCompletionsAdapter, chatCompletionsURL } from './chat-adapter.js'
import { buildOrdinaryHint, deriveServingFacts, encodeAgentHintHeader } from './hint.js'
import type { AgentHintCacheControl, AgentHintPriority, ServingFacts } from './hint.js'
import { buildCacheControl, cacheSignature } from './cache.js'
import { readInheritedConnection, INHERIT_SOURCE_ID } from './inherited-connection.js'
import { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, SessionControlClient } from './control-client.js'
import type { ManageSessionFacts } from './control-client.js'
import { agentHintAcceptExtensions } from './extension.js'
import { DEFAULT_PENDING_OP_AWAIT_MS, LifecycleBridge } from './lifecycle-bridge.js'
import { observeArchives } from './archive-observer.js'
import { AgentHintSignals } from './composing-service.js'
import { HintTrace } from './trace.js'
import { createSessionTraceSink } from './session-trace.js'

export { buildManageHint, buildOrdinaryHint, deriveServingFacts, encodeAgentHintHeader, STATE_EDIT } from './hint.js'
export type {
  AgentHint, AgentHintCacheControl, AgentHintContextManagement, AgentHintEdit, AgentHintPriority,
  AgentHintSession, ManageState, OrdinaryHintFacts, ManageHintFacts, SessionState, ServingFacts,
} from './hint.js'
export { BASE_URL_ENV, Config, DEFAULT_BASE_URL, DEFAULT_PROVIDER, INHERITED_BASE_URL_ENV, NO_INHERITED_CONNECTION,
  plainOptions, resolveAdapterOptions, resolveBaseURL, resolveModels } from './config.js'
export type { AgentHintConfig, CacheControlConfig, InheritedConnection, Options, PriorityConfig,
  ResolvedAgentHintOptions, SessionControlConfig, StaticCacheControl } from './config.js'
export { INHERIT_SOURCE_ID, readInheritedConnection } from './inherited-connection.js'
export { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, SessionControlClient } from './control-client.js'
export type { ControlResult, ControlConnection, ControlWarnSink, ManageSessionFacts, SessionControlClientOptions } from './control-client.js'
export { AgentHintAdapter, agentHintScope } from './adapter.js'
export type { AgentHintAdapterOptions, MessagesHintFacts } from './adapter.js'
export { agentHintAcceptExtensions } from './extension.js'
export type { AgentHintExtensionOptions } from './extension.js'
export { ControlBarrierError, COMPACTION_LINEAGE_WINDOW_MS, DEFAULT_PENDING_OP_AWAIT_MS, DEFAULT_QUARANTINE_TTL_MS, LifecycleBridge } from './lifecycle-bridge.js'
export type { BridgeWarnSink, LifecycleBridgeOptions } from './lifecycle-bridge.js'
export { HintTrace } from './trace.js'
export type { HintTraceRecord, HintTraceSummary } from './trace-record.js'
export { HINT_TRACE_RECORD_TYPE, createSessionTraceSink } from './session-trace.js'
export type { HintTraceSessionSinkOptions } from './session-trace.js'

export const name = 'agent-hints'
export const inject = ['llm']

/** The conventional manage-request path appended to `baseURL` when no explicit endpoint is configured. */
export { chatCompletionsURL }

export function apply(ctx: Context, config: Config): void {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort(), 'agent-hint: adapter lifetime')
  const provider = config.provider
  const options = () => resolveAdapterOptions(plainOptions(config), launchEnvironmentOf(ctx), readInheritedConnection(ctx))
  options()
  const resolveApiKey = async (connection: ResolvedAgentHintOptions): Promise<string | undefined> => {
    const ref = connection.apiKeyEnv
    if (ref === undefined) return undefined
    const credentials = ctx.get('credentials')
    if (credentials !== undefined) {
      const hit = await credentials.resolve(ref)
      if (hit !== undefined) return assertUsableApiKey(hit.value, 'agent-hints', ref)
    } else {
      const ambient = launchEnvironmentOf(ctx).get(ref)
      if (ambient !== undefined && ambient.value.length > 0) return assertUsableApiKey(ambient.value, 'agent-hints', ref)
    }
    // An unauthenticated local coordinator may coexist with the stock route's
    // default, unused DEEPSEEK_API_KEY reference. Explicit plugin refs are strict.
    if (connection.credentialInherited) return undefined
    throw new LlmError(
      `agent-hints: no API key for provider route "${provider}"; store ${ref} through the credentials`
      + ` service (the web Models page writes it), or export ${ref} in the launching environment`,
      'MISSING_CREDENTIAL',
    )
  }

  const hintConfig = config.agentHint
  const hintEnabled = hintConfig?.enabled !== false
  const sessionControl = hintConfig?.sessionControl
  const controlEnabled = hintEnabled && sessionControl?.enabled !== false
  const traceConfig = hintConfig?.trace
  const traceEnabled = traceConfig?.enabled !== false
  const traceMaxRecords = traceConfig?.maxRecords ?? 2000
  const priorityMode: PriorityConfig = hintConfig?.priority ?? 'dynamic'
  const cacheMode: CacheControlConfig = hintConfig?.cacheControl ?? 'dynamic'

  const sessionOf = (sessionId: string) => {
    if (sessionId.length === 0) return undefined
    return ctx.get('sessions')?.get(SessionId(sessionId))
  }
  // Last derived facts per session. A manage request must still be labelled
  // correctly when its session has already left the store — notably `stop` at
  // disposal, which can no longer read the session log.
  const lastManageFacts = new Map<string, ManageSessionFacts>()
  const rememberManageFacts = (sessionId: string, facts: ManageSessionFacts): void => {
    lastManageFacts.delete(sessionId)
    lastManageFacts.set(sessionId, facts)
    while (lastManageFacts.size > 1024) {
      const oldest = lastManageFacts.keys().next().value
      if (oldest === undefined) break
      lastManageFacts.delete(oldest)
    }
  }
  const servingFacts = (sessionId: string): ServingFacts => {
    const session = sessionOf(sessionId)
    if (session === undefined) {
      return { callIndex: 1, epoch: 0, turnOpening: true, intervalMs: undefined, afterCompaction: false }
    }
    const facts = deriveServingFacts(session)
    rememberManageFacts(sessionId, {
      callIndex: Math.max(1, facts.callIndex), epoch: facts.epoch, parentSessionId: parentOf(sessionId),
    })
    return facts
  }
  // Ordinary history forks may name their source; a subagent names its creator instead.
  const parentOf = (sessionId: string): string | undefined => {
    const header = sessionOf(sessionId)?.header
    if (header === undefined || header.origin === 'subagent') return undefined
    return header.parentSession === undefined ? undefined : String(header.parentSession)
  }
  const manageFacts = (sessionId: string): ManageSessionFacts => {
    if (sessionOf(sessionId) === undefined) {
      return lastManageFacts.get(sessionId) ?? { callIndex: 1, epoch: 0 }
    }
    const facts = servingFacts(sessionId)
    return { callIndex: Math.max(1, facts.callIndex), epoch: facts.epoch, parentSessionId: parentOf(sessionId) }
  }
  const priorityOf = (facts: ServingFacts): AgentHintPriority | undefined => {
    if (priorityMode === 'omit') return undefined
    if (priorityMode !== 'dynamic') return { level: priorityMode.level, reason: priorityMode.reason }
    return facts.turnOpening
      ? { level: 3, reason: 'user_waiting' }
      : { level: 1, reason: 'critical_path' }
  }
  // Process-local prefix signature per session: a declaration from a different
  // signature would pin a prefix the engine cached under another key.
  const signatures = new Map<string, string>()
  const cacheOf = (sessionId: string, model: string, toolNames: readonly string[],
    wireMessageCount: number, prefixTokens: number, facts: ServingFacts): AgentHintCacheControl | undefined => {
    if (cacheMode === 'omit') return undefined
    const signature = cacheSignature(model, toolNames)
    const previous = signatures.get(sessionId)
    const stable = previous !== undefined ? previous === signature : facts.callIndex <= 1
    signatures.set(sessionId, signature)
    if (!stable || facts.afterCompaction) return undefined
    if (cacheMode !== 'dynamic') {
      return { type: 'ephemeral', ttl_s: cacheMode.ttl_s, msg_offset: cacheMode.msg_offset ?? wireMessageCount }
    }
    return buildCacheControl(wireMessageCount, prefixTokens, facts.intervalMs)
  }

  // Live Session lookup for the durable trace writer, resolved per call so a
  // host without the store, or one that loads later, degrades to stdout.
  const liveSession = (sessionId: string) => sessionOf(sessionId)
  const writeSessionRecord = traceEnabled && traceConfig?.writeToSession !== false
    ? createSessionTraceSink({ resolveSession: liveSession, maxRecords: traceMaxRecords,
      warn: message => ctx.logger.warn(message) })
    : undefined
  const trace = new HintTrace({ enabled: traceEnabled,
    maxRecords: traceMaxRecords,
    // Stock Web may suppress info-level framework logs. Explicit stdout keeps
    // this diagnostic channel available to Docker / service log collection.
    log: record => console.info(`agent-hint/trace ${JSON.stringify(record)}`),
    ...writeSessionRecord === undefined ? {} : { writeSessionRecord } })
  const bridge = controlEnabled
    ? new LifecycleBridge({
      client: new SessionControlClient({
        endpoint: sessionControl?.endpoint ?? chatCompletionsURL(options().baseURL),
        resolveApiKey: async () => resolveApiKey(options()),
        resolveConnection: async () => {
          const connection = options()
          const endpoint = sessionControl?.endpoint ?? chatCompletionsURL(connection.baseURL)
          if (connection.apiKeyEnv !== undefined && new URL(endpoint).origin !== new URL(connection.baseURL).origin) {
            throw new Error('agent-hints: refusing to forward model credentials to a different control origin')
          }
          return {
            endpoint,
            apiKey: await resolveApiKey(connection),
            authHeader: connection.authHeader,
          }
        },
        model: options().models[0]?.id ?? 'default',
        timeoutMs: sessionControl?.controlTimeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS,
        retries: sessionControl?.retries ?? DEFAULT_CONTROL_RETRIES,
        sessionFacts: manageFacts,
        trace,
        warn: (message, error) => {
          ctx.logger.warn(message)
          if (error !== undefined) ctx.logger.warn(error)
        },
      }),
      pendingOpAwaitMs: sessionControl?.pendingOpAwaitMs ?? DEFAULT_PENDING_OP_AWAIT_MS,
      warn: message => ctx.logger.warn(message),
    })
    : undefined
  bridge?.subscribe(ctx)
  if (bridge !== undefined && sessionControl?.pluginTriggers !== false) {
    ctx.inject(['typertGateway'], (scope) => { scope.plugin(AgentHintSignals, bridge) })
    ctx.inject(['workspaceRegistry'], (scope) => {
      try {
        scope.effect(() => observeArchives(scope.workspaceRegistry,
          id => bridge.onSessionArchived(id), id => bridge.onSessionUnarchived(id)),
        'agent-hint: observe public archive methods')
      } catch (error) {
        ctx.logger.warn('agent-hint: archive observer unavailable; disposal stop remains active', error)
      }
    })
  }

  ctx.llm.registerConfigurableProviders([
    { provider, displayName: 'DeepSeek (agent-hint)', settingsNs: ctx.fiber.entry?.options.id ?? name, settingsPath: [], declared: true },
  ])
  const chained = (request: Parameters<ReturnType<typeof agentHintAcceptExtensions>>[0]) =>
    ctx.get('deepseekLlmApiExtensions')?.prepare(request)
      ?? Promise.resolve({ fields: {}, accept: () => Promise.resolve() })
  const authForConnection = async (connection: ResolvedAgentHintOptions) => {
    const key = await resolveApiKey(connection)
    const headers: Record<string, string> = {}
    if (key !== undefined) headers[connection.authHeader] = connection.authHeader === 'authorization' ? `Bearer ${key}` : key
    return { headers }
  }
  // The Messages adapter has no per-request header hook; it carries the hint
  // through `agentHintScope` and `resolveAuth` spreads it into the request.
  const authForMessages = async (connection: ResolvedAgentHintOptions) => {
    const { headers } = await authForConnection(connection)
    const hint = agentHintScope.getStore()
    if (hint !== undefined) headers['x-agent-hint'] = encodeAgentHintHeader(hint)
    return { headers }
  }
  const prepareHint = (request: {
    sessionId: string | undefined
    purpose: string | undefined
    model: string
    wireMessageCount: number
    prefixTokens: number
    toolNames: readonly string[]
  }) => {
    if (!hintEnabled) return undefined
    // Any declared purpose is a background call that must not perturb the live session.
    if (request.purpose !== undefined) return undefined
    if (request.sessionId === undefined) return undefined
    const id = request.sessionId
    const facts = bridge?.facts(SessionId(id)) ?? { seeded: false, firstOrdinarySent: true, parentSessionId: undefined }
    const serving = servingFacts(id)
    return buildOrdinaryHint({
      sessionId: id,
      parentSessionId: parentOf(id),
      callIndex: Math.max(1, serving.callIndex),
      epoch: serving.epoch,
      state: !facts.seeded && !facts.firstOrdinarySent ? 'start' : 'append',
      priority: priorityOf(serving),
      cacheControl: cacheOf(id, request.model, request.toolNames, request.wireMessageCount, request.prefixTokens, serving),
    })
  }
  const onAccepted = (request: { sessionId: string | undefined; purpose: string | undefined; model: string }) => {
    if (hintEnabled && request.purpose === undefined) {
      bridge?.noteOrdinaryRequest(request.sessionId === undefined ? undefined : SessionId(request.sessionId), request.model)
    }
  }
  const adapter = config.transport === 'chat' ? new ChatCompletionsAdapter({
    options,
    providerName: 'DeepSeek (agent-hint)',
    resolveAuth: authForConnection,
    bridge,
    signal: lifetime.signal,
    trace,
    prepareHint,
    onAccepted,
  }) : new AgentHintAdapter({
    options,
    providerName: 'DeepSeek (agent-hint)',
    resolveUserId: getOrCreateAnonymousUserId,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments,
      hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    resolveAuth: authForMessages,
    discoverModels: route => Promise.resolve(options().models.map(model => catalogModelInfo(route, model))),
    prepareExtensions: hintEnabled
      ? agentHintAcceptExtensions({ chained, ...bridge === undefined ? {} : { bridge } })
      : chained,
    prepareHint,
  }, bridge, lifetime.signal)
  const registration = ctx.llm.registerAdapter([provider], adapter)
  let signature = ''
  const refresh = () => {
    const current = options()
    const next = JSON.stringify(current)
    if (next === signature) return
    signature = next
    registration.replace([provider])
    ctx.logger.info(`agent-hint: provider=${provider} origin=${new URL(current.baseURL).origin} models=${current.models.length} credential=${current.apiKeyEnv === undefined ? 'none' : current.credentialInherited ? 'inherited-reference' : 'explicit-reference'}`)
    if (current.models.length === 0) ctx.logger.warn('agent-hint: no selectable models; configure the source llm-deepseek route or explicit plugin models')
  }
  // Source changes are scoped to a sibling fiber; topology changes include reload/remove.
  ctx.on('loader/volatile-update', refresh, { global: true })
  ctx.on('loader/config-update', refresh, { global: true })
  ctx.on('loader/entry-init', refresh, { global: true })
  // 0.2.2 additionally announces a catalog change on the route itself, which is the
  // narrowest signal for an inherited `models`/`baseURL` edit. It is an addition, not a
  // replacement: the loader/`internal/status` path below stays as the fallback so a host
  // that never emits it still refreshes.
  ctx.on('llm/models-updated', provider => {
    if (provider !== INHERIT_SOURCE_ID) return
    try { refresh() } catch (error) { ctx.logger.warn('agent-hint: source refresh failed', error) }
  }, { global: true })
  // Entry creation precedes activation. Refresh after a source reaches/leaves
  // active state too, including disable, removal and re-addition.
  let disposed = false
  let refreshQueued = false
  ctx.effect(() => () => { disposed = true }, 'agent-hint: catalog refresh')
  ctx.on('internal/status', fiber => {
    if (fiber.entry?.options.id !== INHERIT_SOURCE_ID || refreshQueued) return
    refreshQueued = true
    queueMicrotask(() => {
      refreshQueued = false
      if (!disposed) {
        try { refresh() } catch (error) { ctx.logger.warn('agent-hint: source refresh failed', error) }
      }
    })
  }, { global: true })
  refresh()
}
