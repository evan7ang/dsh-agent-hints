// SPDX-License-Identifier: MulanPSL-2.0
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
 * (tool/running/finalize events) activates when any sink is configured
 * (`statusSink` JSONL file and/or the `statusEndpoint`/`statusAuto` HTTP
 * endpoint).
 *
 * @module dsh-agent-hints
 */
import { deriveServingFacts } from './hint.js';
import { HintedDeepSeekAdapter } from './adapter.js';
import { normalizeConfig } from './config.js';
import { loadPredictionTrie, resolvePredictionBlock, toolSequenceOf } from './prediction.js';
import { HttpStatusSink, StatusObserver, appendStatusEvent } from './status.js';
export const name = 'agent-hints';
/** The llm service is the mounting target; sessions/credentials are read through `ctx.get` so absence degrades gracefully. */
export const inject = ['llm'];
/** The provider route this adapter owns; select it via `agent-default-model.provider`. */
export const PROVIDER_ROUTE = 'deepseek-hint';
/** The conventional status-endpoint path appended to `baseURL`'s origin when `statusAuto` is on — the Motor-coordinator convention (DSH ↔ Motor 对接约定). */
export const STATUS_ENDPOINT_PATH = '/agent-status';
/**
 * Mount the hinted adapter. The plugin is zero-config: endpoint/credential
 * facts inherit the DSH host (`$DEEPSEEK_BASE_URL` → public API default;
 * `DEEPSEEK_API_KEY` credential ref) and the patch-row config only overrides
 * per field. Provided-but-invalid config still aborts composition with a
 * field path.
 * @param ctx - the mounting Cordis context.
 * @param config - raw patch-row config.
 */
export function apply(ctx, config) {
    const inherited = config === undefined || config === null;
    const pluginConfig = normalizeConfig(config);
    if (inherited) {
        ctx.logger?.info?.(`agent-hints: no config — inheriting the DSH host endpoint (${pluginConfig.baseURL})`
            + ` and credential ref (${pluginConfig.apiKeyEnv})`);
    }
    const hintOptions = {
        agentType: pluginConfig.agentType,
        priority: pluginConfig.priority,
        cacheControl: pluginConfig.cacheControl,
    };
    // Join tracking: the parent's delegating tool call (`run_in_background`)
    // fires on the firehose before the child's first request, so the child's
    // hint reads the parent's track. Parallel delegations share the latest
    // value — an accepted approximation (protocol join is per derivation).
    const subagentTools = new Set(pluginConfig.subagentToolNames);
    const delegationJoin = new Map();
    // Serving facts: derive from the durable log when the session store is
    // reachable; otherwise fall back to a per-process ordinal (the store is a
    // dsh-base service, so the fallback only covers exotic compositions).
    const fallbackCounter = new Map();
    const servingFacts = (sessionId) => {
        const session = ctx.get('sessions')?.get(sessionId);
        if (session !== undefined)
            return deriveServingFacts(session);
        const next = (fallbackCounter.get(sessionId) ?? 0) + 1;
        fallbackCounter.set(sessionId, next);
        return { callIndex: next, epoch: 0 };
    };
    // Prediction sources: the offline trie loads once at composition (any
    // problem warns and degrades to statics); with neither source configured
    // the block stays absent and the wire shape matches the pre-prediction
    // plugin byte for byte.
    const trie = pluginConfig.predictionTrie !== undefined
        ? loadPredictionTrie(pluginConfig.predictionTrie, message => ctx.logger?.warn?.(message))
        : undefined;
    const predictionSource = trie !== undefined || pluginConfig.predictionStatic !== undefined
        ? { trie, statics: pluginConfig.predictionStatic, minSamples: pluginConfig.predictionMinSamples }
        : undefined;
    const predictionFacts = predictionSource === undefined
        ? undefined
        : (sessionId) => {
            const session = ctx.get('sessions')?.get(sessionId);
            return resolvePredictionBlock(predictionSource, session === undefined ? [] : toolSequenceOf(session));
        };
    ctx.on('session/event', (session, event) => {
        if (event.type === 'tool/call') {
            const toolName = event.data?.name;
            if (toolName !== undefined && subagentTools.has(toolName)) {
                let runInBackground;
                try {
                    runInBackground = JSON.parse(event.data?.arguments ?? '{}')?.run_in_background;
                }
                catch {
                    // Unparseable arguments default to the foreground-wait (`sync`) below.
                }
                delegationJoin.set(session.id, runInBackground === true ? 'async' : 'sync');
            }
        }
    });
    // Out-of-band status channel: activate when any sink is configured. The
    // HTTP endpoint resolves in priority order — explicit `statusEndpoint`
    // override, else the `statusAuto` derivation from `baseURL`'s origin
    // (`<origin>/agent-status`, the Motor-coordinator convention). Both sinks
    // may coexist: the JSONL file keeps a local trace while HTTP streams events
    // to the scheduler; a gateway client later replaces the HTTP sink behind
    // the same `emit` seam.
    const statusHttpEndpoint = pluginConfig.statusEndpoint
        ?? (pluginConfig.statusAuto === true ? new URL(pluginConfig.baseURL).origin + STATUS_ENDPOINT_PATH : undefined);
    if (pluginConfig.statusSink !== undefined || statusHttpEndpoint !== undefined) {
        const sinks = [];
        if (pluginConfig.statusSink !== undefined) {
            const sinkPath = pluginConfig.statusSink;
            sinks.push(event => appendStatusEvent(sinkPath, event, message => ctx.logger?.warn?.(message)));
        }
        if (statusHttpEndpoint !== undefined) {
            const httpSink = new HttpStatusSink(statusHttpEndpoint, message => ctx.logger?.warn?.(message));
            sinks.push(event => httpSink.send(event));
        }
        const observer = new StatusObserver(event => {
            for (const sink of sinks)
                sink(event);
        }, subagentTools, pluginConfig.expectedResumeS);
        ctx.on('session/event', (session, event) => observer.onEvent(session, event));
    }
    const resolveApiKey = async () => {
        const ref = pluginConfig.apiKeyEnv;
        const hit = await ctx.get('credentials')?.resolve(ref);
        if (hit?.value !== undefined && hit.value.length > 0)
            return hit.value;
        const ambient = process.env[ref];
        if (ambient !== undefined && ambient.length > 0)
            return ambient;
        throw new Error(`agent-hints: no API key for provider route "${PROVIDER_ROUTE}"; store ${ref} through the credentials`
            + ` service, or export ${ref} in the launching environment`);
    };
    const adapter = new HintedDeepSeekAdapter({
        config: pluginConfig,
        hintOptions,
        servingFacts,
        predictionFacts,
        derivationJoin: sessionId => delegationJoin.get(sessionId),
        sessionHeader: sessionId => ctx.get('sessions')?.get(sessionId)?.header,
        resolveApiKey,
    });
    ctx.llm.registerAdapter([PROVIDER_ROUTE], adapter);
}
