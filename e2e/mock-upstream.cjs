#!/usr/bin/env node
/**
 * Scripted OpenAI-compatible upstream for the e2e phases. One JSON line per
 * request records the path, the `x-agent-hint` header and the parsed body.
 *
 * Scripts are selected by the conversation text, because the plugin's own header
 * is the thing under test:
 *
 * - `E2E_PROBE`          one probe tool round trip, then text (start/append run);
 * - `E2E_DELEGATE`       probe, then a background `subagent` call (its child
 *                        session runs while the parent is idle → pause), then
 *                        text on the notification turn (resume);
 * - `HINT_E2E_OVERFLOW`  probe, then a synthetic context-window error; the
 *                        harness compacts and retries the step (compact),
 *                        then finishes;
 * - `E2E_CHILD`          a delegated child answers text;
 * - a title request      answers text, never a tool call.
 *
 * Placeholder manage requests (`stream: false`) get `{}` and are never executed
 * as inference.
 *
 * Usage: node mock-upstream.cjs [capturePath] [portFile]
 * Env: MOCK_PORT (default 0 = ephemeral)
 */
const fs = require('node:fs')
const http = require('node:http')

const capturePath = process.argv[2] ?? 'captures.jsonl'
const portFile = process.argv[3]
const port = Number(process.env.MOCK_PORT || 0)
fs.writeFileSync(capturePath, '')

const phases = new Map()
const overflowSessions = new Set()
/** First hinted session is the scenario's parent; any other hinted session is its child. */
let primarySession

const decodeHint = headers => {
  const raw = headers['x-agent-hint']
  if (typeof raw !== 'string') return undefined
  try { return JSON.parse(Buffer.from(raw, 'base64url').toString('utf8')) } catch { return undefined }
}

const sse = (res, frames) => {
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
  for (const frame of frames) res.write(`data: ${JSON.stringify(frame)}\n\n`)
  res.write('data: [DONE]\n\n')
  res.end()
}
const usageFrame = (body, promptTokens = 8) => ({
  id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model, choices: [],
  usage: { prompt_tokens: promptTokens + (body.messages?.length ?? 0), completion_tokens: 1 },
})
const answer = (body, value) => [
  { id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model,
    choices: [{ index: 0, delta: { role: 'assistant', content: value }, finish_reason: null }] },
  { id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
]
const toolCall = (body, id, name, args) => [
  { id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model,
    choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id,
      function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: null }] },
  { id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model,
    choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
]

const server = http.createServer((req, res) => {
  const chunks = []
  req.on('data', chunk => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body = null
    try { body = JSON.parse(raw) } catch { /* keep raw below */ }
    fs.appendFileSync(capturePath, JSON.stringify({
      at: new Date().toISOString(),
      method: req.method,
      path: req.url,
      headers: {
        authorization: req.headers.authorization === undefined ? null : '<present>',
        'content-type': req.headers['content-type'] ?? null,
        'x-agent-hint': req.headers['x-agent-hint'] ?? null,
        'x-deepseek-harness-compact': req.headers['x-deepseek-harness-compact'] ?? null,
      },
      body: body === null ? { unparsed: raw.slice(0, 2000) } : body,
    }) + '\n')

    if (req.method !== 'POST') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"data":[]}')
      return
    }
    // A manage request is a placeholder: never executed as inference.
    if (body?.stream !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
      return
    }

    const messages = Array.isArray(body.messages) ? body.messages : []
    const contentOf = message => typeof message.content === 'string' ? message.content : ''
    const allText = messages.map(contentOf).join('\n')

    if (allText.includes('concise title')) {
      sse(res, [...answer(body, 'title'), usageFrame(body)])
      return
    }
    if (allText.includes('E2E_CHILD')) {
      sse(res, [...answer(body, 'child done'), usageFrame(body)])
      return
    }

    const hint = decodeHint(req.headers)
    const session = typeof hint?.session?.session_id === 'string' ? hint.session.session_id : 'anonymous'
    if (typeof hint?.session?.session_id === 'string' && primarySession === undefined) primarySession = session
    if (primarySession !== undefined && session !== primarySession) {
      // A delegated child session: answer text, never delegate again.
      sse(res, [...answer(body, 'child done'), usageFrame(body)])
      return
    }
    const phase = (phases.get(session) ?? 0) + 1
    phases.set(session, phase)

    if (allText.includes('HINT_E2E_OVERFLOW')) overflowSessions.add(session)
    if (overflowSessions.has(session)) {
      // One probe, then a provider context-window error for the retried step:
      // the harness summarizes (auxiliary, hint-free) and retries it.
      if (phase === 1) {
        sse(res, [...toolCall(body, 'probe-overflow', 'e2e_probe', { message: 'X'.repeat(2_000) }), usageFrame(body)])
        return
      }
      if (phase === 2) {
        res.writeHead(400, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { message: "This model's maximum context length is 128000 tokens." } }))
        return
      }
      if (phase === 3) {
        sse(res, [...toolCall(body, 'probe-after-compaction', 'e2e_probe', { message: 'after-compaction' }), usageFrame(body)])
        return
      }
      sse(res, [...answer(body, 'done'), usageFrame(body)])
      return
    }

    if (allText.includes('E2E_DELEGATE')) {
      // Probe first, then a background child; its request arrives while the
      // parent is idle, which is exactly the pause trigger.
      if (phase === 1) {
        sse(res, [...toolCall(body, 'probe-delegate', 'e2e_probe', { message: 'probe' }), usageFrame(body)])
        return
      }
      if (phase === 2) {
        sse(res, [...toolCall(body, 'delegate-1', 'subagent', {
          description: 'probe child', prompt: 'E2E_CHILD Reply with the single word child.',
          run_in_background: true,
        }), usageFrame(body)])
        return
      }
      sse(res, [...answer(body, 'done'), usageFrame(body)])
      return
    }

    // Probe mode: one probe round trip per `E2E_PROBE` user message, which keeps
    // adopted sessions working across headless runs.
    const prompts = messages.filter(message => message.role === 'user' && contentOf(message).includes('E2E_PROBE')).length
    const results = messages.filter(message => message.role === 'tool').length
    if (prompts > results) {
      sse(res, [...toolCall(body, `probe-${results + 1}`, 'e2e_probe', { message: 'probe' }), usageFrame(body)])
      return
    }
    sse(res, [...answer(body, 'done'), usageFrame(body)])
  })
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  if (portFile !== undefined) fs.writeFileSync(portFile, String(actual))
  console.log(`mock upstream listening on http://127.0.0.1:${actual}`)
})
