// SPDX-License-Identifier: MulanPSL-2.0
/**
 * The Messages route's `prepareExtensions`: the official adapter invokes it
 * after serialization and before dispatch, and its `accept()` runs only after
 * the endpoint answers 2xx. The hint itself rides the request header, so this
 * contribution carries no fields; it exists so `start`/`append` bookkeeping is
 * committed only for an accepted ordinary request.
 *
 * @module @deepseek-ai/dsh-agent-hints/extension
 */

import type {
  DeepSeekLlmApiExtensionRequest,
  PreparedDeepSeekLlmApiExtensions,
} from '@deepseek-ai/dsh-deepseek-llm-api-extensions'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { LifecycleBridge } from './lifecycle-bridge.js'

/** Request-local dependencies for {@link agentHintAcceptExtensions}. */
export interface AgentHintExtensionOptions {
  /** The registry chain this route still composes with (usually the global `deepseekLlmApiExtensions` service). */
  chained: (request: DeepSeekLlmApiExtensionRequest) => Promise<PreparedDeepSeekLlmApiExtensions>
  /** Lifecycle control plane; omission suppresses ordinary-request bookkeeping. */
  bridge?: LifecycleBridge | undefined
}

/**
 * Build the route's `prepareExtensions`: chain the host's own fields and commit
 * `start` bookkeeping only after acceptance.
 * @param options - the chain to compose with and the optional control plane.
 * @returns a `prepareExtensions` implementation for `DeepSeekAdapterOptions`.
 */
export function agentHintAcceptExtensions(
  options: AgentHintExtensionOptions,
): (request: DeepSeekLlmApiExtensionRequest) => Promise<PreparedDeepSeekLlmApiExtensions> {
  return async (request) => {
    const base = await options.chained(request)
    return {
      fields: base.fields,
      async accept() {
        await base.accept()
        if (options.bridge !== undefined && request.purpose === undefined) {
          const model = typeof request.body['model'] === 'string' ? request.body['model'] : 'default'
          const sessionId = request.sessionId === undefined ? undefined : SessionId(request.sessionId)
          options.bridge.noteOrdinaryRequest(sessionId, model)
        }
      },
    }
  }
}
