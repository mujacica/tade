import { mkdirSync, writeFileSync } from 'node:fs'
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
    await until('the marker to move', () => /▌\S search/.test(terminal.written))
    await first.stop()

    // A new window, same home: it should not dump you back on the first task.
    terminal = new FakeTerminal()
    await start()
    await until('the window to come back', () => terminal.written.includes('search'))
    expect(terminal.written).toMatch(/▌\S search/)
  })

  it('opens on the first task when it has never been opened before', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    expect(terminal.written).toMatch(/▌\S refunds/)
  })

  it('moves the pane when you ask to be shown something', async () => {
    const transcriber = new ScriptedTranscriber(['show me search'])
    const recorder = new ScriptedRecorder()
    await start({ transcriber, recorder })
    await until('the first frame', () => terminal.written.includes('refunds'))
    // Focus starts on the first task.
    expect(terminal.written).toMatch(/▌\S refunds/)
    terminal.written = ''

    terminal.press('\x00')
    await until('recording to start', () => recorder.started.length === 1)
    terminal.press('\x00')

    // Asking to be shown something has to actually show it, rather than
    // telling you which command would.
    await until('the marker to move', () => /▌\S search/.test(terminal.written))
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
    await until('the first frame', () => terminal.written.includes('New agent'))
    const button = find('+ New agent')
    click(button.col + 2, button.row)
    const deadline = Date.now() + 20_000
    while ((await client.events({ types: ['task_created'] })).length === 0) {
      if (Date.now() > deadline) throw new Error('no agent was made')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const [created] = await client.events({ types: ['task_created'] })
    // Named for nothing in particular, because nothing was said.
    expect(created?.task).toBe('app/agent-1')
  }, 30_000)

  it('opens a project from the + beside the tabs, looking in your home folder', async () => {
    const folders = tmp('wilco-app-home-')
    writeFileSync(join(folders, 'notes.txt'), 'not a folder')
    mkdirSync(join(folders, 'payments'))
    const was = process.env.HOME
    process.env.HOME = folders
    try {
      await start()
      await until('the first frame', () => terminal.written.includes('WILCO'))
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

  it('goes to anything with ctrl+g, and finds the agents there', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('refunds'))
    terminal.written = ''
    terminal.press('\x07')
    await until('the palette', () => terminal.written.includes('Go to anything'))
    for (const char of 'sear') terminal.press(char)
    await until('the search agent', () => terminal.written.includes('agent in app'))
  })

  it('opens the Spend panel from the status bar', async () => {
    await start()
    await until('the first frame', () => terminal.written.includes('today'))
    const status = find('today')
    terminal.written = ''
    click(status.col + 1, status.row)
    await until('the spend panel', () => terminal.written.includes('BUDGETS'))
  })
})
