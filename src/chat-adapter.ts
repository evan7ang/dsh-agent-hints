/** Chat Completions transport with lossless roles, bounded streams and session leases. */
import { attributionHeaders, LlmAdapter, LlmError, ReasoningEffortId, ToolCallId,
  ProviderRequestId, isContextWindowExceededError, isQuotaExceededError, resolveRetryPolicy } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, FinishReason, GenerateOptions, LlmModelInfo, LlmResolvedModelInfo,
  PreparedAdapterCall, StreamChunk, TokenUsage, ResolvedRetryPolicy } from '@deepseek-ai/dsh-llm'
import { catalogModelInfo, DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, DEFAULT_STREAM_IDLE_TIMEOUT_MS } from '@deepseek-ai/dsh-llm-deepseek'
import type { DeepSeekConnectionOptions } from '@deepseek-ai/dsh-llm-deepseek'
import { idleWatchdog, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { encodeAgentHintHeader, type AgentHint } from './hint.js'
import { estimatePrefixTokens } from './cache.js'
import type { LifecycleBridge } from './lifecycle-bridge.ts'
import type { HintTrace, HintTraceAttempt } from './trace.ts'

export interface ChatConnectionOptions {
  baseURL: string
  maxTokens?: number
  models?: DeepSeekConnectionOptions['models']
  defaultContextWindow?: number
  defaults?: DeepSeekConnectionOptions['defaults']
  streamIdleTimeoutMs?: number
  retryPolicy?: ResolvedRetryPolicy
}
export interface ChatRequestFacts {
  sessionId: string | undefined
  /**
   * Declared request purpose, or `undefined` for an ordinary conversation request.
   * DSH 0.2.2 made purposes an open, declaration-merged key set
   * (`GenerateOptions<Purpose extends string>`), so a forwarding adapter must treat
   * this as a plain string rather than the old `'compaction' | 'session-title'` union.
   */
  purpose: string | undefined
  model: string
  signal: AbortSignal
  /** Wire message count of this request (the cache declaration's msg_offset). */
  wireMessageCount: number
  /** Estimated prefix size of the serialized request, in tokens. */
  prefixTokens: number
  /** Offered tool names (cache suppression signature). */
  toolNames: string[]
}
export interface ChatAdapterDependencies<C extends ChatConnectionOptions = ChatConnectionOptions> {
  options(): C
  providerName?: string
  /** Authentication must resolve from this exact connection, never current options(). */
  resolveAuth(connection: C): Promise<{ headers: Record<string, string> }>
  prepareHint?(request: ChatRequestFacts): AgentHint | undefined | Promise<AgentHint | undefined>
  onAccepted?(request: ChatRequestFacts): void
  bridge?: LifecycleBridge
  /** Plugin lifetime, including when lifecycle controls are disabled. */
  signal?: AbortSignal
  trace?: HintTrace
  /** Kept for consumers constructing this adapter directly. */
  discoverModels?(provider: string): readonly LlmModelInfo[] | Promise<readonly LlmModelInfo[]>
}
interface ChatMessage {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool'
  content: string
  tool_call_id?: string
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  reasoning_content?: string
}
const malformed = (message: string) => new LlmError(`chat/completions: ${message}`, 'MALFORMED_RESPONSE')
function record(value: unknown): Record<string, any> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw malformed('expected an object')
  return value as Record<string, any>
}
function requestText(blocks: readonly ContentBlock[], role: string): string {
  const text: string[] = []
  for (const block of blocks) {
    if (block.type === 'text') text.push(block.text)
    else if (role === 'assistant' && (block.type === 'tool-call' || block.type === 'reasoning')) continue
    // Current tool schemas are sent in full. These historical activation markers
    // are intentionally projected away for a route without native tool updates.
    else if (role === 'developer' && (block.type === 'tool-addition' || block.type === 'tool-removal')) continue
    else throw new LlmError(`Chat transport does not support ${block.type} content; use a compatible route or a text representation`, 'UNSUPPORTED_CONTENT')
  }
  return text.join('\n')
}
function toChatMessage(message: GenerateOptions<string>['messages'][number]): ChatMessage | undefined {
  const role = message.role
  if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(role)) throw new LlmError('Unsupported message role', 'INVALID_REQUEST')
  const blocks = typeof message.content === 'string' ? [{ type: 'text' as const, text: message.content }] : message.content
  const content = requestText(blocks, role)
  if (role === 'developer' && blocks.length > 0 && blocks.every(b => b.type === 'tool-addition' || b.type === 'tool-removal')) return undefined
  const result: ChatMessage = { role, content }
  if (role === 'tool') {
    if (!('toolCallId' in message) || typeof message.toolCallId !== 'string' || !message.toolCallId) throw new LlmError('Tool result requires toolCallId', 'INVALID_REQUEST')
    result.tool_call_id = message.toolCallId
  }
  if (role === 'assistant') {
    const calls = blocks.filter(b => b.type === 'tool-call')
    if (calls.length) result.tool_calls = calls.map(call => ({ id: String(call.id), type: 'function', function: { name: call.name, arguments: call.arguments } }))
    const reasoning = blocks.filter(b => b.type === 'reasoning').map(b => b.text).join('\n')
    if (reasoning) result.reasoning_content = reasoning
  }
  return result
}
/** Shared by data and control planes; a /v1 root is never duplicated. */
export function chatCompletionsURL(baseURL: string): string {
  const root = baseURL.replace(/\/+$/, '')
  return `${root.endsWith('/v1') ? root : `${root}/v1`}/chat/completions`
}
function modelInfo(connection: ChatConnectionOptions, provider: string, model: string): LlmResolvedModelInfo {
  const configured = connection.models?.find(entry => entry.id === model)
  const off = connection.defaults?.thinking === 'disabled'
  const levels = off ? ['off'] : ['off', 'low', 'high', 'max']
  return {
    ...catalogModelInfo(provider, configured ?? { id: model }),
    // This transport deliberately rejects native images/files; do not advertise them.
    inputModalities: ['text'],
    context: { contextWindow: configured?.contextWindow ?? connection.defaultContextWindow ?? DEFAULT_CONTEXT_WINDOW },
    defaultMaxTokens: configured?.maxTokens ?? connection.maxTokens ?? DEFAULT_MAX_TOKENS,
    reasoning: { efforts: levels.map(level => ({ id: ReasoningEffortId(level), name: level })),
      defaultEffort: ReasoningEffortId(off ? 'off' : connection.defaults?.reasoningEffort ?? 'high') },
  }
}
function buildBody(options: GenerateOptions<string>, connection: ChatConnectionOptions) {
  const info = modelInfo(connection, options.provider, options.model)
  const effort = String(options.reasoningEffort ?? info.reasoning!.defaultEffort)
  if (!info.reasoning!.efforts.some(e => String(e.id) === effort)) throw new LlmError(`Unsupported reasoning effort: ${effort}`, 'INVALID_REQUEST')
  const messages = options.messages.map(toChatMessage).filter((m): m is ChatMessage => m !== undefined)
  if (options.system) messages.unshift({ role: 'system', content: options.system })
  return { model: options.model, messages, stream: true, stream_options: { include_usage: true },
    max_tokens: options.maxTokens ?? info.defaultMaxTokens,
    reasoning_effort: effort === 'off' ? 'none' : effort,
    ...options.temperature === undefined ? {} : { temperature: options.temperature },
    ...!options.stop?.length ? {} : { stop: options.stop },
    ...!options.tools?.length ? {} : { tools: options.tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } })) } }
}
function providerError(raw: unknown, status?: number, headers?: Headers): LlmError {
  const envelope = raw !== null && typeof raw === 'object' ? raw as Record<string, any> : {}
  const error = envelope.error !== null && typeof envelope.error === 'object' ? envelope.error : envelope
  const message = typeof error.message === 'string' ? error.message : typeof envelope.detail === 'string' ? envelope.detail : `Chat request failed (${status ?? 'stream error'})`
  const detail = `${error.code ?? ''} ${error.type ?? ''} ${message}`
  const code = status === 401 || status === 403 ? 'AUTH' : status === 402 || isQuotaExceededError(detail) ? 'QUOTA'
    : status === 429 || error.type === 'rate_limit_error' ? 'RATE_LIMIT' : isContextWindowExceededError(detail) ? 'CONTEXT_WINDOW_EXCEEDED'
    : status === 408 || status === 504 ? 'TIMEOUT' : status === 400 || status === 413 ? 'INVALID_REQUEST'
    : status === undefined || status >= 500 ? 'SERVER' : `HTTP_${status}`
  const retry = headers?.get('retry-after')
  const delay = retry == null ? NaN : /^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
  const id = headers?.get('x-request-id') ?? headers?.get('request-id')
  return new LlmError(message, code, { ...status === undefined ? {} : { status },
    ...Number.isFinite(delay) && delay > 0 ? { providerRetryAfterMs: delay } : {},
    ...id ? { requestId: ProviderRequestId(id) } : {} })
}
/** Bound promises that do not themselves support AbortSignal (credential resolvers). */
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted()
  let abort: (() => void) | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true })
  })]) } finally { if (abort) signal.removeEventListener('abort', abort) }
}
/** SSE line state handles LF, CRLF, CR, chunk boundaries and multi-line data. */
async function* sseEvents(response: Response, signal: AbortSignal, activity: () => void): AsyncGenerator<Record<string, any> | 'done'> {
  if (!response.body) throw malformed('missing response body')
  const reader = response.body.getReader(), decoder = new TextDecoder()
  let buffer = '', data: string[] = [], size = 0, eventName = ''
  const frame = () => { const value = { data: data.join('\n'), eventName }; data = []; size = 0; eventName = ''; return value }
  try {
    while (true) {
      const next = await abortable(reader.read(), signal)
      if (!next.done) activity()
      buffer += next.done ? decoder.decode() : decoder.decode(next.value, { stream: true })
      while (true) {
        const cut = buffer.search(/[\r\n]/)
        if (cut < 0 || (!next.done && buffer[cut] === '\r' && cut === buffer.length - 1)) break
        const line = buffer.slice(0, cut)
        buffer = buffer.slice(cut + (buffer[cut] === '\r' && buffer[cut + 1] === '\n' ? 2 : 1))
        if (!line) {
          const event = frame()
          if (!event.data) continue
          if (event.data.trim() === '[DONE]') { yield 'done'; return }
          let parsed: unknown
          try { parsed = JSON.parse(event.data) } catch { throw malformed('invalid SSE JSON') }
          const value = record(parsed)
          if (event.eventName === 'error' || value.error !== undefined) throw providerError(value)
          yield value
        } else if (line.startsWith('data:')) {
          const value = line.slice(5).replace(/^ /, '')
          data.push(value); size += value.length
        } else if (line.startsWith('event:')) eventName = line.slice(6).trim()
        if (size > 4 * 1024 * 1024) throw malformed('SSE event exceeds 4 MiB')
      }
      if (buffer.length > 4 * 1024 * 1024) throw malformed('SSE line exceeds 4 MiB')
      if (next.done) break
    }
    // An unterminated data tail must never turn into a successful answer.
    if (data.length || buffer.trim()) throw malformed('unterminated SSE event')
  } finally { await reader.cancel().catch(() => undefined); reader.releaseLock() }
}
function finishOf(raw: unknown): FinishReason {
  if (raw === 'stop') return { kind: 'stop' }
  if (raw === 'tool_calls' || raw === 'function_call') return { kind: 'tool-calls' }
  if (raw === 'length') return { kind: 'max-tokens' }
  if (raw === 'content_filter') throw new LlmError('Provider refused the response', 'REFUSAL')
  throw malformed('unknown finish reason')
}
/** Only complete provider samples may replace token accounting; absence is not zero. */
function tokenUsage(value: unknown): TokenUsage | undefined {
  const raw = record(value)
  const count = (v: unknown): number | undefined => {
    if (v == null) return undefined
    if (!Number.isSafeInteger(v) || (v as number) < 0) throw malformed('invalid token usage')
    return v as number
  }
  const input = count(raw.prompt_tokens), output = count(raw.completion_tokens)
  const cached = count(raw.prompt_tokens_details?.cached_tokens ?? raw.prompt_cache_hit_tokens) ?? 0
  const total = count(raw.total_tokens), reasoning = count(raw.completion_tokens_details?.reasoning_tokens)
  if (input !== undefined && cached > input) throw malformed('cached token count exceeds input')
  if (output !== undefined && reasoning !== undefined && reasoning > output) throw malformed('reasoning token count exceeds output')
  if (input === undefined || output === undefined) return undefined
  if (total !== undefined && total !== input + output) throw malformed('total token count does not match input and output')
  return { inputTokens: input - cached, outputTokens: output, ...cached ? { cacheReadTokens: cached } : {},
    ...total === undefined ? {} : { totalTokens: total },
    ...reasoning === undefined ? {} : { reasoningTokens: reasoning } }
}
async function* translate(events: AsyncIterable<Record<string, any> | 'done'>): AsyncGenerator<StreamChunk> {
  let textIndex: number | undefined, reasoningIndex: number | undefined, index = 0
  let text = '', reasoningText = ''
  let reason: FinishReason | undefined, usage: TokenUsage | undefined
  const calls = new Map<number, { index: number; id: string; name: string; arguments: string;
    emittedArguments: number; emittedName: string | undefined; emittedId: string | undefined }>()
  for await (const event of events) {
    if (event === 'done') break
    if (event.usage != null) {
      usage = tokenUsage(event.usage) ?? usage
    }
    if (event.choices === undefined && event.usage === undefined) throw malformed('missing choices/usage')
    if (event.choices !== undefined && !Array.isArray(event.choices)) throw malformed('choices must be an array')
    if (event.choices?.length > 1) throw malformed('multiple choices are not supported')
    for (const raw of event.choices ?? []) {
      const choice = record(raw), delta = record(choice.delta ?? {})
      const reasoning = delta.reasoning_content ?? delta.reasoning
      if (reason !== undefined && (delta.content || reasoning || delta.tool_calls?.length)) throw malformed('content after finish reason')
      if (reasoning !== undefined && typeof reasoning !== 'string') throw malformed('invalid reasoning delta')
      if (reasoning) {
        if (reasoningIndex === undefined) { reasoningIndex = index++; yield { type: 'block-start', index: reasoningIndex, blockType: 'reasoning' } }
        reasoningText += reasoning
        yield { type: 'reasoning-delta', index: reasoningIndex, text: reasoning }
      }
      if (delta.content != null && typeof delta.content !== 'string') throw malformed('invalid text delta')
      if (delta.content) {
        if (textIndex === undefined) { textIndex = index++; yield { type: 'block-start', index: textIndex, blockType: 'text' } }
        text += delta.content
        yield { type: 'text-delta', index: textIndex, text: delta.content }
      }
      if (delta.tool_calls !== undefined) {
        if (!Array.isArray(delta.tool_calls)) throw malformed('invalid tool calls')
        for (const rawCall of delta.tool_calls) {
          const call = record(rawCall)
          if (!Number.isSafeInteger(call.index) || call.index < 0) throw malformed('invalid tool index')
          let state = calls.get(call.index)
          if (!state) {
            state = { index: index++, id: '', name: '', arguments: '', emittedArguments: 0, emittedName: undefined, emittedId: undefined }
            calls.set(call.index, state)
            yield { type: 'block-start', index: state.index, blockType: 'tool-call' }
          }
          if (call.id !== undefined) { if (typeof call.id !== 'string') throw malformed('invalid tool id'); if (call.id !== state.id) state.id += call.id }
          if (call.function !== undefined) {
            const fn = record(call.function)
            if (fn.name !== undefined) { if (typeof fn.name !== 'string') throw malformed('invalid tool name'); state.name += fn.name }
            if (fn.arguments !== undefined) { if (typeof fn.arguments !== 'string') throw malformed('invalid tool arguments'); state.arguments += fn.arguments }
          }
          // Raw deltas are observable, not permission to execute a tool. The
          // stock loop dispatches only after a validated terminal outcome.
          // ToolCallId is required by DSH: hold fragments only until it exists.
          const argumentsDelta = state.arguments.slice(state.emittedArguments)
          const nameChanged = state.name !== '' && state.name !== state.emittedName
          if (state.id && (argumentsDelta || nameChanged || state.id !== state.emittedId)) {
            yield { type: 'tool-call-delta', index: state.index, id: ToolCallId(state.id),
              ...nameChanged ? { name: state.name } : {}, argumentsDelta }
            state.emittedArguments = state.arguments.length
            state.emittedName = state.name || undefined
            state.emittedId = state.id
          }
        }
      }
      if (choice.finish_reason != null) {
        if (reason !== undefined) throw malformed('duplicate finish reason')
        reason = finishOf(choice.finish_reason)
      }
    }
  }
  if (!reason) throw malformed('stream ended without a finish reason')
  if (reason.kind === 'tool-calls' && !calls.size) throw malformed('tool finish without calls')
  if (calls.size && reason.kind === 'stop') throw malformed('tool calls without a tool finish')
  const ids = new Set<string>()
  // Validate every parallel call before completing any block. A malformed
  // stream stays an error even if another call happened to be complete.
  if (reason.kind === 'tool-calls') for (const call of calls.values()) {
    if (!call.id || !call.name) throw malformed('incomplete tool identity')
    if (ids.has(call.id)) throw malformed('duplicate tool identity')
    ids.add(call.id)
    if (!call.arguments) call.arguments = '{}'
    try { JSON.parse(call.arguments) } catch { throw malformed('incomplete tool arguments') }
  }
  if (reason.kind === 'stop' && textIndex === undefined) throw new LlmError('Chat returned no answer', 'EMPTY_RESPONSE')
  const completed: { index: number; block: ContentBlock }[] = []
  if (textIndex !== undefined) completed.push({ index: textIndex, block: { type: 'text', text } })
  if (reasoningIndex !== undefined) completed.push({ index: reasoningIndex, block: { type: 'reasoning', text: reasoningText } })
  for (const call of calls.values()) {
    if (reason.kind === 'tool-calls' && call.arguments.length > call.emittedArguments) {
      yield { type: 'tool-call-delta', index: call.index, id: ToolCallId(call.id),
        argumentsDelta: call.arguments.slice(call.emittedArguments) }
    }
    // max-tokens closes the raw partial block without inventing its identity
    // or completing its JSON. DSH discards all tool blocks for this terminal.
    completed.push({ index: call.index, block: { type: 'tool-call', id: ToolCallId(call.id), name: call.name, arguments: call.arguments } })
  }
  for (const { index, block } of completed.sort((a, b) => a.index - b.index)) yield { type: 'block-end', index, block }
  if (usage) yield { type: 'usage', usage }
  yield { type: 'finish', reason }
}
export class ChatCompletionsAdapter<C extends ChatConnectionOptions = ChatConnectionOptions> extends LlmAdapter {
  constructor(private readonly dependencies: ChatAdapterDependencies<C>) { super() }
  override providerInfo(provider: string) { return { id: provider, name: this.dependencies.providerName ?? 'DeepSeek (agent-hint)' } }
  override providerRetryPolicy(_provider: string) { return this.dependencies.options().retryPolicy ?? resolveRetryPolicy(undefined, 'agent-hint.retryPolicy') }
  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const options = this.dependencies.options()
    const models = this.dependencies.discoverModels ? await this.dependencies.discoverModels(provider) : (options.models ?? []).map(m => catalogModelInfo(provider, m))
    return models.map(m => ({ ...m, inputModalities: ['text'] }))
  }
  override async resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
    signal?.throwIfAborted(); return modelInfo(this.dependencies.options(), provider, model)
  }
  override async prepareCall(provider: string, model: string, signal?: AbortSignal): Promise<PreparedAdapterCall> {
    signal?.throwIfAborted()
    const connection = this.dependencies.options()
    return { model: modelInfo(connection, provider, model), stream: options => this.generate(options, connection) }
  }
  override stream(options: GenerateOptions<string>): AsyncIterable<StreamChunk> { return this.generate(options, this.dependencies.options()) }
  private async *generate(options: GenerateOptions<string>, connection: C): AsyncGenerator<StreamChunk> {
    const consumer = new AbortController(), bridge = this.dependencies.bridge
    const signals = [consumer.signal, options.signal, bridge?.signal, this.dependencies.signal].filter((v): v is AbortSignal => v !== undefined)
    const watchdog = idleWatchdog(AbortSignal.any(signals), connection.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS, 'CHAT_IDLE')
    const iterator = this.request(options, connection, watchdog.signal, () => watchdog.pulse())
    try { while (true) { const next = await watchdog.next(iterator); if (next.done) return; yield next.value } }
    catch (error) {
      if (timeoutOf(watchdog.signal, 'CHAT_IDLE')) throw new LlmError('Chat stream idle timeout', 'TIMEOUT', { cause: error })
      if (options.signal?.aborted || bridge?.signal.aborted || this.dependencies.signal?.aborted) throw new LlmError('Chat request aborted', 'ABORTED', { cause: error })
      if (error instanceof LlmError) throw error
      throw new LlmError('Chat transport failed', 'TRANSPORT', { cause: error })
    } finally { consumer.abort(); watchdog[Symbol.dispose](); await iterator.return(undefined).catch(() => undefined) }
  }
  private async *request(options: GenerateOptions<string>, connection: C, signal: AbortSignal, activity: () => void): AsyncGenerator<StreamChunk> {
    signal.throwIfAborted()
    const body = buildBody(options, connection)
    const facts: ChatRequestFacts = { sessionId: options.sessionId === undefined ? undefined : String(options.sessionId), purpose: options.purpose, model: options.model, signal, wireMessageCount: body.messages.length, prefixTokens: estimatePrefixTokens(body.messages), toolNames: options.tools?.map(tool => tool.name) ?? [] }
    const release = options.purpose === undefined ? await this.dependencies.bridge?.beginOrdinary(options.sessionId, options.model, signal) : undefined
    let observation: HintTraceAttempt | undefined
    let dispatched = false
    try {
      const hint = await abortable(Promise.resolve(this.dependencies.prepareHint?.(facts)), signal)
      if (hint !== undefined) observation = this.dependencies.trace?.begin({
        plane: 'data', transport: 'chat', model: options.model, hint }, 'prepared')
      const auth = await abortable(this.dependencies.resolveAuth(connection), signal)
      signal.throwIfAborted()
      const payload = JSON.stringify(body)
      observation?.dispatch()
      dispatched = true
      const response = await fetch(chatCompletionsURL(connection.baseURL), { method: 'POST', redirect: 'error', signal,
        headers: { ...attributionHeaders(), 'content-type': 'application/json', accept: 'text/event-stream', ...auth.headers,
          // Identity metadata mirrors the official adapter so gateway consumers
          // see the same transport facts on this route (not hint fields).
          ...options.sessionId === undefined ? {} : { 'x-deepseek-harness-session-id': String(options.sessionId) },
          ...options.purpose === 'compaction' ? { 'x-deepseek-harness-compact': '1' } : {},
          ...hint === undefined ? {} : { 'x-agent-hint': encodeAgentHintHeader(hint) } }, body: payload })
      observation?.finish(response.ok ? 'accepted' : 'rejected', { httpStatus: response.status, dispatched: true })
      try {
        if (!response.ok) {
          const text = await abortable(response.text(), signal)
          let raw: unknown; try { raw = JSON.parse(text) } catch { raw = undefined }
          throw providerError(raw, response.status, response.headers)
        }
        if (options.purpose === undefined) this.dependencies.onAccepted?.(facts)
        yield* translate(sseEvents(response, signal, activity))
      } finally { await response.body?.cancel().catch(() => undefined) }
    } catch (error) {
      observation?.finish(!dispatched ? (signal.aborted ? 'cancelled' : 'not-dispatched')
        : signal.aborted ? 'cancelled' : 'unknown', { dispatched })
      throw error
    } finally { release?.() }
  }
}
