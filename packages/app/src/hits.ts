// What is where on the screen, so a click can mean something.
//
// The rows and the map of what they are come out of the same pass: a second
// function working out where things ended up would be a second layout to keep
// in step, and the first symptom of it drifting is a button that does what the
// one above it says.
//
// Pure, like the drawing it comes from.

export type Target =
  | { kind: 'task'; task: string }
  | { kind: 'project'; project: string }
  | { kind: 'orchestrator' }
  | { kind: 'file'; path: string }
  | { kind: 'action'; name: string }

export interface Hit {
  /** Inclusive row, zero-based from the top of the window. */
  row: number
  /** Inclusive column range. */
  from: number
  to: number
  target: Target
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

/** One thing you can click along a row: a tab, or a button. */
export interface Chip {
  label: string
  target: Target
}

/**
 * Lay chips out along a row, and say where each one landed.
 *
 * Position is worked out from the label alone and the painting is applied
 * afterwards, so colour cannot move a hit: the two come from one loop, and a
 * chip can never be clickable somewhere other than where it is written.
 */
export function chips(
  row: number,
  items: readonly Chip[],
  width: number,
  paint: (label: string, item: Chip) => string = (label) => label,
): { text: string; hits: Hit[]; width: number } {
  const hits: Hit[] = []
  let text = ''
  let at = 0
  for (const item of items) {
    const label = ` ${item.label} `
    if (at + 1 + label.length > width) break
    text += ` ${paint(label, item)}`
    hits.push({ row, from: at + 1, to: at + label.length, target: item.target })
    at += 1 + label.length
  }
  return { text, hits, width: at }
}
