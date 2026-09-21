// What is where on the screen, so a click can mean something.
//
// The rows and the map of what they are come out of the same pass: a second
// function working out where things ended up would be a second layout to keep
// in step, and the first symptom of it drifting is a button that does what the
// one above it says.
//
// Pure, like the drawing it comes from.

import type { MenuSubject } from './panels.ts'

export type Target =
  | { kind: 'task'; task: string }
  | { kind: 'task-menu'; task: string }
  /** A note under NOTES, named by when it was said and what it said. */
  | { kind: 'note'; at: string; text: string }
  | { kind: 'lane'; task: string; lane: string }
  /** The tab beside an agent's, showing what it has done rather than its screen. */
  | { kind: 'pane-tab'; task: string; tab: 'work' }
  /** A check on the work tab: clicking it shows what it printed. */
  | { kind: 'check'; task: string; check: string }
  | { kind: 'project'; project: string }
  | { kind: 'orchestrator' }
  | { kind: 'file'; path: string }
  /** A folder in the FILES tree: clicking it opens or closes it. */
  | { kind: 'folder'; path: string }
  /** A tab of the bottom panel: `orchestrator`, or a terminal's lane id. */
  | { kind: 'bottom-tab'; tab: string }
  /** A terminal's screen: clicking it gives it the keyboard. */
  /** The terminal in front; `split` for the one beside or below it. */
  | { kind: 'terminal'; side?: 'split' }
  /** The agent's screen: clicking it gives the keyboard back to the agent. */
  /** An agent's pane; `split` for the lane shown beside or below the main one. */
  | { kind: 'pane'; side?: 'split' }
  /** A line between regions that can be dragged to resize them. */
  | { kind: 'divider'; edge: 'sidebar' | 'bottom' | 'split' | 'terminal-split' }
  /** The branch under GIT: clicking it is its menu. */
  | { kind: 'branch' }
  /** A ≡ that opens something's menu. */
  | { kind: 'menu'; subject: MenuSubject }
  /** Somewhere the wheel scrolls, laid under what is drawn there. */
  | { kind: 'scroll'; area: ScrollArea }
  /**
   * The bar down the right of it, or along the bottom of it: where you are,
   * and a handle to move. It carries what it was drawn from, because a drag
   * has to be turned back into a line to scroll to and the drawing is the only
   * thing that knows the sums. `across` is the one lying down, whose numbers
   * are columns rather than lines.
   */
  | { kind: 'scrollbar'; area: ScrollArea; total: number; shown: number; across?: true }
  /**
   * A line of the orchestrator's input, by the visual line the editor drew:
   * clicking one puts the caret where the click was, as any text box does.
   */
  | { kind: 'input'; line: number }
  /**
   * A line of the file being read, by its line in the file: clicking one puts
   * the caret there and lets you type. Which character that is comes from how
   * far along the hit the click landed, which only the hit knows.
   */
  | { kind: 'caret'; line: number }
  /** A file the task changed: clicking it shows the change. */
  | { kind: 'change'; task: string; path: string }
  /** A link on an agent's screen. */
  | { kind: 'link'; url: string }
  /** A file reference on an agent's screen, maybe at a line. */
  | { kind: 'place'; path: string; line?: number; column?: number }
  | { kind: 'section'; section: string }
  | { kind: 'action'; name: string }
  /** A panel's own control, named by the panel. */
  | { kind: 'control'; id: string }
  /** Outside an open panel: clicking here closes it. */
  | { kind: 'dismiss' }
  /** Inside a panel but on nothing: swallows the click so it cannot fall through. */
  | { kind: 'inert' }

/**
 * Somewhere the wheel moves what is shown: the sidebar, a panel, the
 * conversation. `plan` is the picture of a chain where an agent's screen
 * would be, which only ever moves sideways.
 */
export type ScrollArea = 'sidebar' | 'panel' | 'transcript' | 'pane' | 'terminal' | 'plan'

export interface Hit {
  /** Inclusive row, zero-based from the top of the window. */
  row: number
  /** Inclusive column range. */
  from: number
  to: number
  target: Target
}

/** The scrollable area under this cell, whatever is drawn over it. */
export function scrollAt(hits: readonly Hit[], x: number, y: number): ScrollArea | null {
  let found: ScrollArea | null = null
  for (const hit of hits) {
    if (hit.target.kind === 'scroll' && hit.row === y && x >= hit.from && x <= hit.to)
      found = hit.target.area
  }
  return found
}

/** What is at this cell, if anything. Later hits win: they are drawn on top. */
export function hitAt(hits: readonly Hit[], x: number, y: number): Target | null {
  return hitBoxAt(hits, x, y)?.target ?? null
}

/**
 * The same, as the hit itself: what was clicked *and* where it starts, for the
 * few things that care how far along them the pointer landed.
 */
export function hitBoxAt(hits: readonly Hit[], x: number, y: number): Hit | null {
  let found: Hit | null = null
  for (const hit of hits) {
    if (hit.row === y && x >= hit.from && x <= hit.to) found = hit
  }
  return found
}

/** A row that is entirely one thing, which most of them are. */
export function rowHit(row: number, width: number, target: Target): Hit {
  return { row, from: 0, to: Math.max(0, width - 1), target }
}

/** The same thing on screen: compared by what it is, not by which object. */
export function sameTarget(a: Target | null, b: Target | null): boolean {
  if (a === null || b === null) return a === b
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * Whether pointing at this is pointing at something you can press. Rows of
 * transcript are clickable in the sense that they focus the strip, but they
 * are not buttons, and asking for a hand over them would be a lie.
 */
export function pressable(target: Target | null): boolean {
  if (!target) return false
  return (
    target.kind !== 'inert' &&
    target.kind !== 'orchestrator' &&
    target.kind !== 'dismiss' &&
    target.kind !== 'scroll' &&
    target.kind !== 'scrollbar' &&
    target.kind !== 'input' &&
    target.kind !== 'caret' &&
    target.kind !== 'terminal' &&
    target.kind !== 'pane' &&
    target.kind !== 'divider'
  )
}

/**
 * The rows one thing covers: where it starts and how many rows it is — or,
 * `across`, where it starts along the window and how many columns it is, for
 * something lying down. Read back out of the map rather than remembered while
 * drawing, because a region's rows are moved to where the region ended up
 * long after it drew them — so only the map knows where a scrollbar actually
 * is. Either way it comes back as a start and a count of cells: the sums that
 * move a thumb do not care which way it points.
 */
export function extentOf(
  hits: readonly Hit[],
  target: Target,
  across = false,
): { top: number; rows: number } {
  let first = Number.POSITIVE_INFINITY
  let last = -1
  for (const hit of hits) {
    if (!sameTarget(hit.target, target)) continue
    first = Math.min(first, across ? hit.from : hit.row)
    last = Math.max(last, across ? hit.to : hit.row)
  }
  return last < 0 ? { top: 0, rows: 0 } : { top: first, rows: last - first + 1 }
}

/** Move a region's hits to where the region was put. */
export function shift(hits: readonly Hit[], rows: number, cols = 0): Hit[] {
  return hits.map((hit) => ({
    ...hit,
    row: hit.row + rows,
    from: hit.from + cols,
    to: hit.to + cols,
  }))
}
