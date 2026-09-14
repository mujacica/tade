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
  | { kind: 'lane'; task: string; lane: string }
  | { kind: 'project'; project: string }
  | { kind: 'orchestrator' }
  | { kind: 'file'; path: string }
  /** A folder in the FILES tree: clicking it opens or closes it. */
  | { kind: 'folder'; path: string }
  /** A tab of the bottom panel: `orchestrator`, or a terminal's lane id. */
  | { kind: 'bottom-tab'; tab: string }
  /** A terminal's screen: clicking it gives it the keyboard. */
  | { kind: 'terminal' }
  /** The agent's screen: clicking it gives the keyboard back to the agent. */
  | { kind: 'pane' }
  /** A line between regions that can be dragged to resize them. */
  | { kind: 'divider'; edge: 'sidebar' | 'bottom' }
  /** The branch under GIT: clicking it is its menu. */
  | { kind: 'branch' }
  /** A ≡ that opens something's menu. */
  | { kind: 'menu'; subject: MenuSubject }
  /** Somewhere the wheel scrolls, laid under what is drawn there. */
  | { kind: 'scroll'; area: ScrollArea }
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

/** Somewhere the wheel moves what is shown: the sidebar, a panel, the conversation. */
export type ScrollArea = 'sidebar' | 'panel' | 'transcript' | 'pane' | 'terminal'

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
  let found: Target | null = null
  for (const hit of hits) {
    if (hit.row === y && x >= hit.from && x <= hit.to) found = hit.target
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
    target.kind !== 'terminal' &&
    target.kind !== 'pane' &&
    target.kind !== 'divider'
  )
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
