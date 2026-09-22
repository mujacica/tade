import type { Hit, ScrollArea, Target } from '../hits.ts'
import { rowHit, shift } from '../hits.ts'
import { type AgentPane, type AppState, MARK_TONES, markOf } from '../model.ts'
import { barRows, type Scrolled } from '../scrollbar.ts'
import type { Band, Look, Skin } from '../skin.ts'
import { blank, fit, type Pointer, Row } from '../ui.ts'
import { shortened } from './text.ts'

// The shapes every region of the window is built out of: a tab, the quiet row
// under it, a list of them, and a scrollbar against the right edge.
//
// A tab is two rows because two rows is what reads as a tab, and every list
// down the side agrees about that — which is the whole reason these live here
// and not in whichever region happened to need one first.

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

/** What an agent is doing, in a few words, for the row under its name. */
export function doing(pane: AgentPane): string {
  const reason = pane.reason ?? ''
  switch (markOf(pane)) {
    case 'working':
      return reason && reason !== 'agent running' ? `working · ${reason}` : 'working'
    case 'idle':
      return 'idle · waiting for you'
    case 'needs-you':
      return pane.approval ? `wants you to approve ${pane.approval.summary}` : reason
    case 'done':
      if (pane.finished) {
        return pane.finished.summary ? `finished · ${pane.finished.summary}` : 'finished'
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
