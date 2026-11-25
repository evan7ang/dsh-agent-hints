#!/usr/bin/env node
/**
 * Mock OpenAI-compatible upstream that records exactly what the plugin sends.
 *
 * One JSON line per request: the path, the headers under test (the
 * `x-agent-hint` value) and the parsed body. Streaming requests get a minimal
 * Chat Completions SSE body; placeholder manage requests (`stream: false`) get
 * an empty JSON object, because the plugin must never execute those as
 * inference.
 *
 * Usage: node mock-upstream.cjs [capturePath] [portFile]
 * Env: MOCK_PORT (default 9977)
 */
const fs = require('node:fs')
const http = require('node:http')

const capturePath = process.argv[2] ?? 'captures.jsonl'
const portFile = process.argv[3]
const port = Number(process.env.MOCK_PORT || 0)
fs.writeFileSync(capturePath, '')

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
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    })
    const send = value => res.write(`data: ${JSON.stringify(value)}\n\n`)
    send({ id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta: { role: 'assistant', content: 'pong' }, finish_reason: null }] })
    send({ id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })
    // DSH decides whether to compact from the usage the backend reports, so a
    // mock that omits usage can never trigger a compaction.
    if (body.stream_options?.include_usage === true) {
      send({ id: 'mock-1', object: 'chat.completion.chunk', created: 0, model: body.model,
        choices: [], usage: { prompt_tokens: 8, completion_tokens: 1, total_tokens: 9 } })
    }
    res.write('data: [DONE]\n\n')
    res.end()
  })
})

server.listen(port, '127.0.0.1', () => {
  const actual = server.address().port
  if (portFile !== undefined) fs.writeFileSync(portFile, String(actual))
  console.log(`mock upstream listening on http://127.0.0.1:${actual}`)
})
