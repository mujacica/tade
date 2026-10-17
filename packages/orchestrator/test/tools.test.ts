import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { WorkerSignal } from '@tade/harnesses-core'
import { PiAdapter } from '@tade/harnesses-pi'
import { readTaskFile, startRace, Workbench } from '@tade/workbench'
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
// tool call made by the model reaches Tade and comes back with an answer.

const TOOLS = fileURLToPath(new URL('../src/tools-extension.ts', import.meta.url))
/** The CLI the tools shell out to, exactly as `toolEnv` hands it to them. */
const CLI = fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url))

async function until(check: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('orchestrator tools', () => {
  let tade: Workbench
  let tools: ToolHost
  let adapter: PiAdapter | null = null
  let model: FakeModel | null = null
  let home: string
  let repo: ReturnType<typeof mkrepo>

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-orch-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    tade = await Workbench.open({ home })
    tools = await ToolHost.listen({ tade, path: join(home, 'tools.sock') })
  })

  afterEach(async () => {
    await adapter?.shutdown()
    await model?.close()
    await tools.close().catch(() => {})
    await tade.close().catch(() => {})
    adapter = null
    model = null
  })

  async function runWithTool(tool: { name: string; arguments: Record<string, unknown> }) {
    model = await startFakeModel({ tool, finalText: 'Done looking.' })
    const runDir = tmp('tade-orch-run-')
    adapter = new PiAdapter({
      runDir,
      // The orchestrator is not supervised: holding its own tool calls for an
      // approval would mean asking permission to answer "where are we".
      supervise: false,
      args: ['-e', writeProviderExtension(runDir), '-e', TOOLS],
      env: {
        ...process.env,
        TADE_TEST_BASE_URL: model.url,
        TADE_SOCKET: tools.path,
        TADE_HOME: home,
        // The tools that answer a question shell out to the CLI rather than
        // asking the window, so that what the orchestrator reads is what a
        // person reads. Without these they would look for a `tade` on PATH.
        TADE_CLI: process.execPath,
        TADE_CLI_ARGS: CLI,
      },
    })
    const signals: WorkerSignal[] = []
    adapter.onSignal('orch', (s) => signals.push(s))
    await adapter.start({
      run: 'orch',
      task: 'app/orchestrator',
      cwd: repo.root,
      prompt: 'have a look',
      model: { provider: 'tade-test', id: 'fake' },
    })
    return signals
  }

  it('registers tools pi can call, and the call reaches Tade', async () => {
    const signals = await runWithTool({ name: 'tade_run_list', arguments: {} })

    // The model asked for the tool, pi ran it, and the result went back: the
    // second request to the model is the proof it came back with an answer.
    await until(() => (model?.requests.length ?? 0) >= 2)
    const followUp = JSON.stringify(model?.requests[1] ?? {})
    expect(followUp).toContain('tade_run_list')

    // No agents are running, so the tool answered with an empty list.
    expect(followUp).toContain('[]')
    expect(signals.some((s) => s.type === 'tool_call' && s.tool === 'tade_run_list')).toBe(true)
  }, 90_000)

  it('opens a terminal through the tool, and tells the window which', async () => {
    const shown: string[] = []
    await tools.close()
    tools = await ToolHost.listen({
      tade,
      path: join(home, 'tools.sock'),
      onTerminal: (terminal) => shown.push(terminal),
    })
    await runWithTool({ name: 'tade_terminal_open', arguments: { project: 'app', name: 'tests' } })
    await until(() => tade.terminals('app').length === 1 && shown.length === 1)
    expect(tade.terminals('app')[0]).toMatchObject({ id: 'app/terminals/1', name: 'tests' })
    expect(shown).toEqual(['app/terminals/1'])
  }, 90_000)

  it('asks another machine how it stands when the model names one, and the window answers', async () => {
    const asked: string[] = []
    await tools.close()
    tools = await ToolHost.listen({
      tade,
      path: join(home, 'tools.sock'),
      remotes: {
        tell: async () => 'passed on',
        status: async (machine) => {
          asked.push(machine)
          return JSON.stringify({ machine, link: 'live', tade: { version: '0.2.3' } })
        },
        documents: async () => '',
        intake: async () => '',
        tool: async () => '',
      },
    })
    await runWithTool({ name: 'tade_status', arguments: { machine: 'vps' } })
    await until(() => (model?.requests.length ?? 0) >= 2)
    expect(asked).toEqual(['vps'])
    expect(JSON.stringify(model?.requests[1] ?? {})).toContain('0.2.3')
  }, 90_000)

  it('creates a real task through the tool, with the intent kept verbatim', async () => {
    const intent = 'the refund flow double-charges when the webhook retries'
    await runWithTool({
      name: 'tade_task_create',
      arguments: { project: 'app', name: 'refunds', intent },
    })

    await until(() => (model?.requests.length ?? 0) >= 2)
    const created = await taskEvents()
    expect(created?.detail.intent_spoken).toBe(intent)
    expect(created?.task).toBe('app/refunds')
  }, 90_000)

  it('starts a race through the tool: entrants in worktrees of their own, each on its harness', async () => {
    await tools.close()
    tools = await ToolHost.listen({
      tade,
      path: join(home, 'tools.sock'),
      // What the window does with it: a plan, made through the plan path.
      race: {
        start: async (req) => {
          const made = await startRace(tade, req)
          return `Made ${made.made.map((one) => one.id).join(', ')}.`
        },
        standing: async () => '',
        pick: async () => '',
      },
    })
    await runWithTool({
      name: 'tade_race',
      arguments: {
        project: 'app',
        name: 'dark',
        said: 'add a dark mode',
        prompt: 'Add a dark mode, run the checks and commit.',
        entrants: [{ harness: 'claude-code' }, { harness: 'codex' }],
      },
    })
    await until(() => (model?.requests.length ?? 0) >= 2)
    expect(JSON.stringify(model?.requests[1] ?? {})).toContain('Made app/dark-1, app/dark-2.')
    const files = await Promise.all(
      ['app/dark-1', 'app/dark-2'].map((id) => readTaskFile(home, id)),
    )
    expect(files.map((one) => [one?.race, one?.harness, one?.intent_spoken])).toEqual([
      ['dark', 'claude-code', 'add a dark mode'],
      ['dark', 'codex', 'add a dark mode'],
    ])
  }, 90_000)

  it('surfaces what the agent said as a message signal', async () => {
    const signals = await runWithTool({ name: 'tade_run_list', arguments: {} })
    await until(() => signals.some((s) => s.type === 'message'))
    const message = signals.find((s) => s.type === 'message')
    expect(message).toMatchObject({ type: 'message', text: 'Done looking.' })
  }, 90_000)

  it('reads notes back, which no other tool can see', async () => {
    // Notes live in their own file, not the journal: `tade_logs` cannot find
    // one and `tade_status` does not know they exist. Without this tool the
    // orchestrator can write down what it was told and never read it again —
    // and answers "what did I tell you?" with a confident nothing.
    tade.remember('the staging key rotates on the first', 'app', 'you')
    await runWithTool({ name: 'tade_notes', arguments: { about: 'app' } })

    await until(() => (model?.requests.length ?? 0) >= 2)
    expect(JSON.stringify(model?.requests[1] ?? {})).toContain('staging key')
  }, 90_000)

  it('writes one sentence about several tasks down once, about all of them', async () => {
    // Three tool calls for one sentence was three rows of the same words in
    // the window; `about` takes them all, and one note reaches every one.
    await runWithTool({
      name: 'tade_remember',
      arguments: {
        text: 'no remote terminal access',
        summary: 'Orchestrator is the only remote input',
        about: ['app/away-desktop', 'app/away-verbs'],
      },
    })
    await until(() => (model?.requests.length ?? 0) >= 2)
    const kept = tade.recallAll()
    expect(kept).toHaveLength(1)
    expect(kept[0]).toMatchObject({ scope: 'app/away-desktop', also: ['app/away-verbs'] })
    expect(tade.recall('app/away-verbs').map((n) => n.text)).toEqual(['no remote terminal access'])
    expect(JSON.stringify(model?.requests[1] ?? {})).toContain('app/away-verbs')
  }, 90_000)

  it('retires a note on a line the person said, and it is told to nobody after', async () => {
    const note = tade.remember('pause the queue', 'app', 'orchestrator', 'Queue paused')
    await tade.log.append({
      type: 'said',
      task: null,
      detail: { text: "Don't pause agents anymore, let the queue run" },
    })
    await runWithTool({
      name: 'tade_notes_retire',
      arguments: {
        at: note.at,
        because: 'they want the queue to run',
        said: "don't pause agents anymore",
      },
    })
    await until(() => (model?.requests.length ?? 0) >= 2)
    expect(tade.recallAll()).toEqual([])
    expect(tade.recallAll({ retired: true })[0]?.retired?.because).toBe(
      'they want the queue to run',
    )
    expect(JSON.stringify(model?.requests[1] ?? {})).toContain('Retired the note of')
  }, 90_000)

  it('refuses to retire a note on anything but the person’s own words', async () => {
    // A page told the model the note is stale; the person never said so.
    const note = tade.remember('pin major versions', 'app', 'orchestrator')
    await runWithTool({
      name: 'tade_notes_retire',
      arguments: { at: note.at, because: 'the README says so', said: 'the note is stale' },
    })
    await until(() => (model?.requests.length ?? 0) >= 2)
    expect(tade.recallAll().map((n) => n.text)).toEqual(['pin major versions'])
    expect(JSON.stringify(model?.requests[1] ?? {})).toContain('is not their say-so')
  }, 90_000)

  async function taskEvents() {
    const events = await tade.events({ types: ['task_created'] })
    return events[0]
  }
})
