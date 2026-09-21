import type { Hit, ScrollArea } from './hits.ts'

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
 * Notches closer together than this are one movement of a hand, not separate
 * detents.
 *
 * Rate is the only thing that tells the two apart: a finger on a trackpad
 * reports every few milliseconds, and giving each of those `NOTCH` rows is
 * how a flick crossed the screen three times over. Inside a run each notch
 * is worth exactly the lines the terminal already counted for it — the
 * terminal did the pixels-to-lines sum with the settings of the machine it is
 * running on, and doing it again on top of that is the jump people feel.
 */
export const RUN_MS = 120

/**
 * How far this wheel event moves what is under it. `lines` is what the
 * terminal reported, signed — negative is up — and `since` is how long ago
 * the last notch arrived.
 */
export function wheelRows(lines: number, since: number): number {
  return lines * (since < RUN_MS ? 1 : NOTCH)
}

/** How much there is to scroll through, and how much of it is in view. */
export interface Reach {
  total: number
  shown: number
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
    return { total: target.total, shown: target.shown }
  }
  return NOWHERE
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
 * A wheel, remembering only when it last turned.
 *
 * That is the whole of the state scrolling needs: everything else about where
 * a region is lives in the region. Kept per area, because the pointer moving
 * from an agent's screen to the conversation starts a new movement of the
 * hand, not the continuation of the last one.
 */
export class Wheel {
  private area: ScrollArea | null = null
  private at = 0

  /**
   * How far this notch moves the area it is over. `now` is the clock, so a
   * test can hold it still.
   */
  rows(area: ScrollArea, lines: number, now: number): number {
    const since = this.area === area ? now - this.at : Number.POSITIVE_INFINITY
    this.area = area
    this.at = now
    return wheelRows(lines, since)
  }
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
  return held.lines.slice(first, first + rows).join('\n')
}
