import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { ScriptedRecorder, ScriptedTranscriber } from '@tade/voice-stt'
import { Speaker } from '@tade/voice-tts'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { ThinkerEvent } from '../../src/transcript.ts'
import { type FakeTerminal, type Repo, screenOf, until, windowUnderTest } from './harness.ts'

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
    expect(asked[0]).toBe('why is refunds slow')
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
  }, 30_000)

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
  }, 30_000)

  it("shows the orchestrator's model in the status bar, and switches it from there", async () => {
    terminal.columns = 140
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        orchestrator: { provider: 'openrouter', model: 'anthropic/claude-opus-5' },
      }),
      models: async () => [
        { id: 'openrouter/anthropic/claude-opus-5', provider: 'openrouter', name: 'Claude Opus 5' },
        ...Array.from({ length: 40 }, (_, i) => ({
          id: `openrouter/vendor/model-${i}`,
          provider: 'openrouter',
          name: `Model ${i}`,
        })),
      ],
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
    const medium = find('medium')
    click(medium.col + 2, medium.row)
    // It takes effect where it is: the conversation carries on, at the new level.
    await until('the orchestrator to be told', () => told.length === 1)
    expect(told[0]).toBe('medium')
    // And it is written down, so the next one starts there.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('thinking: medium')
    await until('it to say so', () =>
      screenOf(terminal.written).some((row) => row.includes('thinks at medium')),
    )
  })
})
