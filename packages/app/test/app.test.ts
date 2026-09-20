import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import { ConfigSchema, Secrets } from '@tade/core'
import { ExtensionHost } from '@tade/extensions-core'
import { ScriptedRecorder, ScriptedTranscriber } from '@tade/voice-stt'
import { Speaker } from '@tade/voice-tts'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { App, type AppOptions } from '../src/app.ts'
import { asPaste } from '../src/images.ts'
import type { ThinkerEvent } from '../src/transcript.ts'

// The window against a real workbench and a real repository. Everything it shows
// is tested elsewhere without a terminal; what is tested here is the wiring —
// that it boots, draws, and that a keystroke reaches it at all.

/**
 * A terminal that keeps what was drawn instead of drawing it, and hands back
 * the callback the TUI registers so a test can press keys.
 */
class FakeTerminal implements Terminal {
  columns = 80
  rows = 24
  kittyProtocolActive = false
  /** Everything written, which is the screen as the user would see it. */
  written = ''
  /** Every title the window has asked the terminal for, in order. */
  titles: string[] = []
  private onInput: ((data: string) => void) | null = null

  start(onInput: (data: string) => void, _onResize: () => void): void {
    this.onInput = onInput
  }

  /** Press a key, exactly as a terminal would deliver it. */
  press(data: string): void {
    this.onInput?.(data)
  }

  write(data: string): void {
    this.written += data
  }

  stop(): void {}
  async drainInput(): Promise<void> {}
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(title: string): void {
    this.titles.push(title)
  }
  setProgress(): void {}
}

/**
 * The screen as rows of text, rebuilt from what the renderer wrote: cursor
 * moves place the text, so this is what a person would see, not the byte
 * stream. Enough of a terminal for finding a label, not a replacement for one.
 */
function screenOf(written: string): string[] {
  // Built from a character code, as elsewhere: an escape in a regex literal is
  // usually a mistake, and here it is the whole point.
  const esc = String.fromCharCode(27)
  const bel = String.fromCharCode(7)
  const token = new RegExp(
    `(${esc}\\[[0-9;?]*[A-Za-z]|${esc}\\][^${bel}]*${bel}|${esc}[<>=][0-9;]*[A-Za-z]?|\\r|\\n)`,
  )
  const moveTo = new RegExp(`^${esc}\\[(\\d+);(\\d+)H$`)
  const upDown = new RegExp(`^${esc}\\[(\\d*)([AB])$`)
  const rows: string[][] = []
  let row = 0
  let col = 0
  for (const part of written.split(token)) {
    if (!part) continue
    const move = moveTo.exec(part)
    const step = upDown.exec(part)
    if (move) {
      row = Number(move[1]) - 1
      col = Number(move[2]) - 1
    } else if (step) {
      row += (step[2] === 'B' ? 1 : -1) * Number(step[1] || 1)
    } else if (part === '\r') {
      col = 0
    } else if (part === '\n') {
      row++
    } else if (part === `${esc}[H`) {
      row = 0
      col = 0
    } else if (part === `${esc}[2K`) {
      rows[row] = []
    } else if (!part.startsWith(esc)) {
      const line = rows[row] ?? []
      rows[row] = line
      for (const char of part) line[col++] = char
    }
  }
  return rows.map((line) => Array.from(line, (char) => char ?? ' ').join(''))
}

/** Wait for something to become true, rather than for a fixed time. */
async function until(
  what: string,
  ok: () => boolean | Promise<boolean>,
  ms = 5_000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await ok()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${what}`)
}

describe('the window, wired up', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench
  let terminal: FakeTerminal
  let app: App | null = null

  beforeEach(async () => {
    repo = mkrepo()
    repo.commit('first')
    repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
    repo.addTask('search', { project: 'app', intent: 'search is slow above ten thousand rows' })
    // A tmp home, so status never reads the real machine's agent transcripts.
    home = tmp('tade-app-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
    terminal = new FakeTerminal()
  })

  afterEach(async () => {
    await app?.stop().catch(() => {})
    app = null
    await client.close().catch(() => {})
  })

  async function start(over: Partial<AppOptions> = {}): Promise<App> {
    const speaker = await Speaker.create({
      soundDir: tmp('tade-app-sound-'),
      platform: 'darwin',
      // Never actually make a noise in a test run.
      run: async () => {},
    })
    app = await App.start({
      client,
      config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
      home,
      cwd: repo.root,
      terminal,
      speaker,
      frameMs: 50,
      // Never the machine's own clipboard: what a developer copied is not a test's to read.
      clipboard: { state: async () => null, image: async () => null },
      ...over,
    })
    return app
  }

  it('boots and draws the tasks it found', async () => {
    await start()
    await until('the tasks to be drawn', () => terminal.written.includes('refunds'))
    expect(terminal.written).toContain('search')
    expect(terminal.written).toContain('app')
  })

  it('names its own window after what is happening', async () => {
    await start()
    await until('the window to name itself', () => terminal.titles.length > 0)
    // Tade owns the title: nothing it starts is left in the terminal's
    // foreground process group to name the window after itself instead.
    const title = terminal.titles.at(-1) ?? ''
    expect(title).toContain('tade')
    expect(title).toMatch(/idle|working|waiting|nothing running/)
  })

  it('always shows the orchestrator', async () => {
    await start()
    // It cannot be closed: it is how you see what Tade heard.
    await until('the orchestrator strip', () => terminal.written.includes('orchestrator'))
  })

  it('takes a keystroke and opens the dictation line', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    // ctrl+space, as a terminal without the Kitty protocol sends it.
    terminal.press('\x00')
    await until('the dictation line', () => terminal.written.includes('◉'))
  })

  it('holds a line addressed to Tade rather than typing it at the agent', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    for (const char of 'tade par') terminal.press(char)
    await until('the held line', () => terminal.written.includes('◌'))
  })

  it('moves between agents on tab', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\t')
    // The marker has to land somewhere; which task is the model's business.
    await until('a redraw with the focus marker', () => terminal.written.includes('▌'))
  })

  it('records what you say, and acts on it', async () => {
    const transcriber = new ScriptedTranscriber(['where are we'])
    const recorder = new ScriptedRecorder()
    await start({ transcriber, recorder })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''

    // ctrl+space, as a terminal without key releases sends it: press to start,
    // press again to stop.
    terminal.press('\x00')
    await until('recording to start', () => recorder.started.length === 1)
    terminal.press('\x00')
    await until('what was said to reach the engine', () => transcriber.heard.length === 1)
    // And it lands in the orchestrator strip, exactly as typing it would.
    await until('the utterance on screen', () => terminal.written.includes('where are we'))
  })

  it('tells the engine the task names, which are the words it would get wrong', async () => {
    const transcriber = new ScriptedTranscriber([''])
    const recorder = new ScriptedRecorder()
    await start({ transcriber, recorder })
    await until('the first frame', () => terminal.written.includes('refunds'))

    terminal.press('\x00')
    await until('recording to start', () => recorder.started.length === 1)
    terminal.press('\x00')
    await until('the engine to be asked', () => transcriber.offered.length === 1)
    expect(transcriber.offered[0]).toContain('app/refunds')
    expect(transcriber.offered[0]).toContain('app')
  })

  it('falls back to a typed line when there is nothing to listen with', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x00')
    // No recorder configured, so ctrl+space opens the line you can type into.
    await until('the dictation line', () => terminal.written.includes('◉'))
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

  it('selects the whole line with ctrl+a, and one backspace takes it', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00') // opens the line you type into
    for (const char of 'why is refunds slow') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('why is refunds slow')),
    )

    terminal.press('\x01') // ctrl+a: all of it
    terminal.press('\x7f') // backspace: the selection, not the last character
    await until('the line to be empty again', () =>
      screenOf(terminal.written).every((row) => !row.includes('why is refunds')),
    )
    // Emptied, not closed: the keyboard is still on the orchestrator's line.
    expect(screenOf(terminal.written).some((row) => row.includes('enter sends'))).toBe(true)
  })

  it('replaces what is selected with what you type next', async () => {
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
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('why is refunds slow')),
    )

    terminal.press('\x01') // ctrl+a
    for (const char of 'and search') terminal.press(char)
    terminal.press('\r')
    await until('the question', () => asked.length === 1)
    expect(asked[0]).toBe('and search')
  })

  it('keeps the keyboard on the orchestrator after sending, until you leave it', async () => {
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

    terminal.press('\x00') // opens the line you type into
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')
    await until('the first question', () => asked.length === 1)

    // Nothing reopens the line: sending emptied it, it did not close it, so
    // the next sentence goes to the orchestrator and not to the agent in front.
    for (const char of 'and what about search') terminal.press(char)
    terminal.press('\r')
    await until('the second question', () => asked.length === 2)
    expect(asked).toEqual(['why is refunds slow', 'and what about search'])

    // Escape is the way out, and then the keyboard is the agent's again.
    terminal.written = ''
    terminal.press('\x1b')
    await until('the line to close', () =>
      screenOf(terminal.written).some((row) => row.includes('Ask Tade anything')),
    )
    for (const char of 'typed at the agent') terminal.press(char)
    terminal.press('\r')
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect(asked).toHaveLength(2)
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

  it('goes quiet the moment you mute it, mid-sentence', async () => {
    const started: string[] = []
    const finished: string[] = []
    let cut = 0
    const speaker = await Speaker.create({
      soundDir: tmp('tade-app-sound-'),
      platform: 'darwin',
      run: (command, signal) =>
        new Promise<void>((resolve) => {
          if (command.command !== 'say') return resolve()
          const text = command.args.at(-1) ?? ''
          started.push(text)
          // Saying a sentence out loud takes seconds; mute must not wait.
          const done = setTimeout(() => {
            finished.push(text)
            resolve()
          }, 2_000)
          signal?.addEventListener('abort', () => {
            cut += 1
            clearTimeout(done)
            resolve()
          })
        }),
    })
    const listeners: Array<(event: ThinkerEvent) => void> = []
    const answer = 'The first sentence. The second sentence. The third sentence.'
    await start({
      speaker,
      thinker: {
        onEvent: (listener) => {
          listeners.push(listener)
          return () => {}
        },
        ask: async () => {
          for (const listener of listeners) listener({ type: 'delta', text: `${answer} ` })
          for (const listener of listeners) listener({ type: 'message', text: answer })
          return answer
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    for (const char of 'why is refunds slow') terminal.press(char)
    terminal.press('\r')
    await until('it to start talking', () => started.length === 1)

    // ctrl+m, as a terminal sends it.
    terminal.press('\x1b[109;5u')
    await until('the sentence to be cut off', () => cut === 1)
    await new Promise((resolve) => setTimeout(resolve, 200))
    // Nothing finished, and the two sentences queued behind it never start.
    expect(finished).toEqual([])
    expect(started).toEqual(['The first sentence.'])
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

  it('brings back what you said with up, and finds it with ctrl+r, in the next window too', async () => {
    const asked: string[] = []
    const thinker = {
      ask: async (text: string) => {
        asked.push(text)
        return 'ok'
      },
    }
    await start({ thinker })
    await until('the first frame', () => terminal.written.includes('refunds'))
    for (const line of ['why is refunds slow', 'what changed in search']) {
      terminal.press('\x00')
      for (const char of line) terminal.press(char)
      terminal.press('\r')
    }
    await until('both to be asked', () => asked.length === 2)
    await until(
      'both journaled',
      async () => (await client.events({ types: ['said'] })).length === 2,
    )
    // The line as pi's editor draws it: the words, then the cursor after them.
    const onLine = (text: string) => () =>
      screenOf(terminal.written).some((row) => row.trimEnd() === ` ${text}`)

    // Up twice is the one before last; down comes back.
    terminal.press('\x00')
    terminal.press('\x1b[A')
    terminal.press('\x1b[A')
    await until('the older line back', onLine('why is refunds slow'))
    terminal.press('\x1b[B')
    await until('the newer line back', onLine('what changed in search'))
    terminal.press('\x1b')

    // A new window finds it in the journal: ctrl+r, a few letters, enter.
    await app?.stop()
    terminal.written = ''
    await start({ thinker })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00')
    terminal.press('\x12')
    for (const char of 'refunds') terminal.press(char)
    await until('the match', () =>
      screenOf(terminal.written).some(
        (row) => row.includes('search: refunds▏') && row.includes('why is refunds slow'),
      ),
    )
    terminal.press('\r')
    await until('it sent again', () => asked.length === 3)
    expect(asked[2]).toBe('why is refunds slow')
  })

  it('offers a screenshot on the clipboard, and attaches it from an empty paste or a click', async () => {
    const shot = join(tmp('tade-shot-'), 'shot.png')
    writeFileSync(shot, Buffer.from('89504e470d0a1a0a', 'hex'))
    let copy = '7'
    await start({
      clipboard: { state: async () => ({ copy, image: true }), image: async () => shot },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Open the line: the picture on the clipboard is offered.
    terminal.press('\x00')
    await until('the offer', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Attach the screenshot on the clipboard'),
      ),
    )
    // Cmd+V on a picture reaches a terminal program as a paste with nothing in it.
    terminal.press(asPaste(''))
    await until('attached', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ shot.png')),
    )
    // That copy is not offered again; a new one is.
    expect(
      screenOf(terminal.written).some((row) =>
        row.includes('Attach the screenshot on the clipboard'),
      ),
    ).toBe(false)
    // Abandoned, and something new copied: offered when the line opens again.
    terminal.press('\x1b')
    copy = '8'
    terminal.press('\x00')
    await until(
      'the next copy offered',
      () =>
        screenOf(terminal.written).some((row) =>
          row.includes('Attach the screenshot on the clipboard'),
        ),
      8_000,
    )
  }, 20_000)

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
    // The wheel over the list moves through it, as far as it goes.
    const list = find('model-3 ')
    for (let i = 0; i < 12; i++) terminal.press(`\x1b[<65;${list.col + 1};${list.row + 1}M`)
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

  it('asks who a dropped screenshot is for, and sends it with what you say next', async () => {
    const shot = join(tmp('tade-shot-'), 'Screen Shot.png')
    writeFileSync(shot, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const sent: { text: string; images: readonly { mimeType: string }[] }[] = []
    await start({
      thinker: {
        ask: async (text, images = []) => {
          sent.push({ text, images })
          return 'a red square'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // What a terminal types when a file is dropped on it.
    terminal.press(asPaste(shot.replace(/ /g, '\\ ')))
    await until('the question', () =>
      screenOf(terminal.written).some((row) => row.includes('Send Screen Shot.png to')),
    )
    terminal.press('\r')
    await until('the picture waiting on the line', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ Screen Shot.png')),
    )
    for (const char of 'what is this') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator to be asked', () => sent.length === 1)
    expect(sent[0]?.text).toBe('what is this')
    expect(sent[0]?.images.map((image) => image.mimeType)).toEqual(['image/png'])
  })

  it('keeps several screenshots, and each can be removed', async () => {
    const dir = tmp('tade-multi-shot-')
    const a = join(dir, 'a.png')
    const b = join(dir, 'b.png')
    writeFileSync(a, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    writeFileSync(b, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Drop the first.
    terminal.press(asPaste(a))
    await until('the question', () =>
      screenOf(terminal.written).some((row) => row.includes('Send a.png to')),
    )
    terminal.press('\r')
    await until('first attached', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ a.png')),
    )
    // Drop the second.
    terminal.press(asPaste(b))
    await until('the question again', () =>
      screenOf(terminal.written).some((row) => row.includes('Send b.png to')),
    )
    terminal.press('\r')
    await until('both attached', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ a.png') && row.includes('▣ b.png')),
    )
    // Remove the first by clicking its ×.
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.includes('▣ a.png') && line.includes('▣ b.png'))
    expect(row).toBeGreaterThanOrEqual(0)
    const aX = (lines[row] ?? '').indexOf('×', (lines[row] ?? '').indexOf('▣ a.png'))
    expect(aX).toBeGreaterThanOrEqual(0)
    terminal.press(`\x1b[<0;${aX + 1};${row + 1}M`)
    terminal.press(`\x1b[<0;${aX + 1};${row + 1}m`)
    await until('only the second remains', () =>
      screenOf(terminal.written).some((row) => !row.includes('▣ a.png') && row.includes('▣ b.png')),
    )
  })

  it('attaches a non-image file dropped on the orchestrator', async () => {
    const dir = tmp('tade-file-')
    const txt = join(dir, 'notes.txt')
    writeFileSync(txt, 'these are notes')
    const sent: { text: string; images: readonly { mimeType: string }[] }[] = []
    await start({
      thinker: {
        ask: async (text, images = []) => {
          sent.push({ text, images })
          return 'got it'
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press(asPaste(txt))
    await until('the question', () =>
      screenOf(terminal.written).some((row) => row.includes('Send notes.txt to')),
    )
    terminal.press('\r')
    await until('the file waiting on the line', () =>
      screenOf(terminal.written).some((row) => row.includes('▣ notes.txt')),
    )
    for (const char of 'read this') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator to be asked', () => sent.length === 1)
    expect(sent[0]?.images).toEqual([])
  })

  it('comes back to the pane you were watching', async () => {
    const first = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Focus starts on refunds; move it to search.
    terminal.press('\t')
    await until('the marker to move', () => /▌ \S search/.test(terminal.written))
    await first.stop()

    // A new window, same home: it should not dump you back on the first task.
    terminal = new FakeTerminal()
    await start()
    await until('the window to come back', () => terminal.written.includes('search'))
    expect(terminal.written).toMatch(/▌ \S search/)
  })

  it('opens on the first task when it has never been opened before', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    expect(terminal.written).toMatch(/▌ \S refunds/)
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

  it('types to the orchestrator when no agent has focus', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Tab past every pane to the orchestrator, which is one of the things you
    // can focus precisely so that there is always somewhere to type.
    terminal.press('\t')
    terminal.press('\t')
    terminal.written = ''
    terminal.press('h')
    terminal.press('i')
    await until('the typed line', () => terminal.written.includes('hi'))
  })

  it('offers its commands when you type a slash', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\t')
    terminal.press('\t')
    terminal.written = ''
    terminal.press('/')
    await until('the command list', () => terminal.written.includes('/new'))
    expect(terminal.written).toContain('/settings')
  })

  it('stops cleanly, and stopping twice is safe', async () => {
    const started = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await started.stop()
    await started.stop()
    // Whoever is waiting on the window is released, or this never resolves.
    await started.wait()
  })

  it('reloads when the reload key is pressed and nothing is running', async () => {
    let reloaded = false
    await start({
      reloadWindow: async () => {
        reloaded = true
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x1b[114;6u')
    await until('reload to be called', () => reloaded)
  })

  it('warns before reloading when lanes cannot survive', async () => {
    await client.openTerminal({ project: 'app' })
    let reloaded = false
    await start({
      reloadWindow: async () => {
        reloaded = true
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x1b[114;6u')
    await until('the reload panel', () => terminal.written.includes('Reload Tade?'))
    expect(reloaded).toBe(false)
    // Dismiss the panel so the test ends cleanly.
    terminal.written = ''
    terminal.press('\x1b')
    await until('the panel to close', () => !terminal.written.includes('Reload Tade?'))
  })

  /** A left click, as a terminal in SGR mouse mode sends it: press, then release. */
  function click(col: number, row: number): void {
    terminal.press(`\x1b[<0;${col + 1};${row + 1}M`)
    terminal.press(`\x1b[<0;${col + 1};${row + 1}m`)
  }

  /** Where a label is on the last full frame, found the way a person would. */
  function find(label: string): { col: number; row: number } {
    const lines = screenOf(terminal.written)
    for (let row = lines.length - 1; row >= 0; row--) {
      const col = lines[row]?.indexOf(label) ?? -1
      if (col >= 0) return { col, row }
    }
    throw new Error(`"${label}" is not on screen`)
  }

  it('starts a new agent from its button, asking nothing first', async () => {
    await start()
    await until('the first frame', () =>
      screenOf(terminal.written).some((row) => row.includes('AGENTS')),
    )
    // The + beside AGENTS: where agents are, not a button at the foot.
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.includes('AGENTS'))
    click(lines[row]?.indexOf('+') ?? 0, row)
    const deadline = Date.now() + 20_000
    while ((await client.events({ types: ['task_created'] })).length === 0) {
      if (Date.now() > deadline) throw new Error('no agent was made')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const [created] = await client.events({ types: ['task_created'] })
    // Named for nothing in particular, because nothing was said.
    expect(created?.task).toBe('app/agent-1')
  }, 30_000)

  it('closes the agents that have finished, from the cleanup beside the +', async () => {
    await start()
    await until('the first frame', () =>
      screenOf(terminal.written).some((row) => row.includes('AGENTS')),
    )
    // One of the two is finished, so there is something to clean up.
    await client.markDone('app/refunds', { by: 'you' })
    const heading = () => {
      const lines = screenOf(terminal.written)
      const row = lines.findIndex((line) => line.includes('AGENTS'))
      return { row, text: lines[row] ?? '' }
    }
    await until('the cleanup button', () => heading().text.includes('⌫'), 20_000)
    const bar = heading()
    click(bar.text.indexOf('⌫'), bar.row)
    // It asks first, and says how many it would close.
    await until('the question', () => terminal.written.includes('Close 1 finished agent?'))
    const answer = find('Close 1 ')
    terminal.written = ''
    click(answer.col, answer.row)
    await until(
      'the agent to be closed',
      () => repo.git('branch', '--list', 'tade/refunds').trim() === '',
      20_000,
    )
    // The other one is untouched: only what had finished went.
    expect(repo.git('branch', '--list', 'tade/search')).toContain('tade/search')
  }, 30_000)

  it('opens a project from the + beside the tabs, looking in your home folder', async () => {
    const folders = tmp('tade-app-home-')
    writeFileSync(join(folders, 'notes.txt'), 'not a folder')
    mkdirSync(join(folders, 'payments'))
    const was = process.env.HOME
    process.env.HOME = folders
    try {
      await start()
      // The wordmark is spelt with the letters apart, so look for it that way.
      await until('the first frame', () => terminal.written.includes('T A D E'))
      const tabs = screenOf(terminal.written)[0] ?? ''
      terminal.written = ''
      click(tabs.indexOf('+'), 0)
      await until('the panel', () => terminal.written.includes('Open a project'))
      await until('the folders in home', () => terminal.written.includes('payments/'))
      expect(terminal.written).toContain('RECENT')

      // Once to choose it, and again to go in, the way folders work everywhere.
      const folder = find('payments/')
      click(folder.col, folder.row)
      await until('it to be chosen', () => terminal.written.includes('Open ~/payments'))
      terminal.written = ''
      click(folder.col, folder.row)
      await until('the folder to be opened', () => terminal.written.includes('no folders here'))
    } finally {
      process.env.HOME = was
    }
  })

  // The panels, opened the way a person opens them, through the whole window.
  // The screen tests draw each panel from a frame they build themselves; these
  // are what notice when the window stops handing a panel what it needs.

  it('opens Settings from its button, with its categories and controls', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    terminal.written = ''
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents run'))
    expect(terminal.written).toContain('Accounts')
  })

  it('saves where agents work so the workbench starts the next one there', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    await until('the settings', () => terminal.written.includes('Where agents work'))
    terminal.written = ''
    // Two choices are radios: the arrow moves to the other one and saves it.
    terminal.press('\x1b[C')
    await until('saved', () => terminal.written.includes('applies now'))
    // The workbench's own copy is the one that decides where a task is made.
    expect(client.config.agents.workspace).toBe('worktree')
  })

  it('pastes a key from Settings, into the keychain and not the config', async () => {
    terminal.columns = 140
    terminal.rows = 50
    const secrets = Secrets.open({ home, platform: 'linux' })
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          settings: [
            { key: 'key', kind: 'secret', env: 'WEATHER_API_KEY', means: 'the forecast key' },
          ],
          ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
          setup: () => ({
            guide: ['Paste the key.'],
            fields: [{ key: 'key', label: 'API key', kind: 'secret' }],
          }),
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: {},
      secrets,
    })
    await start({ extensions })
    await until('the first frame', () => terminal.written.includes('Settings'))
    const button = find('Settings ')
    click(button.col + 1, button.row)
    // Every key anything asks for is one group, wherever the thing asking for
    // it lives: it is a key, and that is how people look for it.
    await until('the settings', () => terminal.written.includes('Keys and tokens'))
    const category = find('Keys and tokens')
    click(category.col + 1, category.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather api key')),
    )
    const field = find('Weather api key')
    click(field.col + 30, field.row)
    for (const char of 'wk_0123456789') terminal.press(char)
    terminal.press('\r')
    await until('saved', () => terminal.written.includes('Saved in'))
    expect(secrets.get('weather.key')).toBe('wk_0123456789')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('wk_0123456789')
    // Neither as it was typed, nor read back to you afterwards.
    expect(terminal.written).not.toContain('wk_0123456789')
  })

  it("opens an agent's menu with a right-click, listing what can be done", async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // With a space before it: the worktree's path under GIT can say refunds too.
    const task = find(' refunds')
    terminal.written = ''
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}M`)
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Remove agent'))
    expect(terminal.written).toContain('Copy branch name')
  })

  it('marks an agent finished from its menu, whatever its rule', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const task = find(' refunds')
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}M`)
    terminal.press(`\x1b[<2;${task.col + 2};${task.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Mark finished'))
    const item = find('Mark finished')
    click(item.col + 1, item.row)
    await until(
      'it written down',
      async () => (await client.events({ types: ['task_done'] })).length === 1,
    )
    const [done] = await client.events({ types: ['task_done'] })
    expect(done).toMatchObject({ task: 'app/refunds', detail: { by: 'you' } })
    await until('finished on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('✓ refunds')),
    )
  })

  it("writes a task's own rule down once it is met, and only then", async () => {
    const worktree = join(repo.root, '..', 'worktrees', 'app-refunds')
    const file = join(worktree, '.tade', 'task.yaml')
    writeFileSync(file, `${readFileSync(file, 'utf8')}done: committed\n`)
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Its agent ran and ended a turn, but nothing is committed: not yet.
    await client.log.append({ type: 'run_started', task: 'app/refunds', detail: {} })
    await client.log.append({ type: 'turn_done', task: 'app/refunds', detail: { status: 'ok' } })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(await client.events({ types: ['task_done'] })).toEqual([])
    repo.commit('refunds charge once', { 'refunds.ts': 'once' }, worktree)
    await until(
      'the rule written down',
      async () => (await client.events({ types: ['task_done'] })).length === 1,
      15_000,
    )
    const [done] = await client.events({ types: ['task_done'] })
    expect(done).toMatchObject({ task: 'app/refunds', detail: { by: 'rule', rule: 'committed' } })
  }, 30_000)

  it('starts what can start, and the rest once what it waits on has finished', async () => {
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const answer = await window.queueTools().plan({
      project: 'app',
      said: 'charge once, then give refunds back',
      agents: [
        { name: 'charge-once', said: 'charge once', prompt: '', after: [], touches: ['charge.ts'] },
        {
          name: 'refund-back',
          said: 'then give refunds back',
          prompt: '',
          after: [{ agent: 'charge-once', why: 'both change charge.ts' }],
          touches: ['charge.ts'],
        },
      ],
    })
    expect(answer).toContain('Started charge-once.')
    expect(answer).toContain('Queued refund-back (after app/charge-once).')
    expect(client.runs().map((run) => run.task)).toEqual(['app/charge-once'])

    // Nobody asks: the first finishing is what starts the second.
    await client.markDone('app/charge-once', { by: 'you' })
    await until(
      'the second started',
      () => client.runs().some((run) => run.task === 'app/refund-back'),
      10_000,
    )
    await until(
      'why it started, written down',
      async () =>
        (await client.events({ types: ['queue_started'], task: 'app/refund-back' }))[0]?.detail
          .why === 'app/charge-once has finished',
    )
  }, 60_000)

  it('shows queued work under the agents, opens it, and starts it from its card', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'look first, then fix',
      agents: [
        { name: 'look-first', said: 'look first', prompt: '', after: [], touches: [] },
        {
          name: 'fix-after',
          said: 'then fix',
          prompt: 'fix what look-first found',
          after: [{ agent: 'look-first', why: 'it needs what that finds' }],
          touches: [],
        },
      ],
    })
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('SMART QUEUE')),
    )
    const tab = find('fix-after')
    terminal.written = ''
    click(tab.col + 1, tab.row)
    await until('its card', () => terminal.written.includes('it needs what that finds'))
    expect(terminal.written).toContain('fix what look-first found')
    // Looking at queued work is not starting it: clicking the row shows what it
    // waits on and what it will be told, and nothing has run.
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(client.runs().some((run) => run.task === 'app/fix-after')).toBe(false)
    const button = find('Start now')
    click(button.col + 2, button.row)
    await until(
      'it started',
      () => client.runs().some((run) => run.task === 'app/fix-after'),
      10_000,
    )
  }, 60_000)

  it('warns when a plan runs into work the project already has, which no plan can see', async () => {
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'fix the charge, then bill for it',
      agents: [
        { name: 'charge-first', said: 'fix the charge', prompt: '', after: [], touches: [] },
        {
          name: 'bill-after',
          said: 'then bill for it',
          prompt: '',
          after: [{ agent: 'charge-first', why: 'it changes how a charge is made' }],
          touches: ['src/charge.ts'],
        },
      ],
    })
    const answer = await window.queueTools().plan({
      project: 'app',
      said: 'now refunds',
      agents: [
        {
          name: 'refunds-next',
          said: 'now refunds',
          prompt: '',
          after: [],
          touches: ['src/charge.ts'],
        },
      ],
    })
    expect(answer).toContain(
      'Watch out: refunds-next and app/bill-after, which is queued, both change src/charge.ts',
    )
  }, 60_000)

  it('pauses one piece of queued work from its card, and there is no pause-everything button', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'one now, one after',
      agents: [
        { name: 'first-one', said: 'one now', prompt: '', after: [], touches: [] },
        {
          name: 'second-one',
          said: 'one after',
          prompt: '',
          after: [{ agent: 'first-one', why: 'they touch the same thing' }],
          touches: [],
        },
      ],
    })
    await until('the queue on screen', () =>
      screenOf(terminal.written).some((row) => row.includes('all  next  timed')),
    )
    // Nothing over the queue pauses everything at once: the filters, and no more.
    expect(screenOf(terminal.written).some((row) => row.includes('‖ pause'))).toBe(false)

    // Looking at it is not starting it: its card says which one you are pausing.
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.slice(0, 28).includes('second-one'))
    expect(row).toBeGreaterThanOrEqual(0)
    click((lines[row]?.indexOf('second-one') ?? 0) + 1, row)
    await until('its card', () =>
      screenOf(terminal.written).some(
        (line) => line.includes('‖ Pause') && line.includes('second-one'),
      ),
    )
    const pause = find('‖ Pause')
    click(pause.col + 1, pause.row)
    await until('that one paused', async () =>
      /app\/second-one — paused/.test(await window.queueTools().describe()),
    )
    // Its own work finishing starts nothing while it is paused.
    await client.markDone('app/first-one', { by: 'you' })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(client.runs().some((run) => run.task === 'app/second-one')).toBe(false)

    const resume = find('▶ Resume')
    click(resume.col + 1, resume.row)
    await until(
      'it starts again',
      () => client.runs().some((run) => run.task === 'app/second-one'),
      15_000,
    )
  }, 60_000)

  it('still holds a whole project’s queue when the orchestrator asks, with no button for it', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const window = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    await window.queueTools().plan({
      project: 'app',
      said: 'one now, one after',
      agents: [
        { name: 'first-one', said: 'one now', prompt: '', after: [], touches: [] },
        {
          name: 'second-one',
          said: 'one after',
          prompt: '',
          after: [{ agent: 'first-one', why: 'they touch the same thing' }],
          touches: [],
        },
      ],
    })
    await window.queueTools().change({ project: 'app', change: 'pause' })
    // Its own work finishing starts nothing while the queue is held.
    await client.markDone('app/first-one', { by: 'you' })
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(client.runs().some((run) => run.task === 'app/second-one')).toBe(false)
    expect(await window.queueTools().describe()).toContain('paused with the queue')

    await window.queueTools().change({ project: 'app', change: 'resume' })
    await until(
      'it starts again',
      () => client.runs().some((run) => run.task === 'app/second-one'),
      15_000,
    )
  }, 60_000)

  it('runs a schedule when it comes due: its agent starts, or the orchestrator is asked', async () => {
    terminal.columns = 120
    terminal.rows = 60
    const told: string[] = []
    const window = await start({
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    const soon = new Date(Date.now() + 1_500).toISOString()
    const answer = await tools.schedule({
      name: 'Release notes',
      project: 'app',
      said: 'draft the release notes in a moment',
      when: { at: soon },
      agent: 'Draft the release notes from what merged today.',
    })
    expect(answer).toMatch(/^Release notes \(release-notes\): once, .+, starts an agent\. Next: /)
    await tools.schedule({
      name: 'Morning brief',
      project: 'app',
      said: 'in a moment, tell me what happened',
      when: { at: soon },
      ask: 'Say what the agents did, and what needs the person first.',
    })
    await until('both in the queue', () =>
      screenOf(terminal.written).some((row) => row.includes('Morning brief')),
    )

    await until(
      'its agent started',
      () => client.runs().some((run) => run.task.startsWith('app/release-notes-')),
      15_000,
    )
    await until('the orchestrator asked', () =>
      told.some((text) => text.includes('It is time for "Morning brief"')),
    )
    const fired = await client.events({ types: ['schedule_fired'] })
    expect(fired.map((event) => event.detail.schedule).sort()).toEqual([
      'morning-brief',
      'release-notes',
    ])
    // Once is once: nothing comes due again.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect(await client.events({ types: ['schedule_fired'] })).toHaveLength(2)
  }, 60_000)

  it('turns a watch on from the Extensions panel, starts work on what it finds once, and says when it cannot look', async () => {
    terminal.columns = 120
    terminal.rows = 50
    let clock = Date.now()
    const found: { key: string; title: string }[] = []
    let radar: string | null = null
    const told: string[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          watches: [
            {
              id: 'rain',
              title: 'Rain',
              means: 'Looks for rain, and starts an agent to bring the washing in.',
              every: '1h',
              check: async () => {
                if (radar) throw new Error(radar)
                return { found }
              },
              agent: (finding) => ({
                title: `bring in ${finding.key}`,
                prompt: `It is raining: ${finding.title}.`,
                context: 'The washing is on the line.',
              }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window = await start({
      extensions,
      now: () => clock,
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const extensionsButton = find('Extensions ]')
    click(extensionsButton.col + 2, extensionsButton.row)
    await until('the watch offered', () =>
      screenOf(terminal.written).some((row) => row.includes('Watch app ]')),
    )
    const watch = find('Watch app ]')
    click(watch.col + 2, watch.row)
    await until('it is on, and says when it looks', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Rain is on in app: it looks every hour, first at'),
      ),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('Show ]'))).toBe(true)
    expect(client.schedules()).toMatchObject([
      {
        id: 'rain',
        name: 'Rain',
        project: 'app',
        by: 'you',
        when: { every: '1h' },
        does: { kind: 'watch', watch: 'weather.rain', found: 'agent', most: 2 },
      },
    ])

    // Asked to look now, it says what it found, nothing included.
    const tools = window.queueTools()
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain looked: found nothing.',
    )

    // On its clock: the first two new things start work; the third waits for the next look.
    found.push(
      { key: 'shed', title: 'rain over the shed' },
      { key: 'yard', title: 'rain over the yard' },
      { key: 'roof', title: 'rain over the roof' },
    )
    clock += 3_600_000 + 1_000
    await until(
      'work on the first two',
      () =>
        ['app/bring-in-shed', 'app/bring-in-yard'].every((task) =>
          client.runs().some((run) => run.task === task),
        ),
      15_000,
    )
    const file = readFileSync(
      join(repo.root, '.tade', 'tasks', 'bring-in-shed', 'task.yaml'),
      'utf8',
    )
    expect(file).toContain('by: schedule:rain')
    await until('said where you would look', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('Rain found 3 new: queued app/bring-in-shed and app/bring-in-yard'),
      ),
    )
    // Found again, those are not new; the one that waited is.
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain found 1 new: queued app/bring-in-roof.',
    )
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain looked: nothing new.',
    )
    expect(await tools.describe()).toContain('last looked')

    // What it could not look at is said when it starts going wrong, not at every look.
    radar = 'the radar is down'
    const wrong = () =>
      screenOf(terminal.written).filter((row) => row.includes('Rain could not look')).length
    clock += 3_600_000
    await until('said once', () => wrong() === 1, 15_000)
    clock += 3_600_000
    await until(
      'looked again',
      async () =>
        (await client.events({ types: ['watch_checked'] })).filter((event) => event.detail.problem)
          .length === 2,
      15_000,
    )
    await new Promise((resolve) => setTimeout(resolve, 500))
    expect(wrong()).toBe(1)
    terminal.press('\x1b')
    await until('marked in the queue', () =>
      screenOf(terminal.written).some((row) => /! Rain/.test(row)),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('weather · could not'))).toBe(true)
  }, 90_000)

  it('lists a tool Tade wrote for itself, off, and turning it on is written down for next start', async () => {
    terminal.columns = 120
    terminal.rows = 50
    const root = join(home, 'extensions')
    mkdirSync(root, { recursive: true })
    writeFileSync(
      join(root, 'standup.ts'),
      '// Reads out what each agent did yesterday.\nexport default function () {}\n',
    )
    await start({
      config: ConfigSchema.parse({
        projects: { app: { root: repo.root } },
        orchestrator: { extensions: root },
      }),
      written: () => [
        {
          name: 'standup',
          why: 'Reads out what each agent did yesterday.',
          path: join(root, 'standup.ts'),
        },
      ],
    })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('what Tade wrote, off', () =>
      screenOf(terminal.written).some((row) => row.includes('standup') && row.includes('off')),
    )
    // Nothing was run to show it: what it is for is read out of the file.
    expect(
      screenOf(terminal.written).some((row) =>
        row.includes('Reads out what each agent did yesterday.'),
      ),
    ).toBe(true)
    const on = find('Turn on ]')
    click(on.col + 2, on.row)
    await until('it says when it will run', () =>
      screenOf(terminal.written).some((row) =>
        row.includes('standup is on — it loads the next time Tade starts'),
      ),
    )
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('enabled: true')
  }, 60_000)

  it('turns a watch on for the orchestrator: what it finds is told, and what cannot be kept is refused', async () => {
    const told: string[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          watches: [
            {
              id: 'rain',
              title: 'Rain',
              means: 'Looks for rain.',
              every: '30m',
              input: {
                type: 'object',
                properties: { heavier: { type: 'number', description: 'in mm' } },
              },
              check: async () => ({
                found: [
                  {
                    key: 'shed',
                    title: 'rain over the shed',
                    links: [{ title: 'radar', url: 'https://radar.example/shed' }],
                  },
                  { key: 'yard', title: 'rain over the yard' },
                ],
              }),
              agent: () => ({ title: 'never', prompt: 'never' }),
            },
          ],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    const window = await start({
      extensions,
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await expect(
      tools.schedule({ name: 'Snow', project: 'app', said: '', watch: 'weather.snow' }),
    ).rejects.toThrow('there is no watch called weather.snow (there is weather.rain)')
    await expect(
      tools.schedule({
        name: 'Rain',
        project: 'app',
        said: '',
        watch: 'weather.rain',
        input: { heavier: 'lots' },
      }),
    ).rejects.toThrow('heavier should be a number')
    await expect(
      tools.schedule({ name: 'Rain', project: 'app', said: '', watch: 'weather.rain', most: 0 }),
    ).rejects.toThrow('a whole number, 1 or more')
    await expect(
      tools.schedule({
        name: 'Rain',
        project: 'app',
        said: '',
        watch: 'weather.rain',
        ask: 'is it raining?',
      }),
    ).rejects.toThrow('with one of')

    expect(
      await tools.schedule({
        name: 'Rain',
        project: 'app',
        said: 'tell me when it rains',
        watch: 'weather.rain',
        input: { heavier: 2 },
        found: 'ask',
      }),
    ).toMatch(
      /^Rain \(rain\): every 30 minutes, looks with weather\.rain, and tells the orchestrator what it finds\. Next: /,
    )
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain found 2 new: the orchestrator is told.',
    )
    await until('the orchestrator told', () =>
      told.some((text) =>
        text.includes('"Rain", a watch you turned on in app (weather.rain), found 2 new things:'),
      ),
    )
    const message = told.find((text) => text.includes('"Rain", a watch')) ?? ''
    expect(message).toContain('- rain over the shed (https://radar.example/shed)')
    expect(message).toContain('start work only on what they ask for')
    expect(client.runs()).toEqual([])
    // Told once: found again, it is not new.
    expect(await tools.change({ schedule: 'rain', change: 'start' })).toBe(
      'Rain looked: nothing new.',
    )
  }, 30_000)

  it('looks at the tree before it starts queued work, and holds what has moved under it', async () => {
    const told: string[] = []
    const window = await start({
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await tools.plan({
      project: 'app',
      said: 'fix the charge, have a look, then write both of them up',
      agents: [
        {
          name: 'fix-charge',
          said: 'fix the charge',
          prompt: 'fix it',
          after: [],
          touches: ['charge.ts'],
        },
        { name: 'look-around', said: 'have a look', prompt: 'look', after: [], touches: [] },
        {
          name: 'write-up',
          said: 'write up the charge',
          prompt: 'write up how charging works',
          after: [{ agent: 'look-around', why: 'it needs what that finds' }],
          touches: ['charge.ts'],
        },
        {
          name: 'mail-notes',
          said: 'write up the mailer',
          prompt: 'write up how mail works',
          after: [{ agent: 'look-around', why: 'it needs what that finds' }],
          touches: ['mail.ts'],
        },
      ],
    })
    await until('the first two started', () => client.runs().length === 2, 10_000)

    // The agent at work commits the very file the write-up was planned
    // around. Its trailer is what says whose the commit is.
    repo.write({ 'charge.ts': 'charge once\n' })
    repo.git('add', 'charge.ts')
    repo.git('commit', '-q', '-m', 'charge once\n\nTade-Task: app/fix-charge')
    await client.markDone('app/look-around', { by: 'you' })

    // Nobody has been near the mailer, so that one starts by rule as it always did.
    await until(
      'the one nobody collided with started',
      () => client.runs().some((run) => run.task === 'app/mail-notes'),
      15_000,
    )
    // The other is held on the evidence, with the files and whose they are.
    const [held] = await client.events({ types: ['queue_held'], task: 'app/write-up' })
    expect(held).toMatchObject({
      task: 'app/write-up',
      detail: { changed: ['charge.ts'], by: ['app/fix-charge'] },
    })
    expect(String(held?.detail.because)).toBe(
      'app/fix-charge, which is working, has already changed charge.ts, which this was planned to change',
    )
    expect(client.runs().some((run) => run.task === 'app/write-up')).toBe(false)
    await until('the orchestrator told', () =>
      told.some((text) => text.includes('app/write-up is held')),
    )
    expect(told.find((text) => text.includes('app/write-up is held'))).toContain(
      'It was planned against code that has moved since',
    )

    // Said once: the hold is not repeated at every look while it waits.
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    expect((await client.events({ types: ['queue_held'], task: 'app/write-up' })).length).toBe(1)

    // The person's answer is written down, read back, and it starts.
    expect(await tools.change({ task: 'app/write-up', change: 'start', by: 'you' })).toBe(
      'Done. Started app/write-up.',
    )
    const [started] = await client.events({ types: ['queue_started'], task: 'app/write-up' })
    expect(started?.detail.why).toBe('it was started anyway')
  }, 60_000)

  it('holds work whose dependency stopped, tells the orchestrator, and starts it when told to', async () => {
    const told: string[] = []
    const window = await start({
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the first frame', () => terminal.written.includes('refunds'))
    const tools = window.queueTools()
    await tools.plan({
      project: 'app',
      said: 'first, then second',
      agents: [
        { name: 'first', said: 'first', prompt: '', after: [], touches: [] },
        {
          name: 'second',
          said: 'second',
          prompt: '',
          after: [{ agent: 'first', why: '' }],
          touches: [],
        },
      ],
    })
    await client.stopAgent('app/first')
    await until(
      'the hold written down',
      async () => (await client.events({ types: ['queue_held'] })).length === 1,
      10_000,
    )
    await until('the orchestrator told', () =>
      told.some((text) => text.includes('app/second is held')),
    )
    expect(await tools.describe()).toContain(
      'app/second — held: app/first was stopped before it finished',
    )

    expect(await tools.change({ task: 'app/second', change: 'start' })).toBe(
      'Done. Started app/second.',
    )
    expect(client.runs().some((run) => run.task === 'app/second')).toBe(true)
  }, 60_000)

  it('searches with ctrl+k, finding agents and files, and opens a file to read', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of 'sear') terminal.press(char)
    await until('the search agent', () => terminal.written.includes('in app'))

    // A file in the repository, by part of its name, opened where it is read.
    terminal.press('\x15')
    for (const char of 'readme') terminal.press(char)
    // Its mark as well as its name: the sidebar lists README.md too.
    await until('the file', () => terminal.written.includes('□ README.md'))
    terminal.written = ''
    terminal.press('\r')
    await until('the viewer', () => terminal.written.includes('Open in editor'))
    await until('what the file says', () => terminal.written.includes('fixture'))
  })

  it('asks what a sentence means when the letters find nothing, and shows what comes back', async () => {
    const asked: { said: string; choices: string[] }[] = []
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'reader',
          title: 'Reader',
          description: 'Reads a sentence.',
          meant: async (_ctx, request) => {
            asked.push({ said: request.said, choices: request.choices.map((one) => one.id) })
            // Only ever something already in front of them.
            return request.choices
              .filter((one) => one.label.toLowerCase().includes('refunds'))
              .slice(0, 1)
              .map((one) => one.id)
          },
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await start({ extensions })
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    terminal.written = ''
    // A sentence, not the start of a name: almost none of its letters are in
    // anything the window has, so matching finds nothing.
    for (const char of 'stop whoever is on the refunds thing') terminal.press(char)
    await until('nothing matching', () => terminal.written.includes('Nothing matches'))

    await until('what it might mean', () => terminal.written.includes('MIGHT MEAN (1)'))
    // The same entry the window always had, under a heading of its own: its
    // own mark, where it is, and nothing lit — because nothing matched.
    await until('the thing it meant', () => terminal.written.includes('○ refunds  in app'))
    // It is asked about what they typed, and only about what is already there.
    expect(asked[0]?.said).toBe('stop whoever is on the refunds thing')
    expect(asked[0]?.choices.length).toBeGreaterThan(0)
    expect(asked[0]?.choices.every((id) => id.includes(':'))).toBe(true)
  })

  it('looks inside files for what you type', async () => {
    writeFileSync(join(repo.root, 'ledger.ts'), 'export const refundTwice = false\n')
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of '#refundtwice') terminal.press(char)
    // Case does not matter, and the line is said with the file.
    await until('the line inside the file', () => terminal.written.includes('ledger.ts:1'))
  })

  it('keeps a note added with the + beside NOTES, word for word, about the project', async () => {
    terminal.rows = 60
    await start()
    await until('the notes heading', () =>
      screenOf(terminal.written).some((row) => row.includes('NOTES')),
    )
    const heading = find('NOTES')
    const plus = (screenOf(terminal.written)[heading.row] ?? '').indexOf('+', heading.col)
    terminal.written = ''
    click(plus, heading.row)
    await until('the note panel', () => terminal.written.includes('New note'))
    for (const char of 'Staging key rotates on the 1st') terminal.press(char)
    terminal.press('\r')
    await until('the note kept', () => client.recallAll().length === 1)
    expect(client.recallAll()[0]).toMatchObject({
      text: 'Staging key rotates on the 1st',
      scope: 'app',
    })
  })

  it('scrolls the sidebar by dragging the bar down its right', async () => {
    // Short of room, so there is more in the sidebar than fits and the bar has
    // a thumb to take hold of.
    terminal.columns = 100
    terminal.rows = 14
    await start()
    await until('the first frame', () =>
      screenOf(terminal.written).some((row) => row.includes('AGENTS')),
    )
    const lines = screenOf(terminal.written)
    const top = lines.findIndex((line) => line.includes('AGENTS'))
    const bar = (lines[top] ?? '').indexOf('\u2502') - 1
    expect(bar).toBeGreaterThan(10)
    const thumb = lines.findIndex((line) => line[bar] === '\u2588')
    expect(thumb).toBeGreaterThanOrEqual(top)
    // Pressed on the thumb, dragged to the foot of the track, let go.
    terminal.press(`\x1b[<0;${bar + 1};${thumb + 1}M`)
    terminal.press(`\x1b[<32;${bar + 1};${thumb + 6}M`)
    terminal.press(`\x1b[<0;${bar + 1};${thumb + 6}m`)
    await until(
      'the sidebar scrolled',
      () => !(screenOf(terminal.written)[top] ?? '').includes('AGENTS'),
    )
  }, 30_000)

  it('puts the caret where you click in what you have typed', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Clicking the line opens it; then it takes what you type.
    const line = find('Ask Tade anything')
    click(line.col, line.row)
    await until('the line open', () =>
      screenOf(terminal.written).some((row) => row.includes('enter sends')),
    )
    for (const char of 'abcdef') terminal.press(char)
    await until('what was typed', () =>
      screenOf(terminal.written).some((row) => row.includes('abcdef')),
    )
    // A click in the middle of it, and then a letter: it lands where the click was.
    const typed = find('abcdef')
    click(typed.col + 2, typed.row)
    terminal.press('X')
    await until('the caret moved', () =>
      screenOf(terminal.written).some((row) => row.includes('abXcdef')),
    )
  }, 30_000)

  it('finds in an open file, types a short edit into it, and saves it with ctrl+s', async () => {
    const path = join(repo.root, 'ledger.ts')
    writeFileSync(path, 'export const rate = 1\nexport const other = 2\n')
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x0b')
    await until('search', () => terminal.written.includes('Search'))
    for (const char of 'ledger') terminal.press(char)
    await until('the file', () => terminal.written.includes('□ ledger.ts'))
    terminal.press('\r')
    await until('the viewer', () => terminal.written.includes('Open in editor'))
    await until('what the file says', () =>
      screenOf(terminal.written).some((row) => row.includes('export const rate = 1')),
    )

    // ctrl+f: the bar, and how many it found.
    terminal.written = ''
    terminal.press('\x06')
    await until('the find bar', () => terminal.written.includes('Find'))
    for (const char of 'const') terminal.press(char)
    await until('what it found', () =>
      screenOf(terminal.written).some((row) => row.includes('1 of 2')),
    )
    terminal.press('\x1b')

    // A click at the end of the first line puts the caret there; then it types.
    const line = find('export const rate = 1')
    click(line.col + 'export const rate = 1'.length, line.row)
    terminal.press('0')
    await until('what was typed where it was clicked', () =>
      screenOf(terminal.written).some((row) => row.includes('export const rate = 10')),
    )
    expect(readFileSync(path, 'utf8')).toBe('export const rate = 1\nexport const other = 2\n')

    // ctrl+s, and the file on disk is what is on screen.
    terminal.press('\x13')
    await until(
      'the file saved',
      () => readFileSync(path, 'utf8') === 'export const rate = 10\nexport const other = 2\n',
    )
    await until('it to say so', () => terminal.written.includes('Saved ledger.ts'))
  }, 30_000)

  it('moves an agent to where it is dragged in the list, and remembers it there', async () => {
    await start()
    await until('both agents', () => {
      const lines = screenOf(terminal.written)
      return (
        lines.some((row) => row.includes('refunds')) && lines.some((row) => row.includes('search'))
      )
    })
    const from = find('refunds')
    const to = find('search')
    expect(from.row).toBeLessThan(to.row)
    // Pressed, moved with the button held, and let go over the other agent.
    terminal.press(`\x1b[<0;${from.col + 1};${from.row + 1}M`)
    terminal.press(`\x1b[<32;${from.col + 1};${from.row + 2}M`)
    terminal.press(`\x1b[<32;${from.col + 1};${to.row + 1}M`)
    terminal.press(`\x1b[<0;${from.col + 1};${to.row + 1}m`)
    await until('the new order on screen', () => find('search').row < find('refunds').row)
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.order.app.indexOf('app/search')).toBeLessThan(kept.order.app.indexOf('app/refunds'))
  })

  it('opens how hard an agent thinks from the button beside its model', async () => {
    terminal.columns = 160
    await start()
    await until('the thinking button', () =>
      screenOf(terminal.written).some(
        (row) => row.includes('thinking ▾') || row.includes('think ▾'),
      ),
    )
    // Its own button, on its pane's header near the top — not the
    // orchestrator's, which is the same control at the foot of the window.
    const button = (() => {
      const lines = screenOf(terminal.written)
      for (let row = 0; row < lines.length; row++) {
        const col = (lines[row] ?? '').search(/think(ing)? ▾/)
        if (col >= 0) return { col, row }
      }
      throw new Error('no thinking button')
    })()
    terminal.written = ''
    click(button.col + 1, button.row)
    await until('the levels', () => {
      const shown = screenOf(terminal.written).join('\n')
      return shown.includes('Thinking') && shown.includes('xhigh') && shown.includes('max')
    })
  })

  it('closes an agent with its ×: stopped, and gone from the list', async () => {
    await start()
    await until('the agent', () =>
      screenOf(terminal.written).some((row) => row.includes('refunds')),
    )
    const agent = find('refunds')
    terminal.press(`\x1b[<35;${agent.col + 1};${agent.row + 1}M`)
    await until('its buttons', () => (screenOf(terminal.written)[agent.row] ?? '').includes('×'))
    click((screenOf(terminal.written)[agent.row] ?? '').indexOf('×'), agent.row)
    // Nothing of it unmerged, so nothing to ask: it goes.
    await until('it to be removed', async () =>
      (await client.events({ types: ['task_removed'] })).some(
        (event) => event.task === 'app/refunds',
      ),
    )
    await until('the list without it', () =>
      screenOf(terminal.written)
        .slice(0, 12)
        .every((row) => !row.includes('refunds')),
    )
  })

  it('asks before closing an agent whose worktree has work not merged', async () => {
    const worktree = repo.addTask('ledger', { project: 'app', intent: 'ledger rounding' })
    repo.commit('half the rounding fix', { 'ledger.ts': 'export const round = 2\n' }, worktree)
    await start()
    await until('the agent', () => screenOf(terminal.written).some((row) => row.includes('ledger')))
    const agent = find('ledger')
    terminal.press(`\x1b[<35;${agent.col + 1};${agent.row + 1}M`)
    await until('its buttons', () => (screenOf(terminal.written)[agent.row] ?? '').includes('×'))
    click((screenOf(terminal.written)[agent.row] ?? '').indexOf('×'), agent.row)
    // A commit that is nowhere else is asked about, not thrown away.
    await until('the question', () => terminal.written.includes('Remove ledger?'))
    expect(await client.events({ types: ['task_removed'] })).toEqual([])
  })

  it('forgets a note from the × that pointing at it shows', async () => {
    terminal.rows = 60
    client.remember('the staging key rotates on the 1st', 'app', 'test')
    await start()
    await until('the notes heading', () =>
      screenOf(terminal.written).some((row) => row.includes('NOTES')),
    )
    // Notes start folded: opened the way a person would.
    const heading = find('NOTES')
    click(heading.col, heading.row)
    // Found by a word on its first line: a note that runs on breaks onto a second.
    await until('the note', () => screenOf(terminal.written).some((row) => row.includes('staging')))
    const note = find('staging')
    // The pointer moving over it, with no button held.
    terminal.press(`\x1b[<35;${note.col + 1};${note.row + 1}M`)
    await until('its buttons', () => (screenOf(terminal.written)[note.row] ?? '').includes('×'))
    click((screenOf(terminal.written)[note.row] ?? '').indexOf('×'), note.row)
    await until('the note forgotten', () => client.recallAll().length === 0)
  })

  it('types to the orchestrator when clicked, and leaves the agent in view', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const strip = find('orchestrator')
    terminal.written = ''
    click(strip.col + 2, strip.row)
    await until('the line to open', () => terminal.written.includes('here'))
    // The pane still says whose agent it is.
    expect(screenOf(terminal.written).join('\n')).not.toContain('Nothing is running')
  })

  it("opens a file's menu with a right-click in FILES", async () => {
    terminal.rows = 60
    await start()
    await until('the files', () =>
      screenOf(terminal.written).some((row) => row.includes('README.md')),
    )
    const file = find('README.md')
    terminal.written = ''
    terminal.press(`\x1b[<2;${file.col + 2};${file.row + 1}M`)
    terminal.press(`\x1b[<2;${file.col + 2};${file.row + 1}m`)
    await until('the menu', () => terminal.written.includes('Copy relative path'))
  })

  it('opens a terminal from the + beside the orchestrator, and types into it', async () => {
    await start()
    await until('the tabs', () =>
      screenOf(terminal.written).some((row) => row.includes('orchestrator')),
    )
    // The tab row, which the rule runs along.
    const rows = screenOf(terminal.written)
    const tabRow = rows.findIndex((line) => line.includes('orchestrator') && line.includes('━'))
    const row = rows[tabRow] ?? ''
    click(row.indexOf('+', row.indexOf('orchestrator')), tabRow)
    await until('a terminal', () => client.terminals('app').length === 1)
    await until('its tab', () => terminal.written.includes('terminal 1'))
    // The keyboard is in it now: typed keys are the shell's.
    for (const char of 'echo tade-$((6 * 7))') terminal.press(char)
    terminal.press('\r')
    const deadline = Date.now() + 20_000
    while (!(await client.readTerminal('1', 50, 'app')).includes('tade-42')) {
      if (Date.now() > deadline) throw new Error('the command never ran')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }, 30_000)

  it('opens and names a terminal when told to in words', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.press('\x00') // opens the line you type into
    for (const char of 'open a terminal called logs') terminal.press(char)
    terminal.press('\r')
    await until('the terminal', () => client.terminals('app').some((one) => one.name === 'logs'))
    await until('its tab', () => terminal.written.includes('logs'))
  }, 30_000)

  it('moves the sidebar edge where it is dragged, and remembers it', async () => {
    terminal.columns = 120
    terminal.rows = 40
    const running = await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    const lines = screenOf(terminal.written)
    const row = lines.findIndex((line) => line.includes('AGENTS'))
    const edge = (lines[row] ?? '').indexOf('│')
    expect(edge).toBeGreaterThan(10)
    // Press on the edge, move with the button held, let go.
    terminal.press(`\x1b[<0;${edge + 1};${row + 1}M`)
    terminal.press(`\x1b[<32;${edge + 11};${row + 1}M`)
    terminal.press(`\x1b[<0;${edge + 11};${row + 1}m`)
    await until('the new edge', () => {
      const after = screenOf(terminal.written)[row] ?? ''
      return after.indexOf('│') === edge + 10 || after.indexOf('┃') === edge + 10
    })
    await running.stop()
    const kept = JSON.parse(readFileSync(join(home, 'window.json'), 'utf8'))
    expect(kept.sidebarWidth).toBe(edge + 10)
  }, 30_000)

  it('runs an extension from its panel, and shows it working and what it said', async () => {
    terminal.columns = 120
    terminal.rows = 40
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining where a project lives.',
          tools: [
            {
              name: 'weather_now',
              description: 'Is it raining.',
              parameters: { type: 'object', properties: { project: { type: 'string' } } },
              for: ['orchestrator'],
              run: async (input, ctx) => {
                ctx.progress('looking outside')
                return { text: `Dry over **${String(input.project)}** today.` }
              },
            },
          ],
          actions: [{ id: 'now', title: 'Is it raining?', tool: 'weather_now', project: true }],
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await start({ extensions })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('the panel', () =>
      screenOf(terminal.written).some((row) => row.includes('● Weather  built-in · ready')),
    )
    // The keyboard starts on the first action; enter runs it for the project you are in.
    terminal.press('\r')
    await until('its answer in the conversation', () =>
      screenOf(terminal.written).some((row) => row.includes('Dry over app today.')),
    )
    expect(screenOf(terminal.written).some((row) => row.includes('✓ weather now · app'))).toBe(true)
  })

  it('turns an extension off, and sets one up from the guide it gives', async () => {
    terminal.columns = 120
    terminal.rows = 50
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          settings: [{ key: 'city', kind: 'string', means: 'where' }],
          ready: (ctx) => (ctx.settings.city ? null : 'which city?'),
          setup: () => ({
            guide: ['Say which **city** to look at.'],
            fields: [
              { key: 'city', label: 'City', kind: 'text', choices: async () => ['Vienna', 'Graz'] },
            ],
          }),
        },
        {
          name: 'clock',
          title: 'Clock',
          description: 'The time.',
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
    })
    await start({ extensions })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('the panel', () =>
      screenOf(terminal.written).some((row) => row.includes('◐ Weather')),
    )

    // The clock is on; turning it off writes that down.
    const off = screenOf(terminal.written).findIndex((row) => row.includes('● Clock'))
    const turnOff = find('Turn off ]')
    click(turnOff.col + 2, turnOff.row > off ? turnOff.row : off + 2)
    await until('the clock off', () =>
      screenOf(terminal.written).some((row) => row.includes('○ Clock')),
    )
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('enabled: false')

    // Weather needs setting up: its guide, what it offers, and saving checks it.
    const setup = find('Set up… ]')
    click(setup.col + 2, setup.row)
    await until('the guide and its choices', () =>
      screenOf(terminal.written).some((row) => row.includes('Graz ]')),
    )
    const graz = find('Graz ]')
    click(graz.col + 1, graz.row)
    const save = find('Save and check ]')
    click(save.col + 2, save.row)
    await until('ready', () =>
      screenOf(terminal.written).some((row) => row.includes('Saved. Weather is ready.')),
    )
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('city: Graz')
  })

  it('takes a pasted key, keeps it out of the config, and never draws it', async () => {
    terminal.columns = 120
    terminal.rows = 50
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const secrets = Secrets.open({ home, platform: 'linux' })
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'weather',
          title: 'Weather',
          description: 'Whether it is raining.',
          settings: [
            { key: 'key', kind: 'secret', env: 'WEATHER_API_KEY', means: 'the forecast key' },
          ],
          ready: (ctx) => (ctx.secret('key') ? null : 'weather needs a key'),
          setup: () => ({
            guide: ['Paste the key from the console.'],
            fields: [{ key: 'key', label: 'API key', kind: 'secret' }],
          }),
        },
      ],
      config: { extensions: {}, projects: { app: { root: repo.root } } },
      home,
      env: {},
      secrets,
    })
    await start({ extensions })
    await until('the footer', () =>
      screenOf(terminal.written).some((row) => row.includes('Extensions ]')),
    )
    const button = find('Extensions ]')
    click(button.col + 2, button.row)
    await until('the panel', () =>
      screenOf(terminal.written).some((row) => row.includes('◐ Weather')),
    )
    const setup = find('Set up… ]')
    click(setup.col + 2, setup.row)
    await until('the field', () =>
      screenOf(terminal.written).some((row) => row.includes('API key')),
    )
    for (const char of 'wk_0123456789') terminal.press(char)
    await until('bullets where the key is', () =>
      screenOf(terminal.written).some((row) => row.includes('•••')),
    )
    // Typed, and nowhere on the screen: not as it is typed, not after.
    expect(terminal.written).not.toContain('wk_0123456789')
    const save = find('Save and check ]')
    click(save.col + 2, save.row)
    await until('ready', () =>
      screenOf(terminal.written).some((row) => row.includes('Weather is ready')),
    )
    // Kept where keys are kept — and not in the config, which people commit.
    expect(secrets.get('weather.key')).toBe('wk_0123456789')
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).not.toContain('wk_0123456789')
    expect(terminal.written).not.toContain('wk_0123456789')
  })

  it('keeps what an extension watches in the status bar, and opens its view from there', async () => {
    terminal.columns = 140
    terminal.rows = 40
    let asked = 0
    const extensions = await ExtensionHost.load({
      builtin: [
        {
          name: 'meter',
          title: 'Meter',
          description: 'A number that goes up.',
          status: async () => ({ text: `meter ${++asked}` }),
          view: async () =>
            [
              '**Everything the meter knows.**',
              ...Array.from({ length: 80 }, (_, i) => `- reading ${i}`),
            ].join('\n'),
        },
      ],
      config: { extensions: {}, projects: {} },
      home,
    })
    await start({
      extensions,
      extensionWorkbench: {
        pid: process.pid,
        lanes: () => [],
        agents: () => [],
        startAgent: async () => ({ task: '', worktree: '' }),
      },
    })
    await until('the status', () =>
      screenOf(terminal.written).some((row) => row.includes('meter 1')),
    )
    const status = find('meter 1')
    click(status.col + 1, status.row)
    await until('the view', () =>
      screenOf(terminal.written).some((row) => row.includes('Everything the meter knows.')),
    )
    terminal.press('\x1b[6~')
    await until('it to scroll', () =>
      screenOf(terminal.written).some((row) => row.includes('↑↓ scrolls · 11–')),
    )
  })

  it('opens the Spend panel from the status bar', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('today'))
    const status = find('today')
    terminal.written = ''
    click(status.col + 1, status.row)
    await until('the spend panel', () => terminal.written.includes('BUDGETS'))
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

  it('shows agent spend in the status bar', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('today'))
    terminal.written = ''
    await client.log.append({
      type: 'usage',
      task: 'app/refunds',
      detail: { model: 'anthropic/claude-sonnet-5', tokens: 1500, usd: 0.351 },
    })
    await until('agent spend in status bar', () => terminal.written.includes('$0.35'))
  })
})

describe('a project with nothing in it', () => {
  it('starts agents in the checkout together, and in worktree mode names a branch at the first change', async () => {
    const repo = mkrepo()
    repo.commit('first')
    const home = tmp('tade-app-')
    const yaml = (workspace: string) =>
      `projects:\n  empty:\n    root: ${repo.root}\nagents:\n  workspace: ${workspace}\n`
    writeFileSync(join(home, 'config.yaml'), yaml('worktree'))
    const client = await Workbench.open({ home })
    const terminal = new FakeTerminal()
    const speaker = await Speaker.create({
      soundDir: tmp('tade-app-sound-'),
      platform: 'darwin',
      run: async () => {},
    })
    const app = await App.start({
      client,
      config: ConfigSchema.parse({
        projects: { empty: { root: repo.root } },
        agents: { workspace: 'worktree' },
      }),
      home,
      cwd: repo.root,
      terminal,
      speaker,
      frameMs: 50,
    })
    try {
      // Opening the window makes nothing: an agent is started when you ask for one.
      await new Promise((resolve) => setTimeout(resolve, 300))
      expect(await client.events({ types: ['task_created'] })).toEqual([])
      const button = () => {
        const lines = screenOf(terminal.written)
        for (let row = lines.length - 1; row >= 0; row--) {
          const col = lines[row]?.indexOf('+ New agent') ?? -1
          if (col >= 0) return { col, row }
        }
        return null
      }
      const deadline = Date.now() + 20_000
      while (!button()) {
        if (Date.now() > deadline) throw new Error('no New agent button')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const at = button() as { col: number; row: number }
      terminal.press(`\x1b[<0;${at.col + 3};${at.row + 1}M`)
      terminal.press(`\x1b[<0;${at.col + 3};${at.row + 1}m`)
      const made = async () => (await client.events({ types: ['task_created'] }))[0]
      while (!(await made())) {
        if (Date.now() > deadline) throw new Error('no agent was opened')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const created = await made()
      expect(created).toMatchObject({
        task: 'empty/agent-1',
        detail: { branch: '', workspace: 'worktree' },
      })

      // Its first change is what gives it a branch.
      const worktree = String(created?.detail.worktree)
      writeFileSync(join(worktree, 'refunds.ts'), 'export const once = true\n')
      const named = Date.now() + 20_000
      while ((await client.events({ types: ['task_named'] })).length === 0) {
        if (Date.now() > named) throw new Error('the branch was never named')
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
      const [event] = await client.events({ types: ['task_named'] })
      expect(event).toMatchObject({ task: 'empty/agent-1', detail: { branch: 'tade/agent-1' } })
    } finally {
      await app.stop().catch(() => {})
      await client.close().catch(() => {})
    }
  }, 60_000)
})
