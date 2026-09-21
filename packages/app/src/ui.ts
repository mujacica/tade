import {
  compositeTuiLine,
  sliceByColumn,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { type Hit, rowHit, sameTarget, shift, type Target } from './hits.ts'
import { type IconState, type Look, markLabel, type Skin, type SwitchState } from './skin.ts'

// The controls, and the two things every region is made of: rows that know
// what is clickable in them, and boxes that float over other rows.
//
// A `Row` is built left to right, with an optional group pinned to its right
// edge. Every control is measured by the text it draws before colour is
// applied, so a row's hits are right with any skin, and a row that would not
// fit loses its right group first and its tail second — never its width.

/** Where the pointer is, which is all a control needs to know to look pressed. */
export interface Pointer {
  hover: Target | null
  pressed: Target | null
}

export const NO_POINTER: Pointer = { hover: null, pressed: null }

/** The clear column `keys` puts before a cap, and either side of the `+`. */
const KEY_GAP = ' '

/**
 * Columns `Row.keys` will take, without drawing it: a leading gap and a cap
 * of its label + 4 for each name, and a gap and a `+` before all but the
 * first. A layout that has to know how wide the keys are before it places
 * them asks here rather than working it out again — two answers to the same
 * question drift the moment the spacing changes, and this one has.
 */
export function keysWidth(names: readonly string[]): number {
  return names.reduce(
    (sum, name, i) =>
      sum + visibleWidth(name) + 4 + KEY_GAP.length + (i > 0 ? KEY_GAP.length + 1 : 0),
    0,
  )
}

/** A drawn region: its rows, and what each part of them is. */
export interface Drawn {
  rows: string[]
  hits: Hit[]
}

export class Row {
  readonly width: number
  readonly skin: Skin
  readonly pointer: Pointer
  private parts: string[] = []
  private col = 0
  private hits: Hit[] = []
  private pinned: Row | null = null

  constructor(width: number, skin: Skin, pointer: Pointer = NO_POINTER) {
    this.width = Math.max(0, width)
    this.skin = skin
    this.pointer = pointer
  }

  /** Columns used so far, not counting the right group. */
  get used(): number {
    return this.col
  }

  text(text: string, paint: (text: string) => string = (t) => t, target?: Target): this {
    return this.put(paint(text), visibleWidth(text), target)
  }

  /** The wordmark as a block: the spelt-out label + 4 columns, like a button but not one. */
  mark(label: string): this {
    return this.put(this.skin.mark(label), visibleWidth(markLabel(label)) + 4)
  }

  space(n = 1): this {
    return n > 0 ? this.put(' '.repeat(n), n) : this
  }

  button(label: string, target: Target, look: Look = 'rest'): this {
    return this.put(
      this.skin.button(label, this.lookOf(target, look), this.litBy(target, look)),
      visibleWidth(label) + 4,
      target,
    )
  }

  /**
   * A button of the same block, two columns narrower: for a small control that
   * belongs to the set a button is in — a heading's `H` beside its `+` — and
   * must not read as wide as the button it sits beside.
   */
  chip(label: string, target: Target, look: Look = 'rest'): this {
    return this.put(
      this.skin.chip(label, this.lookOf(target, look), this.litBy(target, look)),
      visibleWidth(label) + 2,
      target,
    )
  }

  /**
   * A glyph as a button, lit under the pointer and held down: `×`, `≡`. A
   * destructive one is only red while the pointer is on it — at rest it is
   * as quiet as the rest.
   */
  icon(label: string, target: Target, tone: 'plain' | 'danger' | 'signal' = 'plain'): this {
    const rest: IconState = tone === 'signal' ? 'signal' : 'rest'
    const state: IconState = sameTarget(this.pointer.pressed, target)
      ? 'pressed'
      : sameTarget(this.pointer.hover, target)
        ? tone === 'danger'
          ? 'danger'
          : 'hover'
        : rest
    return this.put(this.skin.icon(label, state), visibleWidth(label) + 2, target)
  }

  tab(label: string, target: Target, on: boolean): this {
    const hover = sameTarget(this.pointer.hover, target)
    return this.put(this.skin.tabbed(label, on, hover), visibleWidth(label) + 4, target)
  }

  /**
   * Key caps joined by `+`: the shape of something you press. Given a target
   * the whole group is one control — what a key is set to is the thing you
   * click to set it again, and it lights as one.
   *
   * A cap is a painted block, so it needs ground around it to read as a key:
   * with the `+` against the block on both sides a combination runs together
   * into one long bar of colour rather than into two keys you press. So every
   * cap gets a clear column before it, and the `+` one either side. The gaps
   * belong to the target too — a control with holes punched through it is one
   * you have to aim at.
   */
  keys(names: readonly string[], target?: Target): this {
    const lit = target !== undefined && sameTarget(this.pointer.hover, target)
    names.forEach((name, i) => {
      if (i > 0) this.put(KEY_GAP, KEY_GAP.length, target).text('+', this.skin.hint, target)
      this.put(KEY_GAP, KEY_GAP.length, target)
      this.put(this.skin.keycap(` ${name} `, lit), visibleWidth(name) + 4, target)
    })
    return this
  }

  /**
   * The bar that marks the row you are on, or the column it takes left blank
   * so that nothing moves as a row is marked. Exactly one column.
   */
  marker(on: boolean, target?: Target): this {
    return this.put(on ? this.skin.marker() : ' ', 1, target)
  }

  badge(value: string | number): this {
    const text = ` ${value} `
    return this.put(this.skin.badge(text), text.length)
  }

  /**
   * A field, exactly `width` columns. Typed text keeps its end in view, since
   * the end is where you are typing.
   */
  field(
    value: string,
    width: number,
    opts: {
      caret?: boolean
      arrow?: boolean
      hint?: boolean
      target?: Target
      ghost?: string
    } = {},
  ): this {
    const inner = Math.max(1, width - 2)
    const lit = opts.target !== undefined && sameTarget(this.pointer.hover, opts.target)
    const tail = opts.arrow ? ' ▾' : ''
    let body = value + (opts.caret ? '▏' : '')
    const room = inner - tail.length
    if (visibleWidth(body) > room)
      body =
        // Typed text keeps its end; what a field says for itself — a
        // placeholder, a default — keeps its beginning, which is the part
        // that says what it is.
        opts.hint === true
          ? `${truncateToWidth(body, Math.max(1, room - 1), '')}…`
          : `…${[...body].slice(-(room - 1)).join('')}`
    // What tab would complete to, said quietly after the caret, where it fits.
    const ghost = [...(opts.ghost ?? '')].slice(0, Math.max(0, room - visibleWidth(body))).join('')
    const pad = ' '.repeat(Math.max(0, room - visibleWidth(body) - visibleWidth(ghost))) + tail
    if (!this.skin.colour) return this.put(`[${body}${ghost}${pad}]`, inner + 2, opts.target)
    const drawn = ghost
      ? `${this.skin.field(` ${body}`, opts.hint === true, lit)}${this.skin.field(ghost, true, lit)}${this.skin.field(`${pad} `, false, lit)}`
      : this.skin.field(` ${body}${pad} `, opts.hint === true, lit)
    return this.put(drawn, inner + 2, opts.target)
  }

  /**
   * A switch, thrown or not: exactly 8 columns whatever the skin, so a column
   * of them lines up and a switch never changes width as it is thrown.
   */
  toggle(on: boolean, target: Target): this {
    const state: SwitchState = sameTarget(this.pointer.pressed, target)
      ? 'pressed'
      : sameTarget(this.pointer.hover, target)
        ? 'hover'
        : 'rest'
    return this.put(this.skin.toggle(on, state), 8, target)
  }

  check(on: boolean, label: string, target: Target): this {
    const lit = sameTarget(this.pointer.hover, target)
    const mark = on ? this.skin.busy('■') : lit ? this.skin.signal('□') : this.skin.hint('□')
    const said = lit ? this.skin.link(label) : label
    return this.put(`${mark} ${said}`, 2 + visibleWidth(label), target)
  }

  radio(on: boolean, label: string, target: Target): this {
    const lit = sameTarget(this.pointer.hover, target)
    const mark = on ? this.skin.busy('◉') : lit ? this.skin.signal('○') : this.skin.hint('○')
    const said = lit ? this.skin.link(label) : label
    return this.put(`${mark} ${said}`, 2 + visibleWidth(label), target)
  }

  /** A share of something, in whole cells. */
  meter(share: number, cells: number, tone: (text: string) => string = this.skin.busy): this {
    const filled = Math.max(0, Math.min(cells, Math.round(share * cells)))
    return this.put(
      `${tone('█'.repeat(filled))}${this.skin.chrome('░'.repeat(cells - filled))}`,
      cells,
    )
  }

  /** Build the group that sits against the right edge. */
  right(build: (row: Row) => void): this {
    const group = new Row(this.width, this.skin, this.pointer)
    build(group)
    this.pinned = group
    return this
  }

  build(): { text: string; hits: Hit[] } {
    let text = this.parts.join('')
    let hits = this.hits
    let used = this.col

    const pinned = this.pinned
    if (pinned && pinned.col > 0 && used + 1 + pinned.col <= this.width) {
      const at = this.width - pinned.col
      text += ' '.repeat(at - used) + pinned.parts.join('')
      hits = [...hits, ...shift(pinned.hits, 0, at)]
      used = this.width
    }
    if (used > this.width) {
      text = cut(text, this.width)
      hits = hits
        .filter((hit) => hit.from < this.width)
        .map((hit) => ({ ...hit, to: Math.min(hit.to, this.width - 1) }))
      used = visibleWidth(text)
    }
    return { text: text + ' '.repeat(Math.max(0, this.width - used)), hits }
  }

  private put(drawn: string, width: number, target?: Target): this {
    if (target && width > 0)
      this.hits.push({ row: 0, from: this.col, to: this.col + width - 1, target })
    this.parts.push(drawn)
    this.col += width
    return this
  }

  private lookOf(target: Target, look: Look): Look {
    if (look === 'off') return look
    if (sameTarget(this.pointer.pressed, target)) return 'pressed'
    if ((look === 'rest' || look === 'add') && sameTarget(this.pointer.hover, target))
      return 'hover'
    return look
  }

  /**
   * Whether a button whose colour is its meaning is under the pointer: it
   * keeps that colour and the skin lights it, rather than turning grey and
   * losing what it was saying.
   */
  private litBy(target: Target, look: Look): boolean {
    if (look === 'off' || look === 'rest' || look === 'add') return false
    if (sameTarget(this.pointer.pressed, target)) return false
    return sameTarget(this.pointer.hover, target)
  }
}

/** Stack built rows into a region. */
export function stack(rows: readonly { text: string; hits: Hit[] }[]): Drawn {
  const drawn: Drawn = { rows: [], hits: [] }
  rows.forEach((row, i) => {
    drawn.rows.push(row.text)
    drawn.hits.push(...shift(row.hits, i))
  })
  return drawn
}

/** A blank row of a width. */
export function blank(width: number): { text: string; hits: Hit[] } {
  return { text: ' '.repeat(Math.max(0, width)), hits: [] }
}

/**
 * A window onto rows laid out wider than the room there is: everything shifted
 * `across` columns to the left and cut to `width`, with what can be clicked
 * moved with it and what has slid off the edge dropped.
 *
 * This is what a pane scrolling sideways is. The rows were drawn in the room
 * they needed — a chain of ten is ten boxes wide — and the pane shows the part
 * of them you have scrolled to, rather than the layout being folded up to fit
 * and saying something it does not mean.
 */
export function slid(
  rows: readonly { text: string; hits: Hit[] }[],
  across: number,
  width: number,
): { text: string; hits: Hit[] }[] {
  const from = Math.max(0, Math.round(across))
  if (from === 0)
    return rows.map((row) => ({ text: fit(row.text, width), hits: clipped(row.hits, width) }))
  return rows.map((row) => ({
    text: fit(sliceByColumn(row.text, from, width), width),
    hits: clipped(
      row.hits.map((hit) => ({ ...hit, from: hit.from - from, to: hit.to - from })),
      width,
    ),
  }))
}

/** What of a row's hits still lands on the pane, cut to its edges. */
function clipped(hits: readonly Hit[], width: number): Hit[] {
  const out: Hit[] = []
  for (const hit of hits) {
    if (hit.to < 0 || hit.from > width - 1) continue
    out.push({ ...hit, from: Math.max(0, hit.from), to: Math.min(width - 1, hit.to) })
  }
  return out
}

export interface BoxOptions {
  /** Said in the top border, right-aligned: `esc`, a count. */
  corner?: string
  /** A border in the colour of what the box is about, rather than the usual edge. */
  tone?: (text: string) => string
  /** The title's own colour, when it says more than the border does. */
  title?: (text: string) => string
  /** Lay the box on the panel surface. Off for a card drawn into a pane. */
  surface?: boolean
}

/**
 * A panel: a border, a title, and rows on the panel's own surface.
 *
 * Everything inside it swallows clicks it does not use, so a click inside a
 * panel can never land on the window underneath.
 */
export function box(
  title: string,
  inner: readonly { text: string; hits: Hit[] }[],
  width: number,
  skin: Skin,
  opts: BoxOptions = {},
): Drawn {
  const edge = opts.tone ?? skin.edge
  const room = width - 2
  const head = ` ${title} `
  const corner = opts.corner ? ` ${opts.corner} ` : ''
  const run = Math.max(0, room - 1 - visibleWidth(head) - visibleWidth(corner) - 1)
  const titled = opts.title ?? skin.you
  const lay = opts.surface === false ? (row: string) => row : skin.surface
  const top = `${edge('╭─')}${titled(head)}${edge('─'.repeat(run))}${skin.hint(corner)}${edge('─╮')}`

  const rows = [lay(top)]
  const hits: Hit[] = []
  for (const row of inner) {
    rows.push(lay(`${edge('│')}${fit(row.text, room)}${edge('│')}`))
    hits.push(...shift(row.hits, rows.length - 1, 1))
  }
  rows.push(lay(edge(`╰${'─'.repeat(room)}╯`)))
  const cover = rows.map((_, i) => rowHit(i, width, { kind: 'inert' }))
  return { rows, hits: [...cover, ...hits] }
}

/**
 * Lay one region over another.
 *
 * `modal` fades what is underneath and turns all of it into "close the panel",
 * which is what a click outside a dialog means everywhere else.
 */
export function overlay(
  base: Drawn,
  top: Drawn,
  at: { row: number; col: number },
  width: number,
  skin: Skin,
  modal: boolean,
): Drawn {
  const rows = modal
    ? base.rows.map((row) => skin.faded(stripTerminalSequences(row)))
    : [...base.rows]
  const topWidth = Math.max(0, ...top.rows.map((row) => visibleWidth(row)))
  top.rows.forEach((row, i) => {
    const r = at.row + i
    if (r < 0 || r >= rows.length) return
    rows[r] = compositeTuiLine(rows[r] ?? '', row, at.col, topWidth, width)
  })
  const under = modal
    ? base.rows.map((_, i) => rowHit(i, width, { kind: 'dismiss' }))
    : uncovered(base.hits, { row: at.row, col: at.col, rows: top.rows.length, cols: topWidth })
  return { rows, hits: [...under, ...shift(top.hits, at.row, at.col)] }
}

/**
 * What is still clickable once a region is laid over it: a control hidden
 * under a popup cannot be pressed, and one half-covered keeps the half you can
 * see.
 */
function uncovered(
  hits: readonly Hit[],
  cover: { row: number; col: number; rows: number; cols: number },
): Hit[] {
  const out: Hit[] = []
  const last = cover.col + cover.cols - 1
  for (const hit of hits) {
    if (
      hit.row < cover.row ||
      hit.row >= cover.row + cover.rows ||
      hit.to < cover.col ||
      hit.from > last
    ) {
      out.push(hit)
      continue
    }
    if (hit.from < cover.col) out.push({ ...hit, to: cover.col - 1 })
    if (hit.to > last) out.push({ ...hit, from: last + 1 })
  }
  return out
}

/** Exactly `width` visible columns: cut if longer, padded if shorter. */
export function fit(text: string, width: number): string {
  const short = visibleWidth(text) > width ? cut(text, width) : text
  return short + ' '.repeat(Math.max(0, width - visibleWidth(short)))
}

/**
 * Cut to a width. Truncation closes any colour it cut through with a reset,
 * which is right for a painted row and a stray escape code in a plain one — so
 * a row that had no colour going in has none coming out.
 */
function cut(text: string, width: number): string {
  const short = truncateToWidth(text, width, '')
  return text.includes('\x1b') ? short : stripTerminalSequences(short)
}
