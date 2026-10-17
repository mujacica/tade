import {
  printable,
  type Race,
  type Racer,
  raceDollars,
  racerRunsOn,
  raceSpentSays,
} from '@tade/core'
import { sameTarget, type Target } from '../../hits.ts'
import type { Skin } from '../../skin.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { widthOf } from '../../width.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, rowLook } from '../frame.ts'
import { type RacePanel, raceShown } from './state.ts'

// What a race looks like, compared. What a key does to it is beside this in
// `state.ts`, and the order the entrants are in is core's (`raceOrder`).
//
// A head saying which race, what was asked and what it has cost so far; then
// a row per entrant in two lines — its place, its name and every figure that
// orders it (the checks at its head, whether the judge said it strayed from
// what was asked, the findings open, how much it changed, what it cost), and
// under it what it runs on and where it stands. A figure nothing could say is
// drawn as what it is (`…`, `—`), never as nought, and nothing is drawn as the
// winner until somebody has picked one.

interface Figure {
  text: string
  tone: (skin: Skin) => (text: string) => string
}

/** The columns of figures, in the order the race reads them. Short of room the last ones go. */
const SLOTS = ['checks', 'asked', 'findings', 'size', 'cost'] as const

export function race(panel: RacePanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: 112 })
  const inner = width - 2 - BAR
  const races = ctx.races
  const shown = raceShown(panel, races)
  const head: Line[] = shown
    ? headOf(shown, panel, races.length, inner, ctx)
    : nothingHead(inner, ctx)
  const lines: Line[] = []
  let chosen: { from: number; to: number } | null = null
  if (shown) {
    const cells = shown.racers.map((one) => figuresOf(one))
    const widths = SLOTS.map((_, at) =>
      Math.max(0, ...cells.map((one) => widthOf(one[at]?.text ?? ''))),
    )
    const longest = Math.max(0, ...shown.racers.map((one) => widthOf(nameOf(one.facts.task))))
    const fits = columnsFor(widths, inner - 8 - Math.min(longest, 28))
    lines.push(
      new Row(inner, skin)
        .space()
        .text('ENTRANTS', skin.label)
        .text(
          shown.won ? '  as the facts order them' : '  as the facts order them — nobody has picked',
          skin.hint,
        )
        .build(),
    )
    shown.racers.forEach((racer, at) => {
      const on = at === panel.index
      if (on) chosen = { from: lines.length, to: lines.length + 1 }
      lines.push(...item(racer, at, on, inner, ctx, { cells: cells[at] ?? [], widths, fits }))
    })
  }
  const racer = shown?.racers[panel.index]
  const foot: Line[] = panel.confirming
    ? confirmFoot(panel.confirming, inner, ctx)
    : [
        panel.said
          ? new Row(inner, skin).space().text(`▲ ${panel.said}`, skin.waiting).build()
          : blank(inner),
        new Row(inner, skin, ctx.pointer)
          .space()
          .text(
            shown
              ? `↑↓ choose${races.length > 1 ? ' · ←→ races' : ''} · enter reads · a agent · p picks`
              : '',
            skin.hint,
          )
          .right((r) => {
            if (racer) {
              r.button('Read the change', { kind: 'control', id: 'patch' })
                .space()
                .button('Go to agent', { kind: 'control', id: 'agent' })
                .space()
              if (!shown?.won) {
                r.button('Pick this one', { kind: 'control', id: 'pick' }, 'primary').space()
              }
            }
            r.button('Close', { kind: 'control', id: 'close' }).space()
          })
          .build(),
      ]
  const drawn = column(
    {
      head,
      body: { lines, width: inner, scroll: panel.scroll, chosen: panel.following ? chosen : null },
      foot,
      rows: tall,
    },
    ctx,
  )
  return box('Race', drawn.rows, width, skin, { corner: 'esc' })
}

/** Which race, what it was asked, what it cost, and who picked — with a way to the others. */
function headOf(
  shown: Race,
  panel: RacePanel,
  count: number,
  inner: number,
  ctx: PanelContext,
): Line[] {
  const { skin } = ctx
  const at = Math.min(panel.race, count - 1)
  const top = new Row(inner, skin, ctx.pointer)
    .space()
    .text(printable(shown.name), skin.you)
    .text(
      ` in ${shown.project} · ${shown.racers.length} entrants · ${shown.finished} finished · ${raceSpentSays(shown)}`,
      skin.hint,
    )
    .right((r) => {
      if (count < 2) return
      r.button('‹', { kind: 'control', id: `race:${(at - 1 + count) % count}` })
        .text(` ${at + 1} of ${count} `, skin.hint)
        .button('›', { kind: 'control', id: `race:${(at + 1) % count}` })
        .space()
    })
    .build()
  // What it was asked, in whoever asked's words: text.
  const asked = new Row(inner, skin)
    .space()
    .text(`asked: ${printable(shown.said)}`, skin.busy)
    .build()
  const decided = shown.won
    ? new Row(inner, skin)
        .space()
        .text('✓ ', skin.done)
        .text(
          `${nameOf(shown.won.task)} picked ${shown.won.by === 'orchestrator' ? 'by the orchestrator, on your word' : 'by you'}`,
          skin.done,
        )
        // Its reason is said for a pick the orchestrator made; a press is its own reason.
        .text(
          shown.won.by === 'orchestrator' && shown.won.why ? ` · ${shown.won.why}` : '',
          skin.hint,
        )
        .build()
    : blank(inner)
  return [top, asked, decided, blank(inner)]
}

function nothingHead(inner: number, ctx: PanelContext): Line[] {
  return [
    new Row(inner, ctx.skin)
      .space()
      .text(
        'No race is going. Ask the orchestrator for one, or use the race template.',
        ctx.skin.hint,
      )
      .build(),
    blank(inner),
  ]
}

/** Saying yes to a pick: what it does, said where it is pressed. */
function confirmFoot(task: string, inner: number, ctx: PanelContext): Line[] {
  const { skin } = ctx
  return [
    new Row(inner, skin)
      .space()
      .text(`Pick ${nameOf(task)}? `, skin.waiting)
      .text('The others are stopped and marked finished; every branch is kept.', skin.hint)
      .build(),
    new Row(inner, skin, ctx.pointer)
      .space()
      .text('enter picks · escape does not', skin.hint)
      .right((r) => {
        r.button('Pick it', { kind: 'control', id: 'confirm' }, 'primary')
          .space()
          .button('Cancel', { kind: 'control', id: 'cancel' })
          .space()
      })
      .build(),
  ]
}

/** One entrant, in two lines: its place, name and figures, then what it runs on and where it stands. */
function item(
  racer: Racer,
  at: number,
  on: boolean,
  inner: number,
  ctx: PanelContext,
  figures: { cells: readonly Figure[]; widths: readonly number[]; fits: number },
): Line[] {
  const { skin } = ctx
  const target: Target = { kind: 'control', id: `row:${at}` }
  const pointed = sameTarget(ctx.pointer.hover, target)
  const mark = racer.won ? '✓' : racer.closed ? '·' : String(racer.place)
  const top = new Row(inner, skin)
    .marker(on)
    .space()
    .text(mark, racer.won ? skin.done : skin.hint)
    .space()
    .text(nameOf(racer.facts.task), on || pointed ? skin.you : skin.busy)
    .right((r) => {
      for (let slot = 0; slot < figures.fits; slot++) {
        const width = figures.widths[slot] ?? 0
        if (width === 0) continue
        const one = figures.cells[slot]
        const text = one?.text ?? ''
        r.space(width - widthOf(text) + 2).text(text, one ? one.tone(skin) : (t) => t)
      }
      r.space()
    })
    .build()
  const where = [
    racerRunsOn(racer.facts),
    racer.facts.finished ? 'finished' : racer.facts.state,
    racer.won ? 'picked' : racer.closed ? 'closed, branch kept' : null,
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  const under = new Row(inner, skin)
    .marker(on)
    .space(4)
    .text(where, racer.won ? skin.done : skin.hint)
    .build()
  const whole = { row: 0, from: 0, to: Math.max(0, inner - 1), target }
  return [top, under].map((line) => ({
    text: rowLook(line.text, skin, { on, pointed }),
    hits: [whole, ...line.hits],
  }))
}

/**
 * Every figure an entrant has, one per column (`SLOTS`): the checks, whether it
 * kept to what was asked, the findings, the size, the money. What nothing could
 * say is said as that.
 */
export function figuresOf(racer: Racer): Figure[] {
  const facts = racer.facts
  const out: Figure[] = []
  out.push(
    facts.checks === 'pass'
      ? { text: '✓ checks', tone: (s) => s.done }
      : facts.checks === 'fail'
        ? { text: '✕ checks', tone: (s) => s.bad }
        : facts.checks === 'unknown'
          ? { text: '— checks', tone: (s) => s.waiting }
          : { text: '… checks', tone: (s) => s.hint },
  )
  out.push(
    facts.strayed === null
      ? { text: 'asked —', tone: (s) => s.hint }
      : facts.strayed
        ? { text: '✕ strayed', tone: (s) => s.bad }
        : { text: '✓ asked', tone: (s) => s.done },
  )
  const found = facts.findings
  const open = found === null ? null : found.open + found.answered + found.confirmed
  out.push(
    open === null
      ? { text: 'findings —', tone: (s) => s.hint }
      : open > 0
        ? { text: `◆ ${open} open`, tone: (s) => s.bad }
        : { text: 'no findings', tone: (s) => s.hint },
  )
  out.push(
    facts.size && facts.size.added !== null && facts.size.removed !== null
      ? { text: `+${facts.size.added} −${facts.size.removed}`, tone: () => (t) => t }
      : { text: '±—', tone: (s) => s.hint },
  )
  out.push({
    text: facts.usd === null ? '$—' : raceDollars(facts.usd),
    tone: facts.usd === null ? (s) => s.hint : () => (t) => t,
  })
  return out
}

/** How many of the columns fit in `room`, the first kept. */
function columnsFor(widths: readonly number[], room: number): number {
  let used = 1
  let shown = 0
  for (const width of widths) {
    const cost = width === 0 ? 0 : width + 2
    if (used + cost > room) break
    used += cost
    shown++
  }
  return shown
}

function nameOf(task: string): string {
  return task.split('/')[1] ?? task
}
