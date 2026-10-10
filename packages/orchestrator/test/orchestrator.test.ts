import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Arm, ConfigSchema, LOCAL } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  type FakeModel,
  startFakeModel,
  writeProviderExtension,
} from '../../../test/fixtures/fake-model.ts'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { orchestratorExtensions } from '../src/extensions.ts'
import { Orchestrator, type OrchestratorEvent } from '../src/orchestrator.ts'
import { ToolHost } from '../src/tool-host.ts'

// The thing you talk to, driven by a scripted model: it answers, it reaches
// for Tade's own tools, and it says when it has finished.

async function until(check: () => boolean | Promise<boolean>, timeout = 30_000): Promise<void> {
  const deadline = Date.now() + timeout
  for (;;) {
    if (await check()) return
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('Orchestrator', () => {
  let tade: Workbench
  let tools: ToolHost
  let model: FakeModel | null = null
  let orchestrator: Orchestrator | null = null
  let home: string
  let repo: ReturnType<typeof mkrepo>
  /**
   * How far the turn in flight reaches, as the window would answer it, and
   * every call the host refused because of it.
   *
   * The host is the gate — Tade's own tools extension asks it at every tool
   * call — so these two are what a test reads instead of watching for a
   * signal: `arm` is what the window would say, and `refusals` is what the
   * audit got.
   */
  let arm: Arm = LOCAL
  const refusals: { tool: string; why: string }[] = []

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-chat-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    tade = await Workbench.open({ home })
    arm = LOCAL
    refusals.length = 0
    tools = await ToolHost.listen({
      tade,
      path: join(home, 'tools.sock'),
      remote: {
        arm: () => arm,
        seen: async () => ({ tasks: [] }),
        refused: (_one, tool, why) => refusals.push({ tool, why }),
      },
    })
  })

  afterEach(async () => {
    await orchestrator?.stop()
    await model?.close()
    await tools.close().catch(() => {})
    await tade.close().catch(() => {})
    orchestrator = null
    model = null
  })

  async function start(
    options: Parameters<typeof startFakeModel>[0],
    over: Partial<Parameters<typeof Orchestrator.start>[0]> = {},
  ) {
    model = await startFakeModel(options)
    const runDir = over.runDir ?? tmp('tade-chat-run-')
    orchestrator = await Orchestrator.start({
      home,
      socket: tools.path,
      runDir,
      cwd: repo.root,
      model: { provider: 'tade-test', id: 'fake' },
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, TADE_TEST_BASE_URL: model.url },
      ...over,
    })
    return orchestrator
  }

  /** Everything the model was told on a given request, system prompt included. */
  function told(request = 0): string {
    return JSON.stringify(model?.requests[request] ?? {})
  }

  it('answers, and says when it has finished', async () => {
    const said: string[] = []
    let idle = false
    const chat = await start({ finalText: 'Nothing is running.' })
    chat.onMessage((text) => said.push(text))
    chat.onIdle(() => {
      idle = true
    })

    await chat.ask('where are we')
    await until(() => said.length > 0)
    expect(said[0]).toBe('Nothing is running.')
    // Without this a surface would never know it could speak again.
    await until(() => idle)
  }, 90_000)

  it('stops the turn it is on, and carries on the same conversation after', async () => {
    // Interrupting is not stopping. Everything about the window's escape key
    // rests on this: the process stays up, the session id does not change, and
    // the next thing you say continues where you cut it off — it is never
    // introduced again.
    let release = () => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    let holding = true
    const chat = await start({
      finalText: 'Back with you.',
      hold: async () => {
        if (holding) await held
      },
    })
    const events: OrchestratorEvent[] = []
    chat.onEvent((event) => events.push(event))

    await chat.ask('run the webhook tests')
    await until(() => (model?.requests.length ?? 0) > 0)
    await chat.interrupt()
    // It finished the turn rather than the conversation.
    await until(() => events.some((event) => event.type === 'idle'))
    expect(chat.stopped).toBeNull()
    expect(events.some((event) => event.type === 'exited')).toBe(false)
    // Cut off before it said anything, which is what was being asked for.
    expect(events.some((event) => event.type === 'message')).toBe(false)

    holding = false
    release()
    expect(await chat.askFor('and now?', 30_000)).toBe('Back with you.')
    // The same conversation: what you asked before you stopped it is still in it.
    const carried = told((model?.requests.length ?? 1) - 1)
    expect(carried).toContain('run the webhook tests')
    expect(carried).toContain('and now?')
  }, 90_000)

  it('comes back to the same conversation when Tade is closed and opened again', async () => {
    // The whole of remembering where it left off: one session id, kept for
    // ever, so the second start is a continuation and not an introduction.
    const runDir = tmp('tade-chat-run-')
    const first = await start({ finalText: 'Noted.' }, { runDir })
    expect(await first.askFor('the release is on the 14th', 30_000)).toBe('Noted.')
    await first.stop()
    await model?.close()

    const again = await start({ finalText: 'The 14th.' }, { runDir })
    expect(await again.askFor('when is the release?', 30_000)).toBe('The 14th.')
    // Not a summary of what was said: what was said.
    expect(told()).toContain('the release is on the 14th')
  }, 90_000)

  it('opens knowing where things stood, from the journal', async () => {
    // The conversation comes back on its own; the world it was about does not.
    await tade.log.append({ type: 'said', detail: { text: 'start the refunds one' } })
    await tade.log.append({ type: 'task_created', task: 'app/refunds', detail: { by: 'you' } })
    await tade.log.append({ type: 'run_started', task: 'app/refunds' })
    await tade.log.append({ type: 'tade_closing', detail: { pid: 1 } })
    const chat = await start(
      { finalText: 'Caught up.' },
      {
        journal: await tade.events({ limit: 100 }),
        queue: '- app/migrate — after app/refunds',
      },
    )
    expect(await chat.askFor('where are we', 30_000)).toBe('Caught up.')
    const prompt = told()
    expect(prompt).toContain('Where things stood when this window opened')
    expect(prompt).toContain('app/refunds, started')
    // The queue's own words, and theirs, both reach it.
    expect(prompt).toContain('- app/migrate — after app/refunds')
    expect(prompt).toContain('start the refunds one')
  }, 90_000)

  it('lets a surface watch it work: the tool, how it went, the words as they come', async () => {
    const events: OrchestratorEvent[] = []
    const chat = await start({
      tool: { name: 'tade_run_stop', arguments: { task: 'app/nothing-here' } },
      finalText: 'There was nothing to stop.',
    })
    chat.onEvent((event) => events.push(event))
    await chat.ask('stop the nothing-here agent')
    await until(() => events.some((event) => event.type === 'idle'))
    const tool = events.find((event) => event.type === 'tool')
    expect(tool).toMatchObject({ tool: 'tade_run_stop', input: { task: 'app/nothing-here' } })
    // It failed, and the reason came with it rather than the tool's name.
    const done = events.find((event) => event.type === 'tool_done')
    expect(done).toMatchObject({ ok: false })
    expect(done?.type === 'tool_done' ? done.text : '').toContain('nothing-here')
    // And the model was told it too: a tool whose answer never reaches the
    // model is a tool that silently does nothing.
    const request = (model?.requests[1] ?? {}) as {
      messages?: { role?: string; content?: unknown }[]
    }
    const answered = (request.messages ?? []).filter((message) => message.role === 'tool')
    expect(JSON.stringify(answered)).toContain('nothing-here')
    expect(events.filter((event) => event.type === 'delta').length).toBeGreaterThan(0)
    expect(events).toContainEqual({ type: 'message', text: 'There was nothing to stop.' })
  }, 90_000)

  it('never ends a turn on a tool call with nothing said', async () => {
    // The worst failure the conversation has, and the one that looks exactly
    // like thinking: the tool answers, the turn ends, and the spinner is
    // still turning over a model that has stopped. Scripted as it actually
    // happened — a tool call, then a final message with nothing in it.
    const events: OrchestratorEvent[] = []
    const chat = await start({
      tool: { name: 'tade_run_stop', arguments: { task: 'app/nothing-here' } },
      finalText: '',
    })
    chat.onEvent((event) => events.push(event))

    const answer = await chat.askFor('stop the nothing-here agent', 30_000)
    // An empty answer is the bug: a surface can only read it as "still
    // thinking" and draw nothing at all.
    expect(answer).not.toBe('')
    expect(answer).toContain('tade_run_stop')
    expect(answer).toContain('without saying anything')
    // And it is said as it happens, too, so a surface watching the turn does
    // not have to wait for the answer to find out there isn't one.
    const quiet = events.filter((event) => event.type === 'quiet')
    expect(quiet).toEqual([{ type: 'quiet', tool: 'tade_run_stop' }])
    // Before `idle`, which is what stops the spinner.
    expect(events.findIndex((event) => event.type === 'quiet')).toBeLessThan(
      events.findIndex((event) => event.type === 'idle'),
    )
  }, 90_000)

  it('is silent about a turn that said something after its last tool call', async () => {
    // The other half of the rule: a "done" that fires after every tool call
    // would be a sentence nobody can trust, which is worse than silence.
    const events: OrchestratorEvent[] = []
    const chat = await start({
      tool: { name: 'tade_run_stop', arguments: { task: 'app/nothing-here' } },
      finalText: 'There was nothing to stop.',
    })
    chat.onEvent((event) => events.push(event))

    expect(await chat.askFor('stop the nothing-here agent', 30_000)).toBe(
      'There was nothing to stop.',
    )
    expect(events.some((event) => event.type === 'quiet')).toBe(false)
  }, 90_000)

  it("calls an extension's tool through the window, and is told about the extension first", async () => {
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
              run: async (input) => ({ text: `Raining over ${String(input.project)}.` }),
            },
          ],
          orchestrator: () => 'Check weather_now before a deploy.',
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
    model = await startFakeModel({
      tool: { name: 'weather_now', arguments: { project: 'app' } },
      finalText: 'Hold the deploy.',
    })
    const runDir = tmp('tade-chat-run-')
    orchestrator = await Orchestrator.start({
      home,
      socket: tools.path,
      runDir,
      cwd: repo.root,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      model: { provider: 'tade-test', id: 'fake' },
      args: ['-e', writeProviderExtension(runDir)],
      env: { ...process.env, TADE_TEST_BASE_URL: model.url },
      extensions: orchestratorExtensions(extensions, home, 'pi'),
    })
    expect(await orchestrator.askFor('can we deploy app?')).toBe('Hold the deploy.')
    expect(JSON.stringify(model.requests[0])).toContain('Check weather_now before a deploy.')
    const answered = (
      (model.requests[1] ?? {}) as { messages?: { role?: string }[] }
    ).messages?.filter((message) => message.role === 'tool')
    expect(JSON.stringify(answered)).toContain('Raining over app.')
  }, 90_000)

  it('says why it would not start, instead of never answering', async () => {
    await expect(
      Orchestrator.start({
        home,
        socket: tools.path,
        runDir: tmp('tade-chat-run-'),
        cwd: repo.root,
        model: { provider: 'no-such-provider', id: 'nothing' },
      }),
    ).rejects.toThrow(/no-such-provider/)
  }, 90_000)

  it('says why the model would not answer, instead of going quiet', async () => {
    const events: OrchestratorEvent[] = []
    const chat = await start({
      refuse: {
        status: 400,
        body: { error: { message: 'Mid-conversation reasoning effort is not supported' } },
      },
    })
    chat.onEvent((event) => events.push(event))
    const answer = await chat.askFor('change your model to opus 5', 20_000)
    expect(answer).toMatch(
      /^The orchestrator could not answer: .*Mid-conversation reasoning effort/,
    )
    expect(events.some((event) => event.type === 'error')).toBe(true)
    expect(chat.stopped).toBeNull()
  })

  it('waits for the whole answer when asked to', async () => {
    // Surfaces that speak in turns need the reply, not a stream of parts.
    const chat = await start({ finalText: 'Two tasks, nothing blocked.' })
    expect(await chat.askFor('where are we')).toBe('Two tasks, nothing blocked.')
  }, 90_000)

  it('starts with none of the self-written tools when asked to', async () => {
    // Safe mode is the way back when one of them is what broke, so it must
    // start with a thoroughly broken one sitting in the active directory.
    const active = join(home, 'extensions', 'active')
    mkdirSync(active, { recursive: true })
    writeFileSync(join(active, 'broken.ts'), 'this is not valid typescript at all !!!\n')

    const said: string[] = []
    const chat = await start({ finalText: 'Still here.' }, { safe: true })
    chat.onMessage((text) => said.push(text))
    await chat.ask('where are we')
    await until(() => said.length > 0)
    expect(said[0]).toBe('Still here.')
  }, 90_000)

  it('starts at the level it was told to think at, and moves without restarting', async () => {
    const chat = await start(
      { finalText: 'Thought about it.' },
      {
        config: ConfigSchema.parse({
          projects: { app: { root: repo.root } },
          orchestrator: { thinking: 'low' },
        }),
      },
    )
    // How hard it thinks is a level like an agent's, asked of the process it
    // is already in: the conversation carries on, so nothing is said twice.
    await chat.setThinking('high')
    expect(await chat.askFor('where are we', 30_000)).toBe('Thought about it.')
  }, 90_000)

  it('switches its own model when asked, and hands it to the window to keep', async () => {
    const asked: string[] = []
    await tools.close()
    tools = await ToolHost.listen({
      tade,
      path: join(home, 'tools.sock'),
      orchestratorModel: async (said) => {
        asked.push(said)
        return { provider: 'tade-test', id: 'fake' }
      },
    })
    const events: OrchestratorEvent[] = []
    const chat = await start({
      tool: { name: 'tade_orchestrator_model', arguments: { model: 'opus 5' } },
      finalText: 'Switched.',
    })
    chat.onEvent((event) => events.push(event))
    expect(await chat.askFor('change your model to opus 5', 30_000)).toContain('Switched.')
    expect(asked).toEqual(['opus 5'])
    const done = events.find((event) => event.type === 'tool_done')
    expect(done).toMatchObject({ ok: true })
    expect(done?.type === 'tool_done' ? done.text : '').toContain('tade-test/fake')
  }, 90_000)

  it("reaches for Tade's own tools and reports which one", async () => {
    const tools: string[] = []
    const chat = await start({
      tool: {
        name: 'tade_task_create',
        arguments: { project: 'app', name: 'refunds', intent: 'the refund flow double-charges' },
      },
      finalText: 'Started it.',
    })
    chat.onTool((tool) => tools.push(tool))

    await chat.ask('start a task in app about the refund flow double-charging')
    await until(() => tools.includes('tade_task_create'))

    // That signal fires BEFORE the tool runs, so wait for the effect itself.
    // On failure, report what the model was told: a tool that errored hands
    // the reason back rather than throwing, so it would otherwise be silent.
    await until(async () => (await tade.events({ types: ['task_created'] })).length > 0).catch(
      () => {
        throw new Error(
          `task never created. The model was told: ${JSON.stringify(model?.requests[1] ?? {}).slice(
            0,
            600,
          )}`,
        )
      },
    )

    // The task exists and the intent is kept word for word.
    const [created] = await tade.events({ types: ['task_created'] })
    expect(created?.task).toBe('app/refunds')
    expect(created?.detail.intent_spoken).toBe('the refund flow double-charges')
  }, 90_000)
  // A turn a paired device asked for, with the gate wired and a real pi
  // holding its own tool calls.
  //
  // **The one thing no unit test can show**: `origin.test.ts` is the tables and
  // `tool-host.test.ts` is the socket, but *the harness holding its own `bash`
  // until Tade answers* is a property of pi under `approvals: 'policy'` — and
  // if that stopped working, every table above would still pass while a
  // stranger's words reached a shell.
  it('runs a turn from away narrowed, and refuses the harness’s own tools', async () => {
    // The window's own answer to *whose turn is this*, which is what the host
    // asks at every call. Set here because the host and the orchestrator are
    // two objects in this test and one window in life.
    arm = { how: 'remote', device: 'a1b2c3d4e5f60718', projects: null, may: [] }
    const chat = await start(
      { tool: { name: 'bash', arguments: { command: 'echo hi' } }, finalText: 'I cannot do that.' },
      { talking: true },
    )
    const events: OrchestratorEvent[] = []
    chat.onEvent((event) => events.push(event))
    expect(chat.unarmed).toBeNull()

    await chat.askFrom('run the tests and push it', arm)
    // **The arm is held from the prompt**, so the turn's first tool call is
    // never judged as the person's.
    expect(chat.arm).toEqual(arm)
    expect(chat.busy).toBe(true)

    // A second message while that one is in flight is refused rather than
    // steered into it: a harness delivers a mid-turn prompt *into* the turn.
    await expect(chat.askFrom('and this too', arm)).rejects.toThrow(/still answering/)

    arm = chat.arm
    await until(() => events.some((event) => event.type === 'idle'))
    arm = chat.arm
    // **`bash` was refused**, by the gate inside Tade's own tools extension
    // asking the host at the call — which is the one thing no unit test can
    // show. The host said so, and said it to the audit.
    expect(refusals.map((one) => one.tool)).toEqual(['bash'])
    expect(refusals[0]?.why).toContain('needs the person at the machine')
    // And the lease is let go on `idle`, so the person at the keyboard is not
    // narrowed a moment longer than the turn.
    expect(chat.arm).toEqual({ how: 'local' })
    expect(chat.busy).toBe(false)

    // What the model was told: Tade's own line, above a heading that is not
    // the one the person's words go under.
    const asked = told(0)
    expect(asked).toContain('came from a paired device')
    expect(asked).toContain('What a paired device asked:')
    expect(asked).toContain('run the tests and push it')
    expect(asked).not.toContain('What they said:')
    // And nothing anywhere wrote a `said` line.
    expect(await tade.events({ types: ['said'] })).toEqual([])
  }, 90_000)

  it('is not narrowed at all for the person at the keyboard', async () => {
    // The other half of the same gate, and the one a regression would hide:
    // with talking on, every tool call is held — so a local turn would stop
    // dead if the gate forgot to answer one. Nothing is refused here.
    const chat = await start(
      { tool: { name: 'bash', arguments: { command: 'echo hi' } }, finalText: 'Done.' },
      { talking: true },
    )
    const events: OrchestratorEvent[] = []
    chat.onEvent((event) => events.push(event))
    expect(await chat.askFor('run echo', 60_000)).toBe('Done.')
    expect(refusals).toEqual([])
    expect(events.some((event) => event.type === 'tool' && event.tool === 'bash')).toBe(true)
  }, 90_000)

  it('refuses a local arm handed to the away door, rather than running it unnarrowed', async () => {
    const chat = await start({ finalText: 'Nothing.' }, { talking: true })
    await expect(chat.askFrom('hello', { how: 'local' })).rejects.toThrow(/never a local arm/)
  }, 90_000)
})
