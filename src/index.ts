// SPDX-License-Identifier: Apache-2.0
/**
 * The agent hints plugin: per-request serving-intent hints carried on the
 * `X-Agent-Hint` HTTP header (UTF-8 JSON, base64url) of DeepSeek
 * chat-completions requests. The plugin
 * registers an independent provider route (`deepseek-hint`) backed by its own
 * structural LlmAdapter implementation — the official `llm-deepseek` route
 * stays untouched and remains the fallback. Self-contained: no harness-internal
 * runtime imports.
 *
 * Header emission rules:
 * - main-line requests only: auxiliary calls (purpose compaction/session-title)
 *   and requests without a session identity carry no hint;
 * - `strict_priority` is never sent by an agent (trusted-control-plane field);
 * - `prediction` is not sent: it requires an observation statistics engine
 *   (future item).
 * The request body keeps the provider's original format and NEVER carries
 * hint fields.
 *
 * Serving facts (`call_index`/`epoch`/`runningSinceMs`) are derived from the
 * session's durable event log at request time — restart-safe (restored
 * sessions replay their log). `derivation.join` comes from the parent's
 * delegating tool call (`run_in_background`). The out-of-band status channel
 * (tool/running/finalize events) activates when `statusSink` is configured.
 *
 * @module dsh-agent-hints
 */

import type { Context, SessionLike, SessionEventLike } from '@deepseek-ai/cordis'
import type { HintOptions, ServingFacts } from './hint.js'
import { deriveServingFacts } from './hint.js'
import { HintedDeepSeekAdapter } from './adapter.js'
import { normalizeConfig } from './config.js'
import { StatusObserver, appendStatusEvent } from './status.js'

export const name = 'agent-hints'

/** The llm service is the mounting target; sessions/credentials are read through `ctx.get` so absence degrades gracefully. */
export const inject = ['llm']

/** The provider route this adapter owns; select it via `agent-default-model.provider`. */
export const PROVIDER_ROUTE = 'deepseek-hint'

/**
 * Mount the hinted adapter. Invalid config aborts composition with a field
 * path — request-time hint construction has no failure path.
 * @param ctx - the mounting Cordis context.
 * @param config - raw patch-row config.
 */
export function apply(ctx: Context, config?: unknown): void {
  const pluginConfig = normalizeConfig(config)
  const hintOptions: HintOptions = {
    agentType: pluginConfig.agentType,
    priority: pluginConfig.priority,
    cacheControl: pluginConfig.cacheControl,
  }

  // Join tracking: the parent's delegating tool call (`run_in_background`)
  // fires on the firehose before the child's first request, so the child's
  // hint reads the parent's track. Parallel delegations share the latest
  // value — an accepted approximation (protocol join is per derivation).
  const subagentTools = new Set(pluginConfig.subagentToolNames)
  const delegationJoin = new Map<string, 'sync' | 'async'>()

  // Serving facts: derive from the durable log when the session store is
  // reachable; otherwise fall back to a per-process ordinal (the store is a
  // dsh-base service, so the fallback only covers exotic compositions).
  const fallbackCounter = new Map<string, number>()
  const servingFacts = (sessionId: string): ServingFacts => {
    const session = ctx.get('sessions')?.get(sessionId)
    if (session !== undefined) return deriveServingFacts(session)
    const next = (fallbackCounter.get(sessionId) ?? 0) + 1
    fallbackCounter.set(sessionId, next)
    return { callIndex: next, epoch: 0 }
  }

  ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    if (event.type === 'tool/call') {
      const toolName = event.data?.name
      if (toolName !== undefined && subagentTools.has(toolName)) {
        let runInBackground: unknown
        try {
          runInBackground = JSON.parse(event.data?.arguments ?? '{}')?.run_in_background
        } catch {
          // Unparseable arguments default to the foreground-wait (`sync`) below.
        }
        delegationJoin.set(session.id, runInBackground === true ? 'async' : 'sync')
      }
    }
  })

  // Out-of-band status channel: activate only when a sink is configured; the
  // gateway client will replace the local JSONL sink behind `emit`.
  if (pluginConfig.statusSink !== undefined) {
    const sinkPath = pluginConfig.statusSink
    const observer = new StatusObserver(
      event => appendStatusEvent(sinkPath, event, message => ctx.logger?.warn?.(message)),
      subagentTools,
    )
    ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => observer.onEvent(session, event))
  }

  const resolveApiKey = async (): Promise<string> => {
    const ref = pluginConfig.apiKeyEnv
    const hit = await ctx.get('credentials')?.resolve(ref)
    if (hit?.value !== undefined && hit.value.length > 0) return hit.value
    const ambient = process.env[ref]
    if (ambient !== undefined && ambient.length > 0) return ambient
    throw new Error(
      `agent-hints: no API key for provider route "${PROVIDER_ROUTE}"; store ${ref} through the credentials`
      + ` service, or export ${ref} in the launching environment`,
    )
  }
  const adapter = new HintedDeepSeekAdapter({
    config: pluginConfig,
    hintOptions,
    servingFacts,
    derivationJoin: sessionId => delegationJoin.get(sessionId),
    sessionHeader: sessionId => ctx.get('sessions')?.get(sessionId)?.header,
    resolveApiKey,
  })
  ctx.llm.registerAdapter([PROVIDER_ROUTE], adapter)
}
