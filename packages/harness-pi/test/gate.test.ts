import { existsSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { WorkerSignal } from '@wilco/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { PiAdapter } from '../src/adapter.ts'

// The approval gate, proven against a REAL pi agent making a REAL tool call.
//
// The model is a fake OpenAI-compatible server in this file, so the test is
// deterministic, offline and needs no credentials. This is what makes it safe
// to claim that a denied command never runs.

async function until(check: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error('timed out')
}

interface FakeModel {
  url: string
  requests: number
  close(): Promise<void>
}

/** Minimal OpenAI-completions server: one tool call, then a final answer. */
async function fakeModel(command: string): Promise<FakeModel> {
  const state = { requests: 0 }
  const server: Server = createServer((req, res) => {
    let body = ''
    req.on('data', (c) => {
      body += c
    })
    req.on('end', () => {
      state.requests++
      const first = state.requests === 1
      const chunks = first
        ? [
            {
              choices: [
                {
                  index: 0,
                  delta: {
                    role: 'assistant',
                    tool_calls: [
                      {
                        index: 0,
                        id: 'call_1',
                        type: 'function',
                        function: { name: 'bash', arguments: JSON.stringify({ command }) },
                      },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            },
            { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
          ]
        : [
            { choices: [{ index: 0, delta: { role: 'assistant', content: 'All done.' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
          ]
      const stream = /"stream"\s*:\s*true/.test(body)
      if (!stream) {
        const message = first
          ? {
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: 'call_1',
                  type: 'function',
                  function: { name: 'bash', arguments: JSON.stringify({ command }) },
                },
              ],
            }
          : { role: 'assistant', content: 'All done.' }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion',
            model: 'fake',
            choices: [{ index: 0, message, finish_reason: first ? 'tool_calls' : 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          }),
        )
        return
      }
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
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}/v1`,
    get requests() {
      return state.requests
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

/** A pi extension that registers the fake provider. */
function writeProviderExtension(dir: string): string {
  const path = join(dir, 'fake-provider.ts')
  writeFileSync(
    path,
    `export default function (pi: any) {
  pi.registerProvider('wilco-test', {
    name: 'Wilco Test',
    baseUrl: process.env.WILCO_TEST_BASE_URL,
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

describe('approval gate', () => {
  let adapter: PiAdapter | null = null
  let model: FakeModel | null = null

  beforeEach(() => {
    adapter = null
    model = null
  })

  afterEach(async () => {
    await adapter?.shutdown()
    await model?.close()
  })

  it('holds a tool call until Wilco decides, and a denial never runs it', async () => {
    const runDir = tmp('wilco-gate-')
    const cwd = tmp('wilco-gate-work-')
    const marker = join(cwd, 'the-command-ran')
    model = await fakeModel(`touch ${marker}`)

    adapter = new PiAdapter({
      runDir,
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
    })

    const signals: WorkerSignal[] = []
    adapter.onSignal('gate', (s) => signals.push(s))
    await adapter.start({
      run: 'gate',
      task: 'app/gate',
      cwd,
      prompt: 'run the command',
      model: { provider: 'wilco-test', id: 'fake' },
    })

    // The agent asks before running anything.
    await until(() => signals.some((s) => s.type === 'permission_request'))
    const request = signals.find((s) => s.type === 'permission_request')
    expect(request).toBeDefined()
    if (request?.type !== 'permission_request') throw new Error('unreachable')
    expect(request.tool).toBe('bash')
    // The summary carries the exact command, which is what gets read back.
    expect(request.summary).toContain(`touch ${marker}`)

    // It is still held: nothing has run while we think about it.
    expect(existsSync(marker)).toBe(false)

    await adapter.decide('gate', request.requestId, { allow: false, reason: 'not in a test' })

    await until(() => signals.some((s) => s.type === 'turn_done' || s.type === 'idle'))
    expect(existsSync(marker)).toBe(false)
    // The agent really did reach the model: this is not a vacuous pass.
    expect(model.requests).toBeGreaterThanOrEqual(1)
  }, 90_000)

  // Without this, the test above would also pass if the gate simply blocked
  // everything. Proving that "allow" runs the command is what gives "deny" its
  // meaning.
  it('runs the command when Wilco allows it', async () => {
    const runDir = tmp('wilco-gate-')
    const cwd = tmp('wilco-gate-work-')
    const marker = join(cwd, 'the-command-ran')
    model = await fakeModel(`touch ${marker}`)

    adapter = new PiAdapter({
      runDir,
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
    })

    const signals: WorkerSignal[] = []
    adapter.onSignal('gate-allow', (s) => signals.push(s))
    await adapter.start({
      run: 'gate-allow',
      task: 'app/gate',
      cwd,
      prompt: 'run the command',
      model: { provider: 'wilco-test', id: 'fake' },
    })

    await until(() => signals.some((s) => s.type === 'permission_request'))
    const request = signals.find((s) => s.type === 'permission_request')
    if (request?.type !== 'permission_request') throw new Error('unreachable')
    expect(existsSync(marker)).toBe(false)

    await adapter.decide('gate-allow', request.requestId, { allow: true })
    await until(() => existsSync(marker))
    expect(existsSync(marker)).toBe(true)
  }, 90_000)
})
