import { sliceByColumn, stripTerminalSequences, visibleWidth } from '@earendil-works/pi-tui'
import type { ScrollArea } from './hits.ts'

// Selecting text by dragging over it, and copying what was covered.
//
// The window reports the mouse, so the terminal cannot select for itself:
// without this nothing on screen could be copied at all.
//
// Two facts shape all of it. The window is **regions side by side** and not one
// flow of text, so a selection is bounded to the columns of the region it was
// started in — a selection that took whole rows between its two ends came back
// with the sidebar's queue down the left of every line but the first and the
// last. And a region **scrolls**, so an offset into the rows on screen is
// meaningless the moment those rows go: the ends are anchored in the region's
// own lines and projected onto whatever is drawn, which is what lets a
// selection outlive a scroll and copy the part of itself that is off screen.
//
// Pure: cells and lines in, cells and text out.

/** A cell on the screen. */
export interface Cell {
  x: number
  y: number
}

/**
 * The columns a selection may reach: the region it was started in, or the whole
 * row where it was started on nothing in particular.
 */
export interface Within {
  from: number
  to: number
}

/**
 * A region of the window that scrolls, as the pass that drew it knows it.
 *
 * Where something ended up is always the drawing's to say, so this comes out of
 * the same pass as the rows and the hits rather than from a second reading of
 * how the region slid. `lines` is as much of the region as the window holds — a
 * conversation entire, a lane's scrollback as far back as it has been read —
 * and the four numbers are how a line of it and a row of the window are turned
 * into one another.
 */
export interface Region {
  /** The lines the window holds of it. */
  lines: readonly string[]
  /** Which line of the region `lines[0]` is. */
  first: number
  /** Which line of the region was drawn on the first of its rows. */
  offset: number
  /** Where those rows are in the drawing, and how many of them hold a line. */
  row: number
  rows: number
}

/** The regions a frame drew, by the area each of them scrolls as. */
export type Regions = Partial<Record<ScrollArea, Region>>

/**
 * One end of a selection: the cell the pointer was on, and the line of the
 * region that cell fell on.
 *
 * `line` is `null` while the end follows the pointer — which the far end of a
 * live drag does, and is exactly what makes the wheel *extend* a selection
 * rather than lose it: the hand stays where it is, the content moves under it,
 * and the line under the pointer is a different one. It is fixed when the drag
 * is let go, so the selection stays over the words it took.
 */
export interface End extends Cell {
  line: number | null
}

/** A selection from where it starts to where it ends, reading order, whichever way it was dragged. */
export function ordered(selection: { from: Cell; to: Cell }): { from: Cell; to: Cell } {
  const { from, to } = selection
  return from.y < to.y || (from.y === to.y && from.x <= to.x)
    ? { from, to }
    : { from: to, to: from }
}

/** Which line of a region a row of the window fell on, taken at the nearest row it drew. */
export function lineAt(region: Region, y: number): number {
  return region.offset + Math.max(0, Math.min(region.rows - 1, y - region.row))
}

/**
 * The two ends as cells of the window as it is drawn now.
 *
 * An end whose line has scrolled out of view is taken at the edge it went past
 * — the whole first or last row of the region — so the selection goes on
 * covering everything between the two of them rather than collapsing onto what
 * happens to be on screen.
 */
export function cellsIn(
  selection: { from: End; to: End },
  region: Region | null,
  within: Within | null,
): { from: Cell; to: Cell } {
  const at = (end: End): Cell => {
    if (!region || end.line === null) return { x: end.x, y: end.y }
    const y = region.row + (end.line - region.offset)
    if (y < region.row) return { x: within?.from ?? 0, y: region.row }
    const last = region.row + Math.max(0, region.rows - 1)
    if (y > last) return { x: within ? within.to : end.x, y: last }
    return { x: end.x, y }
  }
  return ordered({ from: at(selection.from), to: at(selection.to) })
}

/** The first and the last column of a row a selection takes, in reading order. */
function columnsOn(
  chosen: { from: Cell; to: Cell },
  y: number,
  width: number,
  within: Within | null,
): { start: number; end: number } {
  const start = Math.max(within?.from ?? 0, y === chosen.from.y ? chosen.from.x : 0)
  const end = Math.min(
    within ? within.to + 1 : Number.POSITIVE_INFINITY,
    y === chosen.to.y ? chosen.to.x + 1 : width,
  )
  return { start, end: Math.max(start, end) }
}

/** The text a selection covers, one line per row, without the spaces that pad a row out. */
export function selectedText(
  rows: readonly string[],
  chosen: { from: Cell; to: Cell },
  within: Within | null = null,
): string {
  const lines: string[] = []
  for (let y = chosen.from.y; y <= chosen.to.y; y++) {
    const plain = stripTerminalSequences(rows[y] ?? '')
    const { start, end } = columnsOn(chosen, y, visibleWidth(plain), within)
    lines.push(sliceByColumn(plain, start, Math.max(0, end - start)).trimEnd())
  }
  return lines.join('\n')
}

/**
 * The same, for a selection anchored in a region's own lines: the whole span,
 * including the pages of it that have scrolled off the screen.
 *
 * `within` is where the region was drawn across the window, which is what turns
 * a column of the window into a column of the line. Reaching past what the
 * window holds of the region gives what it holds and no invention: a lane's
 * scrollback goes back as far as it has been read and no further.
 */
export function spanText(
  region: Region,
  span: { from: End; to: End },
  within: Within | null,
): string {
  const left = within?.from ?? 0
  const columns = within ? within.to - within.from + 1 : null
  const place = (end: End) => ({ line: end.line ?? 0, column: Math.max(0, end.x - left) })
  const one = place(span.from)
  const other = place(span.to)
  const forwards = one.line < other.line || (one.line === other.line && one.column <= other.column)
  const a = forwards ? one : other
  const b = forwards ? other : one
  const last = region.first + region.lines.length - 1
  const from = Math.max(region.first, Math.min(last, a.line))
  const to = Math.max(from, Math.min(last, b.line))
  const lines: string[] = []
  for (let line = from; line <= to; line++) {
    const plain = stripTerminalSequences(region.lines[line - region.first] ?? '')
    const start = line === a.line ? a.column : 0
    // A whole line is as wide as the region was drawn, or — with no region to
    // bound it — as wide as the line itself.
    const end = line === b.line ? Math.max(start, b.column + 1) : (columns ?? visibleWidth(plain))
    lines.push(sliceByColumn(plain, start, Math.max(0, end - start)).trimEnd())
  }
  return lines.join('\n')
}

/** Rows with a selection shown the way a terminal shows one: reversed. */
export function highlighted(
  rows: readonly string[],
  chosen: { from: Cell; to: Cell },
  width: number,
  within: Within | null = null,
): string[] {
  return rows.map((row, y) => {
    if (y < chosen.from.y || y > chosen.to.y) return row
    const { start, end } = columnsOn(chosen, y, width, within)
    const plain = stripTerminalSequences(row)
    const lit = sliceByColumn(plain, start, Math.max(0, end - start))
    return `${sliceByColumn(row, 0, start)}\x1b[0m\x1b[7m${lit}\x1b[0m${sliceByColumn(row, end, Math.max(0, width - end))}`
  })
}
