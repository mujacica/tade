import type { Skin } from './skin.ts'

// The bar down the right of anything that scrolls, and the one along the
// bottom of anything wider than its pane.
//
// Two jobs, and the second is the one that is usually missing: it says where
// you are in something longer than the screen, and it can be taken hold of and
// moved. A window that reports the mouse itself gets neither for free — the
// terminal's own scrollbar is scrolling the terminal, not the pane inside it —
// so every region that scrolls draws one of these and answers drags on it.
//
// The arithmetic does not know which way it is pointing: a bar lying down is
// the same sums over columns, so there is one of these and not two that drift.
//
// Pure: a few numbers in, rows of glyphs out, and the same arithmetic run
// backwards to turn a row the pointer is on into a place to scroll to.

/** How much of something is in view, and where. Lines down, or columns across. */
export interface Scrolled {
  /** Lines — or columns — there are altogether. */
  total: number
  /** Lines, or columns, in view at once. */
  shown: number
  /** Lines above the first one in view, or columns left of it. */
  offset: number
  /** Cells of track the bar is drawn in: rows down the side, columns along the bottom. */
  rows: number
}

/** Where the thumb sits: the row it starts on, and how many rows it covers. */
export interface Thumb {
  from: number
  size: number
}

/** A column of one: how wide a bar is, and what every region has to leave it. */
export const BAR = 1

/**
 * Where the thumb goes, or nothing when everything already fits — a bar that
 * fills its whole track says "there is more" when there is not.
 *
 * The thumb is never the whole track and never less than a row: a scrollbar
 * you cannot see is as useless as one you cannot move.
 */
export function thumbOf(view: Scrolled): Thumb | null {
  const { rows } = view
  const total = Math.max(0, view.total)
  const shown = Math.max(0, view.shown)
  if (rows < 2 || total <= shown || shown <= 0) return null
  const size = Math.max(1, Math.min(rows - 1, Math.round((rows * shown) / total)))
  const span = rows - size
  const most = total - shown
  const offset = Math.max(0, Math.min(most, view.offset))
  return { from: Math.round((offset / most) * span), size }
}

/**
 * The offset that puts the thumb's top on this row of the track: a drag, read
 * backwards. Past either end is that end, because a pointer dragged off the
 * bar still means "as far as it goes that way".
 */
export function offsetAt(view: Scrolled, row: number): number {
  const thumb = thumbOf(view)
  if (!thumb) return 0
  const span = view.rows - thumb.size
  const most = Math.max(0, view.total - view.shown)
  if (span <= 0) return most
  return Math.round((Math.max(0, Math.min(span, row)) / span) * most)
}

/**
 * The rows of the bar itself, top to bottom. `lit` while it is being dragged or
 * pointed at.
 *
 * Every row of the thumb is the very same cell and every row of the track is
 * the very same cell, both of them filled by the skin rather than drawn as a
 * glyph on the window's ground: a thumb is one object, and a bar whose rows
 * are each their own little box says the opposite of what it is for. Which
 * two tones they are is the skin's to say — a scrollbar that picked its own
 * greys would be the one part of the window outside the palette.
 *
 * Drawn even where nothing scrolls, because a column that comes and goes
 * reflows everything beside it every time output arrives.
 */
export function barRows(
  view: Scrolled,
  skin: Skin,
  lit: boolean,
  marks: readonly (BarMark | null)[] = NO_MARKS,
): string[] {
  const thumb = thumbOf(view)
  const track = skin.scrollTrack()
  const held = skin.scrollThumb(lit)
  return Array.from({ length: Math.max(0, view.rows) }, (_, row) => {
    const on = thumb !== null && row >= thumb.from && row < thumb.from + thumb.size
    const mark = marks[row] ?? null
    if (mark) return skin.scrollMark(mark, on, lit)
    return on ? held : track
  })
}

/** What a cell of the bar can say is in the stretch of the file it stands for. */
export type BarMark = 'add' | 'remove' | 'change'

/** A run of lines something is to be marked on — a change, for the file viewer. */
export interface Marked {
  from: number
  /** One past its last line. */
  to: number
  kind: BarMark
}

const NO_MARKS: readonly (BarMark | null)[] = []

/**
 * Which cells of a bar stand for some of these runs, and what they say: each
 * run placed down the track as far as it is down what there is, so where a
 * mark is says where in the file to look. A cell two kinds of run share says
 * `change`, because that stretch has both in it.
 *
 * Where everything fits, a cell is the line beside it. A run is never too
 * short to be marked — a one-line change in a file of a hundred thousand is a
 * cell, because a mark too small to draw is a change nobody finds.
 *
 * And a mark never contradicts the thumb. The thumb is placed by how far you
 * are through what can be scrolled and a mark by how far its line is through
 * all of it, and rounded, the two part by a cell: a change on screen came out
 * marked just above the thumb, which says there is a change above what you are
 * reading. So a run in view is marked inside the thumb, one above it above,
 * one below it below — where it falls anyway, everywhere but at the thumb's
 * two edges.
 *
 * Kept with the runs it was made from, for the view it was made for: the runs
 * are made once per diff, and every frame drawn after the first, until the
 * view moves, is answered with the very same cells.
 */
export function marksAlong(runs: readonly Marked[], view: Scrolled): readonly (BarMark | null)[] {
  const { total, shown, offset, rows } = view
  const kept = MARKS.get(runs)
  if (
    kept &&
    kept.view.total === total &&
    kept.view.shown === shown &&
    kept.view.offset === offset &&
    kept.view.rows === rows
  )
    return kept.marks
  const marks: (BarMark | null)[] = new Array(Math.max(0, rows)).fill(null)
  // Lines per cell, where there are more lines than cells: one otherwise.
  const unit = Math.max(total, rows, 1)
  const cellOf = (line: number) => Math.max(0, Math.min(rows - 1, Math.floor((line * rows) / unit)))
  const thumb = thumbOf(view)
  const top = Math.max(0, Math.min(total - shown, offset))
  for (const run of runs) {
    if (rows <= 0 || run.to <= run.from) continue
    let first = cellOf(run.from)
    let last = cellOf(run.to - 1)
    if (thumb) {
      // The cells the run may be drawn in, by where it is against the view.
      const [lo, hi] =
        run.to <= top
          ? [0, Math.max(0, thumb.from - 1)]
          : run.from >= top + shown
            ? [Math.min(rows - 1, thumb.from + thumb.size), rows - 1]
            : [thumb.from, thumb.from + thumb.size - 1]
      first = Math.max(lo, Math.min(hi, first))
      last = Math.max(lo, Math.min(hi, last))
    }
    for (let cell = first; cell <= last; cell++) {
      const there = marks[cell]
      marks[cell] = there && there !== run.kind ? 'change' : run.kind
    }
  }
  MARKS.set(runs, { view: { total, shown, offset, rows }, marks })
  return marks
}

const MARKS = new WeakMap<
  readonly Marked[],
  { view: Scrolled; marks: readonly (BarMark | null)[] }
>()

/**
 * The same column beside something the window is *not* scrolling: what a
 * region whose program took the screen for itself gets instead of a bar.
 *
 * A bar is drawn from three numbers — how much there is, how much is in view,
 * where in it you are — and a program on the alternate screen keeps none of
 * them anywhere the window can read. What scrolled off was never kept, the
 * wheel is handed to the program and it moves its own conversation, so every
 * one of those numbers would be invented. Which is what the empty track was:
 * `lines` is the height of the screen and the screen is what is in view, so
 * the bar had nothing to draw and looked exactly like one that is broken —
 * and with an approval card over the pane the two numbers differed by five
 * rows, so a thumb appeared, saying something true about the capture and
 * nothing at all about where the program is in its own history.
 *
 * So: `lane` — it scrolls, elsewhere — is a dashed rule the whole height,
 * which cannot be read as a thumb, because a thumb is never the whole track.
 * `nobody` — it took the screen and does not want the mouse — is the plain
 * track every region that does not scroll already draws, because nothing here
 * scrolls either. Neither is ever given a hit, so neither lights under the
 * pointer and neither can be dragged: a handle that moves nothing is worse
 * than no handle.
 */
export function gutterRows(rows: number, skin: Skin, whose: 'lane' | 'nobody'): string[] {
  const cell = whose === 'lane' ? skin.scrollElsewhere() : skin.scrollTrack()
  return Array.from({ length: Math.max(0, rows) }, () => cell)
}

/**
 * The same bar lying down: one row, a cell per column of the track, for a pane
 * whose content is wider than it is. Drawn only where there is something to
 * scroll to — a bar along the bottom of a pane that fits says there is more to
 * the right when there is not, and costs a row of the pane to say it.
 */
export function barAcross(view: Scrolled, skin: Skin, lit: boolean): string {
  return barRows(view, skin, lit).join('')
}
