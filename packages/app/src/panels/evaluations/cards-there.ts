import type { EvalBy } from '@tade/core'
import type { Machine, Machines } from '../../machines.ts'
import type { Skin } from '../../skin.ts'
import { blank, type Row } from '../../ui.ts'
import type { Line } from '../frame.ts'
import { cardLine, cellsThere, type Figure } from './figures.ts'

// Each other machine's scorecards, under this machine's own on a grouping tab:
// which harness, model, persona or template lands work **there**, as that
// machine folded them over its own journal and sent them (`GET
// /api/evaluations`, asked while this page is open — `wire/remote-machine.ts`).
//
// **Its own section, never a sum.** Two machines' scorecards are two folds over
// two journals; a row here and a row there with the same model are drawn one
// under the other in the same columns, and its own `all` row is its total —
// nothing is added to this machine's. **Over all its work**, whatever range
// this page is on, because that is what it sends, and the heading says so, with
// as of when — a scorecard is of a journal that has moved on since.

/** Every other machine's scorecards by one grouping, each under its name: none where none said. */
export function cardsElsewhere(
  machines: Machines | undefined,
  by: EvalBy,
  at: {
    row: () => Row
    skin: Skin
    date: (at: number) => string
    shown: readonly Figure[]
    name: number
  },
): Line[] {
  const lines: Line[] = []
  for (const machine of machines?.remotes ?? []) {
    const { cards, cardsSaid } = machine.detail
    if (cards === null && cardsSaid === null && machine.link !== 'live') continue
    lines.push(blank(0), ...machineCards(machine, by, at))
  }
  return lines
}

function machineCards(
  machine: Machine,
  by: EvalBy,
  at: {
    row: () => Row
    skin: Skin
    date: (at: number) => string
    shown: readonly Figure[]
    name: number
  },
): Line[] {
  const { row, skin, date } = at
  const { cards, cardsSaid } = machine.detail
  const said = (text: string) => row().space(3).text(text, skin.hint).build()
  const when = cards === null ? '' : `all its work · as of ${date(cards.at)}`
  const lines: Line[] = [
    row()
      .space()
      .text(`ON ${machine.name.toUpperCase()}`, skin.label)
      .right((r) => r.text(when, skin.hint).space())
      .build(),
  ]
  if (cards === null) {
    lines.push(said(cardsSaid ?? `asking ${machine.name}…`))
    return lines
  }
  if (cardsSaid !== null) lines.push(said(cardsSaid))
  if (!cards.read) {
    lines.push(said(`${machine.name} has not read its journal yet`))
    return lines
  }
  const rows = cards.by[by]
  if (rows.length === 0) lines.push(said(`No work on ${machine.name}.`))
  for (const card of rows) {
    lines.push(
      cardLine(row, cellsThere(card), card.label, {
        ...at,
        ...(card.named ? {} : { tone: skin.hint }),
      }),
    )
  }
  if (rows.length > 1 && cards.total !== null) {
    lines.push(
      blank(0),
      cardLine(row, cellsThere(cards.total), `all on ${machine.name}`, { ...at, tone: skin.label }),
    )
  }
  const withheld = [
    cards.granted.spend ? null : 'money',
    cards.granted.findings ? null : 'what its judge found',
  ].filter(Boolean)
  if (withheld.length > 0) lines.push(said(`${machine.name} did not send ${withheld.join(' or ')}`))
  return lines
}
