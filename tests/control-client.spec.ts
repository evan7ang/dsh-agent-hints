import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_CONTROL_RETRIES, DEFAULT_CONTROL_TIMEOUT_MS, SessionControlClient } from '../src/control-client.ts'
import type { ControlWarnSink } from '../src/control-client.ts'

function jsonResponse(status: number): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } })
}

describe('SessionControlClient', () => {
  let warnings: [string, unknown?][]
  let warn: ControlWarnSink
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    warnings = []
    warn = (message, error) => { warnings.push([message, error]) }
    fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function client(options?: {
    endpoint?: string
    model?: string
    timeoutMs?: number
    retries?: number
    resolveApiKey?: () => Promise<string | undefined>
    sessionFacts?: (sessionId: string) => { callIndex: number; epoch: number; parentSessionId?: string } | undefined
  }): SessionControlClient {
    return new SessionControlClient({
      endpoint: 'http://coordinator.test/v1/chat/completions',
      resolveApiKey: () => Promise.resolve('k'),
      model: 'default-model',
      timeoutMs: DEFAULT_CONTROL_TIMEOUT_MS,
      retries: DEFAULT_CONTROL_RETRIES,
      warn,
      ...options,
    })
  }

  const hintOf = (init: RequestInit) =>
    JSON.parse(Buffer.from((init.headers as Record<string, string>)['x-agent-hint'], 'base64url').toString('utf8'))

  it('never sends "start": it is a data-plane piggyback verb only', async () => {
    await client().send('start', 'session-1')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(warnings.map(([message]) => message)[0]).toContain('start')
  })

  it('keeps one endpoint/key snapshot across retries and refreshes it for the next operation', async () => {
    let generation = 'A'
    const resolveConnection = vi.fn(async () => ({ endpoint: `http://${generation}.test/control`, apiKey: generation }))
    const transport = new SessionControlClient({
      endpoint: 'http://unused.test', resolveApiKey: async () => 'unused',
      resolveConnection, model: 'm', timeoutMs: 1000, retries: 1,
    })
    fetchMock.mockImplementationOnce(async () => { generation = 'B'; return jsonResponse(503) })
    fetchMock.mockImplementation(async () => jsonResponse(200))
    await transport.send('resume', 'session-1')
    await transport.send('resume', 'session-1')
    expect(fetchMock.mock.calls.map(([url, init]) => [url, init.headers.authorization])).toEqual([
      ['http://A.test/control', 'Bearer A'], ['http://A.test/control', 'Bearer A'],
      ['http://B.test/control', 'Bearer B'],
    ])
    expect(resolveConnection).toHaveBeenCalledTimes(2)
  })

  it('posts a placeholder body and carries the manage hint in the header', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client({ sessionFacts: () => ({ callIndex: 4, epoch: 1 }) }).send('compact', 'session-1', 'last-model')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://coordinator.test/v1/chat/completions')
    expect(init.method).toBe('POST')
    expect(JSON.parse(init.body as string)).toEqual({ model: 'last-model', messages: [], stream: false })
    // compact evicts the rewritten context, i.e. the previous epoch.
    expect(hintOf(init)).toEqual({
      session: { session_id: 'session-1', call_index: 4, epoch: 0, state: 'compact' },
      context_management: { manage_request: true, edits: [{ type: 'evict', target: 'session' }] },
    })
    expect(warnings).toEqual([])
  })

  it('labels pause as offload, resume as prefetch and stop as evict', async () => {
    fetchMock.mockResolvedValue(jsonResponse(200))
    const transport = client({ sessionFacts: () => ({ callIndex: 2, epoch: 3, parentSessionId: 'p-1' }) })
    for (const verb of ['pause', 'resume', 'stop'] as const) await transport.send(verb, 'session-1')
    const edits = fetchMock.mock.calls.map(([, init]) => hintOf(init as RequestInit))
    expect(edits).toEqual([
      { session: { session_id: 'session-1', parent_session_id: 'p-1', call_index: 2, epoch: 3, state: 'pause' },
        context_management: { manage_request: true, edits: [{ type: 'offload', target: 'session' }] } },
      { session: { session_id: 'session-1', parent_session_id: 'p-1', call_index: 2, epoch: 3, state: 'resume' },
        context_management: { manage_request: true, edits: [{ type: 'prefetch', target: 'session' }] } },
      { session: { session_id: 'session-1', parent_session_id: 'p-1', call_index: 2, epoch: 3, state: 'stop' },
        context_management: { manage_request: true, edits: [{ type: 'evict', target: 'session' }] } },
    ])
  })

  it('falls back to the configured default model', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client().send('resume', 'session-1')
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('missing fetch call')
    const init = call[1] as RequestInit
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'default-model',
    })
  })

  it('reports an unknown mutating outcome for HTTP 503', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503))
    await expect(client().send('stop', 'session-1')).resolves.toMatchObject({ status: 'unknown' })
    expect(warnings.map(([message]) => message)[0]).toContain('unknown')
  })

  it('does not retry an ambiguous transport error', async () => {
    fetchMock.mockRejectedValueOnce(new Error('ECONNREFUSED'))
    await expect(client().send('pause', 'session-1')).resolves.toMatchObject({ status: 'unknown' })
    expect(warnings.map(([message]) => message)[0]).toContain('unknown')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('retries resume after an explicit transient rejection', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(503))
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client({ retries: 1 }).send('resume', 'session-1')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(warnings.length).toBe(1)
  })

  it('gives up after the configured retries', async () => {
    fetchMock.mockRejectedValue(new Error('down'))
    await client({ retries: 0 }).send('compact', 'session-1')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('sends the bearer token and attribution headers', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client().send('resume', 'session-1')
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('missing fetch call')
    const init = call[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBe('Bearer k')
    expect(headers['content-type']).toBe('application/json')
    expect(typeof headers['x-agent-hint']).toBe('string')
  })

  it('omits the authorization header when no credential resolves', async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(200))
    await client({ resolveApiKey: () => Promise.resolve(undefined) }).send('resume', 'session-1')
    const call = fetchMock.mock.calls[0]
    if (call === undefined) throw new Error('missing fetch call')
    const init = call[1] as RequestInit
    const headers = init.headers as Record<string, string>
    expect(headers['authorization']).toBeUndefined()
    expect(headers['content-type']).toBe('application/json')
  })
})
