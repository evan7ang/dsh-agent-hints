#!/usr/bin/env node
// Keyless wire-capture stub for the official DeepSeek chat-completions route:
// records every received request body, then replays a scripted two-phase turn
// (tool call on the e2e probe tool registered by e2e/fixture-tool.mjs, final
// text after the tool result arrives). Plain Node, zero dependencies — the
// harness-side counterpart of packages/llm/llm-deepseek/tests/mock-server.ts.
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

    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const hasToolResult = Array.isArray(body.messages) && body.messages.some(message => message?.role === 'tool')
    if (!hasToolResult) {
      // Phase 1: request the SOP product's tool.
      sse([
        '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
        '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"hint-e2e-call-1","type":"function","function":{"name":"e2e_probe","arguments":""}}]}}]}',
        `{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":${JSON.stringify(JSON.stringify({ message: 'START' }))}}}]}}]}`,
        '{"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":9,"completion_tokens":2}}',
        '[DONE]',
      ])
      return
    }
    // Phase 2: tool result present — produce the final answer.
    sse([
      '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
      '{"choices":[{"delta":{"content":"AGENT_HINTS_E2E_FINAL: wire capture complete."}}]}',
      '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":20,"completion_tokens":6}}',
      '[DONE]',
    ])
  })
})

server.listen(listenPort, '127.0.0.1', () => {
  const { port } = server.address()
  const portFile = arg('port-file')
  if (portFile !== undefined) writeFileSync(portFile, String(port))
  console.log(`stub-server: listening on 127.0.0.1:${port}`)
})
