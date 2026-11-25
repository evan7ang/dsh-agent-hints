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
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import { chatCompletionsURL } from './chat-adapter.js';
export { buildManageHint, buildOrdinaryHint, deriveServingFacts, encodeAgentHintHeader, STATE_EDIT } from './hint.js';
export type { AgentHint, AgentHintCacheControl, AgentHintContextManagement, AgentHintEdit, AgentHintPriority, AgentHintSession, ManageState, OrdinaryHintFacts, ManageHintFacts, SessionState, ServingFacts, } from './hint.js';
export { BASE_URL_ENV, Config, DEFAULT_BASE_URL, DEFAULT_PROVIDER, INHERITED_BASE_URL_ENV, NO_INHERITED_CONNECTION, plainOptions, resolveAdapterOptions, resolveBaseURL, resolveModels } from './config.js';
export type { AgentHintConfig, CacheControlConfig, InheritedConnection, Options, PriorityConfig, ResolvedAgentHintOptions, SessionControlConfig, StaticCacheControl } from './config.js';
export { INHERIT_SOURCE_ID, readInheritedConnection } from './inherited-connection.js';
export { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, SessionControlClient } from './control-client.js';
export type { ControlResult, ControlConnection, ControlWarnSink, ManageSessionFacts, SessionControlClientOptions } from './control-client.js';
export { AgentHintAdapter, agentHintScope } from './adapter.js';
export type { AgentHintAdapterOptions, MessagesHintFacts } from './adapter.js';
export { agentHintAcceptExtensions } from './extension.js';
export type { AgentHintExtensionOptions } from './extension.js';
export { ControlBarrierError, COMPACTION_LINEAGE_WINDOW_MS, DEFAULT_PENDING_OP_AWAIT_MS, DEFAULT_QUARANTINE_TTL_MS, LifecycleBridge } from './lifecycle-bridge.js';
export type { BridgeWarnSink, LifecycleBridgeOptions } from './lifecycle-bridge.js';
export { HintTrace } from './trace.js';
export type { HintTraceRecord, HintTraceSummary } from './trace-record.js';
export { HINT_TRACE_RECORD_TYPE, createSessionTraceSink } from './session-trace.js';
export type { HintTraceSessionSinkOptions } from './session-trace.js';
export declare const name = "agent-hints";
export declare const inject: string[];
/** The conventional manage-request path appended to `baseURL` when no explicit endpoint is configured. */
export { chatCompletionsURL };
export declare function apply(ctx: Context, config: Config): void;
