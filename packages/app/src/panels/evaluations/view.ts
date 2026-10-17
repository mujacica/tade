import {
  type Calibration,
  precisionSaid,
  scorecardsBy,
  UNRECORDED,
  WITHOUT,
  worthSaid,
} from '@tade/core'
import { EVAL_TABS } from '../../evaluations.ts'
import type { Skin } from '../../skin.ts'
import { SPEND_WINDOWS } from '../../spend.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { cap, padTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, tabRow } from '../frame.ts'
import { cardsElsewhere } from './cards-there.ts'
import { judgeElsewhere } from './elsewhere.ts'
import { cardLine, cellsOf, figuresFor, GAP, HEADS, labelOf, nameWidth } from './figures.ts'
import { replaysTab } from './replays.ts'
import type { EvaluationsPanel } from './state.ts'

// What the Evaluations panel looks like: one table of scorecards per way of
// grouping the work, and the judge's own calibration on a tab beside them —
// and under this machine's table, each other machine's own, in the same
// columns and never added into this one's (`cards-there.ts`).
//
// Counts before rates on every cell (`rateCell`, `figures.ts`). A figure
// nothing could say is drawn as what it is — `—`, `not read` — and never as
// nought. What is cut for room is a whole column, the least read first, and
// the name keeps what is left: it is the one column here that cannot be
// abbreviated without lying.

export { rateCell } from './figures.ts'

/** As wide as the table wants. */
export const EVALS_WIDTH = 120

export function evaluations(panel: EvaluationsPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: EVALS_WIDTH })
  const inner = width - 2 - BAR
  const row = () => new Row(inner, skin, ctx.pointer)
  const view = ctx.evaluations
  const evals = view?.evaluations ?? null
  const head: Line[] = []
  const rows: Line[] = []

  const top = row().space()
  if (!evals) top.text('…', skin.hint)
  else {
    const total = evals.total
    top
      .text(`${total.tasks} ${total.tasks === 1 ? 'agent' : 'agents'}`, skin.you)
      .text(` · ${total.landed} landed`, skin.you)
      .text(` · merges from the ${evals.mergedFrom}`, skin.hint)
  }
  head.push(top.build())
  head.push(...tabRow(row, skin, 'for', SPEND_WINDOWS, panel.window, 'window', inner))
  head.push(...tabRow(row, skin, 'by', EVAL_TABS, panel.tab, 'tab', inner))
  head.push(blank(inner))

  const over = SPEND_WINDOWS.find((one) => one.id === panel.window)?.over ?? 'here'
  if (!evals) {
    rows.push(row().space(3).text('…', skin.hint).build())
  } else if (panel.tab === 'judge') {
    judge(evals.calibration, { row, skin, head, rows })
    rows.push(...judgeElsewhere(ctx.machines, { row, skin, date: ctx.date }))
  } else if (panel.tab === 'replays') {
    replaysTab(ctx.replays, { row, skin, rows, inner })
  } else {
    const cards = scorecardsBy(evals, panel.tab)
    const shown = figuresFor(inner)
    const name = nameWidth(inner, shown)
    const heading = row().space().text(padTo(HEADS[panel.tab], name), skin.label)
    for (const figure of shown)
      heading.space(GAP).text(figure.head.padStart(figure.width), skin.label)
    head.push(heading.build())
    const elsewhere = cardsElsewhere(ctx.machines, panel.tab, {
      row,
      skin,
      date: ctx.date,
      shown,
      name,
    })
    // With another machine's below, this one's is headed as this machine's own.
    if (elsewhere.length > 0) {
      rows.push(
        row()
          .space()
          .text(`ON ${(ctx.machines?.here ?? 'here').toUpperCase()}`, skin.label)
          .build(),
      )
    }
    if (cards.length === 0) rows.push(row().space(3).text(`No work ${over}.`, skin.hint).build())
    for (const card of cards) {
      const known = card.key !== UNRECORDED && card.key !== WITHOUT
      rows.push(
        cardLine(row, cellsOf(card), labelOf(card.key, panel.tab), {
          shown,
          name,
          skin,
          ...(known ? {} : { tone: skin.hint }),
        }),
      )
    }
    if (cards.length > 1) {
      rows.push(blank(inner))
      rows.push(cardLine(row, cellsOf(evals.total), 'all', { shown, name, skin, tone: skin.label }))
    }
    const moved = evals.total.moved
    if (moved > 0 && (panel.tab === 'harness' || panel.tab === 'model')) {
      rows.push(blank(inner))
      rows.push(row().space().text(`${moved} moved after their first run`, skin.hint).build())
    }
    rows.push(...elsewhere)
  }

  const drawn = column(
    {
      head,
      body: { lines: rows, width: inner, scroll: panel.scroll },
      foot: [
        blank(inner),
        row()
          .space()
          .text(cap('↑↓ reads · ←→ ranges · tab groups', inner - 12), skin.hint)
          .right((r) => r.button('Done', { kind: 'control', id: 'close' }, 'primary').space())
          .build(),
      ],
      rows: tall,
    },
    ctx,
  )
  return box('Evaluations', drawn.rows, width, skin, { corner: 'esc' })
}

/** The judge's own record: precision per question, then per band of probability. */
function judge(
  calibration: Calibration | null,
  at: { row: () => Row; skin: Skin; head: Line[]; rows: Line[] },
): void {
  const { row, skin, rows } = at
  if (calibration === null) {
    rows.push(row().space(3).text('No judge reads anything here.', skin.hint).build())
    return
  }
  const total = calibration.total
  rows.push(
    row()
      .space()
      .text(`${total.fired} findings`, skin.you)
      .text(` · ${total.open} with no verdict · `, skin.hint)
      .text(precisionSaid(total), total.enough ? undefined : skin.hint)
      .build(),
  )
  rows.push(blank(0))
  rows.push(
    row()
      .space()
      .text(padTo('QUESTION', 22), skin.label)
      .space(GAP)
      .text('FIRED'.padStart(5), skin.label)
      .space(GAP)
      .text('OPEN'.padStart(4), skin.label)
      .space(GAP)
      .text(padTo('PRECISION', 24), skin.label)
      .build(),
  )
  for (const question of calibration.byQuestion) {
    const worth = worthSaid(question.worth, question.tally)
    rows.push(
      row()
        .space()
        .text(padTo(cap(question.question, 22), 22))
        .space(GAP)
        .text(String(question.tally.fired).padStart(5))
        .space(GAP)
        .text(String(question.tally.open).padStart(4), skin.hint)
        .space(GAP)
        .text(
          padTo(precisionSaid(question.tally), 24),
          question.tally.enough ? undefined : skin.hint,
        )
        .text(
          worth,
          question.worth === 'costs'
            ? skin.bad
            : question.worth === 'earns'
              ? skin.done
              : skin.hint,
        )
        .build(),
    )
  }
  rows.push(blank(0))
  rows.push(
    row()
      .space()
      .text(padTo('AT', 22), skin.label)
      .space(GAP)
      .text('FIRED'.padStart(5), skin.label)
      .space(GAP)
      .text('OPEN'.padStart(4), skin.label)
      .space(GAP)
      .text(padTo('PRECISION', 24), skin.label)
      .build(),
  )
  // Only the bands anything fired in: a judge whose thresholds sit at 0.7 has
  // seven empty bands below it, and seven rows of `—` say nothing seven times.
  for (const band of calibration.byBand) {
    if (band.tally.fired === 0) continue
    rows.push(
      row()
        .space()
        .text(padTo(`${band.from.toFixed(1)}–${band.to.toFixed(1)}`, 22), skin.hint)
        .space(GAP)
        .text(String(band.tally.fired).padStart(5))
        .space(GAP)
        .text(String(band.tally.open).padStart(4), skin.hint)
        .space(GAP)
        .text(precisionSaid(band.tally), band.tally.enough ? undefined : skin.hint)
        .build(),
    )
  }
}
