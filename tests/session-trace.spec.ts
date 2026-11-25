import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SessionStore, { Session, SessionId, appendPluginRecord, pluginRecordOf } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { Config } from '../src/config.ts'
import { HintTrace } from '../src/trace.ts'
import type { HintTraceFacts } from '../src/trace.ts'
import type { HintTraceRecord, HintTraceSummary } from '../src/trace-record.ts'
import {
  HINT_TRACE_RECORD_TYPE, createSessionTraceSink,
} from '../src/session-trace.ts'

const SESSION = 'session-1'
const OTHER = 'session-2'
const summary = (overrides: Partial<HintTraceSummary> = {}): HintTraceSummary => ({
  session_id: SESSION, state: 'append', call_index: 1, epoch: 0, ...overrides,
})
const facts = (overrides: Partial<HintTraceFacts> = {}): HintTraceFacts => ({
  plane: 'data', transport: 'chat', model: 'fixture-model',
  hint: { session: { session_id: SESSION, call_index: 1, epoch: 0, state: 'start' } }, ...overrides,
})

const record = (overrides: Partial<HintTraceRecord> = {}): HintTraceRecord => ({
  schemaVersion: 2,
  requestId: 'request-1',
  time: '2026-11-01T00:00:00.000Z',
  sessionId: SESSION,
  plane: 'data',
  transport: 'chat',
  model: 'fixture-model',
  attempt: 1,
  phase: 'result',
  outcome: 'accepted',
  httpStatus: 200,
  durationMs: 1.5,
  dispatched: true,
  hint: summary(),
  ...overrides,
})

/** Independent Session: appends are legal without a store, so no host wiring is needed. */
const detached = (id = SESSION) => Session.create(SessionId(id))

describe('session log writer', () => {
  it('writes exactly one record per attempt, and only the terminal one', () => {
    const session = detached()
    const writes: HintTraceRecord[] = []
    const trace = new HintTrace({ writeSessionRecord: (value) => {
      writes.push(value)
      createSessionTraceSink({ resolveSession: () => session })(value)
    } })
    const attempt = trace.begin(facts(), 'prepared')
    attempt.dispatch()
    attempt.finish('accepted', { httpStatus: 200, dispatched: true })
    expect(writes.map(value => value.phase)).toEqual(['result'])

    const events = session.snapshotEvents()
    expect(events).toHaveLength(1)
    const committed = pluginRecordOf(events[0] as SessionEvent)
    expect(committed?.type).toBe(HINT_TRACE_RECORD_TYPE)
    expect(events[0]?.ignorable).toBe(true)
    expect(committed?.data).toEqual(writes[0])
  })

  it('keeps every intermediate record on stdout while the log stays minimal', () => {
    const session = detached()
    const logged: HintTraceRecord[] = []
    const trace = new HintTrace({
      log: value => logged.push(value),
      writeSessionRecord: createSessionTraceSink({ resolveSession: () => session }),
    })
    const attempt = trace.begin(facts(), 'prepared')
    attempt.dispatch()
    attempt.finish('accepted', { httpStatus: 200, dispatched: true })
    expect(logged.map(value => value.phase)).toEqual(['prepared', 'dispatch', 'result'])
    expect(session.snapshotEvents()).toHaveLength(1)
  })

  it('bounds durable writes per session with the maxRecords window', () => {
    const session = detached()
    const warn = vi.fn()
    const sink = createSessionTraceSink({ resolveSession: () => session, maxRecords: 2, warn })
    for (let attempt = 1; attempt <= 4; attempt++) sink(record({ attempt, requestId: `request-${attempt}` }))
    expect(session.snapshotEvents()).toHaveLength(2)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0]?.[0]).toContain('budget of 2 records')
  })

  it('skips silently without a session, without the primitive, or for an unknown id', () => {
    const session = detached()
    const warn = vi.fn()
    for (const sink of [
      createSessionTraceSink({ resolveSession: () => undefined, warn }),
      createSessionTraceSink({ resolveSession: () => session, append: undefined, warn }),
      createSessionTraceSink({ warn }),
      createSessionTraceSink({ resolveSession: () => session, warn })(record({ sessionId: '' })),
    ]) {
      if (typeof sink === 'function') sink(record())
    }
    expect(session.snapshotEvents()).toHaveLength(0)
    expect(warn).not.toHaveBeenCalled()
  })

  it('degrades to stdout when the host rejects the append', async () => {
    const ctx = new Context()
    try {
      await ctx.plugin(SessionStore)
      // Prepared but never announced: dsh-session refuses appends here.
      const unannounced = ctx.sessions.prepare(SessionId(SESSION))
      const warn = vi.fn()
      const logged: HintTraceRecord[] = []
      const trace = new HintTrace({ log: value => logged.push(value), warn,
        writeSessionRecord: createSessionTraceSink({ resolveSession: () => unannounced, warn }) })
      expect(() => trace.begin(facts()).finish('accepted', { httpStatus: 200 })).not.toThrow()
      expect(warn).toHaveBeenCalledTimes(1)
      expect(logged.map(value => value.phase)).toEqual(['dispatch', 'result'])
      expect(unannounced.snapshotEvents()).toHaveLength(0)
      expect(trace.recordsOf(SESSION)).toHaveLength(2)
    } finally { await ctx.fiber.dispose() }
  })

  it('never lets a throwing sink failure reach inference', () => {
    const trace = new HintTrace({ writeSessionRecord: () => { throw new Error('SECRET-SINK') } })
    const attempt = trace.begin(facts())
    expect(() => attempt.finish('accepted', { httpStatus: 200 })).not.toThrow()
    expect(trace.recordsOf(SESSION).map(value => value.phase)).toEqual(['dispatch', 'result'])
  })
})

describe('configuration', () => {
  it('mirrors into the session log by default and can be switched off', () => {
    expect(Config({}).agentHint.trace).toEqual({ enabled: true, maxRecords: 2000, writeToSession: true })
    expect(Config({ agentHint: { trace: { writeToSession: false } } }).agentHint.trace.writeToSession).toBe(false)
    expect(Config({ agentHint: { trace: { enabled: false } } }).agentHint.trace.enabled).toBe(false)
  })

  it('writes nothing to the session log while disabled, and stdout keeps working', () => {
    const session = detached()
    const logged: HintTraceRecord[] = []
    const enabled = new HintTrace({ log: value => logged.push(value),
      writeSessionRecord: createSessionTraceSink({ resolveSession: () => session }) })
    enabled.begin(facts()).finish('accepted', { httpStatus: 200 })
    expect(session.snapshotEvents()).toHaveLength(1)

    const disabled = new HintTrace({ enabled: false, log: () => { throw new Error('must not log') },
      writeSessionRecord: createSessionTraceSink({ resolveSession: () => session }) })
    disabled.begin(facts()).finish('accepted', { httpStatus: 200 })
    expect(session.snapshotEvents()).toHaveLength(1)
    expect(disabled.recordsOf(SESSION)).toHaveLength(0)
  })
})

describe('model-visible surface', () => {
  it('never enters the surface: no nodes, no derived messages, no surface metadata', () => {
    const session = detached()
    const before = session.surface.nodes.length
    const sink = createSessionTraceSink({ resolveSession: () => session })
    for (let attempt = 1; attempt <= 3; attempt++) sink(record({ attempt, requestId: `request-${attempt}` }))
    expect(session.surface.nodes.length).toBe(before)
    expect(session.deriveMessages()).toEqual([])
    for (const event of session.snapshotEvents()) {
      expect(event.ignorable).toBe(true)
      expect('surfaceOp' in event).toBe(false)
      expect('sourceEventSeqs' in event).toBe(false)
    }
  })
})
