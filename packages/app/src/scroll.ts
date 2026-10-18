import type { LaneScrolling } from '@tade/drivers-core'
import { type Hit, type ScrollArea, scrollAt } from './hits.ts'

// What the wheel means, in one place.
//
// The things people scroll — an agent's screen, a terminal, the conversation,
// the side, the ACTIONS page, the picture of a plan — answered the wheel seven
// different ways, with five different ideas of where the end was. Three of
// them had no end at all: the offset went on growing past the last line there
// was to read, so a flick off the end bought a handful of dead notches on the
// way back. Two more found their end only when the next frame was drawn, a
// look behind the bar beside them. This is the arithmetic all of them now go
// through.
//
// Pure: numbers in, numbers out. How far a region reaches is read back out of
// the bar the last frame drew beside it, because the drawing is the only
// thing that knows how long the region turned out to be.

/**
 * How far a notch moves what is under it, when it arrives on its own.
 *
 * A terminal reports a notch and nothing else: a mouse sends one per detent
 * of its wheel and a trackpad sends one per line of finger travel, in the
 * very same escape sequence, and nothing in the protocol says which it was.
 * A detent worth one row makes scrolling with a wheel a chore, so a notch
 * standing by itself is worth a few.
 */
export const NOTCH = 3

/**
 * A notch this long after the last one is a detent on its own: the hand has
 * stopped, and whatever comes next is a new movement of it.
 *
 * Rate is the only thing that tells a wheel from a trackpad: a finger reports
 * every few milliseconds, and giving each of those `NOTCH` rows is how a
 * flick crossed the screen three times over.
 */
export const RUN_MS = 120

/**
 * A notch this soon after the last one is a finger travelling, not a detent.
 *
 * One frame of the terminal's own drawing: nothing a hand does to a wheel
 * arrives this fast, and everything a trackpad does arrives faster.
 */
export const DRAG_MS = 16

/**
 * How far this wheel event is worth, in rows — not necessarily a whole one.
 * `lines` is what the terminal reported, signed (negative is up), and `since`
 * is how long ago the last notch arrived.
 *
 * Between a finger's rate and a detent's it is a ramp rather than a step, and
 * that is the whole of what was wrong. A step put the line at `RUN_MS`, which
 * is a fifth of a second — so an ordinary mouse wheel, whose detents arrive
 * fifty to a hundred milliseconds apart, fell on the trackpad side of it and
 * moved *one row a detent*, while the same wheel turned slowly moved three.
 * Four notches of one even turn came out `3, 1, 1, 1`, measured over a real
 * pane. That is what "janky" was: the same hand, the same gesture, and a step
 * size that changed threefold on the jitter between two reports.
 *
 * A ramp has no side to fall on. Nothing here rounds — what rounding would
 * throw away is what makes a run of notches uneven, so `Wheel` adds it up and
 * carries it instead.
 */
export function wheelRows(lines: number, since: number): number {
  const along = Math.max(0, Math.min(1, (since - DRAG_MS) / (RUN_MS - DRAG_MS)))
  return lines * (1 + (NOTCH - 1) * along)
}

/** How much there is to scroll through, and how much of it is in view. */
export interface Reach {
  total: number
  shown: number
  /**
   * The line at the top of it as the last frame drew it — said by a panel's
   * bar, because a panel following its keyboard is drawn where that row is
   * (`startOf`) rather than where its own `scroll` says.
   */
  at?: number
}

/** Nowhere to go: a region that has no bar, or none that would move. */
const NOWHERE: Reach = { total: 0, shown: 0 }

/**
 * How far a region can be scrolled, read back out of the bar the last frame
 * drew beside it.
 *
 * Only the drawing knows how long a thing turned out to be — a conversation
 * has to be laid out at the width before it can be counted, an agent's screen
 * is as deep as its scrollback — and laying it out again to answer one notch
 * is the same work twice: two milliseconds of it per notch on a conversation
 * of any length, which is most of a frame spent deciding how far to move.
 * The bar already carries the two numbers, because a drag on it needs them,
 * and a notch needs exactly the same two.
 *
 * `across` is the bar lying along the bottom, whose numbers are columns.
 */
export function reachOf(hits: readonly Hit[], area: ScrollArea, across = false): Reach {
  for (const hit of hits) {
    const target = hit.target
    if (target.kind !== 'scrollbar' || target.area !== area) continue
    if ((target.across === true) !== across) continue
    const reach = { total: target.total, shown: target.shown }
    return target.at === undefined ? reach : { ...reach, at: target.at }
  }
  return NOWHERE
}

/**
 * Which region a notch over this cell moves: the one drawn on top, except the
 * picture of a chain turned up or down. The picture only ever moves sideways,
 * and it is drawn on a page, so a notch up or down over it is the page's
 * wherever the page has somewhere to go: it is a part of what is being read,
 * not a place of its own, and a page that stopped scrolling wherever the
 * pointer crossed a box would be one you could not read to the end of. Where
 * the page fits, the picture keeps the notch and slides (`Mouse.scrolled`).
 */
export function notchedIn(
  hits: readonly Hit[],
  x: number,
  y: number,
  sideways: boolean,
): ScrollArea | null {
  const area = scrollAt(hits, x, y)
  if (area !== 'plan' || sideways) return area
  return scrollable(reachOf(hits, 'page')) ? 'page' : area
}

/** The furthest a region goes: the last line you can put at the top of it. */
export function endOf(reach: Reach): number {
  return Math.max(0, reach.total - reach.shown)
}

/** Whether there is anywhere to go at all — a region that fits swallows nothing. */
export function scrollable(reach: Reach): boolean {
  return endOf(reach) > 0
}

/**
 * A wheel: when it last turned, and what the last turn left over.
 *
 * That is the whole of the state scrolling needs: everything else about where
 * a region is lives in the region. Kept per area, because the pointer moving
 * from an agent's screen to the conversation starts a new movement of the
 * hand, not the continuation of the last one.
 *
 * The leftover is what makes a run of notches even. A terminal grid moves by
 * whole cells, so a notch worth 1.8 rows has to be 1 or 2 — and deciding that
 * notch by notch gives 2, 2, 2, 2 (too fast) or 1, 1, 1, 1 (too slow), never
 * 1.8. Carried, it gives 2, 2, 2, 1, 2, 2, 2, 1: even, in step, and exactly
 * as far as the hand asked for.
 */
export class Wheel {
  private area: ScrollArea | null = null
  private at = 0
  /** Rows the last notch was worth and could not spend, kept for the next one. */
  private over = 0
  /** Which way that leftover is owed, because momentum has a direction. */
  private way = 0

  /**
   * How far this notch moves the area it is over, in whole rows. `now` is the
   * clock, so a test can hold it still.
   */
  rows(area: ScrollArea, lines: number, now: number): number {
    const since = this.area === area ? now - this.at : Number.POSITIVE_INFINITY
    const way = Math.sign(lines)
    // A hand that stopped, moved to another region, or turned back the other
    // way is a new movement, and carries nothing of the last one into it.
    if (since >= RUN_MS || this.area !== area || way !== this.way) this.over = 0
    this.area = area
    this.at = now
    this.way = way
    const want = wheelRows(lines, since) + this.over
    // Never nothing: a notch that moves no rows at all is a notch that did
    // not arrive, whatever the arithmetic came to.
    const whole = way < 0 ? Math.min(-1, Math.ceil(want)) : Math.max(1, Math.floor(want))
    this.over = want - whole
    return whole
  }
}

/**
 * Notches in a row the other way that turn a movement of the hand onto that
 * way. One is a hand not quite straight; two is a hand going that way.
 *
 * Read off a session of real swipes on Ghostty: up and down, a notch sideways
 * came between every three or four, always one on its own (23 of them in 147);
 * sideways, a notch up or down came on its own between runs of four to
 * twenty-six (12 in 271). At two, the swipes up and down kept all 124 of
 * theirs and lost all 23; the swipes sideways kept 258 of 259 and lost the 12.
 */
export const TURNED_AFTER = 2

/**
 * Which way a movement of the hand is going: down the window, or across it.
 *
 * A terminal reports a trackpad's every notch with its way and nothing else,
 * and no swipe is straight — so a swipe up a list wears a notch sideways every
 * few, and once something on screen moved sideways, each of them slid it a
 * column under a hand that was only going up. A movement goes the way its
 * first notch went (`RUN_MS` apart is a new one), a notch the other way on its
 * own is the hand drifting and answers nothing, and `TURNED_AFTER` of them in a
 * row turn it. A notch alone after a pause is a movement of its own, so a
 * wheel tilted once still goes sideways.
 */
export class AxisLock {
  private across: boolean | null = null
  private at = Number.NEGATIVE_INFINITY
  /** Notches in a row against the way it is going. */
  private against = 0

  /** Whether this notch goes the way the hand is going. `now` is the clock. */
  holds(across: boolean, now: number): boolean {
    if (now - this.at >= RUN_MS) this.across = null
    this.at = now
    if (this.across !== null && this.across !== across && ++this.against < TURNED_AFTER) {
      return false
    }
    this.across = across
    this.against = 0
    return true
  }
}

/** What follows `ESC [ <` in a pointer report in SGR: `b ; x ; y`, then M or m. */
const SGR_REPORT = /^(\d+);\d+;\d+[Mm]$/

/**
 * A report of the wheel turned sideways — a trackpad's left and right, a
 * wheel that tilts — as the same notch up or down, which is the only wheel
 * pi-tui reads; null for any other report, which goes on as it came.
 *
 * The wheel's four ways are buttons 4 to 7, each reported with 64 added — up
 * 64, down 65, left 66, right 67 — and 4, 8 and 16 more for shift, alt and
 * control. pi-tui takes 64 and 65 for the wheel and anything else for a
 * button by its low two bits, so left came out as 2, the right button, and
 * opened the menu of whatever the pointer was over. Ghostty sends one every
 * few notches of an ordinary swipe up or down, since no swipe is straight;
 * Terminal sends none, which is why it was never seen there. So left is
 * handed over as up and right as down, keys and place kept, and the window
 * is told which it really was (`wire/paint.ts`): what moves sideways moves,
 * and nothing else does.
 */
export function sidewaysNotch(report: string): string | null {
  const sgr = report.startsWith('\x1b[<') ? SGR_REPORT.exec(report.slice(3)) : null
  // X10's is three bytes after `ESC [ M`, each with 32 added.
  const x10 = report.length === 6 && report.startsWith('\x1b[M')
  const button = sgr ? Number(sgr[1]) : x10 ? report.charCodeAt(3) - 32 : -1
  // 128 and up are buttons 8 to 11, a mouse's back and forward: not the wheel.
  if (button < 0 || (button & 192) !== 64 || (button & 3) < 2) return null
  const upright = button - 2
  return sgr
    ? `\x1b[<${upright}${report.slice(3 + String(button).length)}`
    : `\x1b[M${String.fromCharCode(upright + 32)}${report.slice(4)}`
}

/**
 * A report of the pointer moving with no button held — 32 for moving, 3 for
 * no button, and 4, 8 and 16 more for shift, alt and control — which is
 * somebody here but not a press: nothing was chosen by it.
 */
export function hovered(report: string): boolean {
  const sgr = report.startsWith('\x1b[<') ? SGR_REPORT.exec(report.slice(3)) : null
  return sgr !== null && report.endsWith('M') && (Number(sgr[1]) & 227) === 35
}

/**
 * A lane's screen as it was last read back, kept as its lines.
 *
 * A capture always ends at the lane's newest line, so which lines these are
 * is `at` less their count: `lines[0]` is line `at - lines.length` of the
 * lane. That is what lets a screen further back be cut out of them without
 * asking the driver again, and what says when they no longer reach — the
 * agent has printed since, or the wheel has gone above the oldest one held.
 */
export interface HeldLines {
  /** The lane they came from: another lane's lines are not these. */
  lane: string
  lines: readonly string[]
  /** How many lines the lane had when they were read. */
  at: number
  /** How many were asked for: fewer than this means the top of the scrollback. */
  asked: number
}

/**
 * Whether a lane's lines are worth holding: only where the scrolling is the
 * window's, because that is the only place the one fact they rest on is true.
 *
 * Held lines are keyed by how deep the lane was, and that works because a
 * program which prints appends and never goes back. One on the alternate
 * screen does the opposite: Claude Code repaints every row between one
 * keystroke and the next, and its bottom row always says something, so the
 * depth never moves — every look found the lines it already had, and the pane
 * froze on the first screen it ever read. Which is what "the Claude pane does
 * not scroll" was: the notch reached the program and the program scrolled,
 * while the window went on drawing a photograph.
 *
 * Nothing is lost by not holding them — such a lane has no scrollback to ask
 * for, so a capture is one screen, the cheap end it always was. Unknown reads
 * as the window's, as everywhere else: that is what a lane is until its driver
 * says otherwise.
 */
export function keeping(view: { scrolling?: LaneScrolling } | null): boolean {
  return (view?.scrolling ?? 'window') === 'window'
}

/**
 * `held` with `area`'s lines put in — or taken out, where `read` is null — as
 * a new map, and the same map where there was nothing to take out.
 *
 * The frame is handed this map, and a region drawn from it is kept for as long
 * as it is the same one (`view/last-frame.ts`), so it is never written into: written
 * into, it is the same map with other lines in it, and a selection over the
 * pane copies what the lane said before.
 */
export function holding<Area>(
  held: ReadonlyMap<Area, HeldLines>,
  area: Area,
  read: HeldLines | null,
): ReadonlyMap<Area, HeldLines> {
  if (read) return new Map(held).set(area, read)
  return held.has(area) ? new Map([...held].filter(([one]) => one !== area)) : held
}

/**
 * Whether a view `back` lines up is clear of a live screen `live` tall, and so
 * may be answered out of lines read before.
 *
 * `keeping` is this question about the alternate screen. This is the same
 * question about the normal one, and it has the same answer for the same
 * reason: a program rewriting the rows it is already on leaves the lane no
 * deeper, so the lines held of those rows are a photograph of them, and every
 * look finds the lines it already had. Above the live screen the rows have
 * scrolled off, nothing can reach them again, and that is the part worth
 * holding — which is the whole of what holding them was for.
 *
 * Not a rare shape, and not only agents: it is every progress bar, every
 * spinner, every `npm install` in a terminal lane.
 *
 * Below it the lines held are still worth *drawing* — a photograph as new as
 * the look that took it, which is what every frame is — only never the whole
 * answer: a look still reads the live rows again behind them.
 */
export function settledAbove(back: number, live: number): boolean {
  return back >= live
}

/**
 * How many lines past what is on screen a lane is read back, once it is being
 * scrolled: room for the wheel to move in before the driver has to be asked
 * again.
 *
 * A capture costs what it asks for — a tenth of a millisecond a line, so
 * twelve of them two thousand lines back — and it used to be paid again on
 * every look and again on every notch, for the same lines that had not
 * changed since the agent printed them. Scrollback above the live screen
 * never changes; only the bottom does. So the lines are kept, and the screen
 * the window draws is cut out of them.
 */
export const HELD_LINES = 200

/**
 * How many lines a lane is read back for a screen `rows` tall that ends `back`
 * lines above its newest: the screen alone at the newest line, which is what a
 * lane printing in front of you costs every look, and otherwise the screen,
 * the way back down and `HELD_LINES` more, rounded up to a whole number of
 * `HELD_LINES`.
 *
 * Rounded, because a driver that keeps a frame ready keeps the one it was
 * asked for (`drivers/pty`), and a different number of lines is a frame it has
 * not made. Every notch over the live rows moved `back`, so every one was a
 * frame made on the emulators' thread and waited for, the text a look behind
 * the bar beside it (`Held.cut` has the numbers). Rounded, one
 * frame answers every notch from the newest line to a hundred and sixty lines
 * up a forty-row screen.
 */
export function asking(rows: number, back: number): number {
  if (back <= 0) return rows
  return Math.ceil((rows + back + HELD_LINES) / HELD_LINES) * HELD_LINES
}

/**
 * The rows to draw out of what is held, or nothing when they are not all in
 * there. `back` is how far above the newest line the screen ends, and `at` is
 * how many lines the lane has now — grown since the read, if the agent has
 * printed meanwhile.
 *
 * This is what makes a wheel notch over a terminal an array slice rather than
 * a read from the driver: scrollback above the live screen never changes, so
 * lines read once are lines read for good.
 */
export function cutFrom(held: HeldLines, rows: number, back: number, at: number): string | null {
  const first = cutAt(held, rows, back, at)
  return first === null ? null : held.lines.slice(first, first + rows).join('\n')
}

/**
 * Which of the lines held that cut starts at, or nothing where they do not
 * reach that far.
 *
 * The same arithmetic, said once: the drawing needs it too, because a selection
 * anchored in a lane's scrollback has to know which line of it the top of the
 * screen is — and two readings of that drift the first time either moves.
 */
export function cutAt(held: HeldLines, rows: number, back: number, at: number): number | null {
  // Which line of the lane the oldest one held is.
  const oldest = held.at - held.lines.length
  let first = at - back - rows - oldest
  if (first < 0) {
    // Above the oldest line held. Fewer lines came back than were asked for,
    // so that one is the oldest there is: scrolling past it stops at it
    // rather than sending for lines nobody has.
    if (held.lines.length >= held.asked) return null
    first = 0
  }
  // Below the newest held: the agent has printed since, and what it printed
  // is not in here.
  if (first + rows > held.lines.length) return null
  return first
}
