import type { Skin } from './skin.ts'

// The bar down the right of anything that scrolls.
//
// Two jobs, and the second is the one that is usually missing: it says where
// you are in something longer than the screen, and it can be taken hold of and
// moved. A window that reports the mouse itself gets neither for free — the
// terminal's own scrollbar is scrolling the terminal, not the pane inside it —
// so every region that scrolls draws one of these and answers drags on it.
//
// Pure: a few numbers in, rows of glyphs out, and the same arithmetic run
// backwards to turn a row the pointer is on into a place to scroll to.

/** How much of something is in view, and where. */
export interface Scrolled {
  /** Lines there are altogether. */
  total: number
  /** Lines in view at once. */
  shown: number
  /** Lines above the first one in view. */
  offset: number
  /** Rows the bar is drawn in. */
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
 * The track is a thin rule rather than a full one: the bar sits beside the
 * window's own dividers, and two `│` next to each other read as a mistake.
 * Drawn even where nothing scrolls, because a column that comes and goes
 * reflows everything beside it every time output arrives.
 */
export function barRows(view: Scrolled, skin: Skin, lit: boolean): string[] {
  const thumb = thumbOf(view)
  const track = skin.faded('▕')
  const paint = lit ? skin.you : skin.hint
  return Array.from({ length: Math.max(0, view.rows) }, (_, row) =>
    thumb && row >= thumb.from && row < thumb.from + thumb.size ? paint('█') : track,
  )
}
