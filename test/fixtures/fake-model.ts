import { writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

// A scripted OpenAI-compatible model server, so tests can drive a REAL agent
// deterministically with no network and no credentials. It answers once with a
// tool call, then with a final message.

export interface FakeModelOptions {
  /** The tool the model asks for on its first reply. Omit for a plain answer. */
  tool?: { name: string; arguments: Record<string, unknown> }
  /** What it says once the tool result comes back. */
  finalText?: string
  /** Refuse every request with this status and body, as a provider does a request it will not route. */
  refuse?: { status: number; body: unknown }
  /**
   * Awaited before answering, so a test can have a turn that is still in
   * flight: what an agent being interrupted needs, and the one thing a
   * scripted model that answers instantly can never be.
   */
  hold?: () => Promise<void>
}

export interface FakeModel {
  url: string
  /** Every request body the model received, so tests can see what it was told. */
  requests: Array<Record<string, unknown>>
  close(): Promise<void>
}

export async function startFakeModel(opts: FakeModelOptions = {}): Promise<FakeModel> {
  const requests: Array<Record<string, unknown>> = []
  const finalText = opts.finalText ?? 'All done.'

  const server: Server = createServer((req, res) => {
    let body = ''
    // A request whose caller gave up mid-answer is not this server's problem:
    // writing to it fails, and an unhandled error would take the test down.
    res.on('error', () => {})
    req.on('data', (chunk) => {
      body += chunk
    })
    req.on('end', () => {
      void answer()
    })

    async function answer(): Promise<void> {
      try {
        requests.push(JSON.parse(body) as Record<string, unknown>)
      } catch {
        requests.push({ unparseable: body })
      }
      if (opts.hold) {
        await opts.hold()
        // Whoever was waiting has gone: there is nobody to answer.
        if (res.writableEnded || res.destroyed) return
      }
      if (opts.refuse) {
        res.writeHead(opts.refuse.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(opts.refuse.body))
        return
      }
      const first = requests.length === 1 && opts.tool !== undefined
      const toolCall = opts.tool
        ? [
            {
              index: 0,
              id: 'call_1',
              type: 'function',
              function: {
                name: opts.tool.name,
                arguments: JSON.stringify(opts.tool.arguments),
              },
            },
          ]
        : []

      if (!/"stream"\s*:\s*true/.test(body)) {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            model: 'fake',
            choices: [
              {
                index: 0,
                message: first
                  ? { role: 'assistant', content: null, tool_calls: toolCall }
                  : { role: 'assistant', content: finalText },
                finish_reason: first ? 'tool_calls' : 'stop',
              },
            ],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }

      const chunks = first
        ? [
            { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: toolCall } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { choices: [{ index: 0, delta: { role: 'assistant', content: finalText } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
      for (const chunk of chunks) {
        res.write(
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            model: 'fake',
            ...chunk,
          })}\n\n`,
        )
      }
      res.write('data: [DONE]\n\n')
      res.end()
    }
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** Write a pi extension that points a provider at the fake model. */
export function writeProviderExtension(dir: string): string {
  const path = join(dir, 'fake-provider.ts')
  writeFileSync(
    path,
    `export default function (pi: any) {
  pi.registerProvider('tade-test', {
    name: 'Tade Test',
    baseUrl: process.env.TADE_TEST_BASE_URL,
    apiKey: 'test-key',
    api: 'openai-completions',
    models: [
      {
        id: 'fake',
        name: 'Fake',
        reasoning: false,
        input: ['text'],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 4096,
      },
    ],
  })
}
`,
  )
  return path
}
