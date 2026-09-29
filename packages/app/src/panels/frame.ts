import { visibleWidth } from '@earendil-works/pi-tui'
import type { Hit, Target } from '../hits.ts'
import { BAR, barRows, type Scrolled } from '../scrollbar.ts'
import type { Skin } from '../skin.ts'
import { blank, Row } from '../ui.ts'
import { fitTo, pad } from './cells.ts'
import type { PanelContext } from './context.ts'

// The shell every panel is drawn in: how big it is, how its body scrolls, how
// its bar is drawn beside it, and where its foot sits.
//
// Nine panels grew nine answers to the same four questions. Settings capped
// itself at twenty-eight rows whatever the terminal, drew no bar at all, and
// followed the row the keyboard was on — so the wheel over it had nothing to
// move and was answered by pressing the down key instead, which is why
// scrolling it jumped a setting at a time and skipped. Spend cut its table at
// a fixed count and said `+7 more`. The setup page cut its own Save button
// off the bottom. Each of those is the same bug with a different surface over
// it, and this is the one place the answer now lives.
//
// Pure, like the drawings it serves: numbers and lines in, lines out.

/** A drawn row and what can be pressed on it: what every panel is built out of. */
export interface Line {
  text: string
  hits: Hit[]
}

/**
 * Columns of window kept either side of a panel.
 *
 * Three a side rather than two: a panel is read over the work behind it, and
 * the margin is what says which is which.
 */
const BESIDE = 6

/**
 * Rows of window a panel never takes.
 *
 * The strip along the bottom is four rows, and a panel drawn over it is a
 * panel whose foot — Done, and what it last said — is underneath it. The
 * other two are the margin, one at each end.
 */
const AROUND = 6

/** The fewest rows inside the border a panel can be drawn in and still say anything. */
const LEAST = 6

/** The narrowest a box is worth drawing, whatever the terminal. */
const NARROWEST = 24

/** A panel's geometry: the box, and the room inside it. */
export interface PanelSize {
  /** The whole panel, its border included. */
  width: number
  height: number
  /** Columns inside the border. */
  inner: number
  /** Rows inside the border. */
  rows: number
}

/**
 * How big a panel is: the room it needs, up to the room there is.
 *
 * `max` is the widest it is worth being — prose read across a whole ultrawide
 * is prose nobody reads — and `needs` is how many rows its content would like.
 * A panel that says how much it needs is drawn that tall and no taller; one
 * that does not takes the window it is given. Neither ever covers the strip at
 * the foot, and neither is ever capped at a number somebody typed once:
 * Settings was fixed at twenty-eight rows, which is half a tall terminal, and
 * that is the whole of what "the Settings window is too small" was.
 */
export function panelSize(
  ctx: { width: number; height: number },
  want: { max: number; needs?: number; least?: number },
): PanelSize {
  const width = Math.max(NARROWEST, Math.min(want.max, ctx.width - BESIDE))
  const least = want.least ?? LEAST
  const most = Math.max(least, ctx.height - AROUND - 2)
  const rows = want.needs === undefined ? most : Math.max(least, Math.min(want.needs, most))
  return { width, height: rows + 2, inner: width - 2, rows }
}

/**
 * The first line of a body to draw: where it was scrolled to, moved as far as
 * it must to keep the row the keyboard is on in view.
 *
 * The whole rule, in one place: whoever scrolls reads where they like, and the
 * keyboard moving the choice brings the body back to it — because a choice you
 * cannot see is a choice you did not make. `chosen` is a span rather than a
 * line because a row of a form is as many lines as its control needs, and a
 * setting half in view is a setting you cannot use.
 */
export function startOf(
  scroll: number,
  total: number,
  room: number,
  chosen?: { from: number; to: number } | null,
): number {
  const most = Math.max(0, total - room)
  let from = Math.max(0, Math.min(scroll, most))
  if (!chosen || room <= 0) return from
  if (chosen.to >= from + room) from = Math.min(most, chosen.to - room + 1)
  if (chosen.from < from) from = chosen.from
  return Math.max(0, Math.min(from, most))
}

/** The same, for a list whose rows are one line each. */
export function listStart(scroll: number, total: number, room: number, chosen: number): number {
  return startOf(scroll, total, room, { from: chosen, to: chosen })
}

/**
 * A scrollbar's cells for one of the panel's two sides, each with the hit that
 * turns a drag on it back into a line to scroll to. The same bar the rest of
 * the window uses — one thumb, painted cells — so a panel does not grow a
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

/** What scrolls inside a panel: the lines, where they are, and how much is in view. */
export interface Body {
  /** Every line there is, laid out whole. */
  lines: readonly Line[]
  /** Columns the lines are drawn in — the bar's own column is beside them. */
  width: number
  /** Where it was scrolled to: the panel's own `scroll`. */
  scroll: number
  /** Rows of it in view. Filled in by `column`, which works it out from the room. */
  room?: number
  /** Where the row the keyboard is on begins and ends, so scrolling follows it. */
  chosen?: { from: number; to: number } | null
  /** Which of the window's two panel areas this is. */
  area?: 'panel' | 'panel-side'
}

/** The body drawn: its rows, each with its bar cell, and where it ended up. */
export function bodyRows(
  body: Body & { room: number },
  ctx: PanelContext,
): { rows: Line[]; offset: number } {
  const total = body.lines.length
  const room = Math.max(1, body.room)
  const offset = startOf(body.scroll, total, room, body.chosen)
  const cells = bar({ total, shown: room, offset, rows: room }, body.area ?? 'panel', ctx)
  const rows = Array.from({ length: room }, (_, i) => {
    const line = body.lines[offset + i] ?? blank(body.width)
    const cell = cells[i]
    return {
      text: `${fitTo(line.text, body.width)}${cell?.cell ?? ' '}`,
      hits: [
        ...line.hits,
        ...(cell ? [{ row: 0, from: body.width, to: body.width, target: cell.target }] : []),
      ],
    }
  })
  return { rows, offset }
}

/** One column of a panel: what stays put, what scrolls, and what is pinned under it. */
export interface Column {
  /** Rows above the body that never scroll: a search field, a heading. */
  head?: readonly Line[]
  body: Body
  /**
   * Rows pinned to the bottom, which nothing scrolls over: what the panel last
   * said, and then the keys with its buttons on the right. Two of them
   * everywhere, because a button that reading past the fold takes away is a
   * button that is gone.
   */
  foot?: readonly Line[]
  /** Rows the column has altogether. */
  rows: number
}

/**
 * A panel's column, drawn: the head, the body scrolled with its bar beside it,
 * and the foot at the bottom whatever the body did.
 *
 * `width + 1` columns wide — the extra one is the bar's, kept whether or not
 * there is anything to scroll.
 */
export function column(col: Column, ctx: PanelContext): { rows: Line[]; offset: number } {
  const head = col.head ?? []
  const foot = col.foot ?? []
  const width = col.body.width
  const room = Math.max(1, col.rows - head.length - foot.length)
  const drawn = bodyRows({ ...col.body, room }, ctx)
  const still = (line: Line | undefined): Line => ({
    text: `${fitTo(line?.text ?? '', width)} `,
    hits: line?.hits ?? [],
  })
  const rows = [...head.map(still), ...drawn.rows, ...foot.map(still)]
  return { rows: rows.slice(0, col.rows), offset: drawn.offset }
}

/**
 * Two columns side by side, with the rule between them: the list down the left
 * and what it is showing on the right.
 *
 * The wheel over the left moves the left, laid under everything drawn on it so
 * a click still presses what it is on — the panel's own `scroll` hit, which
 * the window lays under every row of whatever panel is open, is under this one
 * in turn.
 */
export function beside(
  left: readonly Line[],
  right: readonly Line[],
  side: number,
  skin: Skin,
): Line[] {
  const rows = Math.max(left.length, right.length)
  return Array.from({ length: rows }, (_, i) => {
    const one = left[i]
    const other = right[i]
    return {
      text: `${fitTo(one?.text ?? '', side)}${skin.chrome('│')}${other?.text ?? ''}`,
      hits: [
        { row: 0, from: 0, to: side, target: { kind: 'scroll', area: 'panel-side' } as Target },
        ...(one?.hits ?? []),
        ...(other?.hits ?? []).map((hit) => ({
          ...hit,
          from: hit.from + side + 1,
          to: hit.to + side + 1,
        })),
      ],
    }
  })
}

/**
 * A row of a list, painted: the one chosen is on the selection ground, the one
 * under the pointer a shade lighter than it, and everything else plain.
 *
 * One rule, because four panels had four. The models list and the branch list
 * marked the chosen row and did nothing at all under the pointer, so a row you
 * were about to click gave no sign it was the one; a menu did the opposite and
 * drew the pointed item as *chosen*, marker and all, so the keyboard appeared
 * to move when only the mouse had.
 */
export function rowLook(text: string, skin: Skin, look: { on: boolean; pointed: boolean }): string {
  if (look.on) return skin.selected(text)
  return look.pointed ? skin.hovered(text) : text
}

/**
 * The search field every panel that has one draws: the same field, the same
 * place, and the same behaviour — it says what it is for until you use it.
 */
export function searchRow(
  width: number,
  ctx: PanelContext,
  opts: { text: string; says: string; caret: boolean; id?: string; ghost?: string },
): Line {
  const empty = opts.text === '' && !opts.caret
  return new Row(width, ctx.skin, ctx.pointer)
    .space()
    .field(empty ? opts.says : opts.text, width - 2, {
      caret: opts.caret,
      hint: empty,
      target: { kind: 'control', id: opts.id ?? 'search' },
      ...(opts.ghost ? { ghost: opts.ghost } : {}),
    })
    .build()
}

/**
 * How far a key moves a page that scrolls, or nothing where the key is not one
 * of them. The keyboard's half of the one move: a panel answers it through the
 * same clamp the wheel and the bar go through.
 */
/**
 * A row of tabs under the word that introduces it: `for` the ranges a page is
 * read over, `by` the way it is grouped.
 *
 * More tabs than a narrow panel fits on one line is the ordinary case — five
 * ranges and six groupings on the Spend page, five sections and the ranges on
 * an extension's — and a tab past the edge is a tab nobody can reach, so they
 * wrap rather than run off it. Both pages wrap the same way and both leads are
 * padded to one width, so two rows of tabs start in one column.
 */
export function tabRow(
  make: () => Row,
  skin: Skin,
  word: string,
  options: readonly { id: string; label: string }[],
  chosen: string,
  control: string,
  inner: number,
): Line[] {
  const lines: Line[] = []
  let line = make().space().text(pad(word, LEAD_WORD), skin.hint)
  for (const option of options) {
    if (line.used + visibleWidth(option.label) + 4 > inner) {
      lines.push(line.build())
      line = make().space(1 + LEAD_WORD)
    }
    line.tab(option.label, { kind: 'control', id: `${control}:${option.id}` }, chosen === option.id)
  }
  lines.push(line.build())
  return lines
}

/** The lead word's column: `by` and `for` padded to one width, so the tabs line up. */
const LEAD_WORD = 4

export function pageBy(key: string | undefined, page = 10): number | null {
  if (key === 'down') return 1
  if (key === 'up') return -1
  if (key === 'pageDown' || key === 'space') return page
  if (key === 'pageUp') return -page
  return null
}

export { BAR }
