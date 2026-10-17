import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { ScriptedRecorder, ScriptedTranscriber } from '@tade/voice-stt'
import { Speaker } from '@tade/voice-tts'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { SPINNER } from '../../src/model.ts'
import type { ThinkerEvent } from '../../src/transcript.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

/**
 * What the person actually said, out of the message the orchestrator is handed:
 * the window puts where they are standing above their words, under a heading,
 * and every test here is about the words.
 */
const theirWords = (message: string | undefined): string =>
  (message ?? '').split('What they said:\n').at(-1) ?? ''

// What reaches the thing you talk to, what it says back, and what it is told
// while nobody is asking.

describe('the window, talking to the orchestrator', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  let home: string
  const { start, click, find } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
    home = wired.home
  })
  /** The config changes this window has written down. */
  const changes = async () =>
    (await client.events({ types: ['config_changed'] })).map(({ detail }) => detail)

  it('sends anything it does not recognise to the orchestrator', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'because the webhook retries twice'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''

    terminal.press('\x00') // opens the line you type into
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')

    // The grammar has no verb for this, so it goes to the thing that can think.
    await until('the orchestrator to be asked', () => asked.length === 1)
    expect(theirWords(asked[0])).toBe('why is refunds slow')
    await until('the answer on screen', () =>
      terminal.written.includes('because the webhook retries twice'),
    )
  })

  it('says what the orchestrator answers once, as it streams in', async () => {
    const said: string[] = []
    const speaker = await Speaker.create({
      soundDir: tmp('tade-app-sound-'),
      platform: 'darwin',
      run: async ({ command, args }) => {
        if (command === 'say') said.push(args.at(-1) ?? '')
      },
    })
    const listeners: Array<(event: ThinkerEvent) => void> = []
    const answer = 'Refunds has an agent on it. Which opus: 4.6 or 5?'
    await start({
      // Somebody who unmuted it: a fresh Tade starts muted and says nothing.
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        surfaces: { voice: { muted: false } },
      }),
      speaker,
      thinker: {
        onEvent: (listener) => {
          listeners.push(listener)
          return () => {}
        },
        // As the orchestrator answers: in pieces, then the whole message, then the reply.
        ask: async () => {
          for (const text of ['Refunds has an agent on it. ', 'Which opus: 4.6 or 5?']) {
            for (const listener of listeners) listener({ type: 'delta', text })
          }
          for (const listener of listeners) listener({ type: 'message', text: answer })
          return answer
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')

    await until('the answer to be said', () => said.includes('Which opus: 4.6 or 5?'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(said).toEqual(['Refunds has an agent on it.', 'Which opus: 4.6 or 5?'])
  })

  it('tells the orchestrator what finished while nobody asked, with the next thing you say', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // The window has seen refunds with nothing done yet; then its work lands.
    await new Promise((resolve) => setTimeout(resolve, 300))
    repo.commit(
      'refunds charge once',
      { 'refunds.ts': 'once' },
      join(repo.root, '..', 'worktrees', 'app-refunds'),
    )
    await until(
      'refunds finished on screen',
      () => screenOf(terminal.written).some((row) => row.includes('✓ refunds')),
      15_000,
    )
    terminal.press('\x00')
    for (const char of 'how is it going') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator asked', () => asked.length === 1)
    expect(asked[0]).toContain('- ')
    expect(asked[0]).toContain('app/refunds has work to review')
    // Your words last, under their own heading, exactly as you typed them.
    expect(asked[0]?.endsWith('What they said:\nhow is it going')).toBe(true)
  })

  it('tells the orchestrator a document was handed over at once, without waiting for anybody to speak', async () => {
    // What the person asked for: a document written goes back to the
    // orchestrator, which says where things stand and asks what is next — so
    // it is told now, never kept as news for the next thing somebody says.
    const asked: string[] = []
    const told: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.log.append({
      type: 'document_ready',
      task: 'app/refunds',
      urgency: 'blocking',
      detail: {
        produces: '/h/documents/refunds/plan.md',
        bytes: 40,
        asked: 'A or B?',
        waits: true,
      },
    })
    await until('the orchestrator told', () =>
      told.some((text) => text.includes('app/refunds handed over the document it produces')),
    )
    const message = told.find((text) => text.includes('handed over')) ?? ''
    expect(message).toContain('/h/documents/refunds/plan.md (40 bytes)')
    expect(message).toContain('Its agent asks: A or B?')
    expect(message).toContain('Queue nothing and start nothing until they answer')
    // And it is not said a second time with the next thing they say.
    terminal.press('\x00')
    for (const char of 'and now') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator asked', () => asked.length === 1)
    expect(asked[0]).not.toContain('handed over')
  })

  it('keeps a document it could not tell as news, and says so where the person will see it', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
        tell: async () => {
          throw new Error('the session is restarting')
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    await client.log.append({
      type: 'document_ready',
      task: 'app/refunds',
      urgency: 'blocking',
      detail: { produces: '/h/documents/refunds/plan.md', bytes: 40, waits: true },
    })
    await until('the failure said', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Could not tell the orchestrator a document was handed over'),
      ),
    )
    terminal.press('\x00')
    for (const char of 'anything new') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator asked', () => asked.length === 1)
    expect(asked[0]).toContain('app/refunds handed over the document it produces')
  })

  it('tells the orchestrator that agents are gone, rather than letting a call find out', async () => {
    const asked: string[] = []
    await start({
      thinker: {
        ask: async (text: string) => {
          asked.push(text)
          return 'ok'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))

    // Exactly what ending an agent writes down, whoever ended it: the window's
    // stop, its cleanup, tade_run_stop, tade_run_cleanup, removing the task.
    await client.log.append({
      type: 'run_exited',
      task: 'app/refunds',
      run: 'app/refunds/agent',
      detail: { stopped: true },
    })
    await client.log.append({
      type: 'run_exited',
      task: 'app/search',
      run: 'app/search/agent',
      detail: { code: 1 },
    })
    // Subscribers are told on the microtask after the write, so a turn of the
    // timer is the window having heard both. And nothing was said yet: news
    // waits for the next thing you say rather than cutting across a turn.
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(asked).toEqual([])

    terminal.press('\x00')
    for (const char of 'how is it going') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator asked', () => asked.length === 1)
    const told = asked[0] ?? ''
    // Which, how many, and why each — and where to get what is true now.
    expect(told).toContain('2 agents are gone')
    expect(told).toContain('app/refunds (stopped)')
    expect(told).toContain('app/search (it exited on its own, code 1)')
    expect(told).toContain('tade_status says what is running')
    // Riding along with what was said, never a turn of its own.
    expect(told.endsWith('What they said:\nhow is it going')).toBe(true)
  })

  it("shows the orchestrator's model in the status bar, and switches it from there", async () => {
    terminal.columns = 140
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        orchestrator: { provider: 'openrouter', model: 'anthropic/claude-opus-5' },
      }),
      models: async (harness) => ({
        harness,
        models: [
          {
            id: 'openrouter/anthropic/claude-opus-5',
            provider: 'openrouter',
            name: 'Claude Opus 5',
          },
          ...Array.from({ length: 40 }, (_, i) => ({
            id: `openrouter/vendor/model-${i}`,
            provider: 'openrouter',
            name: `Model ${i}`,
          })),
        ],
        why: null,
      }),
    })
    await until(
      'the model in the footer',
      () => screenOf(terminal.written).at(-1)?.includes('claude-opus-5 ▾') ?? false,
    )
    const chip = find('claude-opus-5 ▾')
    click(chip.col + 1, chip.row)
    await until('the picker', () =>
      screenOf(terminal.written).some((row) => row.includes('Model for the orchestrator')),
    )
    // The wheel over the list moves through it, as far as it goes — a name a
    // notch, because notches arriving in a run are a finger on a trackpad and
    // a flick through a list is not a request to visit forty models.
    const list = find('model-3 ')
    for (let i = 0; i < 40; i++) terminal.press(`\x1b[<65;${list.col + 1};${list.row + 1}M`)
    await until('scrolled down the list', () =>
      screenOf(terminal.written).some((row) => row.includes('model-35')),
    )
    // Chosen: kept for the next start, and written down as a change. What it
    // was is what the file said, and this window was handed its config
    // without one written.
    const chosen = find('model-35 ')
    click(chosen.col + 1, chosen.row)
    await until('the lines', async () => (await changes()).length === 2)
    expect(await changes()).toEqual([
      { path: 'orchestrator.provider', was: '', now: 'openrouter', by: 'window' },
      { path: 'orchestrator.model', was: '', now: 'vendor/model-35', by: 'window' },
    ])
  })

  it('writes down the model it settles on, and the one it moves itself to, as whose each is', async () => {
    const app = await start()
    // None was chosen, so the one it ended up on is kept: Tade's own doing.
    app.keepThinkerModel({ provider: 'anthropic', id: 'claude-opus-5' })
    // Asked to move, it moved itself: the orchestrator's doing, with the
    // words that asked for it beside it, as `tade_setting_change` writes them.
    const said = 'use sonnet 5 as your model'
    app.thinkerMovedTo({ provider: 'anthropic', id: 'claude-sonnet-5' }, said)
    await until('the lines', async () => (await changes()).length === 3)
    expect(await changes()).toEqual([
      { path: 'orchestrator.provider', was: '', now: 'anthropic', by: 'window' },
      { path: 'orchestrator.model', was: '', now: 'claude-opus-5', by: 'window' },
      {
        path: 'orchestrator.model',
        was: 'claude-opus-5',
        now: 'claude-sonnet-5',
        by: 'orchestrator',
        said,
      },
    ])
  })

  it('offers the models its own harness runs, and never another harness’s', async () => {
    terminal.columns = 140
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        orchestrator: { harness: 'claude-code' },
      }),
      // What the orchestrator's harness answers, and what agents' answers:
      // two different harnesses, two different catalogs.
      orchestratorModels: async () => ({
        harness: 'claude-code',
        models: [{ id: 'anthropic/opus', provider: 'anthropic', name: 'Claude Opus' }],
        why: null,
      }),
      models: async (harness) => ({
        harness,
        models: [
          { id: 'openrouter/moonshotai/kimi-k2.6', provider: 'openrouter', name: 'Kimi K2.6' },
        ],
        why: null,
      }),
    })
    await until('the strip', () => screenOf(terminal.written).at(-1)?.includes('▾') ?? false)
    const chip = find('no model ▾')
    terminal.written = ''
    click(chip.col + 1, chip.row)
    // Answered: it opens at once on what the harness said last, asking again.
    await until('the picker, answered', () => {
      const rows = screenOf(terminal.written)
      return (
        rows.some((row) => row.includes('Model for the orchestrator')) &&
        rows.every((row) => !row.includes('asking '))
      )
    })
    const shown = screenOf(terminal.written).join('\n')
    expect(shown).toContain('opus')
    expect(shown).toContain('1 of 1 in claude-code')
    // pi's catalog is not the orchestrator's to offer: choosing from it would
    // hand Claude Code a name it never heard of.
    expect(shown).not.toContain('moonshotai')
  })

  it('says why in the harness’s own words when it has no models to offer', async () => {
    terminal.columns = 140
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        orchestrator: { harness: 'codex' },
      }),
      orchestratorModels: async () => ({
        harness: 'codex',
        models: [],
        why: 'names its own models, and the codex on this machine did not answer',
      }),
      models: async (harness) => ({
        harness,
        models: [
          { id: 'openrouter/moonshotai/kimi-k2.6', provider: 'openrouter', name: 'Kimi K2.6' },
        ],
        why: null,
      }),
    })
    await until('the strip', () => screenOf(terminal.written).at(-1)?.includes('▾') ?? false)
    const chip = find('no model ▾')
    terminal.written = ''
    click(chip.col + 1, chip.row)
    // Answered: it opens at once on what the harness said last, asking again.
    await until('the picker, answered', () => {
      const rows = screenOf(terminal.written)
      return (
        rows.some((row) => row.includes('Model for the orchestrator')) &&
        rows.every((row) => !row.includes('asking '))
      )
    })
    const shown = screenOf(terminal.written).join('\n')
    expect(shown).toContain('codex names its own models')
    expect(shown).not.toContain('moonshotai')
  })

  it('shows the orchestrator working, and why a tool it used failed', async () => {
    let emit: (event: ThinkerEvent) => void = () => {}
    let answer: (text: string) => void = () => {}
    await start({
      thinker: {
        ask: () => new Promise<string>((resolve) => (answer = resolve)),
        onEvent: (listener) => {
          emit = listener
          return () => {}
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'run the tests') terminal.press(char)
    terminal.press('\r')
    // What you said is there before anything has answered it.
    await until('what you said', () =>
      screenOf(terminal.written).some((row) => row.includes('❯ run the tests')),
    )

    emit({ type: 'tool', id: '1', tool: 'tade_terminal_run', input: { command: 'pnpm test' } })
    emit({ type: 'tool_done', id: '1', ok: false, text: 'no terminal is open in app' })
    await until('the failure, with its reason', () =>
      screenOf(terminal.written).some((row) => row.includes('no terminal is open in app')),
    )
    emit({ type: 'message', text: 'There is no terminal to run them in.' })
    emit({ type: 'idle' })
    answer('There is no terminal to run them in.')
    await until('the answer, once', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('There is no terminal to run them in.'),
      ),
    )
  })

  it('moves the pane when you ask to be shown something', async () => {
    const transcriber = new ScriptedTranscriber(['show me search'])
    const recorder = new ScriptedRecorder()
    await start({ transcriber, recorder })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Focus starts on the first task.
    expect(terminal.written).toMatch(/▌ \S refunds/)
    terminal.written = ''

    terminal.press('\x00')
    await until('recording to start', () => recorder.started.length === 1)
    terminal.press('\x00')

    // Asking to be shown something has to actually show it, rather than
    // telling you which command would.
    await until('the marker to move', () => /▌ \S search/.test(terminal.written))
    expect(terminal.written).not.toContain('run tade attach')
  })

  it('changes how hard the orchestrator thinks from the strip, and keeps it', async () => {
    terminal.columns = 160
    const told: string[] = []
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        orchestrator: { provider: 'anthropic', model: 'claude-opus-5' },
      }),
      thinker: {
        ask: async () => 'ok',
        setThinking: async (level: string) => {
          told.push(level)
        },
      },
    })
    await until('the orchestrator model in the strip', () =>
      screenOf(terminal.written).some((row) => row.includes('claude-opus-5 ▾')),
    )
    // Some money spent, so the day is drawn to the right of the control and
    // the levels have room to hang from it rather than against the edge.
    await client.log.append({
      type: 'usage',
      task: 'app/refunds',
      detail: { model: 'anthropic/claude-sonnet-5', tokens: 1500, usd: 0.351 },
    })
    await until('the day in the strip', () =>
      screenOf(terminal.written).some((row) => row.includes('today ▾')),
    )
    // The control beside it, at the foot of the window: the level it thinks at.
    const button = (() => {
      const lines = screenOf(terminal.written)
      for (let row = lines.length - 1; row >= 0; row--) {
        const col = (lines[row] ?? '').search(/think(ing)? ▾/)
        if (col >= 0) return { col, row }
      }
      throw new Error('no thinking button in the strip')
    })()
    terminal.written = ''
    click(button.col + 1, button.row)
    await until('the levels', () => {
      const shown = screenOf(terminal.written).join('\n')
      return shown.includes('Thinking') && shown.includes('xhigh')
    })
    // Over the control that opened it, from the control's own column — not
    // pinned to the window's right edge, and not over the strip it is in.
    const corner = find('╭─ Thinking')
    expect(corner.col).toBe(button.col)
    const lines = screenOf(terminal.written)
    const foot = lines.findIndex((line, row) => row > corner.row && line[corner.col] === '╰')
    expect(foot).toBe(button.row - 1)
    const medium = find('medium')
    click(medium.col + 2, medium.row)
    // It takes effect where it is: the conversation carries on, at the new level.
    await until('the orchestrator to be told', () => told.length === 1)
    expect(told[0]).toBe('medium')
    // And it is written down, so the next one starts there — and as a change,
    // what it was and who asked, like one from Settings.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('thinking: medium')
    await until('the line', async () => (await changes()).length === 1)
    expect(await changes()).toEqual([
      { path: 'orchestrator.thinking', was: '', now: 'medium', by: 'window' },
    ])
    await until('it to say so', () =>
      screenOf(terminal.written).some((row) => row.includes('thinks at medium')),
    )
  })

  it('says it is working on its own tab and in the window’s own title', async () => {
    // The turning mark an agent wears, worn by the thing you talk to: the one
    // thing the window could not tell you before was whether the orchestrator
    // was doing anything at all.
    const turning = new RegExp(`orchestrator [${SPINNER}]`)
    // Held in a box rather than a variable: a turn that never ends until the
    // test says so is the whole point, and the resolver is handed over from
    // inside the thinker.
    const turn = { answer: (_text: string) => {} }
    await start({
      thinker: {
        ask: async () =>
          await new Promise<string>((resolve) => {
            turn.answer = resolve
          }),
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // At rest the tab says only its name.
    expect(turning.test(screenOf(terminal.written).join('\n'))).toBe(false)

    terminal.press('\x00') // opens the line you type into
    for (const char of 'what is going on') terminal.press(char)
    terminal.press('\r')

    await until('the tab to say it is working', () =>
      turning.test(screenOf(terminal.written).join('\n')),
    )
    // And the title, which is the one part of this you can read with the
    // window buried behind something else.
    await until('the title to say so too', () =>
      (terminal.titles.at(-1) ?? '').includes('thinking'),
    )

    turn.answer('because the webhook retries twice')
    await until('the turn to end on the tab', () => {
      const shown = screenOf(terminal.written).join('\n')
      return shown.includes('because the webhook retries twice') && !turning.test(shown)
    })
    // The title is written on the next look rather than on the same frame,
    // so it is waited for like everything else here.
    await until(
      'the title to stop saying it',
      () => !(terminal.titles.at(-1) ?? '').includes('thinking'),
    )
  })
})
