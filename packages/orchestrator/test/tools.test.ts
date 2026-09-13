import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerSignal } from '@wilco/harnesses-core'
import { PiAdapter } from '@wilco/harnesses-pi'
import { Workbench } from '@wilco/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeModel,
  startFakeModel,
  writeProviderExtension,
} from '../../../test/fixtures/fake-model.ts'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost } from '../src/tool-host.ts'

// Proves the orchestrator's tools work against a REAL pi agent and a REAL
// workbench, with a scripted model standing in for the LLM. Two assumptions
// are under test: that pi accepts our plain JSON Schema parameters, and that a
// tool call made by the model reaches Wilco and comes back with an answer.

const TOOLS = fileURLToPath(new URL('../src/tools-extension.ts', import.meta.url))

async function until(check: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('orchestrator tools', () => {
  let wilco: Workbench
  let tools: ToolHost
  let adapter: PiAdapter | null = null
  let model: FakeModel | null = null
  let home: string
  let repo: ReturnType<typeof mkrepo>

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('wilco-orch-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    wilco = await Workbench.open({ home })
    tools = await ToolHost.listen({ wilco, path: join(home, 'tools.sock') })
  })

  afterEach(async () => {
    await adapter?.shutdown()
    await model?.close()
    await tools.close().catch(() => {})
    await wilco.close().catch(() => {})
    adapter = null
    model = null
  })

  async function runWithTool(tool: { name: string; arguments: Record<string, unknown> }) {
    model = await startFakeModel({ tool, finalText: 'Done looking.' })
    const runDir = tmp('wilco-orch-run-')
    adapter = new PiAdapter({
      runDir,
      // The orchestrator is not supervised: holding its own tool calls for an
      // approval would mean asking permission to answer "where are we".
      supervise: false,
      args: ['-e', writeProviderExtension(runDir), '-e', TOOLS],
      env: {
        ...process.env,
        WILCO_TEST_BASE_URL: model.url,
        WILCO_SOCKET: tools.path,
        WILCO_HOME: home,
      },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('orch', (s) => signals.push(s))
    await adapter.start({
      run: 'orch',
      task: 'app/orchestrator',
      cwd: repo.root,
      prompt: 'have a look',
      model: { provider: 'wilco-test', id: 'fake' },
    })
    return signals
  }

  it('registers tools pi can call, and the call reaches Wilco', async () => {
    const signals = await runWithTool({ name: 'wilco_run_list', arguments: {} })

    // The model asked for the tool, pi ran it, and the result went back: the
    // second request to the model is the proof it came back with an answer.
    await until(() => (model?.requests.length ?? 0) >= 2)
    const followUp = JSON.stringify(model?.requests[1] ?? {})
    expect(followUp).toContain('wilco_run_list')

    // No agents are running, so the tool answered with an empty list.
    expect(followUp).toContain('[]')
    expect(signals.some((s) => s.type === 'tool_call' && s.tool === 'wilco_run_list')).toBe(true)
  }, 90_000)

  it('opens a terminal through the tool, and tells the window which', async () => {
    const shown: string[] = []
    await tools.close()
    tools = await ToolHost.listen({
      wilco,
      path: join(home, 'tools.sock'),
      onTerminal: (terminal) => shown.push(terminal),
    })
    await runWithTool({ name: 'wilco_terminal_open', arguments: { project: 'app', name: 'tests' } })
    await until(() => wilco.terminals('app').length === 1 && shown.length === 1)
    expect(wilco.terminals('app')[0]).toMatchObject({ id: 'app/terminals/1', name: 'tests' })
    expect(shown).toEqual(['app/terminals/1'])
  }, 90_000)

  it('creates a real task through the tool, with the intent kept verbatim', async () => {
    const intent = 'the refund flow double-charges when the webhook retries'
    await runWithTool({
      name: 'wilco_task_create',
      arguments: { project: 'app', name: 'refunds', intent },
    })

    await until(() => (model?.requests.length ?? 0) >= 2)
    const created = await taskEvents()
    expect(created?.detail.intent_spoken).toBe(intent)
    expect(created?.task).toBe('app/refunds')
  }, 90_000)

  it('surfaces what the agent said as a message signal', async () => {
    const signals = await runWithTool({ name: 'wilco_run_list', arguments: {} })
    await until(() => signals.some((s) => s.type === 'message'))
    const message = signals.find((s) => s.type === 'message')
    expect(message).toMatchObject({ type: 'message', text: 'Done looking.' })
  }, 90_000)

  async function taskEvents() {
    const events = await wilco.events({ types: ['task_created'] })
    return events[0]
  }
})
