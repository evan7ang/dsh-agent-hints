#!/usr/bin/env node
// Keyless wire-capture stub for the official DeepSeek chat-completions route:
// records every received request, then replays a scripted multi-session
// conversation that exercises the AgentHint value logic end to end:
//
//   root session, turn 1
//     1. e2e_probe tool call            → exercises running + turn-opening priority
//     2. subagent(foreground) tool call → exercises spawn lineage + parent pause
//   child session (spawned by the harness)
//     1. e2e_probe tool call            → child running + priority
//     2. final text                     → child resume after the probe release
//   root session, turn 1 (continued)
//     3. final text                     → parent resume after the delegation release
//   root session, turn 2 (adopted via --session-id in run.sh)
//     4. final text                     → new-turn opening after a process restart
//
// Scripting is stateful per session id decoded from the `X-Agent-Hint` header.
// Auxiliary calls (session-title/compaction) carry no hint and always get plain
// text so they never consume a scripted phase.
//
// Also doubles as a status-endpoint receiver (`--status-out <file.jsonl>`):
// POST /agent-status bodies are appended as JSONL lines, standing in for the
// Motor Phase 4 scheduler endpoint in wire e2e runs.
//
// Usage: stub-server.mjs --capture <file.jsonl> [--port <n>] [--port-file <path>] [--status-out <file.jsonl>]
import { appendFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

function arg(name) {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}

const capturePath = arg('capture')
if (capturePath === undefined) {
  console.error('stub-server: --capture <file> is required')
  process.exit(1)
}
const listenPort = Number(arg('port') ?? 0)
const statusOutPath = arg('status-out')

/** Per-session scripted phase counter (main-line requests only). */
const phases = new Map()
/** Sessions whose script is the compaction/overflow scenario (sticky: the marker text is compacted away). */
const overflowSessions = new Set()

function decodeHint(headers) {
  const raw = headers['x-agent-hint']
  if (typeof raw !== 'string') return undefined
  try {
    return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'))
  } catch {
    return undefined
  }
}

const textResponse = text => [
  '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
  `{"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}`,
  '{"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":6}}',
  '[DONE]',
]

function toolCallResponse(id, name, args) {
  const fragments = JSON.stringify(args)
  return [
    '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"id":${JSON.stringify(id)},"type":"function","function":{"name":${JSON.stringify(name)},"arguments":""}}]}}]}`,
    `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(fragments)}}}]}}]}`,
    '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
    '[DONE]',
  ]
}

/**
 * Route one main-line request to its scripted phase. The hint header is the
 * routing key only; assertions still verify its decoded values independently.
 * The `HINT_E2E_OVERFLOW` task text selects the compaction scenario: a huge
 * tool payload is followed by a provider context-window error so the harness
 * summarizes and retries the same step. The marker is remembered per session
 * because compaction rewrites that text out of the retried request.
 */
function scriptFor(hint, body) {
  const sessionId = hint?.session?.session_id
  if (typeof sessionId !== 'string') return textResponse('AGENT_HINTS_E2E_AUX')
  const phase = (phases.get(sessionId) ?? 0) + 1
  phases.set(sessionId, phase)
  const isChild = hint.session.parent_session_id !== undefined
  if (isChild) {
    if (phase === 1) return toolCallResponse('hint-e2e-child-call-1', 'e2e_probe', { message: 'CHILD' })
    return textResponse('AGENT_HINTS_E2E_CHILD_FINAL')
  }
  if (JSON.stringify(body).includes('HINT_E2E_OVERFLOW')) overflowSessions.add(sessionId)
  if (overflowSessions.has(sessionId)) {
    // Phase 2 answers with a context-window error so the harness compacts and
    // retries the same step; phases 3+ then continue the turn.
    if (phase === 1) return toolCallResponse('hint-e2e-call-1', 'e2e_probe', { message: 'X'.repeat(20_000) })
    if (phase === 2) return { status: 400, body: { error: { message: "This model's maximum context length is 128000 tokens." } } }
    if (phase === 3) return toolCallResponse('hint-e2e-call-2', 'e2e_probe', { message: 'after-compaction' })
    return textResponse('AGENT_HINTS_E2E_FINAL')
  }
  if (phase === 1) return toolCallResponse('hint-e2e-call-1', 'e2e_probe', { message: 'START' })
  if (phase === 2) {
    return toolCallResponse('hint-e2e-call-2', 'subagent', {
      description: 'probe subagent',
      prompt: 'Call the e2e_probe tool with message CHILD, then report the result.',
      run_in_background: false,
    })
  }
  return textResponse('AGENT_HINTS_E2E_FINAL')
}

const server = createServer((request, response) => {
  const sse = (events) => {
    for (const event of events) response.write(`data: ${event}\n\n`)
    response.end()
  }
  const chunks = []
  request.on('data', chunk => chunks.push(chunk))
  request.on('end', () => {
    // Status endpoint: record the StatusEvent and acknowledge (no SSE script).
    if (statusOutPath !== undefined && request.method === 'POST' && request.url === '/agent-status') {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        appendFileSync(statusOutPath, JSON.stringify(JSON.parse(raw)) + '\n')
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{"ok":true}')
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' })
        response.end(JSON.stringify({ error: { message: 'unparseable status event' } }))
      }
      return
    }
    let body
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      response.writeHead(400, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: { message: 'unparseable request body' } }))
      return
    }
    appendFileSync(capturePath, `${JSON.stringify({
      path: request.url,
      headers: request.headers,
      body,
    })}\n`)

    const script = scriptFor(decodeHint(request.headers), body)
    if (!Array.isArray(script)) {
      response.writeHead(script.status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(script.body))
      return
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    sse(script)
  })
})

server.listen(listenPort, '127.0.0.1', () => {
  const { port } = server.address()
  const portFile = arg('port-file')
  if (portFile !== undefined) writeFileSync(portFile, String(port))
  console.log(`stub-server: listening on 127.0.0.1:${port}`)
})
