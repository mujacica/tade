import { type Terminal, TuiAltScreen } from '@earendil-works/pi-tui'
import { REPAINT_MS } from '../pace.ts'
import { timing } from '../timing.ts'

// Four things about the terminal itself, rather than about anything the window
// draws in it.
//
// The first three were in `app.ts`, which is wiring, and none of them is: one
// is a technique for recovering from a screen somebody else wiped, one is when
// that technique is worth the bytes, and the third is a question about what
// this terminal can report. All are facts about the terminal, and each has its
// reasoning beside the code rather than beside the fortieth subject. The fourth
// is the screen the window writes through, which is where the two pi-tui
// timing points sit — `../timing.ts` has the argument for all four of them.

/**
 * Write the whole screen again, over itself.
 *
 * The terminal can wipe it without telling us: ⌘K is "clear" in Terminal.app,
 * iTerm2 and VS Code, and never reaches Tade at all. Rendering only sends what
 * changed, so a wiped screen stayed dark until something moved. Every row is
 * written in place — no clear first, so on a screen that was not wiped nothing
 * visibly happens.
 */
export function repaintScreen(tui: TuiAltScreen, terminal: Terminal): void {
  const shown = (tui as unknown as { previousScreen?: unknown }).previousScreen
  if (!Array.isArray(shown) || shown.length === 0) return
  let buffer = '\x1b[?2026h\x1b7'
  shown.forEach((line, row) => {
    if (typeof line === 'string') buffer += `\x1b[${row + 1};1H${line}`
  })
  terminal.write(`${buffer}\x1b8\x1b[?2026l`)
}

/** What a terminal reports when it gains and loses the keyboard (DEC mode 1004). */
const FOCUS_IN = '\x1b[I'
const FOCUS_OUT = '\x1b[O'

/**
 * When writing the whole screen again is worth the bytes.
 *
 * The repaint recovers from a wipe nobody told us about, so it cannot wait for
 * something to change — which made it the one thing on the window's beat that
 * wrote every row on a timer whether or not anybody was looking. Measured at
 * 7,859 bytes for one write on a 140×50 window, which is fourteen megabytes an
 * hour, synchronously down the same pipe the frames go, for as long as Tade is
 * open; and Tade is the control room you leave running all day, which it
 * spends most of in a terminal nobody has in front of them.
 *
 * ⌘K is the thing being recovered from, and ⌘K goes to the window that has the
 * keyboard. So a terminal that has reported losing focus is a terminal whose
 * screen cannot be wiped under us, and it is owed no repaint until the focus
 * comes back — at which point it is owed one *at once*, which is sooner than
 * the timer would have reached it. Recovery while you are looking is the one
 * it was built for and is unchanged: still `REPAINT_MS`, still a beat or two.
 *
 * **Silence is never read as unfocused.** `focused` starts true, only a
 * reported `FOCUS_OUT` lowers it, and a TUI starting raises it again: a
 * terminal without mode 1004 keeps every repaint it has today, and so does one
 * whose focus moved while another screen had the terminal — nothing can get
 * stuck believing nobody is there, because believing it wrongly is the only
 * way this costs anybody a dark screen.
 *
 * Not chosen: stretching the interval while the window is idle, and writing
 * the rows in rotating slices. A wipe lands on an idle window as readily as a
 * busy one and a slice only covers the screen as fast as the whole of it did,
 * so both pay for the saving with a slower recovery — and neither takes any
 * work away in the case that is nearly all of them, which is nobody looking.
 */
export class Repaint {
  /** Whether this terminal has the keyboard, as it last reported. See above. */
  private focused = true
  /** When the screen was last written again; null until it has been. */
  private wroteAt: number | null = null
  /** A repaint owed now rather than on the beat: the focus came back. */
  private owed = false

  /**
   * Watch this terminal's focus reports, on their way to whoever is listening.
   *
   * Nothing is consumed and nothing is answered, so this is invisible to the
   * TUI. It has to happen in front of one because that is the only place a
   * focus report can still be seen: `TuiAltScreen` adds its own input listener
   * in its constructor and consumes `FOCUS_IN`/`FOCUS_OUT` there, which puts
   * every listener Tade adds afterwards behind it, and it keeps no answer
   * about focus to ask for.
   *
   * `start` is wrapped on the terminal rather than on a stand-in that
   * implements `Terminal` over it: `start` is the only member anybody wants
   * differently, a stand-in would be fifteen forwarders of which pi-tui calls
   * seven, and there would then be two objects where the point is that there
   * is one terminal with one piece of state in it.
   */
  watch(terminal: Terminal): void {
    const start = terminal.start.bind(terminal)
    terminal.start = (onInput, onResize) => {
      // A TUI taking the terminal has just drawn every row of it, and whatever
      // the focus did while another screen held it was reported to that screen
      // and not to us. Both are answered by the safe default, which is the
      // only one that cannot leave a wiped screen dark: a terminal says its
      // focus *changed*, so believing it unfocused wrongly is believing it for
      // as long as nobody moves.
      this.focused = true
      this.owed = true
      start((data) => {
        if (data === FOCUS_OUT) this.focused = false
        else if (data === FOCUS_IN && !this.focused) {
          this.focused = true
          this.owed = true
        }
        onInput(data)
      }, onResize)
    }
  }

  /**
   * Whether to write the whole screen again now, taking the turn if it is.
   *
   * Asking spends the turn, so ask it last — after whatever would refuse the
   * write anyway. A caller that asks first and then refuses has thrown the
   * repaint away, and the one owed on the focus coming back is the one it
   * would throw away.
   */
  dueAt(now: number): boolean {
    const onTheBeat = this.wroteAt === null || now - this.wroteAt >= REPAINT_MS
    if (!this.owed && !(this.focused && onTheBeat)) return false
    this.owed = false
    this.wroteAt = now
    return true
  }
}

/** Only some terminals report key releases, which is what holding a key needs. */
export function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}

/**
 * The TUI, with its own pipeline and its write to the terminal timed.
 *
 * Always wrapped, on or off, rather than branched on the flag at startup: a
 * second shape of the window that only exists while somebody is measuring is a
 * second shape nothing tests. What it costs when off is one method call per
 * `doRender` and one per `write` — sixty of each a second, against a pipeline
 * that makes eight passes over every row.
 */
class TimedScreen extends TuiAltScreen {
  protected override doRender(): void {
    const timings = timing()
    const at = timings.start()
    super.doRender()
    timings.took('doRender', at)
  }
}

/**
 * A terminal that says how long it took to accept what was written to it.
 *
 * Only what pi-tui writes goes through this: it wraps the terminal the TUI is
 * given, not the one the window keeps, so a clipboard escape, a pointer shape
 * or the full repaint above is not counted as a frame. The repaint is a
 * blocking write of its own, now owed only while somebody is looking (see
 * `Repaint`), and wants a point of its own rather than hiding inside this one.
 *
 * A stand-in over the terminal rather than a `write` swapped on it, which is
 * the other way round from `Repaint.watch` and for the reason that sentence
 * gives: `watch` wants every `start` there is, and this wants only pi-tui's
 * writes. The window writes to the same terminal object for those three, so a
 * patched `write` would count them all as frames. It composes with `watch`
 * because `start` here is the terminal's own, read when the TUI calls it.
 */
class TimedTerminal implements Terminal {
  private readonly to: Terminal

  constructor(to: Terminal) {
    this.to = to
  }

  write(data: string): void {
    const timings = timing()
    const at = timings.start()
    this.to.write(data)
    timings.took('write', at)
  }

  get columns(): number {
    return this.to.columns
  }
  get rows(): number {
    return this.to.rows
  }
  get kittyProtocolActive(): boolean {
    return this.to.kittyProtocolActive
  }
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.to.start(onInput, onResize)
  }
  stop(): void {
    this.to.stop()
  }
  drainInput(maxMs?: number, idleMs?: number): Promise<void> {
    return this.to.drainInput(maxMs, idleMs)
  }
  moveBy(lines: number): void {
    this.to.moveBy(lines)
  }
  hideCursor(): void {
    this.to.hideCursor()
  }
  showCursor(): void {
    this.to.showCursor()
  }
  clearLine(): void {
    this.to.clearLine()
  }
  clearFromCursor(): void {
    this.to.clearFromCursor()
  }
  clearScreen(): void {
    this.to.clearScreen()
  }
  setTitle(title: string): void {
    this.to.setTitle(title)
  }
  setProgress(active: boolean): void {
    this.to.setProgress(active)
  }
}

/** The alternate screen the window draws on, with the two pi-tui points timed. */
export function screenFor(terminal: Terminal): TuiAltScreen {
  return new TimedScreen(new TimedTerminal(terminal))
}
