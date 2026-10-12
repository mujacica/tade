import { type Terminal, TuiAltScreen } from '@earendil-works/pi-tui'
import {
  ECHO_OWED_MS,
  intervalOf,
  newsWait,
  type Pace,
  paced,
  REPAINT_MS,
  renderWait,
  UNHURRIED,
} from '../pace.ts'
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
// timing points sit — `../timing.ts` has the argument for all four of them —
// and where how fast the terminal takes a frame paces the next one
// (`../pace.ts` has that argument).

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
   *
   * `resized` is told when the terminal changes size, after pi-tui has drawn
   * the window again for it: the lanes in it are then the wrong size and the
   * wrong height to read, and the look that catches them up is owed at once
   * rather than at the next beat.
   */
  watch(terminal: Terminal, resized: () => void = () => {}): void {
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
      const sized = () => {
        onResize()
        resized()
      }
      start((data) => {
        if (data === FOCUS_OUT) this.focused = false
        else if (data === FOCUS_IN && !this.focused) {
          this.focused = true
          this.owed = true
        }
        onInput(data)
      }, sized)
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
 * The TUI, with its own pipeline and its write to the terminal timed — and
 * its frames paced by how fast the terminal takes them (`pace.ts`).
 *
 * Always wrapped, on or off, rather than branched on the flag at startup: a
 * second shape of the window that only exists while somebody is measuring is a
 * second shape nothing tests. What it costs when off is one method call per
 * `doRender` and one per `write` — sixty of each a second, against a pipeline
 * that makes eight passes over every row.
 *
 * The pacing goes in front of pi-tui's throttle rather than in place of it:
 * that interval is a private static of the library's, so it is the same
 * sixteen milliseconds for every screen in the process and nothing of Tade's
 * may move it. A request this holds is handed to pi-tui when the terminal's
 * interval is up, and pi-tui then throttles it as it always did. A key being
 * answered is never held — the half `pace.ts` argues for, which pi-tui's own
 * immediate render never did here, because no component of the window holds
 * the focus: a key reached the screen as a `requestRender` like any other, and
 * a terminal slow to take a frame made somebody wait to see what they typed.
 */
class TimedScreen extends TuiAltScreen {
  private readonly accepting: TimedTerminal
  /** Where the ratchet stands. */
  private pace: Pace = UNHURRIED
  /** When the last frame was drawn, on the clock pi-tui throttles by. */
  private drewAt = Number.NEGATIVE_INFINITY
  /** A frame asked for while the terminal is still owed time, waiting for it. */
  private held: NodeJS.Timeout | null = null
  /** A frame owed to news, waiting for its interval (`newsWait`). */
  private news: NodeJS.Timeout | null = null
  /** Until when a key typed into a lane is owed its echo, on the same clock (`oweEcho`). */
  private echoOwedUntil = Number.NEGATIVE_INFINITY
  /** The next frame owed to an echo is drawn at the end of this turn, and then the next is not. */
  private soonest = false
  /** That frame, on its way. */
  private drawing: NodeJS.Immediate | null = null

  constructor(terminal: TimedTerminal) {
    super(terminal)
    this.accepting = terminal
  }

  override requestRender(force?: boolean): void {
    // A forced frame is a whole screen somebody needs now — a resize — and a
    // key being answered, or its echo, is somebody waiting to see what they
    // typed: none is ever held, and each draws whatever was. While one is
    // held, the frame it becomes draws whatever is true by then, so a second
    // request has nothing to add.
    const at = performance.now()
    const owed = at < this.echoOwedUntil
    const now = force === true || this.accepting.answeringKey() || owed
    if (now) this.release()
    else if (this.held !== null) return
    // The echo has already waited on a program and a look, so its frame does
    // not then wait on pi-tui's timer too: a timeout of nothing is a whole
    // millisecond, and its throttle up to sixteen behind any frame before it.
    // Drawn at the end of this turn, once the key has gone out (`Outbox`), and
    // only once an echo: whatever is asked for after it is throttled as ever.
    if (owed && this.soonest && force !== true) {
      this.soonest = false
      this.drawing ??= setImmediate(() => {
        this.drawing = null
        if (!this.stopped) this.renderNow()
      })
      return
    }
    const wait = now ? 0 : renderWait(this.pace, at - this.drewAt)
    if (wait <= 0) {
      super.requestRender(force)
      return
    }
    // How long the terminal's pace kept a frame back: what a key's echo must never be.
    timing().sample('held', wait)
    this.held = setTimeout(() => {
      this.held = null
      super.requestRender()
    }, wait)
  }

  /**
   * A frame for news: something changed that somebody may see, which is not a
   * key waiting for its echo (`../pace.ts` has the argument). Drawn with the
   * next frame anything else asks for, and on its own no sooner than
   * `NEWS_MS` after the last one. `blocking` is news somebody is waiting on —
   * an agent asking — and is asked for like any other frame.
   *
   * Never while another screen has the terminal: a request that reaches
   * pi-tui while it is stopped is one it keeps, and the `start` that puts the
   * window back then finds a frame already asked for and asks for none.
   */
  requestNews(blocking = false): void {
    if (this.stopped) return
    if (blocking) {
      this.requestRender()
      return
    }
    // A frame is on its way already, and draws whatever is true by then.
    if (this.news !== null || this.held !== null) return
    const wait = newsWait(performance.now() - this.drewAt)
    if (wait <= 0) {
      this.requestRender()
      return
    }
    this.news = setTimeout(() => {
      this.news = null
      this.requestRender()
    }, wait)
  }

  /**
   * A key was typed into a lane. Its echo is the lane's to print and a look's
   * to draw, long after the key was answered — so for `ECHO_OWED_MS` whatever
   * is asked for is never held for the terminal's pace, and the first of it is
   * drawn at the end of the turn it is asked for in. The key's own frame is
   * usually not drawn at all (`Lanes.toLane`), which leaves pi-tui's throttle
   * unarmed for the echo.
   */
  oweEcho(): void {
    this.echoOwedUntil = performance.now() + ECHO_OWED_MS
    this.soonest = true
  }

  override stop(options?: Parameters<TuiAltScreen['stop']>[0]): void {
    this.release()
    this.drawn()
    super.stop(options)
  }

  protected override doRender(): void {
    const timings = timing()
    const at = timings.start()
    // Whatever was held is drawn by this frame, whoever asked for it.
    this.release()
    this.drawn()
    this.drewAt = performance.now()
    this.accepting.begin()
    super.doRender()
    timings.took('doRender', at)
    // A frame that wrote nothing says nothing about the terminal.
    const accepted = this.accepting.accepted()
    if (accepted === null) return
    this.pace = paced(this.pace, accepted)
    timings.sample('pace', intervalOf(this.pace))
  }

  /** Whatever was waiting for its interval is drawn by the frame on its way, or by none. */
  private release(): void {
    if (this.held !== null) clearTimeout(this.held)
    if (this.news !== null) clearTimeout(this.news)
    this.held = null
    this.news = null
  }

  /** The echo's frame on its way is this one, or none. */
  private drawn(): void {
    if (this.drawing !== null) clearImmediate(this.drawing)
    this.drawing = null
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
  /** How long this frame's writes took to be accepted, and whether there were any. */
  private took: number | null = null
  /** A key is being answered: a frame it asks for is drawn at once (`TimedScreen`). */
  private answering = false

  constructor(to: Terminal) {
    this.to = to
  }

  /**
   * Timed whether or not anybody is measuring — the one point that is, because
   * the pacing reads it. Two clock reads a frame.
   */
  write(data: string): void {
    const at = performance.now()
    this.to.write(data)
    const took = performance.now() - at
    this.took = (this.took ?? 0) + took
    timing().sample('write', took)
  }

  /** A frame starts: what it writes is counted from here. */
  begin(): void {
    this.took = null
  }

  /** How long the terminal took to accept what this frame wrote; null where it wrote nothing. */
  accepted(): number | null {
    return this.took
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
  /**
   * Every sequence the terminal hands the TUI passes here on its way, one at a
   * time and answered before the next — so whether a key is being answered is
   * known for exactly as long as it is. A pointer report is not a key: the
   * frames a flick asks for are paced like any others, forty of them at a time.
   */
  start(onInput: (data: string) => void, onResize: () => void): void {
    this.to.start((data) => {
      this.answering = !data.startsWith('\x1b[<') && !data.startsWith('\x1b[M')
      try {
        onInput(data)
      } finally {
        this.answering = false
      }
    }, onResize)
  }

  /** Whether a key is being answered right now. */
  answeringKey(): boolean {
    return this.answering
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

/** What the window draws on: pi-tui's alternate screen, timed, paced, and told what is only news. */
export type Screen = TuiAltScreen & Pick<TimedScreen, 'requestNews' | 'oweEcho'>

/** The alternate screen the window draws on, with the two pi-tui points timed. */
export function screenFor(terminal: Terminal): Screen {
  return new TimedScreen(new TimedTerminal(terminal))
}
