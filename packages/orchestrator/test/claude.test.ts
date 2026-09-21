import { execFileSync, spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSchema } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { type FakeAnthropic, startFakeAnthropic } from '../../../test/fixtures/fake-anthropic.ts'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { orchestratorExtensions } from '../src/extensions.ts'
import { Orchestrator } from '../src/orchestrator.ts'
import { ToolHost } from '../src/tool-host.ts'

// The thing you talk to, running in Claude Code instead of pi.
//
// The same Orchestrator, the same tools and the same signals — only the
// harness underneath differs, which is the whole claim the harness port
// makes. It runs the real `claude` against a scripted model on this machine,
// with an account made for the test: no network, no sign-in, nothing of
// anybody's own touched.

const installed = (() => {
  try {
    execFileSync('claude', ['--version'], { stdio: 'pipe', timeout: 10_000 })
    return true
  } catch {
    return false
  }
})()

/** Processes whose command line carries this mark, by pid. */
function running(mark: string): number[] {
  const listed = execFileSync('ps', ['-ax', '-o', 'pid=,command='], { encoding: 'utf8' })
  return listed
    .split('\n')
    .filter((line) => line.includes(mark) && !line.includes(' ps -ax'))
    .map((line) => Number(line.trim().split(/\s+/)[0]))
    .filter((pid) => Number.isInteger(pid))
}

async function until(check: () => boolean, timeout = 45_000): Promise<void> {
  const deadline = Date.now() + timeout
  while (!check()) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
}

describe.runIf(installed)('the orchestrator in Claude Code', () => {
  let home: string
  let account: string
  let repo: ReturnType<typeof mkrepo>
  let tade: Workbench
  let tools: ToolHost
  let model: FakeAnthropic | null = null
  let orchestrator: Orchestrator | null = null

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-claude-chat-')
    account = tmp('tade-claude-chat-acct-')
    writeFileSync(join(account, 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo sk-fake' }))
    writeFileSync(join(account, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true }))
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    tade = await Workbench.open({ home })
    tools = await ToolHost.listen({ tade, path: join(home, 'tools.sock') })
  })

  afterEach(async () => {
    await orchestrator?.stop().catch(() => {})
    await model?.close()
    await tools.close().catch(() => {})
    await tade.close().catch(() => {})
    orchestrator = null
    model = null
  })

  const start = async (options: Parameters<typeof startFakeAnthropic>[0] = {}) => {
    model = await startFakeAnthropic(options)
    orchestrator = await Orchestrator.start({
      home,
      socket: tools.path,
      runDir: tmp('tcc-chat-'),
      cwd: repo.root,
      config: ConfigSchema.parse({
        orchestrator: { harness: 'claude-code', model: 'haiku' },
        projects: { app: { root: repo.root } },
      }),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: account,
        ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
    })
    return orchestrator
  }

  it('answers in the same words the window draws for pi', async () => {
    const said: string[] = []
    const deltas: string[] = []
    let idle = false
    const chat = await start({ finalText: 'Two agents are working.' })
    chat.onMessage((text) => said.push(text))
    chat.onEvent((event) => {
      if (event.type === 'delta') deltas.push(event.text)
    })
    chat.onIdle(() => {
      idle = true
    })

    await chat.ask('where do things stand?')
    await until(() => idle)
    expect(said.join(' ')).toContain('Two agents are working.')
    // Drawn as it is written, not only when it is done.
    expect(deltas.join('')).toContain('Two agents')
    expect(await chat.model()).toMatchObject({ id: expect.stringContaining('haiku') })
  }, 120_000)

  it("calls Tade's own tools, which answer from the window", async () => {
    const tools: string[] = []
    let idle = false
    const chat = await start({
      tool: { name: 'mcp__tade__tade_status', input: {} },
      finalText: 'Nothing is running.',
    })
    chat.onTool((tool) => tools.push(tool))
    chat.onIdle(() => {
      idle = true
    })

    await chat.ask('what is running?')
    await until(() => idle, 90_000)
    // Its own name, not the harness's way of spelling it.
    expect(tools).toContain('tade_status')
  }, 120_000)

  it("is offered an extension's tool, and calling it reaches the extension", async () => {
    // Tade's own tools and the extensions' are one list, handed to whichever
    // harness it runs in. Claude Code takes them as a server it starts, and
    // what that server is told is the written file's to say — so this is the
    // one place the two harnesses could quietly differ.
    const asked: string[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          tools: [
            {
              name: 'weather_now',
              description: 'Is it raining where a project lives.',
              parameters: { type: 'object', properties: { project: { type: 'string' } } },
              for: ['orchestrator'],
              run: async (input) => {
                asked.push(String(input.project))
                return { text: `Raining over ${String(input.project)}.` }
              },
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await tools.close()
    tools = await ToolHost.listen({
      tade,
      path: join(home, 'tools.sock'),
      extensions: async (call) =>
        (
          await extensions.call(call.tool, call.input, {
            caller: { kind: 'orchestrator' },
            id: call.callId,
          })
        ).text,
    })
    let idle = false
    model = await startFakeAnthropic({
      tool: { name: 'mcp__tade__weather_now', input: { project: 'app' } },
      finalText: 'Hold the deploy.',
    })
    orchestrator = await Orchestrator.start({
      home,
      socket: tools.path,
      runDir: tmp('tcc-chat-'),
      cwd: repo.root,
      config: ConfigSchema.parse({
        orchestrator: { harness: 'claude-code', model: 'haiku' },
        projects: { app: { root: repo.root } },
      }),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: account,
        ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      extensions: orchestratorExtensions(extensions, home, 'claude-code'),
    })
    orchestrator.onIdle(() => {
      idle = true
    })

    await orchestrator.ask('can we deploy app?')
    await until(() => idle && asked.length > 0, 90_000)
    // Offered: it is in the list the model was handed, beside Tade's own.
    const offered = (model.requests.find((request) => Array.isArray(request.tools))?.tools ??
      []) as Array<{ name?: string }>
    expect(offered.map((tool) => tool.name)).toEqual(
      expect.arrayContaining(['mcp__tade__tade_status', 'mcp__tade__weather_now']),
    )
    // And run where it lives, which is the window, not the agent.
    expect(asked).toEqual(['app'])
  }, 120_000)

  it('says what each of its turns cost, so the window can show it', async () => {
    const spent: Array<{ tokens: number; usd: number; model: string | null }> = []
    let idle = false
    model = await startFakeAnthropic({})
    orchestrator = await Orchestrator.start({
      home,
      socket: tools.path,
      runDir: tmp('tcc-chat-'),
      cwd: repo.root,
      config: ConfigSchema.parse({
        orchestrator: { harness: 'claude-code', model: 'haiku' },
        projects: { app: { root: repo.root } },
      }),
      env: {
        ...process.env,
        CLAUDE_CONFIG_DIR: account,
        ANTHROPIC_BASE_URL: model.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      },
      onUsage: (usage) => spent.push(usage),
    })
    orchestrator.onIdle(() => {
      idle = true
    })
    await orchestrator.ask('hello')
    await until(() => idle)
    await until(() => spent.length > 0)
    expect(spent[0]?.tokens).toBeGreaterThan(0)
    expect(spent[0]?.model).toContain('haiku')
  }, 120_000)

  it('does not outlive Tade, even when Tade is killed outright', async () => {
    const mark = `tade-orphan-${process.pid}-${Date.now()}`
    const runDir = tmp('tcc-orphan-')
    const script = join(runDir, 'parent.ts')
    // A stand-in for Tade: it starts the orchestrator in Claude Code and then
    // sits there, as a window does. Nothing of its own runs after a SIGKILL.
    writeFileSync(
      script,
      [
        `import { ClaudeAdapter } from '${fileURLToPath(new URL('../../harnesses/claude/src/adapter.ts', import.meta.url))}'`,
        `const adapter = new ClaudeAdapter({ runDir: '${runDir}', configDir: '${account}', args: ['--append-system-prompt', '${mark}'] })`,
        `await adapter.start({ run: 'orchestrator', task: 'tade/${mark}', cwd: '${repo.root}', prompt: '' })`,
        `setInterval(() => {}, 1000)`,
      ].join('\n'),
    )
    const parent = spawn(process.execPath, [script], { stdio: 'ignore' })
    try {
      await until(() => running(mark).length > 0, 30_000)
      process.kill(parent.pid ?? 0, 'SIGKILL')
      await until(() => running(mark).length === 0, 30_000)
      expect(running(mark)).toEqual([])
    } finally {
      for (const pid of running(mark)) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // already gone
        }
      }
    }
  }, 90_000)

  it('takes the next thing said to it as its own turn, one after another', async () => {
    let done = 0
    const chat = await start({ finalText: 'a long answer' })
    chat.onIdle(() => {
      done += 1
    })
    await chat.ask('take your time')
    await until(() => done > 0)
    // Said while it was free, and said while it was busy: both answered.
    await chat.tell('and another thing')
    await until(() => done > 1, 90_000)
    expect(chat.stopped).toBeNull()
    expect(model?.requests.length).toBeGreaterThan(1)
  }, 120_000)
})
