/** Plugin configuration and request-local resolution for the agent-hint route. */
import type { Volatile } from '@deepseek-ai/cordis';
import z from '@deepseek-ai/schemastery';
import { type CredentialRef } from '@deepseek-ai/dsh-credentials';
import type { LaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import type { Config as ProtocolConfig, DeepSeekCatalogModel, DeepSeekConnectionOptions, Options as ProtocolOptions } from '@deepseek-ai/dsh-llm-deepseek';
import type { AgentHintPriority } from './hint.js';
/** The provider route this plugin owns; read at plugin load. */
export declare const DEFAULT_PROVIDER = "deepseek-hint";
/** Last-resort endpoint when neither configuration, a sibling route, nor the environment names one. */
export declare const DEFAULT_BASE_URL = "https://api.deepseek.com";
/** Environment variable consulted when neither configuration nor a sibling route names an endpoint. */
export declare const BASE_URL_ENV = "DSH_AGENT_HINT_BASE_URL";
/** Environment variable the official route uses; kept as a second fallback for zero-config installs. */
export declare const INHERITED_BASE_URL_ENV = "DEEPSEEK_BASE_URL";
/**
 * Connection facts a sibling DeepSeek route already resolved. An operator who
 * can already talk to a model has, by construction, already named the endpoint
 * this plugin needs; asking them to type it again is the entire configuration
 * burden this shape removes.
 */
export interface InheritedConnection {
    /** Endpoint of the sibling route, when it configured one. */
    baseURL?: string | undefined;
    /** Model catalog of the sibling route, when it declared one. */
    models?: readonly DeepSeekCatalogModel[] | undefined;
    options?: ProtocolOptions | undefined;
    /** Reference only; secret material is resolved per request. */
    apiKeyEnv?: string | undefined;
}
/** No sibling route contributed anything; the identity value of {@link InheritedConnection}. */
export declare const NO_INHERITED_CONNECTION: InheritedConnection;
/** Session lifecycle control plane configuration. */
export interface SessionControlConfig {
    /** `false` disables manage requests; the static data plane keeps working. */
    enabled: boolean;
    /** Install stock-host composer Remote and public archive observers. Default: true. */
    pluginTriggers?: boolean;
    /** Full manage-request URL; omission derives `<baseURL>/v1/chat/completions`. */
    endpoint?: string | undefined;
    /** Cap on how long an ordinary request waits for an in-flight verb. */
    pendingOpAwaitMs: number;
    /** Per-attempt control-request timeout in milliseconds. */
    controlTimeoutMs: number;
    /** Retries of explicit transient HTTP rejections for resume only. */
    retries: number;
}
/** Priority emission mode: dynamic two-level (default), a static override, or omitted. */
export type PriorityConfig = 'dynamic' | 'omit' | AgentHintPriority;
/** Cache-control emission mode: dynamic single ephemeral entry (default), a static override, or omitted. */
export interface StaticCacheControl {
    /** Explicit retention seconds. */
    ttl_s: number;
    /** Fixed 1-based message offset; omission follows the request's wire message count. */
    msg_offset?: number | undefined;
}
export type CacheControlConfig = 'dynamic' | 'omit' | StaticCacheControl;
/** The two hint planes: per-request injection and lifecycle control. */
export interface AgentHintConfig {
    /** Master switch; false retains the selected transport without hints/controls. */
    enabled: boolean;
    /** Bounded, content-free Host trace and an optional Session-log mirror. */
    trace?: {
        enabled: boolean;
        maxRecords: number;
        writeToSession: boolean;
    };
    /** Soft priority: dynamic two-level, a static override, or omitted entirely. */
    priority: PriorityConfig;
    /** Cache declaration: dynamic derivation, a static override, or omitted entirely. */
    cacheControl: CacheControlConfig;
    /** Session lifecycle control plane. */
    sessionControl: SessionControlConfig;
}
/** Messages configuration for the agent-hint route, with an optional per-request credential reference. */
export interface Config extends ProtocolConfig {
    /**
     * Credential reference resolved per request. When omitted, a same-endpoint
     * source reference can inherit unless inheritCredentials is false.
     */
    apiKeyEnv: Volatile<string | undefined>;
    inheritCredentials: boolean;
    /** Provider route id; read at plugin load (changing it requires a reload). */
    provider: string;
    /** Chat is the stock coordinator path; Messages requires backend support. */
    transport: 'chat' | 'messages';
    /** The two hint planes. */
    agentHint?: AgentHintConfig | undefined;
}
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    apiKeyEnv: z<string, string, "volatile">;
    inheritCredentials: z<boolean, boolean, "defined">;
    provider: z<string, string, "defined">;
    transport: z<"chat" | "messages", "chat" | "messages", "defined">;
    agentHint: z<Schemastery.ObjectS<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        trace: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, "plain">;
        priority: z<"dynamic" | "omit" | ({
            level?: number | null | undefined;
            reason?: string | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            level: z<number, number, "defined">;
            reason: z<string, string, "defined">;
        }>>, "defined">;
        cacheControl: z<"dynamic" | "omit" | ({
            ttl_s?: number | null | undefined;
            msg_offset?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            ttl_s: z<number, number, "defined">;
            msg_offset: z<number, number, "plain">;
        }>>, "defined">;
        sessionControl: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        trace: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, "plain">;
        priority: z<"dynamic" | "omit" | ({
            level?: number | null | undefined;
            reason?: string | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            level: z<number, number, "defined">;
            reason: z<string, string, "defined">;
        }>>, "defined">;
        cacheControl: z<"dynamic" | "omit" | ({
            ttl_s?: number | null | undefined;
            msg_offset?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            ttl_s: z<number, number, "defined">;
            msg_offset: z<number, number, "plain">;
        }>>, "defined">;
        sessionControl: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, "plain">;
    }>>, "plain">;
    baseURL: z<string, string, "volatile">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "volatile">;
    reasoningEffort: z<"low" | "off" | "high" | "max", "low" | "off" | "high" | "max", "volatile">;
    maxTokens: z<number, number, "volatile-defined">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    models: z<NoInfer<DeepSeekCatalogModel[]>, NoInfer<DeepSeekCatalogModel[]>, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    maxRequestFilesBytes: z<number, number, "volatile-defined">;
    maxInlineRequestImageBytes: z<number, number, "volatile-defined">;
    maxImagesPerRequest: z<number, number, "volatile-defined">;
    imageOffloadByteQuantum: z<number, number, "volatile-defined">;
    inlineImageOffloadByteQuantum: z<number, number, "volatile-defined">;
    imageOffloadCountQuantum: z<number, number, "volatile-defined">;
    filesApiTimeoutMs: z<number, number, "volatile-defined">;
    fileExpiresAfterSeconds: z<number, number, "volatile-defined">;
    fileRefreshMarginSeconds: z<number, number, "volatile-defined">;
    fileQuotaCleanupBatch: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<import("@deepseek-ai/dsh-llm").RetryPolicyConfig>, NoInfer<import("@deepseek-ai/dsh-llm").RetryPolicyConfig>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    apiKeyEnv: z<string, string, "volatile">;
    inheritCredentials: z<boolean, boolean, "defined">;
    provider: z<string, string, "defined">;
    transport: z<"chat" | "messages", "chat" | "messages", "defined">;
    agentHint: z<Schemastery.ObjectS<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        trace: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, "plain">;
        priority: z<"dynamic" | "omit" | ({
            level?: number | null | undefined;
            reason?: string | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            level: z<number, number, "defined">;
            reason: z<string, string, "defined">;
        }>>, "defined">;
        cacheControl: z<"dynamic" | "omit" | ({
            ttl_s?: number | null | undefined;
            msg_offset?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            ttl_s: z<number, number, "defined">;
            msg_offset: z<number, number, "plain">;
        }>>, "defined">;
        sessionControl: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, "plain">;
    }>>, Schemastery.ObjectT<NoInfer<{
        enabled: z<boolean, boolean, "defined">;
        trace: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            maxRecords: z<number, number, "defined">;
            writeToSession: z<boolean, boolean, "defined">;
        }>>, "plain">;
        priority: z<"dynamic" | "omit" | ({
            level?: number | null | undefined;
            reason?: string | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            level: z<number, number, "defined">;
            reason: z<string, string, "defined">;
        }>>, "defined">;
        cacheControl: z<"dynamic" | "omit" | ({
            ttl_s?: number | null | undefined;
            msg_offset?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict), "dynamic" | "omit" | Schemastery.ObjectT<NoInfer<{
            ttl_s: z<number, number, "defined">;
            msg_offset: z<number, number, "plain">;
        }>>, "defined">;
        sessionControl: z<Schemastery.ObjectS<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, Schemastery.ObjectT<NoInfer<{
            enabled: z<boolean, boolean, "defined">;
            pluginTriggers: z<boolean, boolean, "defined">;
            endpoint: z<string, string, "plain">;
            pendingOpAwaitMs: z<number, number, "defined">;
            controlTimeoutMs: z<number, number, "defined">;
            retries: z<number, number, "defined">;
        }>>, "plain">;
    }>>, "plain">;
    baseURL: z<string, string, "volatile">;
    thinking: z<"enabled" | "disabled", "enabled" | "disabled", "volatile">;
    reasoningEffort: z<"low" | "off" | "high" | "max", "low" | "off" | "high" | "max", "volatile">;
    maxTokens: z<number, number, "volatile-defined">;
    defaultContextWindow: z<number, number, "volatile-defined">;
    models: z<NoInfer<DeepSeekCatalogModel[]>, NoInfer<DeepSeekCatalogModel[]>, "volatile-defined">;
    streamIdleTimeoutMs: z<number, number, "volatile-defined">;
    maxRequestFilesBytes: z<number, number, "volatile-defined">;
    maxInlineRequestImageBytes: z<number, number, "volatile-defined">;
    maxImagesPerRequest: z<number, number, "volatile-defined">;
    imageOffloadByteQuantum: z<number, number, "volatile-defined">;
    inlineImageOffloadByteQuantum: z<number, number, "volatile-defined">;
    imageOffloadCountQuantum: z<number, number, "volatile-defined">;
    filesApiTimeoutMs: z<number, number, "volatile-defined">;
    fileExpiresAfterSeconds: z<number, number, "volatile-defined">;
    fileRefreshMarginSeconds: z<number, number, "volatile-defined">;
    fileQuotaCleanupBatch: z<number, number, "volatile-defined">;
    retryPolicy: z<NoInfer<import("@deepseek-ai/dsh-llm").RetryPolicyConfig>, NoInfer<import("@deepseek-ai/dsh-llm").RetryPolicyConfig>, "volatile">;
}>>, "plain">;
/** Plain deployment inputs for the agent-hint route. */
export type Options = ProtocolOptions & {
    apiKeyEnv?: string;
    inheritCredentials?: boolean;
};
/** Endpoint and credential reference captured from the same configuration generation. */
export interface ResolvedAgentHintOptions extends DeepSeekConnectionOptions {
    /** Credential reference used only for this connection snapshot; absent sends unauthenticated requests. */
    apiKeyEnv: CredentialRef | undefined;
    credentialInherited: boolean;
    authHeader: 'authorization' | 'x-api-key';
}
/** Read one validated provider configuration.
 * @param config - live plugin configuration.
 * @returns detached resolver inputs.
 */
export declare function plainOptions(config: Config): Options;
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
export declare function resolveBaseURL(configured: string | undefined, inherited?: InheritedConnection, environment?: LaunchEnvironmentSnapshot): string;
/** Resolve the model catalog: explicit configuration, then the sibling route's.
 * @param configured - models declared on this plugin's own entry.
 * @param inherited - model catalog read from a sibling route.
 * @returns the catalog to advertise; empty when neither source declared one.
 */
export declare function resolveModels(configured: DeepSeekCatalogModel[] | undefined, inherited?: InheritedConnection): DeepSeekCatalogModel[];
/** Resolve route and protocol settings together.
 * @param config - raw deployment settings.
 * @param environment - application launch environment.
 * @param inherited - endpoint facts read from a sibling route.
 * @returns validated endpoint facts and the matching credential reference, or `undefined` when the route names none.
 */
export declare function resolveAdapterOptions(config: Options, environment?: LaunchEnvironmentSnapshot, inherited?: InheritedConnection): ResolvedAgentHintOptions;
