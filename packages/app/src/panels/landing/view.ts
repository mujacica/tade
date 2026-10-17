import {
  deskSays,
  LANDING_SAID,
  LANDING_TIERS,
  type LandingTier,
  linesOf,
  printable,
} from '@tade/core'
import type { DeskRow } from '../../frame.ts'
import { sameTarget, type Target } from '../../hits.ts'
import type { Skin } from '../../skin.ts'
import { blank, box, type Drawn, Row } from '../../ui.ts'
import { dollars } from '../../view/text.ts'
import { widthOf } from '../../width.ts'
import type { PanelContext } from '../context.ts'
import { BAR, column, type Line, panelSize, rowLook } from '../frame.ts'
import type { LandingPanel } from './state.ts'

// What the landing desk looks like. What a key does to it is beside this in
// `state.ts`, and where each piece of work stands is core's (`landingOf`).
//
// A heading per tier, then a row per piece of work in two lines: its name and
// every figure somebody reads before trusting it — the checks at its head, the
// judge's findings, the forecast's collisions, how much it changed, what it
// cost and how long it has waited — and under it the one sentence saying why it
// is not ready, or nothing where it is. A figure nothing could say is drawn as
// what it is (`…`, `—`), never as nought.

/** The glyph a tier wears: its own shape, so it reads without colour. */
const GLYPH: Readonly<Record<LandingTier, string>> = { ready: '✓', yours: '◆', theirs: '○' }

/** The tone a tier's glyph and heading take. */
function toneOf(tier: LandingTier, skin: Skin): (text: string) => string {
  return tier === 'ready' ? skin.done : tier === 'yours' ? skin.waiting : skin.busy
}

export function landing(panel: LandingPanel, ctx: PanelContext): Drawn {
  const { skin } = ctx
  const { width, rows: tall } = panelSize(ctx, { max: 112 })
  const inner = width - 2 - BAR
  const desk = ctx.landing
  const projects = new Set(desk.map((row) => row.project)).size
  const head: Line[] = [
    new Row(inner, skin)
      .space()
      .text(
        deskSays(desk) ?? 'Nothing is waiting to land.',
        desk.length > 0 ? skin.busy : skin.hint,
      )
      .text(projects > 1 ? ` · in ${projects} projects` : '', skin.hint)
      .build(),
    blank(inner),
  ]
  // Every row's figures in the same columns, so they are read down the page:
  // each column as wide as its widest, and the names given what is left.
  const cells = desk.map((row) => figuresOf(row, ctx.now))
  const widths = SLOTS.map((_, at) =>
    Math.max(0, ...cells.map((one) => widthOf(one[at]?.text ?? ''))),
  )
  const longest = Math.max(0, ...desk.map((row) => widthOf(nameFor(row, projects > 1))))
  const shown = columnsFor(widths, inner - 6 - Math.min(longest, 28))
  const lines: Line[] = []
  let chosen: { from: number; to: number } | null = null
  for (const tier of LANDING_TIERS) {
    const rows = desk.map((row, at) => ({ row, at })).filter(({ row }) => row.tier === tier)
    if (rows.length === 0) continue
    if (lines.length > 0) lines.push(blank(inner))
    lines.push(
      new Row(inner, skin)
        .space()
        .text(LANDING_SAID[tier].toUpperCase(), skin.label)
        .text(`  ${rows.length}`, skin.hint)
        .build(),
    )
    for (const { row, at } of rows) {
      const on = at === panel.index
      if (on) chosen = { from: lines.length, to: lines.length + 1 }
      lines.push(
        ...item(row, at, on, projects > 1, inner, ctx, { cells: cells[at] ?? [], widths, shown }),
      )
    }
  }
  const index = desk[panel.index]
  const foot: Line[] = [
    panel.said
      ? new Row(inner, skin).space().text(`▲ ${panel.said}`, skin.waiting).build()
      : blank(inner),
    new Row(inner, skin, ctx.pointer)
      .space()
      .text(
        desk.length > 0 ? '↑↓ choose · enter reads the change · a goes to its agent' : '',
        skin.hint,
      )
      .right((r) => {
        if (index) {
          r.button('Read the change', { kind: 'control', id: 'patch' }, 'primary')
            .space()
            .button('Go to agent', { kind: 'control', id: 'agent' })
            .space()
        }
        r.button('Close', { kind: 'control', id: 'close' }).space()
      })
      .build(),
  ]
  const drawn = column(
    {
      head,
      body: {
        lines,
        width: inner,
        scroll: panel.scroll,
        chosen: panel.following ? chosen : null,
      },
      foot,
      rows: tall,
    },
    ctx,
  )
  return box('Landing desk', drawn.rows, width, skin, { corner: 'esc' })
}

/** One piece of work, in two lines: its name and its figures, then why. */
function item(
  row: DeskRow,
  at: number,
  on: boolean,
  named: boolean,
  inner: number,
  ctx: PanelContext,
  figures: { cells: readonly Figure[]; widths: readonly number[]; shown: number },
): Line[] {
  const { skin } = ctx
  const target: Target = { kind: 'control', id: `row:${at}` }
  const pointed = sameTarget(ctx.pointer.hover, target)
  const name = nameFor(row, named)
  const top = new Row(inner, skin)
    .marker(on)
    .space()
    .text(GLYPH[row.tier], toneOf(row.tier, skin))
    .space()
    .text(name, on || pointed ? skin.you : skin.busy)
    .right((r) => {
      for (let slot = 0; slot < figures.shown; slot++) {
        const width = figures.widths[slot] ?? 0
        if (width === 0) continue
        const one = figures.cells[slot]
        const text = one?.text ?? ''
        // Figures are read from the right, so each sits at its column's right edge.
        r.space(width - widthOf(text) + 2).text(text, one ? one.tone(skin) : (t) => t)
      }
      r.space()
    })
    .build()
  const because = [
    row.why ?? readySaid(row),
    row.also > 0 ? `and ${row.also} more` : null,
    keptSaid(ctx.kept?.[row.task] ?? 0),
  ]
    .filter((part): part is string => part !== null)
    .join(' · ')
  const under = new Row(inner, skin)
    .marker(on)
    .space(4)
    // Why it is not ready names checks and files a project calls what it likes.
    .text(printable(because), row.tier === 'ready' ? skin.hint : toneOf(row.tier, skin))
    .build()
  const whole = { row: 0, from: 0, to: Math.max(0, inner - 1), target }
  return [top, under].map((line) => ({
    text: rowLook(line.text, skin, { on, pointed }),
    hits: [whole, ...line.hits],
  }))
}

/** The comments written on its change and not sent: what its Send in the patch reader sends. */
function keptSaid(n: number): string | null {
  return n > 0 ? `${n} comment${n === 1 ? '' : 's'} kept` : null
}

/** What a ready row says under its name: that nothing holds it, and what reading it is. */
function readySaid(row: DeskRow): string {
  const commits = row.size ? `${row.size.commits} commit${row.size.commits === 1 ? '' : 's'}` : null
  return ['green', commits, row.review === 'open' ? 'review open' : null, 'nothing open']
    .filter((part): part is string => part !== null)
    .join(' · ')
}

interface Figure {
  text: string
  tone: (skin: Skin) => (text: string) => string
}

/** The columns of figures, most important first. Short of room the last ones go. */
const SLOTS = ['checks', 'findings', 'collisions', 'size', 'cost', 'waited'] as const

/** What a row is called: its project too, where the desk holds more than one. */
function nameFor(row: DeskRow, named: boolean): string {
  return named ? row.task : (row.task.split('/')[1] ?? row.task)
}

/**
 * Every figure a row has, one per column (`SLOTS`): the checks, the findings,
 * the collisions, the size, the money, the wait. A column with nothing to say
 * for this row is empty, never a nought.
 */
export function figuresOf(row: DeskRow, now: number): Figure[] {
  const out: Figure[] = []
  out.push(
    row.checks === 'pass'
      ? { text: '✓ checks', tone: (s) => s.done }
      : row.checks === 'fail'
        ? { text: '✕ checks', tone: (s) => s.bad }
        : row.checks === 'unknown'
          ? { text: '— checks', tone: (s) => s.waiting }
          : { text: '… checks', tone: (s) => s.hint },
  )
  const found = row.findings
  if (found === null) out.push({ text: 'findings —', tone: (s) => s.hint })
  else if (found.open + found.confirmed > 0) {
    out.push({ text: `◆ ${found.open + found.confirmed} open`, tone: (s) => s.bad })
  } else if (found.answered > 0) {
    out.push({ text: `◆ ${found.answered} to judge`, tone: (s) => s.waiting })
  } else out.push({ text: 'no findings', tone: (s) => s.hint })
  out.push(
    row.conflicts === null
      ? { text: '⇄ …', tone: (s) => s.hint }
      : row.conflicts > 0
        ? { text: `⇄ ${row.conflicts}`, tone: (s) => s.bad }
        : { text: '', tone: (s) => s.hint },
  )
  const lines = linesOf(row.size)
  out.push(
    row.size && row.size.added !== null && row.size.removed !== null
      ? { text: `+${row.size.added} −${row.size.removed}`, tone: () => (t) => t }
      : { text: lines === null ? '±—' : `±${lines}`, tone: (s) => s.hint },
  )
  out.push(
    row.usd === null
      ? { text: '$—', tone: (s) => s.hint }
      : { text: dollars(row.usd), tone: () => (t) => t },
  )
  out.push(
    row.waitingSince === null
      ? { text: '', tone: (s) => s.hint }
      : { text: waited(Math.max(0, now - row.waitingSince)), tone: (s) => s.hint },
  )
  return out
}

/** How many of the columns fit in `room`, the most important kept. */
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

/** How long something has waited, in the one unit that says it: `40m`, `3h`, `2d`. */
export function waited(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 48) return `${hours}h`
  return `${Math.floor(hours / 24)}d`
}
