import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from '@tade/drivers-core/conformance'
import type { WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it } from 'vitest'
import { type FakeModel, startFakeModel } from '../../../../test/fixtures/fake-model.ts'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { GrokAdapter } from '../src/adapter.ts'

// Grok as the thing you talk to: headless, a `grok -p` per turn on one
// session, against a scripted model and an account folder made for the test.
// It is what says the orchestrator can run on Grok — its words arrive, a turn
// ends, the next is the same conversation, and the tool server it is handed
// is the one it calls.

const grok = (() => {
  try {
    execFileSync('grok', ['--version'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

const own = (request: Record<string, unknown>) =>
  Array.isArray(request.tools) && request.tools.length > 5

/** A tool server with one tool, `ping`, which answers `pong`: what the orchestrator's stands in for. */
function pingServer(dir: string): string {
  const server = join(dir, 'ping.mjs')
  writeFileSync(
    server,
    `import { createInterface } from 'node:readline'
const send = (m) => process.stdout.write(JSON.stringify(m) + '\\n')
createInterface({ input: process.stdin }).on('line', (line) => {
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'ping', version: '1' } } })
  else if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 'ping', description: 'Answers pong', inputSchema: { type: 'object', properties: {} } }] } })
  else if (m.method === 'tools/call') send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: 'pong from ' + process.env.PING_SAYS }] } })
  else if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} })
})
`,
  )
  const config = join(dir, 'tools.mcp.json')
  writeFileSync(
    config,
    JSON.stringify({
      mcpServers: {
        tools: {
          type: 'stdio',
          command: process.execPath,
          args: [server],
          env: { PING_SAYS: 'tade' },
        },
      },
    }),
  )
  return config
}

describe.runIf(grok)('Grok Build headless', () => {
  let model: FakeModel | null = null
  let adapter: GrokAdapter | null = null

  afterEach(async () => {
    await adapter?.shutdown()
    await model?.close()
  })

  it('answers over its own stream, keeps one conversation across turns, and calls the server it was handed', async () => {
    model = await startFakeModel({
      tool: { name: 'use_tool', arguments: { tool_name: 'tade__ping', tool_input: {} } },
      finalText: 'Pinged.',
      main: own,
      usage: { prompt: 900, completion: 40, cached: 100 },
    })
    const account = tmp('tade-grok-headless-')
    writeFileSync(
      join(account, 'config.toml'),
      `[models]\ndefault = "fake"\n\n[model.fake]\nmodel = "fake-model"\nbase_url = "${model.url}"\napi_key = "sk-fake"\nname = "Fake"\ncontext_window = 100000\n`,
    )
    const cwd = tmp('tade-grok-work-')
    const one = new GrokAdapter({
      runDir: tmp('tade-grok-runs-'),
      grokHome: account,
      home: tmp('tade-grok-home-'),
    })
    adapter = one
    const spec = {
      run: 'orchestrator/agent',
      task: 'tade/orchestrator',
      cwd,
      prompt: 'ping it',
      extras: { mcp: [pingServer(tmp('tade-grok-tools-'))], instructions: 'You are Tade.' },
    }
    const signals: WorkerSignal[] = []
    one.onSignal(spec.run, (signal) => signals.push(signal))
    const failing = (err: unknown) => {
      throw new Error(`${(err as Error).message}\n${JSON.stringify(signals)}`)
    }
    await one.start(spec)
    expect(signals[0]).toMatchObject({ type: 'started' })
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 60_000 }).catch(
      failing,
    )
    expect(signals.find((s) => s.type === 'tool_call')).toMatchObject({ tool: 'ping' })
    expect(signals.find((s) => s.type === 'tool_result')).toMatchObject({ ok: true })
    expect(signals.find((s) => s.type === 'message')).toMatchObject({ text: 'Pinged.' })
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'ok' })
    expect(signals.find((s) => s.type === 'usage')).toMatchObject({
      input: 1600,
      cacheRead: 200,
      output: 80,
    })
    expect(signals.at(-1)).toMatchObject({ type: 'idle' })
    // What the tool answered reached the model, from the server it was handed.
    expect(JSON.stringify(model.requests)).toContain('pong from tade')
    // Its instructions are appended to Grok's own.
    expect(JSON.stringify(model.requests.filter(own)[0])).toContain('You are Tade.')

    signals.length = 0
    await one.prompt(spec.run, 'and again')
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 60_000 }).catch(
      failing,
    )
    // The same conversation: the last request carries the first turn's words.
    const last = JSON.stringify(model.requests.filter(own).at(-1))
    expect(last).toContain('ping it')
    expect(last).toContain('and again')
    expect(await one.hasConversation(spec.task, cwd)).toBe(true)
  }, 180_000)

  it('says why when a turn could not run: an account not signed in, and a model it does not have', async () => {
    const unsigned = new GrokAdapter({
      runDir: tmp('tade-grok-runs-'),
      grokHome: tmp('tade-grok-headless-'),
      home: tmp('tade-grok-home-'),
    })
    adapter = unsigned
    const spec = {
      run: 'orchestrator/agent',
      task: 'tade/unsigned',
      cwd: tmp('tade-grok-work-'),
      prompt: 'hello',
    }
    const signals: WorkerSignal[] = []
    unsigned.onSignal(spec.run, (signal) => signals.push(signal))
    await unsigned.start(spec)
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 60_000 })
    expect(signals.find((s) => s.type === 'turn_done')).toMatchObject({ status: 'error' })
    const why = signals.find((s) => s.type === 'failed')
    expect(why && 'error' in why ? why.error : '').toMatch(/grok login|XAI_API_KEY/)
    await unsigned.shutdown()

    model = await startFakeModel({ main: own })
    const account = tmp('tade-grok-headless-')
    writeFileSync(
      join(account, 'config.toml'),
      `[models]\ndefault = "fake"\n\n[model.fake]\nmodel = "fake-model"\nbase_url = "${model.url}"\napi_key = "sk-fake"\n`,
    )
    const one = new GrokAdapter({
      runDir: tmp('tade-grok-runs-'),
      grokHome: account,
      home: tmp('tade-grok-home-'),
    })
    adapter = one
    const named = {
      ...spec,
      task: 'tade/no-model',
      model: { provider: 'xai', id: 'no-such-model' },
    }
    signals.length = 0
    one.onSignal(named.run, (signal) => signals.push(signal))
    await one.start(named)
    await until(() => signals.some((s) => s.type === 'turn_done'), { timeout: 60_000 })
    const failed = signals.find((s) => s.type === 'failed')
    expect(failed && 'error' in failed ? failed.error : '').toContain('no-such-model')
  }, 90_000)
})
