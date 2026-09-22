import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui'
import type { Target } from '../hits.ts'
import { barRows, type Scrolled } from '../scrollbar.ts'
import { fit as fitRow, type Pointer } from '../ui.ts'
import type { PanelContext } from './context.ts'

// The cells every panel is built out of.
//
// Not a dumping ground: each of these is here because the measurement says it
// is genuinely shared — `cap` in eight panels, `bar` in six, `pad` and `padTo`
// and `wrapTo` across the three that draw a table. A helper only one panel uses
// lives in that panel's own file, where a change to it is a change to one thing.

/**
 * A scrollbar's cells for one of the panel's two sides, each with the hit that
 * turns a drag on it back into a line to scroll to. The same bar the rest of
 * the window uses — one thumb, painted cells — so the panel does not grow a
 * scrollbar of its own.
 *
 * Drawn whether or not there is anything to scroll: a column that comes and
 * goes moves everything beside it every time the page changes.
 */
export function bar(
  view: Scrolled,
  area: 'panel' | 'panel-side',
  ctx: PanelContext,
): { cell: string; target: Target }[] {
  const held =
    ctx.scrolling === area ||
    (ctx.pointer.hover?.kind === 'scrollbar' && ctx.pointer.hover.area === area)
  const target: Target = { kind: 'scrollbar', area, total: view.total, shown: view.shown }
  return barRows(view, ctx.skin, held).map((cell) => ({ cell, target }))
}

/**
 * The first row of a list to draw: where it was scrolled to, moved as far as
 * it must to keep the row you are on in view.
 *
 * Which is the whole rule, in one place: whoever scrolls reads where they
 * like, and the keyboard moving the choice brings the list back to it —
 * because a choice you cannot see is a choice you did not make.
 */
export function listStart(scroll: number, total: number, room: number, chosen: number): number {
  const most = Math.max(0, total - room)
  let from = Math.max(0, Math.min(scroll, most))
  if (chosen >= from + room) from = Math.min(most, chosen - room + 1)
  if (chosen < from) from = chosen
  return Math.max(0, Math.min(from, most))
}

/** `8 tools`, `1 watch`: a count said the way somebody would say it. */
export function count(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`
}

/**
 * How wide the list of categories is. Pared back rather than dropped: a panel
 * you cannot change category in is a panel with one category.
 */
export function sideWidth(inner: number): number {
  if (inner >= 76) return 24
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
