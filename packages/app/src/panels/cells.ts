import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import { fit as fitRow, type Pointer } from '../ui.ts'

// The cells every panel is built out of: text, fitted and cut.
//
// Not a dumping ground: each of these is here because the measurement says it
// is genuinely shared — `cap` in eight panels, `pad` and `padTo` and `wrapTo`
// across the three that draw a table. A helper only one panel uses lives in
// that panel's own file, where a change to it is a change to one thing.
//
// The panel's shell — how big it is, how its body scrolls, the bar beside it —
// is `frame.ts`, which is built on these.

/** `8 tools`, `1 watch`: a count said the way somebody would say it. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * How wide the list of categories is. Pared back rather than dropped: a panel
 * you cannot change category in is a panel with one category.
 *
 * Four columns wider than it was on a terminal with room for them. The rows are
 * what somebody clicks, so the list is a column of targets, and a target you
 * have to aim at sideways is no better than one you have to aim at downwards —
 * at 24 columns the longest name there is (`Keys and tokens`, with a count
 * beside it) was the one cut. The two narrow steps keep what they had: the
 * columns come out of what is beside the list, and on a narrow terminal that is
 * a tool's name or a watch's title giving up its end instead.
 */
export function sideWidth(inner: number): number {
  if (inner >= 76) return 28
  if (inner >= 58) return 18
  return 16
}

/** A path as you would type it: `~/src/pay` rather than `/Users/me/src/pay`. */
export function tildeOf(path: string, home: string): string {
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

/** The keyboard's own control drawn lit, where the mouse is not on something else. */
export function withFocus(pointer: Pointer, id: string | null): Pointer {
  if (!id || pointer.hover) return pointer
  return { ...pointer, hover: { kind: 'control', id } }
}

export function fitTo(text: string, width: number): string {
  return fitRow(text, width)
}

export function pad(text: string, width: number): string {
  const cut = [...text].slice(0, width).join('')
  return cut + ' '.repeat(Math.max(0, width - cut.length))
}

/**
 * As many columns as it is given, with an ellipsis where a word was cut.
 *
 * The difference from `pad` is the whole point: text that stops dead reads as
 * text that ran into what is beside it, which is what it used to do.
 */
export function cap(text: string, width: number): string {
  if (width <= 0) return ''
  if (visibleWidth(text) <= width) return text
  return `${truncateToWidth(text, Math.max(1, width - 1), '')}…`
}

/** `cap`, padded out: exactly `width` columns, so what follows starts where it should. */
export function padTo(text: string, width: number): string {
  const short = cap(text, width)
  return short + ' '.repeat(Math.max(0, width - visibleWidth(short)))
}

/**
 * A sentence over at most so many lines, the last one ellipsised: a paragraph
 * that does not fit is shortened where it is read, never past the panel edge.
 */
export function wrapTo(text: string, width: number, lines: number): string[] {
  if (width <= 0 || lines <= 0 || text.trim() === '') return []
  const all = wrapTextWithAnsi(text, width)
  if (all.length <= lines) return all
  const kept = all.slice(0, lines)
  kept[lines - 1] = cap(`${kept[lines - 1] ?? ''} ${all.slice(lines).join(' ')}`, width)
  return kept
}
