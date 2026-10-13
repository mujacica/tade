// What `tade` shows before the window has a screen to draw on.
//
// Opening is most of a second of loading Tade's own code before anything can
// be drawn, and the terminal used to sit blank for all of it — which reads as
// a command that did nothing. So the first thing `bin.ts` does, before it
// loads anything, is put the Tade mark up where the window is about to be,
// turning (`splash.ts`), on a screen of its own: the alternate screen the
// window draws on, so the window takes it over rather than replacing it, and
// what was in the terminal before is there again when Tade closes.
//
// Where there is no room for it, or the terminal is a dumb one, it is the one
// line it always was, `opening…`; down a pipe it is nothing at all.
//
// Taking it back is two things, and which is the window's to say:
//
// - **The window takes the screen** (`handOverOpening`, just before it starts
//   drawing): the mark stops where it is and the screen is left as it is,
//   because the window clears it as it takes it, and leaves it when it closes.
// - **Something else is written instead of a window** — an invalid config, a
//   home another window holds, setup, a crash, a ctrl+c (`unsayOpening`): the
//   mark's screen is left and the cursor shown, so what is said is said on the
//   terminal somebody was using.
//
// Nothing here may slow the open down: every timer is unref'd, nothing waits
// on anything, and a tick that has nothing new to draw writes nothing.
//
// No dependency but `splash.ts`, which has none, like the other files `bin.ts`
// imports at the top: anything here runs before the check that says this Node
// can run Tade.

import {
  markBytes,
  markRows,
  type Placed,
  paletteOf,
  placed,
  splashBytes,
  turnedAt,
} from './splash.ts'

/** Back to the start of the line, and the line cleared: what was said there is gone. */
const ERASE = '\r\x1b[2K'

/** A screen of its own with the cursor hidden, and back to the one it came from — pi-tui's own pair. */
const ENTER = '\x1b[?1049h\x1b[?25l'
const LEAVE = '\x1b[?1049l\x1b[?25h'

/** How often the mark is looked at again: a frame wherever it moved. */
export const TICK_MS = 40

/** Ending the process the way a person does, while there is a mark up to take back first. */
const SIGNALS: readonly NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP']

/** What the window says while it opens, where it cannot show the mark. */
export const OPENING = 'opening…'

/** What saying it needs of the terminal: `process.stdout`, or anything shaped like it. */
export interface OpeningTerminal {
  readonly isTTY?: boolean
  readonly columns?: number
  readonly rows?: number
  write(text: string): unknown
  getColorDepth?(env?: object): number
  on(event: 'resize', listener: () => void): unknown
  off(event: 'resize', listener: () => void): unknown
}

/** And of the process: what it was started with, and the ways it ends. */
export interface OpeningProcess {
  readonly env: NodeJS.ProcessEnv
  readonly pid: number
  on(event: string, listener: (signal: NodeJS.Signals) => void): unknown
  off(event: string, listener: (signal: NodeJS.Signals) => void): unknown
  kill(pid: number, signal: NodeJS.Signals): unknown
}

type Said =
  | { kind: 'line'; out: OpeningTerminal }
  | { kind: 'mark'; out: OpeningTerminal; stop: () => void }
  /** The window took the screen over, and gives it back itself. */
  | { kind: 'handed' }

let said: Said | null = null

/** The flags that answer instead of opening a window. */
const ANSWERS = new Set(['-h', '--help', '-V', '--version'])

/**
 * Whether these arguments open the window: no command, or `app`, and no
 * asking for help or the version. A guess made before the parser is loaded,
 * so it errs towards saying nothing — `tade -c x` opens the window and is not
 * told so early, which costs a line nobody missed.
 */
export function opensWindow(args: readonly string[]): boolean {
  if (args.some((arg) => ANSWERS.has(arg))) return false
  const command = args.find((arg) => !arg.startsWith('-'))
  return command === undefined || command === 'app'
}

/** The room the terminal says it has. */
const roomOf = (out: OpeningTerminal) => ({ columns: out.columns ?? 0, rows: out.rows ?? 0 })

/** Say it, where there is a terminal to say it on: the mark where it fits, the line where it does not. Once. */
export function sayOpening(
  out: OpeningTerminal = process.stdout,
  proc: OpeningProcess = process,
): void {
  if (said !== null || out.isTTY !== true) return
  const term = proc.env.TERM
  const at = term && term !== 'dumb' ? placed(roomOf(out)) : null
  if (at === null) {
    said = { kind: 'line', out }
    out.write(OPENING)
    return
  }
  said = { kind: 'mark', out, stop: showMark(out, proc, at) }
}

/** Put the mark up and keep it turning; what comes back takes it down. */
function showMark(out: OpeningTerminal, proc: OpeningProcess, first: Placed): () => void {
  const palette = paletteOf(proc.env, out.getColorDepth?.(proc.env))
  const began = Date.now()
  let at: Placed | null = first
  let shown = markRows(first.side)
  out.write(`${ENTER}${splashBytes(first, shown, palette)}`)

  const tick = (): void => {
    if (at === null) return
    const rows = markRows(at.side, turnedAt(Date.now() - began))
    if (rows.every((row, i) => row === shown[i])) return
    shown = rows
    out.write(markBytes(at, rows, palette))
  }
  // Drawn again from nothing at the new size, or not at all where it no longer fits.
  const resized = (): void => {
    at = placed(roomOf(out))
    if (at === null) {
      out.write('\x1b[2J')
      return
    }
    shown = markRows(at.side, turnedAt(Date.now() - began))
    out.write(splashBytes(at, shown, palette))
  }
  // A crash or an exit while it is up is said on the terminal it came from:
  // the monitor runs before Node prints what was thrown.
  const back = (): void => unsayOpening()
  // Before the window there is no raw mode, so ctrl+c is a signal. The mark is
  // taken down, and then the signal does what it would have done: with this
  // the last listener gone, that is Node's own answer, which is to end.
  const ended = (signal: NodeJS.Signals): void => {
    unsayOpening()
    proc.kill(proc.pid, signal)
  }

  const timer = setInterval(tick, TICK_MS)
  timer.unref()
  out.on('resize', resized)
  proc.on('exit', back)
  proc.on('uncaughtExceptionMonitor', back)
  for (const signal of SIGNALS) proc.on(signal, ended)
  return () => {
    clearInterval(timer)
    out.off('resize', resized)
    proc.off('exit', back)
    proc.off('uncaughtExceptionMonitor', back)
    for (const signal of SIGNALS) proc.off(signal, ended)
  }
}

/**
 * The window is taking the screen: the mark stops here, and the screen is left
 * for the window to clear as it takes it — nothing more is written to it, and
 * taking it back later writes nothing either. A line is left where it is, for
 * `unsayOpening` once the window has gone.
 */
export function handOverOpening(): void {
  if (said?.kind !== 'mark') return
  said.stop()
  said = { kind: 'handed' }
}

/** Take it back. Safe to call whether or not it was said, and twice. */
export function unsayOpening(): void {
  const was = said
  said = null
  if (was === null || was.kind === 'handed') return
  if (was.kind === 'line') {
    was.out.write(ERASE)
    return
  }
  was.stop()
  was.out.write(LEAVE)
}
