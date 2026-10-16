// SPDX-License-Identifier: MulanPSL-2.0
/**
 * The hinted DeepSeek chat-completions adapter: a structural implementation of
 * the harness `LlmAdapter` contract (only `stream()` is required) that carries
 * the AgentHint on the `X-Agent-Hint` HTTP header (UTF-8 JSON, base64url) —
 * the request body keeps the provider's original format
 * and never carries hint fields.
 *
 * v1 subset: chat-completions wire, text + tools + thinking + usage + abort;
 * image content is rejected explicitly (`UNSUPPORTED_CONTENT`), never silently
 * degraded. Retries are NOT implemented here: the harness retry layer drives
 * attempts from the route's retry policy (default normal/5), routing on the
 * stable error codes this adapter throws.
 *
 * @module dsh-agent-hints/adapter
 */
import { buildAgentHint, encodeAgentHintHeader } from './hint.js';
/** Stable machine-routable failure with the harness error shape (`code` distinct from `message`, `cause` preserved). */
export class AdapterError extends Error {
    code;
    status;
    constructor(message, code, options) {
        super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
        this.name = 'LlmError';
        this.code = code;
        this.status = options?.status;
    }
}
function flattenText(blocks) {
    return blocks
        .filter((block) => block.type === 'text')
        .map(block => block.text)
        .join('');
}
/** Reject image content before any text-flattening path can silently erase it (v1 subset boundary). */
function assertTextOnly(message) {
    if (message.content.some(block => block.type === 'image')) {
        throw new AdapterError('The agent-hints adapter does not support image content (v1 text-only subset).', 'UNSUPPORTED_CONTENT');
    }
}
/** Serialize one assistant message: text (never null), CoT passback, and tool calls. */
function serializeAssistant(message) {
    const text = flattenText(message.content);
    const reasoning = message.content
        .filter((block) => block.type === 'reasoning')
        .map(block => block.text)
        .join('');
    const toolCalls = message.content
        .filter((block) => block.type === 'tool-call')
        .map(block => ({ id: block.id, type: 'function', function: { name: block.name, arguments: block.arguments } }));
    return {
        role: 'assistant',
        // Text-less turns send "" — NEVER null: some gateways reject null outright
        // and a null here bricks every later turn of that session.
        content: text,
        ...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
        ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
    };
}
/**
 * Serialize the conversation. `tool-result` blocks ride user-role messages in
 * the harness vocabulary but the wire wants standalone `{role: 'tool'}` entries;
 * a mixed user message contributes its text first and its tool results after.
 */
export function serializeMessages(messages) {
    const wire = [];
    for (const message of messages) {
        assertTextOnly(message);
        if (message.role === 'system') {
            wire.push({ role: 'system', content: flattenText(message.content) });
            continue;
        }
        if (message.role === 'assistant') {
            wire.push(serializeAssistant(message));
            continue;
        }
        const toolResults = message.content.filter((block) => block.type === 'tool-result');
        const text = flattenText(message.content);
        if (text.length > 0 || toolResults.length === 0) {
            wire.push({ role: 'user', content: text });
        }
        for (const result of toolResults) {
            wire.push({
                role: 'tool',
                tool_call_id: result.toolCallId,
                // Empty tool output still needs SOME content on the wire.
                content: flattenText(result.content) || '(no output)',
            });
        }
    }
    return wire;
}
/** Resolve the thinking/effort pair for one request (session-title forces thinking off; `off` never appears as a wire effort). */
export function resolveThinking(options, config) {
    if (options.purpose === 'session-title')
        return { thinking: 'disabled' };
    const effort = options.reasoningEffort ?? config.reasoningEffort;
    if (config.thinking === 'disabled' && effort !== 'off') {
        throw new AdapterError(`The agent-hints deployment does not support reasoning effort "${effort}"`, 'UNSUPPORTED_REASONING_EFFORT');
    }
    if (effort === 'off')
        return { thinking: 'disabled' };
    if (effort === 'low' || effort === 'high' || effort === 'max') {
        return { thinking: 'enabled', reasoningEffort: effort };
    }
    return config.thinking === undefined ? {} : { thinking: config.thinking };
}
function serializeTools(tools) {
    const wire = tools?.map(tool => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    return wire !== undefined && wire.length > 0 ? wire : undefined;
}
/** Build the full wire request; optional fields are omitted rather than sent as null so provider defaults apply. */
export function serializeRequest(options, config) {
    const messages = [];
    if (options.system !== undefined)
        messages.push({ role: 'system', content: options.system });
    messages.push(...serializeMessages(options.messages));
    const thinking = resolveThinking(options, config);
    const tools = serializeTools(options.tools);
    return {
        model: options.model,
        messages,
        stream: true,
        stream_options: { include_usage: true },
        ...thinking.thinking !== undefined ? { thinking: { type: thinking.thinking } } : {},
        ...thinking.reasoningEffort !== undefined ? { reasoning_effort: thinking.reasoningEffort } : {},
        ...tools !== undefined ? { tools } : {},
        ...options.temperature !== undefined ? { temperature: options.temperature } : {},
        ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
        ...options.stop !== undefined ? { stop: options.stop } : {},
    };
}
/* ------------------------------------------------------------------ *
 * SSE decoding: byte stream → data payloads, `[DONE]`-terminated
 * ------------------------------------------------------------------ */
export const DONE = '[DONE]';
/**
 * Minimal spec-strict SSE decoder: events dispatch on their blank-line
 * terminator; `data:` lines join with newlines; comment/non-data fields are
 * skipped. The literal `[DONE]` is yielded so the caller owns final flushing;
 * EOF before it raises (truncated response — the call cannot be trusted).
 */
export async function* parseSse(stream) {
    const decoder = new TextDecoder();
    const reader = stream.getReader();
    let buffer = '';
    const dispatch = (event) => {
        const dataLines = event.split('\n')
            .filter(line => line.startsWith('data:'))
            .map(line => line.slice(5).replace(/^\s/, ''));
        return dataLines.length > 0 ? dataLines.join('\n') : undefined;
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done)
                break;
            buffer += decoder.decode(value, { stream: true });
            let boundary = buffer.search(/\r?\n\r?\n/);
            while (boundary >= 0) {
                const event = buffer.slice(0, boundary);
                buffer = buffer.slice(boundary + (buffer[boundary] === '\r' ? 4 : 2));
                const data = dispatch(event);
                if (data !== undefined) {
                    yield data;
                    if (data === DONE)
                        return;
                }
                boundary = buffer.search(/\r?\n\r?\n/);
            }
        }
    }
    finally {
        reader.releaseLock();
    }
    throw new AdapterError('SSE stream ended without [DONE]', 'STREAM_CLOSED');
}
function mapFinishReason(reason) {
    switch (reason) {
        case 'stop': return { kind: 'stop' };
        case 'tool_calls': return { kind: 'tool-calls' };
        case 'length': return { kind: 'max-tokens' };
        default:
            return { kind: 'error', failure: { message: `model stopped: ${reason}`, code: reason.toUpperCase() } };
    }
}
function mapUsage(usage) {
    const promptTokens = usage.prompt_tokens ?? 0;
    const completionTokens = usage.completion_tokens ?? 0;
    const cacheRead = usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens;
    const reasoning = usage.completion_tokens_details?.reasoning_tokens;
    const combined = promptTokens + completionTokens;
    const hasExactTotal = Number.isSafeInteger(promptTokens) && promptTokens >= 0
        && Number.isSafeInteger(completionTokens) && completionTokens >= 0
        && Number.isSafeInteger(combined)
        && (usage.total_tokens === undefined || usage.total_tokens === combined);
    return {
        // DeepSeek's prompt_tokens INCLUDES cache hits; the harness convention is
        // disjoint counts, so cache reads are subtracted out of inputTokens.
        inputTokens: promptTokens - (cacheRead ?? 0),
        outputTokens: completionTokens,
        ...hasExactTotal ? { totalTokens: combined } : {},
        ...cacheRead !== undefined ? { cacheReadTokens: cacheRead } : {},
        ...reasoning !== undefined ? { reasoningTokens: reasoning } : {},
    };
}
/** Identity, not accumulation: empty or non-string re-sends leave the established value alone. */
function acceptIdentity(current, incoming) {
    return typeof incoming === 'string' && incoming.length > 0 ? incoming : current;
}
function closeBlock(block) {
    switch (block.kind) {
        case 'text': return { type: 'text', text: block.text };
        case 'reasoning': return { type: 'reasoning', text: block.text };
        case 'tool-call': return { type: 'tool-call', id: block.callId ?? '', name: block.name ?? '', arguments: block.text };
    }
}
/** Consume SSE data payloads (ending with `[DONE]`) and yield StreamChunks; deltas stream live, ends/usage/finish defer to `[DONE]`. */
export async function* translate(payloads) {
    let nextIndex = 0;
    let textBlock;
    let reasoningBlock;
    const toolBlocks = new Map();
    const order = [];
    let pendingFinish;
    let pendingUsage;
    const open = (kind) => {
        const block = { index: nextIndex++, kind, text: '' };
        order.push(block);
        return block;
    };
    for await (const payload of payloads) {
        if (payload === DONE) {
            for (const block of order) {
                yield { type: 'block-end', index: block.index, block: closeBlock(block) };
            }
            if (pendingUsage !== undefined)
                yield { type: 'usage', usage: pendingUsage };
            const reason = pendingFinish ?? { kind: 'stop' };
            yield {
                type: 'finish',
                reason: reason.kind === 'stop' && order.length === 0
                    ? { kind: 'error', failure: { message: 'model returned a completed response with no content', code: 'EMPTY_RESPONSE' } }
                    : reason,
            };
            return;
        }
        let chunk;
        try {
            chunk = JSON.parse(payload);
        }
        catch (error) {
            throw new AdapterError(`malformed SSE payload: ${payload.slice(0, 120)}`, 'MALFORMED_RESPONSE', { cause: error });
        }
        for (const choice of chunk.choices ?? []) {
            const delta = choice.delta;
            const reasoning = delta?.reasoning_content;
            if (typeof reasoning === 'string' && reasoning.length > 0) {
                if (reasoningBlock === undefined) {
                    reasoningBlock = open('reasoning');
                    yield { type: 'block-start', index: reasoningBlock.index, blockType: 'reasoning' };
                }
                reasoningBlock.text += reasoning;
                yield { type: 'reasoning-delta', index: reasoningBlock.index, text: reasoning };
            }
            const content = delta?.content;
            if (typeof content === 'string' && content.length > 0) {
                if (textBlock === undefined) {
                    textBlock = open('text');
                    yield { type: 'block-start', index: textBlock.index, blockType: 'text' };
                }
                textBlock.text += content;
                yield { type: 'text-delta', index: textBlock.index, text: content };
            }
            for (const call of delta?.tool_calls ?? []) {
                let block = toolBlocks.get(call.index);
                if (block === undefined) {
                    block = open('tool-call');
                    toolBlocks.set(call.index, block);
                    yield { type: 'block-start', index: block.index, blockType: 'tool-call' };
                }
                block.callId = acceptIdentity(block.callId, call.id);
                block.name = acceptIdentity(block.name, call.function?.name);
                const fragment = call.function?.arguments ?? '';
                block.text += typeof fragment === 'string' ? fragment : '';
                yield {
                    type: 'tool-call-delta',
                    index: block.index,
                    id: block.callId ?? '',
                    ...block.name !== undefined ? { name: block.name } : {},
                    argumentsDelta: typeof fragment === 'string' ? fragment : '',
                };
            }
            if (typeof choice.finish_reason === 'string')
                pendingFinish = mapFinishReason(choice.finish_reason);
        }
        if (chunk.usage !== undefined)
            pendingUsage = mapUsage(chunk.usage);
    }
    // parseSse guarantees the [DONE] sentinel (or throws); reaching here means
    // the payload source violated that contract.
    throw new AdapterError('SSE payload stream ended without [DONE]', 'STREAM_CLOSED');
}
/* ------------------------------------------------------------------ *
 * HTTP error mapping
 * ------------------------------------------------------------------ */
function httpErrorCode(status, providerCode) {
    if (status === 401 || status === 403)
        return 'AUTH';
    if (status === 413)
        return 'INVALID_REQUEST';
    if (status === 429)
        return 'RATE_LIMIT';
    if (status === 400)
        return 'INVALID_REQUEST';
    if (status >= 500)
        return 'SERVER';
    return 'PROVIDER_ERROR';
}
/** The structural LlmAdapter: hint on the header, body in provider format, retries owned by the harness layer. */
export class HintedDeepSeekAdapter {
    options;
    constructor(options) {
        this.options = options;
    }
    providerInfo(provider) {
        return { id: provider, name: 'DeepSeek (Agent Hints)' };
    }
    /** No override → the harness layer applies its normal default retry policy. */
    providerRetryPolicy(_provider) {
        return undefined;
    }
    /** Bind exact model metadata and the dispatch to one adapter generation (mirrors the harness base-class default). */
    async prepareCall(provider, model, signal) {
        return {
            model: await this.resolveModel(provider, model, signal),
            stream: callOptions => this.stream(callOptions),
        };
    }
    async resolveModel(provider, model, _signal) {
        const entry = this.options.config.models.find(candidate => candidate.id === model);
        return {
            provider,
            id: model,
            name: entry?.name ?? model,
            context: { contextWindow: entry?.contextWindow ?? this.options.config.defaultContextWindow },
            defaultMaxTokens: entry?.maxTokens ?? this.options.config.defaultMaxTokens,
            reasoning: {
                efforts: [
                    { id: 'off', name: 'Off' },
                    { id: 'low', name: 'Low' },
                    { id: 'high', name: 'High' },
                    { id: 'max', name: 'Max' },
                ],
                defaultEffort: this.options.config.reasoningEffort,
            },
        };
    }
    async *stream(options) {
        const { config } = this.options;
        // Emission rules: main-line requests only — auxiliary calls
        // (compaction/session-title) and requests without a session identity
        // carry no hint. The body keeps the provider's original format.
        let hint;
        if (options.sessionId !== undefined && options.purpose === undefined) {
            const header = this.options.sessionHeader(options.sessionId);
            hint = buildAgentHint({
                sessionId: options.sessionId,
                ...this.options.servingFacts(options.sessionId),
                parentSession: header?.parentSession,
                parentOrigin: header?.origin,
                derivationJoin: header?.parentSession !== undefined
                    ? this.options.derivationJoin(header.parentSession)
                    : undefined,
            }, this.options.hintOptions, Date.now());
        }
        const body = serializeRequest(options, config);
        const headers = {
            'authorization': `Bearer ${await this.options.resolveApiKey()}`,
            'content-type': 'application/json',
            'accept': 'text/event-stream',
            'user-agent': 'dsh-agent-hints/0.2 (+https://github.com/evan7ang/dsh-agent-hints)',
            // Identity/intent signals mirror the official adapter's conventions so
            // gateway consumers see the same transport metadata on this route.
            ...options.sessionId !== undefined
                ? { 'x-deepseek-harness-session-id': String(options.sessionId) }
                : {},
            ...options.purpose === 'compaction'
                ? { 'x-deepseek-harness-compact': '1' }
                : {},
            ...hint !== undefined ? { 'x-agent-hint': encodeAgentHintHeader(hint) } : {},
        };
        const signal = options.signal;
        signal?.throwIfAborted();
        let response;
        try {
            response = await fetch(`${config.baseURL}/chat/completions`, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal,
            });
        }
        catch (error) {
            if (signal?.aborted)
                throw error;
            throw new AdapterError(`DeepSeek API request to ${config.baseURL} failed`, 'TRANSPORT', { cause: error });
        }
        if (!response.ok) {
            let message = `DeepSeek API error (HTTP ${response.status})`;
            let providerCode;
            const raw = await response.text();
            try {
                const parsed = JSON.parse(raw);
                if (parsed.error?.message !== undefined)
                    message = parsed.error.message;
                if (parsed.error?.code !== undefined)
                    providerCode = parsed.error.code;
            }
            catch {
                // The HTTP status remains authoritative when a gateway returns malformed JSON.
            }
            throw new AdapterError(message, httpErrorCode(response.status, providerCode), {
                status: response.status,
                cause: new Error(raw.length > 0 ? raw : `DeepSeek HTTP ${response.status}`),
            });
        }
        if (response.body === null) {
            throw new AdapterError('DeepSeek API returned no response body', 'EMPTY_RESPONSE');
        }
        yield* translate(parseSse(response.body));
    }
}
