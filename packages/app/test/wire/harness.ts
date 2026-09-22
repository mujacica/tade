import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Terminal } from '@earendil-works/pi-tui'
import { ConfigSchema } from '@tade/core'
import { Speaker } from '@tade/voice-tts'
import { Workbench } from '@tade/workbench'
import { afterEach, beforeEach } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { App, type AppOptions } from '../../src/app.ts'

// The window against a real workbench and a real repository. Everything it
// shows is tested elsewhere without a terminal; what is tested through here is
// the wiring — that it boots, draws, and that a keystroke or a click reaches
// the subject that answers it.
//
// The panels are opened the way a person opens them, through the whole window:
// the screen tests draw each panel from a frame they build themselves, and
// these are what notice when the window stops handing a panel what it needs.
//
// One file per subject, beside this one, named for the subject in `src/wire/`
// that answers it. So a change to one subject fails the file named after it,
// and so sixteen files run sixteen ways under `pool: 'forks'`, where one file
// of eighty-seven tests ran one way.

/**
 * A terminal that keeps what was drawn instead of drawing it, and hands back
 * the callback the TUI registers so a test can press keys.
 */
export class FakeTerminal implements Terminal {
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
export function screenOf(written: string): string[] {
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
export async function until(
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

/** The repository a test is given: two tasks in it, and one commit. */
export type Repo = ReturnType<typeof mkrepo>

/** The window under test, and the world it was started in. */
export interface Wired {
  readonly repo: Repo
  readonly home: string
  readonly client: Workbench
  readonly terminal: FakeTerminal
  /**
   * Every opener the window would have handed to the desktop, in order: your
   * editor, your browser, your file manager. Nothing is spawned — a suite that
   * opened Finder on somebody's machine is what this exists to prevent — and
   * asserting the command and its arguments says more than a spawn offscreen
   * ever did.
   */
  readonly opened: { command: string; args: readonly string[] }[]
  /**
   * Start the window over that world. The last one started is stopped after the
   * test; a test that opens a second window stops the first one itself.
   */
  start(over?: Partial<AppOptions>): Promise<App>
  /**
   * A terminal with nothing on it, for a second window over the same home.
   * What the first window drew belongs to the window that has stopped, and a
   * test that asks whether the new one came back where you left it has to be
   * asking about what the new one drew.
   */
  newTerminal(): FakeTerminal
  /** A left click, as a terminal in SGR mouse mode sends it: press, then release. */
  click(col: number, row: number): void
  /** Where a label is on the last full frame, found the way a person would. */
  find(label: string): { col: number; row: number }
  /** The sidebar alone: everything left of the divider, as one piece of text. */
  sidebar(): string
  /** A sidebar heading and where it is, for pressing what is pinned to its right. */
  headingRow(label?: string): { row: number; text: string }
}

/**
 * A repository, a home, a workbench and a terminal, fresh for every test, and
 * the window started over them.
 *
 * `bind` is handed the same object at the end of the harness's own `beforeEach`,
 * so a file keeps the names its tests read it by — `terminal`, `client` — rather
 * than reaching through a holder five hundred times. A callback rather than a
 * documented hook order, because an order is the kind of thing that breaks
 * silently when somebody moves a line.
 */
export function windowUnderTest(bind?: (wired: Wired) => void): Wired {
  let repo: Repo
  let home: string
  let client: Workbench
  let terminal: FakeTerminal
  let app: App | null = null
  const opened: { command: string; args: readonly string[] }[] = []

  const wired: Wired = {
    get repo() {
      return repo
    },
    get home() {
      return home
    },
    get client() {
      return client
    },
    get terminal() {
      return terminal
    },
    get opened() {
      return opened
    },

    async start(over: Partial<AppOptions> = {}): Promise<App> {
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
        // Never the machine's own desktop either: what would have opened is
        // recorded for the test to read, and nothing is spawned.
        open: async (opener) => {
          opened.push({ command: opener.command, args: opener.args })
        },
        ...over,
      })
      return app
    },

    newTerminal(): FakeTerminal {
      terminal = new FakeTerminal()
      return terminal
    },

    click(col: number, row: number): void {
      terminal.press(`\x1b[<0;${col + 1};${row + 1}M`)
      terminal.press(`\x1b[<0;${col + 1};${row + 1}m`)
    },

    find(label: string): { col: number; row: number } {
      const lines = screenOf(terminal.written)
      for (let row = lines.length - 1; row >= 0; row--) {
        const col = lines[row]?.indexOf(label) ?? -1
        if (col >= 0) return { col, row }
      }
      throw new Error(`"${label}" is not on screen`)
    },

    // The pane beside it draws the same names, so a test about the list has to
    // be about the list.
    sidebar(): string {
      return screenOf(terminal.written)
        .map((line) => {
          const edge = Math.max(line.indexOf('│'), line.indexOf('┃'))
          return edge > 0 ? line.slice(0, edge) : line
        })
        .join('\n')
    },

    headingRow(label = 'AGENTS'): { row: number; text: string } {
      const lines = wired.sidebar().split('\n')
      const row = lines.findIndex((line) => line.includes(label))
      if (row < 0) throw new Error(`no ${label} heading on screen`)
      return { row, text: lines[row] ?? '' }
    },
  }

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
    // Emptied rather than replaced, so a test that took the array off the
    // harness once still holds the one being written to.
    opened.length = 0
    bind?.(wired)
  })

  afterEach(async () => {
    await app?.stop().catch(() => {})
    app = null
    await client.close().catch(() => {})
  })

  return wired
}
