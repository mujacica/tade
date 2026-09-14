import { existsSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'
import type { WorkerSignal } from '@wilco/harnesses-core'
import { spawn as openPty } from 'node-pty'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { EXTENSION_PATH, PiAdapter } from '../src/adapter.ts'

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

/**
 * What the fake model says every answer used: mostly its cache read back, as
 * a long session's answers are.
 */
const REPORTED = {
  prompt_tokens: 1_000,
  completion_tokens: 100,
  total_tokens: 1_100,
  prompt_tokens_details: { cached_tokens: 800 },
}
/** The fake model's prices, in dollars per million tokens. */
const PRICES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }

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
            { choices: [], usage: REPORTED },
          ]
        : [
            { choices: [{ index: 0, delta: { role: 'assistant', content: 'All done.' } }] },
            { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
            { choices: [], usage: REPORTED },
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
            usage: REPORTED,
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
        id: 'thinker',
        name: 'Thinker',
        reasoning: true,
        input: ['text'],
        cost: ${JSON.stringify(PRICES)},
        contextWindow: 128000,
        maxTokens: 4096,
      },
      {
        id: 'fake',
        name: 'Fake',
        reasoning: false,
        input: ['text'],
        cost: ${JSON.stringify(PRICES)},
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
      // The gate only exists under `policy`: with approvals off nothing is
      // ever held, which is the default and is tested below.
      approvals: 'policy',
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
      // The gate only exists under `policy`: with approvals off nothing is
      // ever held, which is the default and is tested below.
      approvals: 'policy',
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

  // The default, and the case that matters under a driver whose lanes outlive
  // the window: nobody is listening, and the agent has to work anyway.
  it('never holds anything with approvals off, even with nowhere to ask', async () => {
    const runDir = tmp('wilco-gate-')
    const cwd = tmp('wilco-gate-work-')
    const marker = join(cwd, 'the-command-ran')
    model = await fakeModel(`touch ${marker}`)

    adapter = new PiAdapter({
      runDir,
      // Not supervised at all: there is no socket to reach, exactly as when
      // Wilco has been closed and the agent is still running in tmux.
      supervise: false,
      args: ['-e', writeProviderExtension(runDir), '-e', EXTENSION_PATH],
      env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
    })

    await adapter.start({
      run: 'gate-bypass',
      task: 'app/gate',
      cwd,
      prompt: 'run the command',
      model: { provider: 'wilco-test', id: 'fake' },
    })

    // It ran. Losing Wilco costs the journal an entry, never the work.
    await until(() => existsSync(marker))
    expect(existsSync(marker)).toBe(true)
  }, 90_000)

  // A long task outlives the window under a driver whose lanes do, so Wilco
  // going away and coming back is ordinary. Without reconnection the agent
  // runs on reporting to nobody — and under `policy`, a gate with nothing at
  // the other end refuses everything it is asked.
  it('finds Wilco again after the window that started it went away', async () => {
    const runDir = tmp('wilco-gate-')
    const cwd = tmp('wilco-gate-work-')
    const marker = join(cwd, 'the-command-ran')
    model = await fakeModel(`touch ${marker}`)

    const make = () =>
      new PiAdapter({
        runDir,
        approvals: 'policy',
        args: ['-e', writeProviderExtension(runDir)],
        env: { ...process.env, WILCO_TEST_BASE_URL: model?.url ?? '' },
      })

    // The window that starts it, then goes away without stopping the agent.
    adapter = make()
    const first: WorkerSignal[] = []
    adapter.onSignal('gate-reconnect', (s) => first.push(s))
    const launch = adapter.launchSpec({
      run: 'gate-reconnect',
      task: 'app/gate',
      cwd,
      prompt: '',
    })
    await adapter.supervise({ run: 'gate-reconnect', task: 'app/gate', cwd, prompt: '' })

    // In a real terminal, because that is where an agent lives: pi renders its
    // own interface, and without a tty it has nothing to draw to and exits.
    const agent = openPty(launch.command, launch.args, {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd,
      env: launch.env as Record<string, string>,
    })
    let alive = true
    agent.onExit(() => {
      alive = false
    })
    try {
      await until(() => first.some((s) => s.type === 'started'))
      // The window closes. The socket goes with it; the agent does not — so
      // this detaches rather than shutting down, which is what closing a
      // window does everywhere else too.
      await adapter.detach()
      adapter = null

      // A new window, same run, same derived socket path.
      const reopened = make()
      adapter = reopened
      const second: WorkerSignal[] = []
      reopened.onSignal('gate-reconnect', (s) => second.push(s))
      await reopened.supervise({ run: 'gate-reconnect', task: 'app/gate', cwd, prompt: '' })

      // It dialled back on its own: nobody told it where to look.
      await until(() => {
        if (!alive) throw new Error('the agent exited, so there was nothing to reconnect')
        return second.some((s) => s.type === 'started')
      }, 30_000)
    } finally {
      agent.kill()
    }
  }, 90_000)
})

// How hard it thinks, told to a REAL pi and read back from what it took.
describe('how hard it thinks', () => {
  let adapter: PiAdapter | null = null
  let model: FakeModel | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    await model?.close()
    adapter = null
    model = null
  })

  it('takes a level told over its channel, and says the one it settled on', async () => {
    const runDir = tmp('wilco-think-')
    model = await fakeModel('true')
    adapter = new PiAdapter({
      runDir,
      approvals: 'bypass',
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('think', (s) => signals.push(s))
    await adapter.start({
      run: 'think',
      task: 'app/think',
      cwd: tmp('wilco-think-work-'),
      prompt: '',
      model: { provider: 'wilco-test', id: 'thinker' },
      thinking: 'low',
    })
    const said = (level: string) =>
      signals.some((one) => one.type === 'started' && one.thinking === level)
    // Asked while loading, pi throws, and a throw there once took the agent down with it.
    const failed = () => signals.find((one) => one.type === 'failed')
    // Started at the level it was given…
    await until(() => said('low') || failed() !== undefined)
    expect(failed()).toBeUndefined()
    // …and moved when told, for this session.
    await adapter.setThinking('think', 'high')
    await until(() => said('high'))
  }, 90_000)
})

// What a turn cost, proven against a REAL pi pricing a REAL session.
//
// A person reads what an agent spent in two places — pi's footer, and Wilco's
// Spend panel — and the two must agree. A count checked only against a session
// file written by hand agrees with whoever wrote the file.
describe('what a turn costs', () => {
  let adapter: PiAdapter | null = null
  let model: FakeModel | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    await model?.close()
    adapter = null
    model = null
  })

  /** Everything the usage signals added up to. */
  function spent(signals: readonly WorkerSignal[]) {
    const total = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: 0 }
    for (const signal of signals) {
      if (signal.type !== 'usage') continue
      total.input += signal.input
      total.output += signal.output
      total.cacheRead += signal.cacheRead
      total.cacheWrite += signal.cacheWrite
      total.tokens += signal.tokens
      total.usd += signal.usd
    }
    return total
  }

  it.each([
    ['told by the supervision extension, as an agent’s is', true],
    ['read from pi’s own events, as the orchestrator’s is', false],
  ])(
    'adds up every answer, %s',
    async (_how, supervise) => {
      const runDir = tmp('wilco-cost-')
      const cwd = tmp('wilco-cost-work-')
      const marker = join(cwd, 'the-command-ran')
      model = await fakeModel(`touch ${marker}`)

      adapter = new PiAdapter({
        runDir,
        supervise,
        approvals: 'bypass',
        args: ['-e', writeProviderExtension(runDir)],
        env: { ...process.env, WILCO_TEST_BASE_URL: model.url },
      })
      const signals: WorkerSignal[] = []
      adapter.onSignal('cost', (s) => signals.push(s))
      await adapter.start({
        run: 'cost',
        task: 'app/cost',
        cwd,
        prompt: 'run the command',
        model: { provider: 'wilco-test', id: 'fake' },
      })

      // Two answers: the tool call, and the last word after it.
      const answers = 2
      await until(() => (model?.requests ?? 0) >= answers && existsSync(marker))
      await until(() => spent(signals).tokens >= answers * REPORTED.total_tokens)

      const input = REPORTED.prompt_tokens - REPORTED.prompt_tokens_details.cached_tokens
      const cacheRead = REPORTED.prompt_tokens_details.cached_tokens
      const output = REPORTED.completion_tokens
      expect(spent(signals)).toMatchObject({
        input: answers * input,
        output: answers * output,
        cacheRead: answers * cacheRead,
        tokens: answers * REPORTED.total_tokens,
      })
      const perAnswer =
        (input * PRICES.input + output * PRICES.output + cacheRead * PRICES.cacheRead) / 1_000_000
      expect(spent(signals).usd).toBeCloseTo(answers * perAnswer, 10)
    },
    90_000,
  )
})
