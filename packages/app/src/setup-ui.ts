import {
  type Component,
  ProcessTerminal,
  type Terminal,
  TuiAltScreen,
  type TuiInputListenerResult,
  truncateToWidth,
} from '@earendil-works/pi-tui'
import type { LaneId, Step } from '@wilco/core'
import { PtyDriver } from '@wilco/drivers-pty'

// The first minute, drawn rather than printed.
//
// Setting Wilco up means running other people's programs — logging into a
// provider, installing a package — and the old way was to hand them the
// terminal with `stdio: 'inherit'` while a readline was still reading it.
// Both then consumed the same keystrokes, which is why Enter sometimes did
// nothing and characters vanished.
//
// So the terminal belongs to Wilco throughout: anything it has to run goes in
// a lane, exactly as an agent does, and its screen is drawn inside the window.
// There is one reader of stdin and it is us. That is the same claim the rest
// of Wilco makes — it is a window over things running somewhere else — applied
// to the one place that was still shelling out.

export interface Prompt {
  question: string
  /** Shown in brackets and used when the answer is empty. */
  fallback: string
  /** Answers are yes/no rather than free text. */
  confirm: boolean
}

export interface SetupState {
  title: string
  steps: readonly Step[]
  /** What has happened so far, oldest first. */
  said: readonly string[]
  prompt: Prompt | null
  /** What has been typed at the prompt. */
  typed: string
  /** An embedded terminal, when something is running inside the window. */
  running: { title: string; screen: string } | null
  finished: string
}

export function initialSetup(steps: readonly Step[]): SetupState {
  return {
    title: 'Setting up Wilco',
    steps,
    said: [],
    prompt: null,
    typed: '',
    running: null,
    finished: '',
  }
}

const MARK: Record<string, string> = { done: '✓', required: '·', optional: '○' }

/** The whole screen, one string per row. Pure: state in, rows out. */
export function renderSetup(state: SetupState, frame: { width: number; height: number }): string[] {
  const width = Math.max(28, frame.width)
  const rows: string[] = []
  const line = (text = '') => rows.push(pad(text, width))

  line(` ${state.title}`)
  line(` ${'─'.repeat(Math.max(0, width - 2))}`)
  for (const step of state.steps) {
    const mark = step.done ? MARK.done : step.required ? MARK.required : MARK.optional
    line(`  ${mark} ${step.title}${step.detail ? ` — ${step.detail}` : ''}`)
  }
  line()

  if (state.running) {
    // The embedded terminal gets whatever is left, and is the point of the
    // screen while it is there: the checklist above is context, not the task.
    line(` ${state.running.title}`)
    const height = Math.max(3, frame.height - rows.length - 2)
    const screen = state.running.screen.split('\n')
    // Tail it: what a program just printed is what you need to answer.
    for (const text of screen.slice(Math.max(0, screen.length - height))) line(`  ${text}`)
    line()
    line(' ctrl+] to leave it')
    return rows.slice(0, frame.height)
  }

  for (const said of state.said.slice(-Math.max(1, frame.height - rows.length - 3))) {
    line(`  ${said}`)
  }
  if (state.prompt) {
    line()
    const shown = state.prompt.confirm
      ? `${state.prompt.question} [${state.prompt.fallback === 'y' ? 'Y/n' : 'y/N'}]`
      : `${state.prompt.question}${state.prompt.fallback ? ` [${state.prompt.fallback}]` : ''}`
    line(` ❯ ${shown}: ${state.typed}`)
  }
  if (state.finished) {
    line()
    line(` ${state.finished}`)
  }
  return rows.slice(0, frame.height)
}

function pad(text: string, width: number): string {
  return truncateToWidth(text, width).padEnd(width, ' ')
}

/** What a setup flow can do to the screen. */
export interface SetupUi {
  /** Put a line in the transcript. */
  say(text: string): void
  /** Replace the checklist, after something has changed. */
  steps(steps: readonly Step[]): void
  ask(question: string, fallback?: string): Promise<string>
  confirm(question: string, fallback: boolean): Promise<boolean>
  /**
   * Run something in a terminal inside the window, and wait for it. Every
   * keystroke goes to it while it runs, because Wilco is the only thing
   * reading the keyboard.
   */
  run(title: string, command: string, args: string[]): Promise<number>
}

export interface SetupUiOptions {
  steps: readonly Step[]
  /** Injected by tests; the real terminal otherwise. */
  terminal?: Terminal
  driver?: PtyDriver
  env?: NodeJS.ProcessEnv
  cwd?: string
  /** How often an embedded terminal is re-read. */
  frameMs?: number
}

/** ctrl+] — the way out of an embedded terminal, as telnet has always had it. */
const LEAVE = '\x1d'

/**
 * Draw the setup screen and run `flow` against it.
 *
 * The screen lives for as long as the flow does, and the terminal is restored
 * on every path out of it, including a thrown error: leaving somebody in the
 * alternate screen because setup failed would be a worse first minute than the
 * one we are trying to fix.
 */
export async function runSetupUi(
  opts: SetupUiOptions,
  flow: (ui: SetupUi) => Promise<void>,
): Promise<void> {
  const terminal = opts.terminal ?? new ProcessTerminal()
  const driver = opts.driver ?? new PtyDriver({ scrollback: 2_000 })
  const tui = new TuiAltScreen(terminal)
  let state = initialSetup(opts.steps)

  const draw = () => tui.requestRender()
  tui.addChild(new Screen(() => ({ state, height: Math.max(8, terminal.rows) })))

  /** Whoever is waiting on a keystroke right now. */
  let answer: ((text: string) => void) | null = null
  let lane: LaneId | null = null
  let running = 0

  const release = tui.addInputListener((data: string): TuiInputListenerResult => {
    if (lane) {
      if (data.includes(LEAVE)) {
        void driver.close(lane).catch(() => {})
        return { consume: true }
      }
      void driver.write(lane, new TextEncoder().encode(data)).catch(() => {})
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

  const ui: SetupUi = {
    say(text) {
      state = { ...state, said: [...state.said, text] }
      draw()
    },
    steps(steps) {
      state = { ...state, steps }
      draw()
    },
    ask(question, fallback = '') {
      state = { ...state, prompt: { question, fallback, confirm: false }, typed: '' }
      draw()
      return new Promise<string>((resolve) => {
        answer = (text) => {
          state = { ...state, prompt: null }
          draw()
          resolve(text.trim() || fallback)
        }
      })
    },
    async confirm(question, fallback) {
      state = {
        ...state,
        prompt: { question, fallback: fallback ? 'y' : 'n', confirm: true },
        typed: '',
      }
      draw()
      const said = await new Promise<string>((resolve) => {
        answer = (text) => {
          state = { ...state, prompt: null }
          draw()
          resolve(text.trim().toLowerCase())
        }
      })
      return said === '' ? fallback : said.startsWith('y')
    },
    async run(title, command, args) {
      const id = `setup/${++running}` as LaneId
      const rows = Math.max(8, terminal.rows - state.steps.length - 8)
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
      const code = await new Promise<number>((resolve) => {
        driver.onExit(id, (exit: { code: number | null }) => resolve(exit.code ?? 0))
      })
      clearInterval(ticking)
      stopOutput()
      // One last look, so whatever it said as it exited is on the screen.
      await show()
      lane = null
      state = { ...state, running: null }
      draw()
      return code
    },
  }

  try {
    await flow(ui)
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
  private readonly frame: () => { state: SetupState; height: number }

  constructor(frame: Screen['frame']) {
    this.frame = frame
  }

  render(width: number): string[] {
    const { state, height } = this.frame()
    return renderSetup(state, { width, height })
  }

  invalidate(): void {
    // Nothing is cached: every frame is drawn from the state as it is.
  }
}
