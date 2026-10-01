import { visibleWidth } from '@earendil-works/pi-tui'
import type { MarkView } from '../../frame.ts'
import type { Skin } from '../../skin.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { toneFor } from '../../view/rows.ts'
import { cap, padTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize } from '../frame.ts'
import type { RowSummaryPanel } from './state.ts'

// One row of a list, drawn in front of you.
//
// A heading, then what it is, then groups and figures — the same thing the row
// says in two rows down the side, with the room to say all of it. Options and
// values, no paragraph: a caveat true of every row of a group is that group's
// `note`, said once beside its heading, and never a sentence per mark.
//
// The window knows nothing about what is in one. A review's checks, a Sentry
// issue's events and a dependency's advisories all arrive as the same four
// things — marks, groups of marks, label-and-value facts, links — and are drawn
// the same way, which is what stops this file ever learning what a forge is.

/** The widest it is worth being: figures and short names, not prose. */
const WIDEST = 84

/** The label column of the facts, so the values line up down the page. */
const LABEL = 13

export function rowSummary(panel: RowSummaryPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: WIDEST })
  const inner = width - 2 - BAR
  const row = () => new Row(inner, skin, ctx.pointer)
  const shown = ctx.summary
  const lines: Line[] = []

  if (!shown) {
    lines.push(
      blank(inner),
      row()
        .space()
        .text(
          panel.problem ?? (panel.busy ? 'Looking…' : 'Nothing more is known about it.'),
          panel.problem ? skin.bad : skin.hint,
        )
        .build(),
    )
  } else {
    // What it is, under the title and before any heading: the marks the row
    // wears beside its name and the figures from under it, on one line,
    // because splitting them into two rows was only ever about room and here
    // there is room.
    if ((shown.marks ?? []).length > 0) {
      lines.push(blank(inner))
      const r = row().space()
      marksAcross(r, shown.marks ?? [], inner - 2, skin)
      lines.push(r.build())
    }
    for (const group of shown.groups ?? []) {
      lines.push(blank(inner), ...heading(row, group.label, group.note ?? '', inner, skin))
      if (group.marks.length === 0) continue
      // Marks down the page rather than along it: a check's name is as long as
      // somebody's CI made it, and a row of them wrapped mid-name reads as one
      // unbroken string. Two columns where they are short enough for two.
      lines.push(...inColumns(row, group.marks, inner, skin))
    }
    if ((shown.facts ?? []).length > 0) {
      lines.push(blank(inner))
      for (const fact of shown.facts ?? []) {
        lines.push(
          row()
            .space()
            .text(padTo(fact.label, LABEL), skin.hint)
            .text(cap(fact.value, Math.max(4, inner - LABEL - 3)), toneFor(fact.tone, skin))
            .build(),
        )
      }
    }
    for (const link of shown.links ?? []) {
      lines.push(
        blank(inner),
        row()
          .space()
          .text(cap(link.url, inner - 3), skin.link, { kind: 'link', url: link.url })
          .build(),
      )
    }
  }

  const drawn = column(
    {
      body: { lines, width: inner, scroll: panel.scroll },
      foot: [blank(inner), foot(row(), panel, skin)],
      rows: tall,
    },
    ctx,
  )
  return box(cap(shown?.title ?? panel.title, width - 10), drawn.rows, width, skin, {
    corner: 'esc',
  })
}

/**
 * The two acts a row has, and the way out: where it lives, and what the
 * conversation makes of it.
 *
 * Both were things a click on the row could already do; neither is what the
 * window would *like* pressed next, so neither is coloured — one leaves Tade
 * and the other puts a page of markdown in the transcript. A row with nowhere
 * to go has no `Open it` at all, rather than one that opens nothing.
 */
function foot(r: Row, panel: RowSummaryPanel, skin: Skin): Line {
  if (panel.url) r.space().button('Open it', { kind: 'control', id: 'open' })
  r.space().button('Ask about it', { kind: 'control', id: 'ask' })
  r.right((g) =>
    g
      .text('↑↓ scrolls', skin.hint)
      .space(2)
      .button('Close', { kind: 'control', id: 'close' })
      .space(),
  )
  return r.build()
}

/**
 * A group's heading: its name, a rule, and what the group adds up to at the
 * right — the same shape a section heading has on the ACTIONS page, because it
 * is the same thing and nobody should have to learn it twice.
 */
function heading(row: () => Row, label: string, note: string, inner: number, skin: Skin): Line[] {
  const r = row().space().text(label, skin.label).space()
  const said = note ? cap(note, Math.max(0, inner - r.used - 4)) : ''
  r.text(
    '─'.repeat(Math.max(1, inner - r.used - visibleWidth(said) - (said ? 2 : 0) - 1)),
    skin.chrome,
  )
  if (said) r.right((g) => g.text(said, skin.hint).space())
  return [r.build()]
}

/** A run of marks along one line, each in its own colour. */
function marksAcross(r: Row, marks: readonly MarkView[], room: number, skin: Skin): void {
  let used = 0
  for (const [i, mark] of marks.entries()) {
    const wide = visibleWidth(mark.text) + (i > 0 ? 3 : 0)
    if (used + wide > room) return void r.text('…', skin.chrome)
    if (i > 0) r.text(' · ', skin.chrome)
    r.text(mark.text, toneFor(mark.tone, skin))
    used += wide
  }
}

/**
 * A group's marks down the page, in as many columns as the widest of them
 * leaves room for — two where they are short, one where somebody's CI names a
 * check `integration-tests-postgres-16`.
 *
 * Never cut to fit: every mark is drawn, and the body scrolls. A list of checks
 * that quietly held the first six is a list that hides the red one.
 */
function inColumns(row: () => Row, marks: readonly MarkView[], inner: number, skin: Skin): Line[] {
  const widest = Math.max(...marks.map((mark) => visibleWidth(mark.text)))
  const columns = widest + 4 <= Math.floor((inner - 3) / 2) ? 2 : 1
  const column = Math.floor((inner - 3) / columns)
  const lines: Line[] = []
  for (let at = 0; at < marks.length; at += columns) {
    const r = row().space(2)
    for (const mark of marks.slice(at, at + columns)) {
      r.text(padTo(mark.text, column), toneFor(mark.tone, skin))
    }
    lines.push(r.build())
  }
  return lines
}
