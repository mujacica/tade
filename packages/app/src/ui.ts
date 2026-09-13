import {
  compositeTuiLine,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
} from '@earendil-works/pi-tui'
import { type Hit, rowHit, sameTarget, shift, type Target } from './hits.ts'
import type { Look, Skin } from './skin.ts'

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

  space(n = 1): this {
    return n > 0 ? this.put(' '.repeat(n), n) : this
  }

  button(label: string, target: Target, look: Look = 'rest'): this {
    return this.put(
      this.skin.button(label, this.lookOf(target, look)),
      visibleWidth(label) + 4,
      target,
    )
  }

  tab(label: string, target: Target, on: boolean): this {
    const hover = sameTarget(this.pointer.hover, target)
    return this.put(this.skin.tabbed(label, on, hover), visibleWidth(label) + 4, target)
  }

  /** Key caps joined by `+`: the shape of something you press. */
  keys(names: readonly string[]): this {
    names.forEach((name, i) => {
      if (i > 0) this.text('+', this.skin.hint)
      this.put(this.skin.keycap(` ${name} `), visibleWidth(name) + 4)
    })
    return this
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
    opts: { caret?: boolean; arrow?: boolean; hint?: boolean; target?: Target } = {},
  ): this {
    const inner = Math.max(1, width - 2)
    const tail = opts.arrow ? ' ▾' : ''
    let body = value + (opts.caret ? '▏' : '')
    const room = inner - tail.length
    if (visibleWidth(body) > room) body = `…${[...body].slice(-(room - 1)).join('')}`
    const padded = body + ' '.repeat(Math.max(0, room - visibleWidth(body))) + tail
    const drawn = this.skin.colour
      ? this.skin.field(` ${padded} `, opts.hint === true)
      : `[${padded}]`
    return this.put(drawn, inner + 2, opts.target)
  }

  toggle(on: boolean, target: Target): this {
    const drawn = on
      ? `${this.skin.busy('━━●')} ${this.skin.you('on')} `
      : `${this.skin.hint('●━━')} ${this.skin.hint('off')}`
    return this.put(drawn, 7, target)
  }

  check(on: boolean, label: string, target: Target): this {
    const mark = on ? this.skin.busy('■') : this.skin.hint('□')
    return this.put(`${mark} ${label}`, 2 + visibleWidth(label), target)
  }

  radio(on: boolean, label: string, target: Target): this {
    const mark = on ? this.skin.busy('◉') : this.skin.hint('○')
    return this.put(`${mark} ${label}`, 2 + visibleWidth(label), target)
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
