import {
  type CostPart,
  duration,
  ENOUGH,
  type EvalBy,
  perLanded,
  perLandedCost,
  type Scorecard,
  UNRECORDED,
  WITHOUT,
} from '@tade/core'
import type { CardThere } from '../../machine-looks.ts'
import type { Skin } from '../../skin.ts'
import type { Row } from '../../ui.ts'
import { widthOf } from '../../width.ts'
import { cap, padTo } from '../cells.ts'
import type { Line } from '../frame.ts'

// The columns of a scorecard table, over one shape both machines' rows are
// read into (`Cells`): this machine's own scorecards (`cellsOf`), and another
// machine's as it sent them (`cellsThere`) — so the two are drawn in the same
// columns, one under the other, and never added into one row.
//
// Counts before rates on every cell (`rateCell`): `3/4` until there are
// `ENOUGH` of something, and the percentage after the counts once there are,
// never instead of them. A figure nothing could say is drawn as what it is —
// `—`, `not read` — and never as nought.

/** One row's figures, whichever machine folded them. */
export interface Cells {
  tasks: number
  done: { count: number; of: number }
  landed: { count: number; of: number }
  firstPush: { count: number; of: number }
  /** Red runs where the work ran; null where nothing ran a check there. */
  reds: number | null
  /** What a judge raised; null where none read it, or it was not sent. */
  findings: { fired: number; confirmed: number; wrong: number; open: number } | null
  /** What a landed task cost, part by part; null where it was not sent. */
  cost: readonly CostPart[] | null
  tokens: number | null
  toDoneMs: number | null
}

/** A scorecard folded here. */
export function cellsOf(card: Scorecard): Cells {
  return {
    tasks: card.tasks,
    done: { count: card.done, of: card.tasks },
    landed: { count: card.landed, of: card.tasks },
    firstPush: { count: card.firstPushGreen, of: card.pushed },
    reds: card.checkedHere === 0 ? null : card.redsHere,
    findings: card.findings,
    cost: perLandedCost(card),
    tokens: perLanded(card, (spend) => spend.tokens),
    toDoneMs: card.toDoneMs,
  }
}

/** A scorecard another machine folded over its own journal and sent. */
export function cellsThere(card: CardThere): Cells {
  return {
    tasks: card.tasks,
    done: card.done,
    landed: card.landed,
    firstPush: card.firstPushGreen,
    reds: card.redsHere,
    findings: card.findings,
    cost: card.cost,
    tokens: card.tokensPerLanded,
    toDoneMs: card.toDoneMs,
  }
}

/** One figure column: what it is headed, how wide, and what a row says in it. */
export interface Figure {
  head: string
  width: number
  cell: (cells: Cells) => string
  /** A cell made of more than one claim, each said in its own tone. */
  parts?: (cells: Cells, skin: Skin) => { text: string; tone?: (text: string) => string }[]
}

/** The figures, in the order they are read across. */
const FIGURES: readonly Figure[] = [
  { head: 'AGENTS', width: 6, cell: (cells) => String(cells.tasks) },
  { head: 'DONE', width: 11, cell: (cells) => rateCell(cells.done.count, cells.done.of) },
  { head: 'LANDED', width: 11, cell: (cells) => rateCell(cells.landed.count, cells.landed.of) },
  {
    head: '1ST PUSH',
    width: 10,
    cell: (cells) => rateCell(cells.firstPush.count, cells.firstPush.of),
  },
  { head: 'REDS', width: 5, cell: (cells) => (cells.reds === null ? '—' : String(cells.reds)) },
  { head: 'FINDINGS', width: 14, cell: findingsCell },
  {
    // Money per billed task and a plan's list price per task it paid for, side
    // by side over their own denominators — never one figure made of the two —
    // each a step quieter the less it is a bill (`costTone`'s three steps).
    head: 'PER LANDED',
    width: 15,
    cell: (cells) => (cells.cost ?? []).map((part) => part.said).join(' '),
    parts: (cells, skin) =>
      cells.cost === null
        ? [{ text: '—', tone: skin.hint }]
        : cells.cost.map((part, at) => ({
            text: at === 0 ? part.said : ` ${part.said}`,
            ...(part.kind === 'billed'
              ? {}
              : { tone: part.kind === 'at list' ? skin.chrome : skin.hint }),
          })),
  },
  {
    head: 'TOKENS',
    width: 6,
    cell: (cells) => (cells.tokens === null ? '—' : tokenCount(cells.tokens)),
  },
  {
    head: 'TO DONE',
    width: 7,
    cell: (cells) => (cells.toDoneMs === null ? '—' : duration(cells.toDoneMs)),
  },
]

/** Which figures give ground first, least read first: an index into `FIGURES`. */
const GIVES_UP = [7, 4, 3, 8, 1, 5]

/** The gap between columns. */
export const GAP = 2
/** The narrowest a name is ever left. */
const NAME_MIN = 14

/** The figures that fit beside a name of at least `NAME_MIN`, giving up the least read first. */
export function figuresFor(inner: number): Figure[] {
  const dropped = new Set<number>()
  const kept = () => FIGURES.filter((_, at) => !dropped.has(at))
  for (const at of GIVES_UP) {
    if (inner - 1 - used(kept()) >= NAME_MIN) break
    dropped.add(at)
  }
  return kept()
}

/** How wide the name column is beside `shown`. */
export function nameWidth(inner: number, shown: readonly Figure[]): number {
  return Math.max(NAME_MIN, inner - 1 - used(shown))
}

function used(figures: readonly Figure[]): number {
  return figures.reduce((sum, figure) => sum + GAP + figure.width, 0)
}

/** One row of a table: its name in the name column, then each figure right-aligned in its own. */
export function cardLine(
  row: () => Row,
  cells: Cells,
  label: string,
  at: { shown: readonly Figure[]; name: number; skin: Skin; tone?: (text: string) => string },
): Line {
  const drawn = row()
    .space()
    .text(padTo(cap(label, at.name), at.name), at.tone)
  for (const figure of at.shown) {
    drawn.space(GAP)
    const parts = figure.parts?.(cells, at.skin) ?? [{ text: figure.cell(cells) }]
    const wide = parts.reduce((sum, part) => sum + widthOf(part.text), 0)
    drawn.space(Math.max(0, figure.width - wide))
    for (const part of parts) drawn.text(part.text, part.tone)
  }
  return drawn.build()
}

export const HEADS: Readonly<Record<EvalBy, string>> = {
  harness: 'HARNESS',
  model: 'MODEL',
  persona: 'PERSONA',
  template: 'TEMPLATE',
}

/** A key as a person reads it: never a harness or a persona called `unknown`. */
export function labelOf(key: string, by: EvalBy): string {
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
function findingsCell(cells: Cells): string {
  const found = cells.findings
  if (found === null) return 'not read'
  if (found.fired === 0) return '0'
  return `${found.fired}·${found.confirmed}✓${found.wrong}✗${found.open}?`
}

function tokenCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${Math.round(count / 1_000)}k`
  return String(Math.round(count))
}
