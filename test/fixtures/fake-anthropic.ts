import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// A scripted Anthropic Messages server, so tests can drive a REAL Claude Code
// deterministically with no network and no credentials: point it here with
// `ANTHROPIC_BASE_URL` and give it any key through `apiKeyHelper`. The main
// conversation asks for its tools, one at a time, then answers; anything Claude Code asks on
// the side — a title, a summary — gets a short answer.

export interface FakeAnthropicOptions {
  /** The tool the model asks for on its first reply. Omit for a plain answer. */
  tool?: { name: string; input: Record<string, unknown> }
  /** Tools it asks for one after another, each once the last one's result is back. */
  tools?: Array<{ name: string; input: Record<string, unknown> }>
  /** What it says once the tool result comes back. */
  finalText?: string
}

export interface FakeAnthropic {
  url: string
  /** Every request body the model received, so tests can see what it was told. */
  requests: Array<Record<string, unknown>>
  close(): Promise<void>
}

interface Message {
  role?: string
  content?: unknown
}

/** How many tool results the conversation has had: the model asks for the next tool, or answers. */
function resultsIn(messages: readonly Message[]): number {
  return messages.reduce(
    (count, message) =>
      count +
      (Array.isArray(message.content)
        ? message.content.filter((block: { type?: unknown }) => block?.type === 'tool_result')
            .length
        : 0),
    0,
  )
}

export async function startFakeAnthropic(opts: FakeAnthropicOptions = {}): Promise<FakeAnthropic> {
  const requests: Array<Record<string, unknown>> = []
  const finalText = opts.finalText ?? 'All done.'
  const script = opts.tools ?? (opts.tool ? [opts.tool] : [])
  let n = 0

  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      if (!req.url?.startsWith('/v1/messages') || req.url.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(404, { 'content-type': 'application/json' })
        res.end('{}')
        return
      }
      let request: { model?: string; tools?: unknown[]; messages?: Message[] } = {}
      try {
        request = JSON.parse(body)
      } catch {
        // answered anyway: a test should see the failure, not a hang
      }
      requests.push(request as Record<string, unknown>)
      const main = Array.isArray(request.tools) && request.tools.length > 0
      const next = main ? script[resultsIn(request.messages ?? [])] : undefined
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      const send = (type: string, data: Record<string, unknown>) =>
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
      send('message_start', {
        message: {
          id: `msg_fake_${++n}`,
          type: 'message',
          role: 'assistant',
          model: request.model ?? 'claude-fake',
          content: [],
          stop_reason: null,
          usage: { input_tokens: 12, output_tokens: 1 },
        },
      })
      if (next) {
        send('content_block_start', {
          index: 0,
          content_block: {
            type: 'tool_use',
            id: `toolu_fake_${n}`,
            name: next.name,
            input: {},
          },
        })
        send('content_block_delta', {
          index: 0,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(next.input) },
        })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 7 } })
      } else {
        send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
        send('content_block_delta', {
          index: 0,
          delta: { type: 'text_delta', text: main ? finalText : 'A title' },
        })
        send('content_block_stop', { index: 0 })
        send('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } })
      }
      send('message_stop', {})
      res.end()
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
