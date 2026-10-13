// What the terminal shows while the window opens: the Tade mark, turning, over
// the name as the window writes it.
//
// The mark is the away view's favicon and tade-web's: two squares on a
// diagonal, upper right and lower left (`▞`). A cell is about twice as tall as
// it is wide, so half a cell is a square pixel, and the mark is drawn in those:
// a square of side `side` is `side` columns by half as many rows. At side 1 it
// is `▄▀`, which is the window's own corner (`MARK` in its skin, held to this
// by a test); here it is drawn larger.
//
// It turns about its centre, clockwise, half a turn at a time — after which it
// is the mark again, the two squares having swapped corners — and rests
// between turns. Every pose is a function of how long the splash has been up
// (`turnedAt`), never of how many times a timer fired: opening loads Tade's
// code on this same thread, so a tick lands late, and a late tick jumps to
// where the mark should be rather than slowing it down.
//
// Pure, and no dependency of its own: `bin.ts` reaches it before the check that
// says this Node can run Tade. The clock and the terminal are `opening.ts`'s.

/** How a terminal can paint: not at all, its sixteen colours, or the 256 the window uses. */
export type Palette = 'none' | '16' | '256'

/** The name as the window's corner spells it (`markLabel`): letters apart, two columns of ground each side. */
export const WORD = '  T A D E  '

/**
 * The sides the mark is drawn at, largest first. Even, so that at rest each
 * square is whole cells and only a square part of the way round is in halves.
 */
const SIDES = [6, 4, 2] as const

/** How long the mark sits still between turns, and how long half a turn takes. */
export const REST_MS = 600
export const TURN_MS = 800

/** Upper half, lower half, both: a cell's two pixels, by which of them are lit. */
const HALVES = [' ', '▀', '▄', '█'] as const

/**
 * Each pixel is looked at in a 4 × 4 grid of points and lit where at least half
 * of them are in a square: a square at an angle is a staircase either way, and
 * this is the staircase nearest to it.
 */
const SAMPLES = 4

/**
 * The mark turned by `angle` (radians, clockwise) about the centre of a box
 * `box` pixels each way — `box` columns by `box / 2` rows.
 */
function drawn(side: number, angle: number, box: number): string[] {
  const middle = box / 2
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  // A point is in the mark when, turned back by `angle`, it is in one of the
  // two squares at rest: upper right and lower left of the centre.
  const inMark = (x: number, y: number): boolean => {
    const u = (x - middle) * cos + (y - middle) * sin
    const v = (y - middle) * cos - (x - middle) * sin
    return (
      (u >= 0 && u < side && v >= -side && v < 0) || (u >= -side && u < 0 && v >= 0 && v < side)
    )
  }
  const lit = (x: number, y: number): boolean => {
    let inside = 0
    for (let i = 0; i < SAMPLES; i++)
      for (let j = 0; j < SAMPLES; j++)
        if (inMark(x + (i + 0.5) / SAMPLES, y + (j + 0.5) / SAMPLES)) inside++
    return inside * 2 >= SAMPLES * SAMPLES
  }
  const rows: string[] = []
  for (let row = 0; row < box / 2; row++) {
    let cells = ''
    for (let x = 0; x < box; x++)
      cells += HALVES[(lit(x, 2 * row) ? 1 : 0) | (lit(x, 2 * row + 1) ? 2 : 0)]
    rows.push(cells)
  }
  return rows
}

/**
 * The mark at rest and nothing round it: `2 × side` columns by `side` rows.
 * At side 1 it is one row, `▄▀`, which is how the window's corner draws it.
 */
export function restingMark(side: number): string[] {
  return drawn(side, 0, 2 * side)
}

/**
 * The room the mark needs to turn in, in pixels each way. Its outer corners
 * are `side × √2` from the centre and point every way in a turn, and the
 * centre sits on a boundary between two rows, so that at rest the squares are
 * whole cells: whole rows either side of it, which is a multiple of four.
 */
export function turningRoom(side: number): number {
  return 4 * Math.ceil((side * Math.SQRT2) / 2)
}

/**
 * The mark `turned` half-turns round from rest, in the room it turns in. 0 is
 * the mark and so is 1: the squares have swapped corners, and nobody can tell
 * them apart.
 */
export function markRows(side: number, turned = 0): string[] {
  return drawn(side, turned * Math.PI, turningRoom(side))
}

/** Slow at both ends: a turn that starts and settles, rather than one that jerks. */
const eased = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)

/** How many half-turns round the mark is `ms` after it was first drawn: at rest, then turning. */
export function turnedAt(ms: number): number {
  const into = Math.max(0, ms) % (REST_MS + TURN_MS)
  return into < REST_MS ? 0 : eased((into - REST_MS) / TURN_MS)
}

/** The room the terminal has, in cells. */
export interface Room {
  columns: number
  rows: number
}

/** Where the mark turns and where the word goes in a room, 0-based. */
export interface Placed {
  side: number
  /** The top left of the room the mark turns in (`turningRoom`). */
  top: number
  left: number
  wordRow: number
  wordLeft: number
}

/**
 * The largest mark that fits, with room to turn, the word under it and a cell
 * of margin all round, centred; null where none does, and a line is said
 * instead. A terminal that reports no size at all — a container's, say — is a
 * room nothing fits in.
 *
 * The word sits right under the room the mark turns in, which at rest leaves
 * the mark two rows above it: the room it needs for its corners as they go
 * past straight down.
 */
export function placed(room: Room): Placed | null {
  for (const side of SIDES) {
    const box = turningRoom(side)
    const tall = box / 2 + 1
    if (room.columns < Math.max(box, WORD.length) + 2 || room.rows < tall + 2) continue
    const top = Math.floor((room.rows - tall) / 2)
    return {
      side,
      top,
      left: Math.floor((room.columns - box) / 2),
      wordRow: top + box / 2,
      wordLeft: Math.floor((room.columns - WORD.length) / 2),
    }
  }
  return null
}

/**
 * How this terminal can paint. `reported` is what Node read out of `TERM` and
 * `COLORTERM` (`getColorDepth`: 1, 4, 8 or 24 bits), and `NO_COLOR` is read the
 * way the window's skin reads it. Nothing here is ever painted in more than 256
 * colours, because the window's amber is one of the 256 — `#ffaf00` exactly.
 */
export function paletteOf(env: NodeJS.ProcessEnv, reported: number | undefined): Palette {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== '') return 'none'
  const depth = reported ?? 8
  return depth >= 8 ? '256' : depth >= 4 ? '16' : 'none'
}

const RESET = '\x1b[0m'

/** The window's amber (214), or the nearest of sixteen. */
const AMBER: Record<Palette, string> = { '256': '\x1b[38;5;214m', '16': '\x1b[33m', none: '' }

/**
 * The word on its block: what `COLOUR.mark('TADE')` draws, byte for byte —
 * amber ground, the window's dark ink (233), bold. Sixteen colours have no
 * dark ink but black, and bold black is grey on some of them, so it is plain.
 */
const BLOCK: Record<Palette, string> = {
  '256': '\x1b[48;5;214m\x1b[38;5;233m\x1b[1m',
  '16': '\x1b[43m\x1b[30m',
  none: '',
}

const painted = (code: string, text: string): string =>
  code === '' ? text : `${code}${text}${RESET}`

/** Move to a cell, 0-based. */
const to = (row: number, column: number): string => `\x1b[${row + 1};${column + 1}H`

/**
 * The mark at a pose, each of its rows written over the one before at its full
 * width, so nothing is cleared between two frames and nothing flickers.
 *
 * Never wrapped in a synchronized update (`?2026`), as pi-tui's frames are:
 * `pnpm bench open` takes the end of the first one as the window's first frame.
 */
export function markBytes(at: Placed, rows: readonly string[], palette: Palette): string {
  return rows.map((row, i) => `${to(at.top + i, at.left)}${painted(AMBER[palette], row)}`).join('')
}

/** The whole of it: the screen cleared, the word under where the mark goes, and the mark. */
export function splashBytes(at: Placed, rows: readonly string[], palette: Palette): string {
  return `\x1b[2J${to(at.wordRow, at.wordLeft)}${painted(BLOCK[palette], WORD)}${markBytes(at, rows, palette)}`
}
