import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import Llm, { createUserMessage, isTokenDelta } from '@deepseek-ai/dsh-llm'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import Agents from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import Projections from '@deepseek-ai/dsh-session-projection'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ChatCompletionsAdapter } from '../src/chat-adapter.ts'

let ctx: Context | undefined
afterEach(async () => { await ctx?.fiber.dispose(); ctx = undefined; vi.unstubAllGlobals(); vi.unstubAllEnvs() })
const frame = (value: unknown) => new TextEncoder().encode(`data: ${JSON.stringify(value)}\n\n`)
describe('stock AgentLoop execution after provisional Chat tool deltas', () => {
  it.each(['valid', 'malformed', 'duplicate', 'length', 'stream-error', 'cancel'] as const)(
    'does not dispatch tools before a validated terminal: %s', async ending => {
      vi.stubEnv('DSH_HOME', await mkdtemp(join(tmpdir(), 'agenthint-tool-safety-')))
      let controller!: ReadableStreamDefaultController<Uint8Array>, executions = 0, firstModelCall = true
      const observed: StreamChunk[] = []
      let firstToken!: () => void
      const tokenObserved = new Promise<void>(resolve => { firstToken = resolve })
      vi.stubGlobal('fetch', vi.fn(async () => {
        if (!firstModelCall) return new Response(frame({ choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] }))
        firstModelCall = false
        return new Response(new ReadableStream<Uint8Array>({ start(c) {
          controller = c
          c.enqueue(frame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-a', function: { name: 'fixture_action', arguments: '{' } }] } }] }))
        } }))
      }))
      ctx = new Context()
      // 0.2.2 announces Session projections before Agents can activate (the Agents
      // plugin injects sessionProjections), so the registry must mount first.
      await ctx.plugin(SessionStore); await ctx.plugin(Llm); await ctx.plugin(Projections)
      await ctx.plugin(Agents); await ctx.plugin(SystemPrompt); await ctx.plugin(Tools)
      // 0.2.2 splits tool dispatch out of the registry: a composition must mount an executor.
      await ctx.plugin(NativeToolExecutor)
      ctx.llm.registerAdapter(['safety'], new ChatCompletionsAdapter({
        options: () => ({ baseURL: 'http://fixture.invalid', defaults: { thinking: 'disabled' }, models: [{ id: 'fixture', contextWindow: 32768, maxTokens: 128 }] }),
        resolveAuth: async () => ({ headers: {} }),
      }))
      ctx.on('llm/stream', (_options, next) => (async function* () {
        for await (const chunk of next()) { observed.push(chunk); if (isTokenDelta(chunk)) firstToken(); yield chunk }
      })(), { global: true })
      ctx.tools.register(defineTool({ name: 'fixture_action', description: 'Count fixture executions', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        execute: async () => { executions++; return 'fixture result' } }))
      await ctx.plugin(AgentLoop, { agents: [] })
      const handle = await ctx.agents.create({ sessionId: SessionId(`tool-safety-${ending}`),
        agentOptions: { provider: 'safety', model: 'fixture' } })
      handle.agent.followup(createUserMessage({ content: [{ type: 'text', text: 'run fixture' }], source: { kind: 'user' } }))
      await tokenObserved
      expect(executions).toBe(0)
      expect(observed.some(c => c.type === 'finish')).toBe(false)
      if (ending === 'cancel') handle.agent.cancel({ kind: 'user' })
      else {
        if (ending === 'stream-error') controller.enqueue(frame({ error: { message: 'fixture failed' } }))
        else {
          const calls = [{ index: 0, function: { arguments: ending === 'malformed' || ending === 'length' ? '' : '}' } },
            ...ending === 'duplicate' ? [{ index: 1, id: 'call-a', function: { name: 'fixture_action', arguments: '{}' } }] : []]
          controller.enqueue(frame({ choices: [{ delta: { tool_calls: calls }, finish_reason: ending === 'length' ? 'length' : 'tool_calls' }] }))
        }
        controller.close()
      }
      await handle.agent.whenIdle()
      expect(executions).toBe(ending === 'valid' ? 1 : 0)
      const finishes = observed.filter(c => c.type === 'finish')
      if (ending === 'valid') expect(finishes.map(c => c.reason.kind)).toEqual(['tool-calls', 'stop'])
      else if (ending === 'length') expect(finishes[0]).toMatchObject({ reason: { kind: 'max-tokens' } })
      else if (ending !== 'cancel') expect(finishes[0]).toMatchObject({ reason: { kind: 'error' } })
    }, 5000)
})
