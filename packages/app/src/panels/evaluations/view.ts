import {
  type Calibration,
  duration,
  ENOUGH,
  type EvalBy,
  perLanded,
  perLandedCost,
  precisionSaid,
  type Scorecard,
  scorecardsBy,
  UNRECORDED,
  WITHOUT,
  worthSaid,
} from '@tade/core'
import { EVAL_TABS } from '../../evaluations.ts'
import type { Skin } from '../../skin.ts'
import { SPEND_WINDOWS } from '../../spend.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { widthOf } from '../../width.ts'
import { cap, padTo } from '../cells.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, tabRow } from '../frame.ts'
import { replaysTab } from './replays.ts'
import type { EvaluationsPanel } from './state.ts'

// What the Evaluations panel looks like: one table of scorecards per way of
// grouping the work, and the judge's own calibration on a tab beside them.
//
// Counts before rates on every cell (`rateCell`): `3/4` until there are
// `ENOUGH` of something, and the percentage after the counts once there are,
// never instead of them. A figure nothing could say is drawn as what it is —
// `—`, `not read` — and never as nought. What is cut for room is a whole
// column, the least read first, and the name keeps what is left: it is the one
// column here that cannot be abbreviated without lying.

/** As wide as the table wants. */
export const EVALS_WIDTH = 120

/** One figure column: what it is headed, how wide, and what a row says in it. */
interface Figure {
  head: string
  width: number
  cell: (card: Scorecard) => string
  /** A cell made of more than one claim, each said in its own tone. */
  parts?: (card: Scorecard, skin: Skin) => { text: string; tone?: (text: string) => string }[]
}

/** The figures, in the order they are read across. */
const FIGURES: readonly Figure[] = [
  { head: 'AGENTS', width: 6, cell: (card) => String(card.tasks) },
  { head: 'DONE', width: 11, cell: (card) => rateCell(card.done, card.tasks) },
  { head: 'LANDED', width: 11, cell: (card) => rateCell(card.landed, card.tasks) },
  { head: '1ST PUSH', width: 10, cell: (card) => rateCell(card.firstPushGreen, card.pushed) },
  {
    head: 'REDS',
    width: 5,
    cell: (card) => (card.checkedHere === 0 ? '—' : String(card.redsHere)),
  },
  { head: 'FINDINGS', width: 14, cell: findingsCell },
  {
    // Money per billed task and a plan's list price per task it paid for, side
    // by side over their own denominators — never one figure made of the two —
    // each a step quieter the less it is a bill (`costTone`'s three steps).
    head: 'PER LANDED',
    width: 15,
    cell: (card) => costParts(card).join(' '),
    parts: (card, skin) =>
      perLandedCost(card).map((part, at) => ({
        text: at === 0 ? part.said : ` ${part.said}`,
        ...(part.kind === 'billed'
          ? {}
          : { tone: part.kind === 'at list' ? skin.chrome : skin.hint }),
      })),
  },
  {
    head: 'TOKENS',
    width: 6,
    cell: (card) => {
      const tokens = perLanded(card, (spend) => spend.tokens)
      return tokens === null ? '—' : tokenCount(tokens)
    },
  },
  {
    head: 'TO DONE',
    width: 7,
    cell: (card) => (card.toDoneMs === null ? '—' : duration(card.toDoneMs)),
  },
]

/** Which figures give ground first, least read first: an index into `FIGURES`. */
const GIVES_UP = [7, 4, 3, 8, 1, 5]

/** The gap between columns. */
const GAP = 2
/** The narrowest a name is ever left. */
const NAME_MIN = 14

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
  } else if (panel.tab === 'replays') {
    replaysTab(ctx.replays, { row, skin, rows, inner })
  } else {
    const cards = scorecardsBy(evals, panel.tab)
    const shown = figuresFor(inner)
    const name = Math.max(NAME_MIN, inner - 1 - used(shown))
    const heading = row().space().text(padTo(HEADS[panel.tab], name), skin.label)
    for (const figure of shown)
      heading.space(GAP).text(figure.head.padStart(figure.width), skin.label)
    head.push(heading.build())
    if (cards.length === 0) rows.push(row().space(3).text(`No work ${over}.`, skin.hint).build())
    for (const card of cards) rows.push(line(card, labelOf(card.key, panel.tab), false))
    if (cards.length > 1) {
      rows.push(blank(inner))
      rows.push(line(evals.total, 'all', true))
    }
    const moved = evals.total.moved
    if (moved > 0 && (panel.tab === 'harness' || panel.tab === 'model')) {
      rows.push(blank(inner))
      rows.push(row().space().text(`${moved} moved after their first run`, skin.hint).build())
    }

    function line(card: Scorecard, label: string, all: boolean): Line {
      const known = card.key !== UNRECORDED && card.key !== WITHOUT
      const drawn = row()
        .space()
        .text(padTo(cap(label, name), name), all ? skin.label : known ? undefined : skin.hint)
      for (const figure of shown) {
        drawn.space(GAP)
        const parts = figure.parts?.(card, skin) ?? [{ text: figure.cell(card) }]
        const wide = parts.reduce((sum, part) => sum + widthOf(part.text), 0)
        drawn.space(Math.max(0, figure.width - wide))
        for (const part of parts) drawn.text(part.text, part.tone)
      }
      return drawn.build()
    }
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

/** The figures that fit beside a name of at least `NAME_MIN`, giving up the least read first. */
function figuresFor(inner: number): Figure[] {
  const dropped = new Set<number>()
  const kept = () => FIGURES.filter((_, at) => !dropped.has(at))
  for (const at of GIVES_UP) {
    if (inner - 1 - used(kept()) >= NAME_MIN) break
    dropped.add(at)
  }
  return kept()
}

function used(figures: readonly Figure[]): number {
  return figures.reduce((sum, figure) => sum + GAP + figure.width, 0)
}

const HEADS: Readonly<Record<EvalBy, string>> = {
  harness: 'HARNESS',
  model: 'MODEL',
  persona: 'PERSONA',
  template: 'TEMPLATE',
}

/** A key as a person reads it: never a harness or a persona called `unknown`. */
function labelOf(key: string, by: EvalBy): string {
  if (key === UNRECORDED) return 'not recorded'
  if (key === WITHOUT) return `no ${by}`
  return key
}

/**
 * A count out of a count: the two numbers, and the rate after them only from
 * `ENOUGH` — `countSaid`'s rule, in the room a column has.
 */
export function rateCell(count: number, of: number): string {
  if (of === 0) return '—'
  if (of < ENOUGH) return `${count}/${of}`
  return `${count}/${of} ${Math.round((count / of) * 100)}%`
}

/** What a judge raised about a row's changes: how many, then confirmed, wrong and open. */
function findingsCell(card: Scorecard): string {
  const found = card.findings
  if (found === null) return 'not read'
  if (found.fired === 0) return '0'
  return `${found.fired}·${found.confirmed}✓${found.wrong}✗${found.open}?`
}

function costParts(card: Scorecard): string[] {
  return perLandedCost(card).map((part) => part.said)
}

function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(Math.round(count))
}
