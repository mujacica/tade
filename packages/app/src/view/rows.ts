import { printable } from '@tade/core'
import type { LaneScrolling } from '@tade/drivers-core'
import type { Hit, ScrollArea, Target } from '../hits.ts'
import { pointingIn, rowHit, shift } from '../hits.ts'
import {
  type AgentPane,
  type AppState,
  glyph,
  MARK_TONES,
  markOf,
  offsetOf,
  shownName,
} from '../model.ts'
import { BAR, barRows, gutterRows, type Scrolled } from '../scrollbar.ts'
import type { Band, Look, Skin } from '../skin.ts'
import { blank, fit, type Pointer, Row } from '../ui.ts'
import { widthOf } from '../width.ts'
import { dollars, shortened, tokens } from './text.ts'

// The shapes every region of the window is built out of: a tab, the quiet row
// under it, a list of them, and a scrollbar against the right edge.
//
// A tab is two rows because two rows is what reads as a tab, and every list
// down the side agrees about that — which is the whole reason these live here
// and not in whichever region happened to need one first.

/**
 * A mark's tone, as the skin says it. Quiet by default: most marks are facts.
 *
 * Here with the other two because three regions read it — the side, the
 * ACTIONS page and the rows an extension keeps — and it lived in whichever of
 * them happened to need it first, which put two of them in a cycle the moment
 * they shared a drawing.
 */
export function toneFor(
  tone: 'quiet' | 'good' | 'warning' | 'bad' | undefined,
  skin: Skin,
): (text: string) => string {
  if (tone === 'bad') return skin.bad
  if (tone === 'good') return skin.done
  if (tone === 'warning') return skin.waiting
  return skin.hint
}

export function markTone(mark: string | null, skin: Skin): ((text: string) => string) | null {
  if (mark === 'M' || mark === 'R') return skin.waiting
  if (mark === 'A' || mark === 'U') return skin.done
  if (mark === 'D' || mark === '!') return skin.bad
  return null
}

/**
 * A control in a section's heading. The one that makes another of something
 * is a button; anything beside it is `small` — the same block two columns
 * narrower, so a heading reads as one set of controls with one of them
 * plainly the main one.
 */
export interface SectionAction {
  label: string
  target: Target
  look?: Look
  small?: boolean
  /** Red only while the pointer is on it, as a glyph button is. */
  danger?: boolean
}

export interface Section {
  id: string
  label: string
  count: number | null
  /**
   * What the count is out of, where the list is showing fewer rows than the
   * section holds — hiding the finished agents says `1/14`, not `1`, because a
   * badge that shrinks as things are hidden reads as agents having gone away.
   * Equal to `count` when nothing is hidden, and then only the count is drawn.
   */
  of?: number
  /** Rows when unfolded. At least one, so an open section never looks broken. */
  rows: (row: () => Row) => { text: string; hits: Hit[] }[]
  /** Its heading's controls, the main one last: the `+` sits against the edge. */
  actions?: SectionAction[]
  /** Said quietly at the right of the heading: what the section is measured against. */
  note?: string
  /**
   * The note in the room a narrow side leaves, drawn where the note itself
   * will not fit. A heading with nothing beside it is exactly what a folded
   * section has to avoid, so it says less rather than saying nothing.
   */
  brief?: string
  /**
   * Nothing in it, so it is folded until you open one. Carried on the heading
   * you press as well, so folding and drawing never read it differently.
   */
  quiet?: boolean
  /** Its items are tabs, and its rows carry their own room above and below them. */
  banded?: boolean
}

/** An item down the side: its rows, drawn as a tab, and how it is lit. */
export interface ListItem {
  rows: { text: string; hits: Hit[] }[]
  band: Band | null
  /** What goes in the room under it, where a blank row would be: a tree's lines carry on. */
  under?: { text: string; hits: Hit[] }
}

/**
 * Items down the side as tabs, a row of room between them: a tab never
 * touches the one next to it, and lighting one moves nothing.
 */
export function tabList(
  items: readonly ListItem[],
  width: number,
): { text: string; hits: Hit[] }[] {
  const out = [blank(width)]
  for (const item of items) out.push(...item.rows, item.under ?? blank(width))
  return out
}

/** Columns a tab spends on itself: a margin and an end, on each side. */
export const TAB_EDGES = 4

/** Two glyph buttons at the end of a tab, `×` and `≡`, and the room after them. */
export const TAB_ICONS = 7

/** Three glyph buttons at the end of a queued tab — pause, remove, menu — and the room after them. */
export const QUEUE_ICONS = 10

/** One glyph button — a row's `≡` — and the column of room after it. */
export const MENU_ICON = 4

/**
 * What is drawn inside a tab, laid on it: its ends and its ground when lit,
 * and every hit moved to where the tab puts it. The whole row is the item;
 * what sits on it is on top.
 */
export function tabbed(
  width: number,
  skin: Skin,
  band: Band | null,
  inner: { text: string; hits: Hit[] },
  target: Target,
): { text: string; hits: Hit[] } {
  return {
    text: ` ${skin.item(inner.text, band)} `,
    hits: [rowHit(0, width, target), ...shift(inner.hits, 0, TAB_EDGES / 2)],
  }
}

/**
 * A tab's second row: what is said quietly under its first, lit with it. A
 * tab is two rows because two rows is what reads as a tab and not a line —
 * one row was too thin, and three all ground was too heavy.
 */
export function secondRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  band: Band | null,
  said: string,
  target: Target,
  indent: number,
): { text: string; hits: Hit[] } {
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer)
  inner.space(indent).text(shortened(said, Math.max(1, inner.width - indent - 1)), skin.hint)
  return tabbed(width, skin, band, inner.build(), target)
}

/**
 * What an agent is doing, in a few words, for the row under its name. The
 * reason, the command it wants approved and its summary are the agent's own
 * words, so they are drawn as text (`printable`).
 */
export function doing(pane: AgentPane): string {
  const reason = printable(pane.reason ?? '')
  switch (markOf(pane)) {
    case 'working':
      return reason && reason !== 'agent running' ? `working · ${reason}` : 'working'
    case 'idle':
      return 'idle · waiting for you'
    case 'needs-you':
      return pane.approval ? `wants you to approve ${printable(pane.approval.summary)}` : reason
    case 'done':
      if (pane.finished) {
        return pane.finished.summary ? `finished · ${printable(pane.finished.summary)}` : 'finished'
      }
      return reason.startsWith('agent stopped')
        ? 'stopped · its work is in the checkout'
        : reason || 'finished'
    case 'failed':
      return reason || 'failed'
    case 'parked':
      return 'parked'
    default:
      return 'not started'
  }
}

export function toneOf(pane: AgentPane, skin: Skin): (text: string) => string {
  return skin[MARK_TONES[markOf(pane)]]
}

/**
 * Rows with a scrollbar against their right edge: each one as drawn, in the
 * room it was given, and one more column saying where in the whole thing you
 * are.
 *
 * The bar's hits carry what it was drawn from, so a drag on it can be turned
 * back into a line to scroll to without laying the region out a second time.
 */
export function barBeside(
  rows: readonly { text: string; hits: Hit[] }[],
  view: Scrolled,
  area: ScrollArea,
  width: number,
  state: AppState,
  skin: Skin,
): { text: string; hits: Hit[] }[] {
  const bar = barRows(view, skin, isScrolling(state, area))
  const target: Target = { kind: 'scrollbar', area, total: view.total, shown: view.shown }
  return Array.from({ length: view.rows }, (_, i) => ({
    text: `${fit(rows[i]?.text ?? '', width)}${bar[i] ?? ' '}`,
    hits: [...(rows[i]?.hits ?? []), { row: 0, from: width, to: width, target }],
  }))
}

/**
 * A page where an agent's screen would be — queued work, the plan, a
 * schedule, an agent's ACTIONS — in the rows under its heading. Laid out in
 * the room there is, and where it is longer than that, laid out again a
 * column narrower and windowed, with a bar in the column it gave up: a page
 * longer than its pane scrolls, rather than losing its end.
 *
 * `lay` is the page at a width, asked a second time only where the first
 * answer did not fit, because what wraps depends on how wide it is. Every row
 * carries the page's scroll hit under what is drawn on it, so the wheel moves
 * the page wherever on it the pointer is, and a control on it is still what a
 * click lands on.
 */
export function paged(
  lay: (width: number) => { text: string; hits: Hit[] }[],
  room: number,
  width: number,
  area: ScrollArea,
  state: AppState,
  skin: Skin,
): { text: string; hits: Hit[] }[] {
  const scrolls: Target = { kind: 'scroll', area }
  const under = (rows: readonly { text: string; hits: Hit[] }[]) =>
    rows.map((row) => ({ text: row.text, hits: [rowHit(0, width, scrolls), ...row.hits] }))
  const whole = lay(width)
  if (whole.length <= room) return under(whole)
  const body = width - BAR
  const page = lay(body)
  const offset = offsetOf(state, area, page.length, room)
  const seen = page.slice(offset, offset + room)
  while (seen.length < room) seen.push(blank(body))
  const view = { total: page.length, shown: room, offset, rows: room }
  return under(barBeside(seen, view, area, body, state, skin))
}

/**
 * The same column beside a lane's screen, drawn from whose the scrolling is.
 *
 * One function, because the agent's pane and the terminal along the bottom
 * are the same situation and a second reading of it would drift: a shell with
 * an editor open in it is a program that took the screen exactly as an agent
 * that draws its own conversation is, and neither is known by what was
 * launched into it. `window` — which is what a lane is until its driver says
 * otherwise — is the bar it has always been, numbers, handle and all; the
 * other two are a mark, and never a hit, so nothing about them says they can
 * be taken hold of.
 */
export function gutterBeside(
  rows: readonly { text: string; hits: Hit[] }[],
  whose: LaneScrolling,
  view: Scrolled,
  area: ScrollArea,
  width: number,
  state: AppState,
  skin: Skin,
): { text: string; hits: Hit[] }[] {
  if (whose === 'window') return barBeside(rows, view, area, width, state, skin)
  const cells = gutterRows(view.rows, skin, whose)
  return Array.from({ length: view.rows }, (_, i) => ({
    text: `${fit(rows[i]?.text ?? '', width)}${cells[i] ?? ' '}`,
    hits: [...(rows[i]?.hits ?? [])],
  }))
}

/**
 * Whether the pointer is on this region's bar, or holding it. A region with
 * two of them lights the one being used: the bar down its side and the one
 * along its bottom are two handles, not one.
 */
export function isScrolling(state: AppState, area: ScrollArea, across = false): boolean {
  if (state.scrolling?.area === area) return (state.scrolling.across === true) === across
  return (
    state.hover?.kind === 'scrollbar' &&
    state.hover.area === area &&
    (state.hover.across === true) === across
  )
}

/**
 * The columns an agent's tab keeps at its right end for what it has cost, and
 * the one after it: `$99.99`, which is also the room its close and menu take
 * under the pointer. So nothing that happens there cuts the name again — the
 * first cost arriving, `$9.99` becoming `$10.00`, the pointer crossing the row.
 * A figure in tokens is wider, and an agent a plan pays for says nothing else
 * all its life, so that one keeps a token figure's room instead.
 */
const COST_SLOT = widthOf('$99.99') + 1
/** Worn after the name of each agent whose work the forecast says would collide with another's. */
export const CLASH = ' ⇄'
const TOKENS_SLOT = widthOf('999k tok') + 1

/**
 * An agent down the side, as a tab: what it is doing, its name — cut short
 * with `…` rather than pushing anything off the edge — and what it has cost,
 * in a slot of its own (`COST_SLOT`). Under the pointer, a close and a menu
 * take the cost's place, each lit in turn: close in red, since it is a close.
 */
export function taskRow(
  width: number,
  skin: Skin,
  pointer: Pointer,
  task: AgentPane & { focused: boolean; dragging?: boolean },
  spent: { tokens: number; usd: number } | undefined,
  now: number,
): ListItem {
  const target: Target = { kind: 'task', task: task.task }
  const close: Target = { kind: 'action', name: `close-task:${task.task}` }
  const menu: Target = { kind: 'task-menu', task: task.task }
  const pointed = pointingIn(pointer.hover, [target, close, menu])
  // Only where they are drawn: an invisible button is a trap. Not on the one in your hand.
  const buttons = pointed && !task.dragging
  const inTokens = spent !== undefined && spent.usd <= 0 && spent.tokens > 0
  const cost =
    !buttons && spent && (spent.usd > 0 || spent.tokens > 0)
      ? spent.usd > 0
        ? dollars(spent.usd)
        : tokens(spent.tokens)
      : ''
  // The one being dragged is lit wherever it would land.
  const band: Band | null = task.focused || task.dragging ? 'selected' : pointed ? 'hovered' : null
  const inner = new Row(Math.max(0, width - TAB_EDGES), skin, pointer).space()
  inner.text(glyph(task, now), toneOf(task, skin), target).space()
  // The name is cut to what is left of the cost's slot, never of the cost.
  const right = Math.max(
    inTokens ? TOKENS_SLOT : COST_SLOT,
    cost ? widthOf(cost) + 1 : 0,
    buttons ? TAB_ICONS : 0,
  )
  // Its work would collide with another's (`conflictsOn`): a mark both of them wear.
  const clash = (task.conflicts?.length ?? 0) > 0 ? CLASH : ''
  const room = Math.max(1, inner.width - inner.used - right - 1 - widthOf(clash))
  inner.text(shortened(shownName(task), room), task.focused ? skin.you : (t) => t, target)
  if (clash) inner.text(clash, skin.waiting, target)
  inner.right((r) => {
    if (cost) r.text(cost, skin.hint, target).space()
    if (buttons) r.icon('×', close, 'danger').icon('≡', menu).space()
  })
  return {
    rows: [
      tabbed(width, skin, band, inner.build(), target),
      // What it is doing, in words, under its name.
      secondRow(width, skin, pointer, band, doing(task), target, 3),
    ],
    band,
  }
}
