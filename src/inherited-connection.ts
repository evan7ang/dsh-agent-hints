/** Read effective sibling configuration through the public Loader surface. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-config-editor'
import { Config as ProtocolConfig, plainOptions, resolveAdapterOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type { InheritedConnection } from './config.ts'

export const INHERIT_SOURCE_ID = 'llm-deepseek'

/** Read live references on each call. Missing/disabled sources contribute nothing;
 * invalid sources surface an error rather than silently changing request targets.
 */
export function readInheritedConnection(ctx: Context, sourceId = INHERIT_SOURCE_ID): InheritedConnection {
  const loader = ctx.get('loader')
  let options: ReturnType<typeof plainOptions> & { apiKeyEnv?: string }
  if (loader !== undefined) {
    const entries = [...loader.entries()].filter(entry => entry.options.id === sourceId && !entry.disabled)
    if (entries.length !== 1) return {}
    const fiber = entries[0]?.fiber
    if (fiber?.state !== 2) return {}
    // cordis >= 4.1 exposes the schema-validated config (defaults materialized) as
    // `effectiveConfig`; `fiber.config` is only the raw loader input, so reading it
    // here would hand the resolver unresolved/expression-bearing values. The property
    // is typed `unknown`, so narrow it to the parsed Config shape this resolver expects.
    const effective: unknown = fiber.effectiveConfig
    if (effective === null || typeof effective !== 'object') return {}
    options = plainOptions(effective as Parameters<typeof plainOptions>[0])
  } else {
    // Hosts exposing only ConfigEditor still use the public protocol defaults.
    const editor = ctx.get('configEditor')
    if (editor === undefined) return {}
    const rows = editor.configuration().filter(row => row.entry.options.id === sourceId)
    if (rows.length !== 1) return {}
    const row = rows[0]!
    const raw = { ...row.inherited, ...row.override }
    options = { ...plainOptions(ProtocolConfig(raw)),
      ...typeof raw.apiKeyEnv === 'string' ? { apiKeyEnv: raw.apiKeyEnv } : {} }
  }
  const resolved = resolveAdapterOptions(options, launchEnvironmentOf(ctx))
  return { baseURL: resolved.baseURL, models: resolved.models, options,
    ...typeof options.apiKeyEnv === 'string' ? { apiKeyEnv: options.apiKeyEnv } : {} }
}
