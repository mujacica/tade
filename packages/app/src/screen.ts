import {
  type Component,
  ProcessTerminal,
  type Terminal,
  TuiAltScreen,
  type TuiInputListenerResult,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import type { LaneId } from '@wilco/core'
import { PtyDriver } from '@wilco/drivers-pty'

// A screen for the things Wilco asks you: setting up, and changing settings.
//
// Both used to be printed — a scroll of prompts, and for setup, other people's
// programs handed the terminal with `stdio: 'inherit'` while a readline was
// still reading it. Two readers of one keyboard is why Enter sometimes did
// nothing and characters vanished.
//
// So the terminal belongs to Wilco throughout. Anything it has to run goes in
// a lane, exactly as an agent does, and its screen is drawn inside this one.
// That is the claim the rest of Wilco makes — a window over things running
// somewhere else — applied to the last place that was still shelling out.

const LOGO = [
  '██╗    ██╗██╗██╗      ██████╗ ██████╗ ',
  '██║    ██║██║██║     ██╔════╝██╔═══██╗',
  '██║ █╗ ██║██║██║     ██║     ██║   ██║',
  '██║███╗██║██║██║     ██║     ██║   ██║',
  '╚███╔███╔╝██║███████╗╚██████╗╚██████╔╝',
  ' ╚══╝╚══╝ ╚═╝╚══════╝ ╚═════╝ ╚═════╝ ',
]
/** Below this the banner is taking room the questions need. */
const ROOM_FOR_LOGO = { width: 46, height: 24 }

/**
 * How the screen is coloured.
 *
 * A function per role rather than a table of codes, so the plain palette is
 * the identity function and everything downstream stays a string. Colour is
 * decoration: every screen has to read correctly without it, because plenty of
 * terminals, pipes and CI logs will never show it.
 */
export interface Palette {
  title(text: string): string
  rule(text: string): string
  done(text: string): string
  todo(text: string): string
  optional(text: string): string
  cursor(text: string): string
  hint(text: string): string
  said(text: string): string
}

const plain = (text: string) => text
export const PLAIN: Palette = {
  title: plain,
  rule: plain,
  done: plain,
  todo: plain,
  optional: plain,
  cursor: plain,
  hint: plain,
  said: plain,
}

const paint = (code: string) => (text: string) => `\x1b[${code}m${text}\x1b[0m`
const COLOUR: Palette = {
  title: paint('1;36'),
  rule: paint('2;36'),
  done: paint('32'),
  todo: paint('33'),
  optional: paint('2'),
  cursor: paint('1;36'),
  hint: paint('2'),
  said: paint('2'),
}

/**
 * Colour, where the terminal is one that shows it.
 *
 * `NO_COLOR` is honoured because people who set it mean it, and a `dumb`
 * terminal or a pipe gets nothing: escape codes in a log file are worse than
 * plain text, and this is the one decision that cannot be made from inside the
 * renderer, which is pure.
 */
export function paletteFor(env: NodeJS.ProcessEnv = process.env, tty = true): Palette {
  if (!tty) return PLAIN
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return PLAIN
  if (env.TERM === 'dumb' || !env.TERM) return PLAIN
  return COLOUR
}

export interface Prompt {
  question: string
  /** Shown in brackets and used when the answer is empty. */
  fallback: string
  /** Answers are yes/no rather than free text. */
  confirm: boolean
}

export interface Menu {
  question: string
  options: readonly string[]
  /** Which one is under the cursor. */
  index: number
}

export interface ScreenState {
  /** What this screen is for, shown beside the banner. */
  title: string
  /** Standing context: a checklist, a file path, whatever is always true. */
  context: readonly string[]
  /** What has happened so far, oldest first. */
  said: readonly string[]
  prompt: Prompt | null
  menu: Menu | null
  /** What has been typed at the prompt. */
  typed: string
  /** An embedded terminal, when something is running inside the window. */
  running: { title: string; screen: string } | null
  finished: string
}

export function initialScreen(title: string, context: readonly string[] = []): ScreenState {
  return {
    title,
    context,
    said: [],
    prompt: null,
    menu: null,
    typed: '',
    running: null,
    finished: '',
  }
}

/** Wilco is stopped the way every terminal program is: ctrl+c. */
export class ScreenCancelled extends Error {
  readonly code = 'SCREEN_CANCELLED'
  constructor() {
    super('stopped')
    this.name = 'ScreenCancelled'
  }
}

/**
 * The whole screen, one string per row.
 *
 * Fixed regions: the banner and whatever is always true at the top, the keys
 * you can press at the bottom, and the question in between. Fixed, because a
 * screen where the question moves as the transcript grows is one you have to
 * search every time you look up.
 *
 * Pure: state in, rows out.
 */
export function renderScreen(
  state: ScreenState,
  frame: { width: number; height: number; palette?: Palette },
): string[] {
  const width = Math.max(30, frame.width)
  const height = Math.max(10, frame.height)
  const paint = frame.palette ?? PLAIN
  const rule = paint.rule('─'.repeat(width))

  const head: string[] = []
  if (width >= ROOM_FOR_LOGO.width && height >= ROOM_FOR_LOGO.height) {
    LOGO.forEach((row, i) => {
      head.push(`  ${paint.cursor(row)}${i === 2 ? `   ${paint.title(state.title)}` : ''}`)
    })
    head.push('')
  } else {
    head.push(`  ${paint.cursor('W I L C O')} · ${paint.title(state.title)}`)
  }
  head.push(rule)
  for (const line of state.context) head.push(`  ${colourContext(line, paint)}`)
  if (state.context.length > 0) head.push(rule)

  const foot = [rule, `  ${paint.hint(keys(state))}`]
  const body = renderBody(state, Math.max(1, height - head.length - foot.length), paint)

  // Clamped to what the terminal actually has, not to the minimum this layout
  // wants: drawing one row more than there is scrolls the screen out from
  // under itself, and a cramped window is somebody's split pane, not a bug.
  return [...head, ...body, ...foot].slice(0, frame.height).map((row) => pad(row, width))
}

/**
 * The context lines are somebody else's strings — a checklist, a path — and
 * the marks at the front are the only part with a meaning worth colouring.
 */
function colourContext(line: string, paint: Palette): string {
  const mark = line.trimStart().slice(0, 1)
  if (mark === '✓') return paint.done(line)
  if (mark === '·' || mark === '▸') return paint.todo(line)
  if (mark === '○') return paint.optional(line)
  return line
}

function keys(state: ScreenState): string {
  if (state.running) return 'ctrl+] leave it · ctrl+c quit'
  if (state.menu) return '↑↓ choose · enter accept · ctrl+c quit'
  if (state.prompt) return 'enter accepts the suggestion · ctrl+c quit'
  return 'ctrl+c quit'
}

function renderBody(state: ScreenState, height: number, paint: Palette): string[] {
  if (state.running) {
    const rows = [`  ${paint.title(state.running.title)}`, '']
    const screen = state.running.screen.split('\n')
    // Tail it: what a program just printed is what you need to answer.
    for (const line of screen.slice(Math.max(0, screen.length - (height - 2)))) {
      rows.push(`  ${line}`)
    }
    return fill(rows, height)
  }

  if (state.menu) {
    const menu = state.menu
    const rows = [`  ${paint.title(menu.question)}`, '']
    menu.options.forEach((option, i) => {
      const here = i === menu.index
      rows.push(here ? `  ${paint.cursor(`▸ ${option}`)}` : `    ${paint.said(option)}`)
    })
    return fill(rows, height)
  }

  // The transcript, newest last, cropped to whatever is left after the
  // question — which is always on screen, because it is the thing to answer.
  const spare = Math.max(0, height - (state.prompt ? 3 : 1))
  const rows = state.said.slice(-spare).map((said) => `  ${paint.said(said)}`)
  const before = fill(rows, spare)
  if (state.prompt) {
    const shown = state.prompt.confirm
      ? `${state.prompt.question} [${state.prompt.fallback === 'y' ? 'Y/n' : 'y/N'}]`
      : `${state.prompt.question}${state.prompt.fallback ? ` [${state.prompt.fallback}]` : ''}`
    return [...before, '', `  ${paint.cursor('❯')} ${shown}: ${state.typed}`, ''].slice(0, height)
  }
  if (state.finished) return [...before, `  ${paint.done(state.finished)}`].slice(0, height)
  return before
}

function fill(rows: string[], height: number): string[] {
  while (rows.length < height) rows.push('')
  return rows.slice(0, height)
}

function pad(text: string, width: number): string {
  // By what it looks like, not by how long the string is: `padEnd` counts the
  // bytes in a colour code, so a coloured row would come out short and the
  // whole screen ragged down one side.
  const clipped = truncateToWidth(text, width)
  return clipped + ' '.repeat(Math.max(0, width - visibleWidth(clipped)))
}

/** What a flow can do to the screen. */
export interface Ui {
  /** Put a line in the transcript. */
  say(text: string): void
  /** Replace the standing context above the question. */
  context(lines: readonly string[]): void
  ask(question: string, fallback?: string): Promise<string>
  confirm(question: string, fallback: boolean): Promise<boolean>
  /** Pick one of several. Returns the index. */
  choose(question: string, options: readonly string[]): Promise<number>
  /**
   * Run something in a terminal inside the window, and wait for it. Every
   * keystroke goes to it while it runs, because Wilco is the only thing
   * reading the keyboard.
   */
  run(title: string, command: string, args: string[]): Promise<number>
}

export interface ScreenOptions {
  title: string
  context?: readonly string[]
  /** Injected by tests; the real terminal otherwise. */
  terminal?: Terminal
  driver?: PtyDriver
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** How often an embedded terminal is re-read. */
  frameMs?: number
  /** Defaults to colour where the terminal shows it. */
  palette?: Palette
}

/** ctrl+] — the way out of an embedded program, as telnet has always had it. */
const LEAVE = '\x1d'
const INTERRUPT = '\x03'
const UP = '\x1b[A'
const DOWN = '\x1b[B'

/**
 * Draw the screen and run `flow` against it.
 *
 * The screen lives as long as the flow does, and the terminal is restored on
 * every path out — ctrl+c and a thrown error included. Leaving somebody in the
 * alternate screen because something failed is a worse outcome than whatever
 * failed.
 */
export async function runScreen(
  opts: ScreenOptions,
  flow: (ui: Ui) => Promise<void>,
): Promise<void> {
  const terminal = opts.terminal ?? new ProcessTerminal()
  const driver = opts.driver ?? new PtyDriver({ scrollback: 2_000 })
  const tui = new TuiAltScreen(terminal)
  let state = initialScreen(opts.title, opts.context ?? [])

  const draw = () => tui.requestRender()
  const palette = opts.palette ?? paletteFor(opts.env ?? process.env, true)
  tui.addChild(new Screen(() => ({ state, height: Math.max(10, terminal.rows), palette })))

  /** Whoever is waiting on a keystroke right now. */
  let answer: ((text: string) => void) | null = null
  let lane: LaneId | null = null
  let running = 0

  /** Settles if ctrl+c is pressed, so every wait can race against it. */
  let cancel: (() => void) | null = null
  const cancelled = new Promise<never>((_, reject) => {
    cancel = () => reject(new ScreenCancelled())
  })
  // Nobody may be waiting when ctrl+c arrives, and an unhandled rejection
  // would take the process down with a stack trace instead of a sentence.
  cancelled.catch(() => {})

  const release = tui.addInputListener((data: string): TuiInputListenerResult => {
    if (data.includes(INTERRUPT)) {
      if (lane) void driver.close(lane).catch(() => {})
      cancel?.()
      return { consume: true }
    }
    if (lane) {
      if (data.includes(LEAVE)) {
        void driver.close(lane).catch(() => {})
        return { consume: true }
      }
      void driver.write(lane, new TextEncoder().encode(data)).catch(() => {})
      return { consume: true }
    }
    if (state.menu) {
      const menu = state.menu
      const settle = (index: number) => {
        const chosen = answer
        answer = null
        state = { ...state, menu: null }
        chosen?.(String(index))
      }
      if (data === UP) {
        state = { ...state, menu: { ...menu, index: Math.max(0, menu.index - 1) } }
      } else if (data === DOWN) {
        const last = menu.options.length - 1
        state = { ...state, menu: { ...menu, index: Math.min(last, menu.index + 1) } }
      } else if (data === '\r' || data === '\n') {
        settle(menu.index)
      } else if (/^[1-9]$/.test(data) && Number(data) <= menu.options.length) {
        // The options are numbered on screen; typing one should do what it
        // looks like it does.
        settle(Number(data) - 1)
      }
      draw()
      return { consume: true }
    }
    if (!answer) return { consume: true }
    for (const char of data) {
      if (char === '\r' || char === '\n') {
        const text = state.typed
        state = { ...state, typed: '' }
        const settle = answer
        answer = null
        settle(text)
        break
      }
      if (char === '\x7f' || char === '\b') {
        state = { ...state, typed: state.typed.slice(0, -1) }
        continue
      }
      // Control characters are not answers: ignore rather than paint them.
      if (char >= ' ') state = { ...state, typed: state.typed + char }
    }
    draw()
    return { consume: true }
  })

  tui.start()
  draw()

  /** Wait for an answer, or for ctrl+c, whichever comes first. */
  const waitFor = (): Promise<string> =>
    Promise.race([
      new Promise<string>((resolve) => {
        answer = resolve
      }),
      cancelled,
    ])

  const ui: Ui = {
    say(text) {
      state = { ...state, said: [...state.said, text] }
      draw()
    },
    context(lines) {
      state = { ...state, context: lines }
      draw()
    },
    async ask(question, fallback = '') {
      state = { ...state, prompt: { question, fallback, confirm: false }, typed: '' }
      draw()
      const said = await waitFor()
      state = { ...state, prompt: null }
      draw()
      return said.trim() || fallback
    },
    async confirm(question, fallback) {
      const prompt = { question, fallback: fallback ? 'y' : 'n', confirm: true }
      state = { ...state, prompt, typed: '' }
      draw()
      const said = (await waitFor()).trim().toLowerCase()
      state = { ...state, prompt: null }
      draw()
      return said === '' ? fallback : said.startsWith('y')
    },
    async choose(question, options) {
      state = { ...state, menu: { question, options, index: 0 } }
      draw()
      const picked = Number(await waitFor())
      state = { ...state, menu: null }
      draw()
      return Number.isInteger(picked) ? picked : 0
    },
    async run(title, command, args) {
      const id = `screen/${++running}` as LaneId
      const rows = Math.max(8, terminal.rows - state.context.length - 14)
      await driver.open({
        id,
        cwd: opts.cwd ?? process.cwd(),
        command,
        args,
        cols: Math.max(40, terminal.columns - 4),
        rows,
        ...(opts.env ? { env: stringly(opts.env) } : {}),
      })
      lane = id
      state = { ...state, running: { title, screen: '' } }

      const show = async () => {
        const screen = await driver.capture(id, { lines: rows }).catch(() => '')
        state = { ...state, running: { title, screen } }
        draw()
      }
      // Polled as well as pushed. A capture taken the instant output arrives
      // can beat the emulator to rendering it, and a program that prints once
      // and then waits — which is every login prompt — would leave the screen
      // blank forever with nothing to trigger a second look.
      const stopOutput = driver.onOutput(id, () => void show())
      const ticking = setInterval(() => void show(), opts.frameMs ?? 80)
      ticking.unref?.()
      try {
        return await Promise.race([
          new Promise<number>((resolve) => {
            driver.onExit(id, (exit: { code: number | null }) => resolve(exit.code ?? 0))
          }),
          cancelled,
        ])
      } finally {
        clearInterval(ticking)
        stopOutput()
        lane = null
        state = { ...state, running: null }
        draw()
      }
    },
  }

  try {
    await Promise.race([flow(ui), cancelled])
    state = { ...state, finished: 'Done.' }
    draw()
  } finally {
    release()
    await driver.shutdown().catch(() => {})
    tui.stop()
  }
}

/** node-pty rejects anything that is not a string, which test runners inject. */
function stringly(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === 'string') out[key] = value
  }
  return out
}

class Screen implements Component {
  private readonly frame: () => { state: ScreenState; height: number; palette: Palette }

  constructor(frame: Screen['frame']) {
    this.frame = frame
  }

  render(width: number): string[] {
    const { state, height, palette } = this.frame()
    return renderScreen(state, { width, height, palette })
  }

  invalidate(): void {
    // Nothing is cached: every frame is drawn from the state as it is.
  }
}
