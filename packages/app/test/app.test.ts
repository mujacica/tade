import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import { ConfigSchema } from '@wilco/core'
import { ScriptedRecorder, ScriptedTranscriber } from '@wilco/voice-stt'
import { Speaker } from '@wilco/voice-tts'
import { Workbench } from '@wilco/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { App, type AppOptions } from '../src/app.ts'

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
  setTitle(): void {}
  setProgress(): void {}
}

/** Wait for something to become true, rather than for a fixed time. */
async function until(what: string, ok: () => boolean, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (ok()) return
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
    home = tmp('wilco-app-')
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
      soundDir: tmp('wilco-app-sound-'),
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

  it('always shows the orchestrator', async () => {
    await start()
    // It cannot be closed: it is how you see what Wilco heard.
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

  it('holds a line addressed to Wilco rather than typing it at the agent', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    for (const char of 'wilco par') terminal.press(char)
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
    expect(terminal.written).not.toContain('run wilco attach')
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
    await until('the command list', () => terminal.written.includes('/task'))
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
})
