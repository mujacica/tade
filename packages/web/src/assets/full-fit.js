// How big the full view draws the window on this screen (§10 T4 of the Duo
// plan): the type size, and the columns and rows that come of it. The window
// lays itself out for whatever terminal it is given, so what is decided here is
// only how big a cell is — and from that, how many there are.
//
// **One cell width sideways, on every phone.** The plan asks for about 130
// columns on the Duo's large screen sideways (951 CSS px) and about 80 on its
// small one (594 px once the camera column is taken): both are a cell of about
// 7.35 px, which is the type at about 12 px in a monospace face. So the cell is
// that width wherever the screen is a terminal's shape, and a slab phone
// sideways (750–930 px) gets 100–125 columns of the same type rather than type
// scaled to some count. Upright the window wants more than the width allows, so
// the type comes down to fit at least `UPRIGHT_COLUMNS`, never below `SMALLEST`.
//
// **The fold, with no API.** On the large screen sideways the fold is the
// centre line, wherever the phone is folded — the Duo's inner screen folds at
// 475.5 of 951 — and the browser cannot tell book pose from flat until WebKit
// turns Viewport Segments on (the plan's §2). So on that screen the sidebar's
// edge is put on the centre column always, which is right in either pose:
// `book` is a screen sideways, at least `BOOK_WIDTH` wide and no wider than
// `BOOK_ASPECT` times its height — the Duo's inner screen (951 × 669, 1.42),
// and never a slab phone sideways (932 × 430, 2.2).
//
// Pure: numbers in, numbers out, so the table in `test/full-fit.test.ts` is the
// whole of it. The page measures what one character of its face is at 1 px of
// type (`ratio`, about 0.6) and how tall a line is (`lead`) and hands both in.

/** The width of a cell wherever the screen is sideways: about 12 px type. */
export const CELL = 7.35

/** The fewest columns the window is drawn in upright, where the type comes down to fit. */
export const UPRIGHT_COLUMNS = 64

/** The smallest type, in px, however narrow the screen. */
export const SMALLEST = 9

/** The type the window's fewest rows may bring it down to, and no further, with the keyboard up. */
export const TINY = 6

/** The largest type, in px, however wide. */
export const LARGEST = 16

/** A screen at least this wide sideways, and no wider than `BOOK_ASPECT` times its height, folds. */
export const BOOK_WIDTH = 800
export const BOOK_ASPECT = 1.6

/** The fewest columns and rows the window can be laid out in (`layout.ts`'s minimum and its door's). */
const LEAST = { columns: 33, rows: 9 }

/**
 * The type, the columns and the rows for a room of `width` × `height` CSS px,
 * and where the sidebar's edge goes: `sidebar` is a column count on the large
 * screen sideways, and null everywhere else, where the window's own is kept.
 *
 * `screen` is the whole of the glass, which says how the phone is held and
 * whether it folds; the room is what is left of it for the window, under the
 * header and above the keys — and above the keyboard, which leaves an upright
 * phone a room wider than it is tall without turning it sideways.
 */
export function fitOf({ width, height, screen = { width, height }, ratio = 0.6, lead = 1.2 }) {
  const sideways = screen.width > screen.height
  const cell = sideways ? CELL : Math.min(CELL, width / UPRIGHT_COLUMNS)
  // To the hundredth of a pixel, as the grid is given it, so the columns are counted in that.
  let font = Math.round(clamp(cell / ratio, SMALLEST, LARGEST) * 100) / 100
  // A room too short for the window's fewest rows — the keyboard up on a phone
  // held sideways — brings the type down until they fit, rather than drawing
  // the window's foot under the keys.
  if (height / (font * lead) < LEAST.rows) {
    font = Math.max(TINY, Math.floor((height / (LEAST.rows * lead)) * 100) / 100)
  }
  const across = font * ratio
  const tall = font * lead
  const columns = Math.max(LEAST.columns, Math.floor(width / across))
  const rows = Math.max(LEAST.rows, Math.floor(height / tall))
  const book = sideways && screen.width >= BOOK_WIDTH && screen.width / screen.height <= BOOK_ASPECT
  return {
    font,
    columns,
    rows,
    book,
    sidebar: book ? foldAt(columns) : null,
  }
}

/**
 * The sidebar's width that puts its edge on the centre column. The window
 * draws `sidebar` columns, the edge, then the pane: so the edge is at column
 * `sidebar`, counted from nought, and the centre of `columns` is half of it.
 */
export function foldAt(columns) {
  return Math.floor(columns / 2)
}

function clamp(n, least, most) {
  return Math.min(most, Math.max(least, n))
}
