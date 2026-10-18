import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StdinBuffer, type Terminal } from '@earendil-works/pi-tui'
import { ConfigSchema } from '@tade/core'
import type { AccountStatus, WorkerAdapter } from '@tade/harnesses-core'
import { makeCollector, type StatusCollector } from '@tade/status'
import { Speaker } from '@tade/voice-tts'
import { HARNESS_ADAPTERS, type HarnessOptions, recordAuthored, Workbench } from '@tade/workbench'
import { afterEach, beforeEach } from 'vitest'
import { copyRepo, mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
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
  private onResize: (() => void) | null = null

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.onInput = onInput
    this.onResize = onResize
  }

  /** Made another size, as a terminal window dragged by its corner tells the program in it. */
  resize(columns: number, rows: number): void {
    this.columns = columns
    this.rows = rows
    this.onResize?.()
  }

  /** Press a key, exactly as a terminal would deliver it. */
  press(data: string): void {
    this.onInput?.(data)
  }

  /**
   * What a terminal read from stdin at once — a paste it did not bracket, a
   * flick, keys that piled up while the window was busy — split into
   * sequences the way pi-tui's own terminal splits it, and handed over one
   * after another before anything else runs. One `type` is one read.
   */
  type(chunk: string): void {
    this.stdin.process(chunk)
  }

  private readonly stdin = (() => {
    const buffer = new StdinBuffer()
    buffer.on('data', (sequence) => this.press(sequence))
    buffer.on('paste', (content) => this.press(`\x1b[200~${content}\x1b[201~`))
    return buffer
  })()

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

/**
 * How long to wait on something that is really waiting on a process.
 *
 * Starting an agent starts one for real — a lane, a PTY, a harness process —
 * and the suite runs its files side by side, so a spawn that takes two seconds
 * with the machine to itself takes far longer while two hundred other files are
 * spawning their own. Budgets picked from how long it takes alone were the
 * whole of this repository's flakiness: `queue`, `schedules` and `status` each
 * went red on a busy laptop, as a *timeout*, which reads exactly like the hang
 * it is not and sends whoever sees it looking for a bug that was never there.
 *
 * So it is one number for all of them rather than one per call site, which is
 * what let them drift to ten and fifteen seconds while their neighbours sat at
 * thirty. Loose on purpose, and safely inside the `it` budgets that enclose it
 * so the message you get says what it was waiting for: a test that is genuinely
 * stuck still fails, half a minute later, and half a minute is far cheaper than
 * a suite nobody believes.
 */
export const SPAWNING_MS = 90_000

/**
 * Wait for something to become true, rather than for a fixed time.
 *
 * The default is a liveness bound and not a measurement: nothing here is
 * faster for passing sooner, and the only cost of a loose one is how long a
 * genuinely stuck test takes to say so. At five seconds it was neither — a
 * runner with 279 forked workers on two cores missed it for reasons that had
 * nothing to do with the window, and named `lanes`, then `schedules`, then
 * `queue`, one per run. Twenty, and safely inside the `it` budget that
 * encloses it, so what you get is still `timed out waiting for <what>` rather
 * than vitest's own timeout, which names nothing.
 *
 * Which is why there are no per-test budgets in these files any more, and no
 * per-call-site deadlines either. There were forty-eight of the first and
 * nine of the second, between eight and ninety seconds, and every one of them
 * was somebody's guess about a machine they were not on. A release went red
 * at `Test timed out in 20000ms` with no word about what the window had been
 * waiting for, because the budget and this deadline had drifted to the same
 * number and vitest won the race; the next one went red at sixty on a test
 * that takes fifty-one when it passes. One number here, one in
 * `vitest.config.ts`, and a wide gap between them — so the thing you read is
 * `timed out waiting for <what>` and not vitest naming nothing.
 *
 * Write neither when you add a test. If a wait here is genuinely longer than
 * this, it is `SPAWNING_MS`.
 *
 * `what` may be a function, read once the deadline has passed, so a wait can
 * say what it saw instead of only what it wanted.
 */
export async function until(
  what: string | (() => string),
  ok: () => boolean | Promise<boolean>,
  ms = 45_000,
): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await ok()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`timed out waiting for ${typeof what === 'string' ? what : what()}`)
}

/**
 * How often the window looks at status again in these tests: a quarter of the
 * two seconds a person gets. What the beat does is counted in beats here
 * (`Wired.beats`), so a test that waits for nothing more to happen waits three
 * of them rather than a guess in seconds; a probe about what the beat costs
 * says `beatMs: 2_000`, the one people get.
 */
export const BEAT_MS = 500

/** What every harness says about its sign-in here: nobody is signed in, and nothing was asked. */
const SIGNED_OUT: AccountStatus = {
  signedIn: false,
  who: null,
  plan: null,
  method: null,
  problem: null,
}

/**
 * The harnesses as Tade registers them, except that none of them asks the
 * machine who it is signed in as. The window reads every account when it
 * opens, and the harness's own answer is its real program — `claude auth
 * status`, `codex login status`, a tenth of a second of CPU each on every
 * test, and the developer's own sign-ins read by a suite. An account paid by
 * an API key keeps its own answer, which asks no program. Everything else
 * about an adapter is the real one: an agent a test starts runs for real.
 */
export const HARNESSES: Readonly<Record<string, (opts: HarnessOptions) => WorkerAdapter>> =
  Object.fromEntries(
    Object.entries(HARNESS_ADAPTERS).map(([id, make]) => [
      id,
      (opts: HarnessOptions) => {
        const adapter = make(opts)
        if (opts.account?.kind !== 'api-key') adapter.account = async () => SIGNED_OUT
        return adapter
      },
    ]),
  )

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
   * Start the window over that world, and wait for its first look at status:
   * the window draws before it has looked (*looking…*), and the tests here are
   * about what it does once it knows what there is. `looked: false` hands it
   * over at its first frame instead. The last one started is stopped after the
   * test; a test that opens a second window stops the first one itself.
   */
  start(over?: Partial<AppOptions>, opts?: { looked?: boolean }): Promise<App>
  /**
   * A terminal with nothing on it, for a second window over the same home.
   * What the first window drew belongs to the window that has stopped, and a
   * test that asks whether the new one came back where you left it has to be
   * asking about what the new one drew.
   */
  newTerminal(): FakeTerminal
  /** A left click, as a terminal in SGR mouse mode sends it: press, then release. */
  click(col: number, row: number): void
  /**
   * What sleep the window held off, and what it dropped. Never the machine's
   * own: a suite may not ask the laptop it runs on to stay awake, and could
   * assert nothing about it afterwards if it did.
   */
  readonly awake: { took: string[]; dropped: () => number }
  /** Where a label is on the last full frame, found the way a person would. */
  find(label: string): { col: number; row: number }
  /** The sidebar alone: everything left of the divider, as one piece of text. */
  sidebar(): string
  /** A sidebar heading and where it is, for pressing what is pinned to its right. */
  headingRow(label?: string): { row: number; text: string }
  /**
   * Wait for the window to have looked at status this many more times, each
   * look landed: how a test says "and nothing more happens" about what the
   * beat does, counted in beats rather than seconds (`BEAT_MS`). Only the
   * window's own looks count, so a test that hands `start` a `status` of its
   * own cannot wait on them here.
   */
  beats(count: number): Promise<void>
}

/**
 * The repository every test here starts from: one commit past the first, and
 * two tasks — and a home Tade has opened before, whose `skills` is already the
 * repository Tade keeps there (`recordAuthored`, which makes it). Opening a home
 * for the first time makes that repository, three git processes more on every
 * open; a home somebody uses has had it since its first, and `authored.test.ts`
 * is where the first time is tested.
 */
async function worldToCopy(): Promise<Repo> {
  const repo = mkrepo()
  repo.commit('first')
  repo.addTask('refunds', { project: 'app', intent: 'refunds double-charge on retries' })
  repo.addTask('search', { project: 'app', intent: 'search is slow above ten thousand rows' })
  await recordAuthored(join(repo.home, 'skills'), 'lessons proposed since Tade was last open')
  return repo
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
  let template: Repo | null = null
  let repo: Repo
  let home: string
  let client: Workbench
  let terminal: FakeTerminal
  let app: App | null = null
  const opened: { command: string; args: readonly string[] }[] = []
  const took: string[] = []
  let dropped = 0
  /** The collectors each window here looks through, closed after the test as a window's own would be. */
  const collectors: StatusCollector[] = []
  let looked = 0

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
    awake: { took, dropped: () => dropped },

    async beats(count: number): Promise<void> {
      const from = looked
      await until(`${count} looks at status`, () => looked >= from + count, SPAWNING_MS)
    },

    async start(over: Partial<AppOptions> = {}, opts: { looked?: boolean } = {}): Promise<App> {
      const speaker = await Speaker.create({
        soundDir: tmp('tade-app-sound-'),
        platform: 'darwin',
        // Never actually make a noise in a test run.
        run: async () => {},
      })
      // Read off the title, as a person would: it says *looking…* until the
      // first look lands, and something else from the next look on.
      const from = terminal.titles.length
      // The collector the window makes for itself, in this process, counted
      // as each look lands: one per window, as it would have made, because
      // what it holds between looks is that window's.
      const own = makeCollector('here')
      collectors.push(own)
      const status: StatusCollector = {
        id: own.id,
        collect: async (ask) => {
          const answer = await own.collect(ask)
          looked += 1
          return answer
        },
        close: () => own.close(),
      }
      app = await App.start({
        client,
        config: ConfigSchema.parse({ projects: { app: { root: repo.root } } }),
        home,
        cwd: repo.root,
        terminal,
        speaker,
        frameMs: 50,
        beatMs: BEAT_MS,
        status,
        // Every region kept from one frame to the next is drawn again and
        // compared, so a subject that changes what it hands the frame in place
        // fails whichever test happened to move it (`view/last-frame.ts`).
        checkLastFrame: true,
        // Never the machine's own clipboard: what a developer copied is not a test's to read.
        clipboard: {
          watch: () => ({ stop: () => {} }),
          image: async () => null,
          text: async () => '',
        },
        // Never the machine's own desktop either: what would have opened is
        // recorded for the test to read, and nothing is spawned.
        open: async (opener) => {
          opened.push({ command: opener.command, args: opener.args })
        },
        // Nor the machine's own sleep: what would have been held is recorded,
        // and nothing spawns.
        hold: {
          program: () => '/usr/bin/caffeinate',
          start: (program) => {
            took.push(program)
            return () => {
              dropped += 1
            }
          },
        },
        ...over,
      })
      if (opts.looked !== false) {
        await until('the window to have looked once', () =>
          terminal.titles.slice(from).some((title) => !title.includes('looking…')),
        )
        // And drawn: the title is set in the turn the look lands, while the
        // frame waits on the terminal's pace (`paint.ts`). Where the look is
        // quicker than that — Linux, where git is — the title came first and a
        // test that pressed what it found pressed a blank screen.
        await until('the window to have drawn a frame', () =>
          screenOf(terminal.written).some((row) => row.trim() !== ''),
        )
      }
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
      const drawn = lines.filter((line) => line.trim() !== '')
      throw new Error(
        drawn.length === 0
          ? `"${label}" is not on screen: nothing has been drawn on it yet`
          : `"${label}" is not on screen, which shows:\n${lines.join('\n')}`,
      )
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
    // Built once a file and copied for each test, which is a dozen git
    // processes fewer every time (`copyRepo`): every test here starts from the
    // same two tasks, and each still has a repository of its own to change.
    template ??= await worldToCopy()
    repo = copyRepo(template)
    // The fixture's own home, so status never reads the real machine's agent
    // transcripts — and so the tasks it just made are the ones it finds.
    home = repo.home
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home, harnesses: HARNESSES })
    terminal = new FakeTerminal()
    // Emptied rather than replaced, so a test that took the array off the
    // harness once still holds the one being written to.
    opened.length = 0
    took.length = 0
    dropped = 0
    bind?.(wired)
  })

  afterEach(async () => {
    // What this test opened, taken before anything is awaited: read after the
    // window's stop, `client` may already be the next test's — and nothing at
    // all where this file's first `beforeEach` never got as far as opening one.
    const [window, workbench] = [app, client as Workbench | undefined]
    const looking = collectors.splice(0)
    app = null
    await window?.stop().catch(() => {})
    await Promise.all(looking.map((one) => one.close().catch(() => {})))
    await workbench?.close().catch(() => {})
  })

  return wired
}
