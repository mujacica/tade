import type { ParsedDiff } from '../../diff.ts'

// What git says about the file you have open, as rows the viewer draws.
//
// The viewer edits the *working file*, so the file's own lines are the only
// thing that can be typed into and the only thing a save writes back. A diff
// has one kind of line the file does not have — one that was taken out — so
// the inline view is a list of rows over the file rather than a second copy of
// it: a row is either a line of the file, by its index, or a line git says is
// gone, which carries its own text and can never be typed into.
//
// Everything a diff says is keyed by the line numbers *git* gave the file when
// it looked. What the panel holds is `Edited.from` — where each line it has
// came from in the file as it was read — so a line nobody has touched finds
// its own mark however much has been typed above it, and a line typed since is
// an addition nobody has asked git about yet. That is why nothing here counts
// lines from the top of the buffer.

/** One row of the inline diff: a line of the file, or a line that is gone from it. */
export interface InlineRow {
  /** The line of the file this row draws, counting from 0 — null for one that is gone. */
  line: number | null
  kind: 'context' | 'add' | 'remove'
  /** What a gone line said. It is not in the file any more, so it is kept here. */
  text: string
}

/**
 * The rows the file is drawn as, with what git says laid into them — or
 * nothing, where there is no diff to lay in.
 *
 * `from` is `Edited.from` when something has been typed, and nothing when the
 * file is as it was read, in which case line `n` is git's line `n + 1`.
 * `count` is how many lines the file has now.
 */
export function inlineRows(
  diff: ParsedDiff | null,
  from: readonly number[] | null,
  count: number,
): InlineRow[] | null {
  if (!diff || diff.binary) return null
  const { added, gone } = marksOf(diff)
  const rows: InlineRow[] = []
  // In order, so a walk down the file meets each run of gone lines once.
  const anchors = [...gone.keys()].sort((a, b) => a - b)
  let next = 0
  /** Every run of gone lines anchored at or before this line of the file git read. */
  const goneUpTo = (upto: number) => {
    for (; next < anchors.length; next++) {
      const at = anchors[next]
      if (at === undefined || at > upto) break
      for (const text of gone.get(at) ?? []) rows.push({ line: null, kind: 'remove', text })
    }
  }
  const origins = nextOrigins(from, count)
  for (let line = 0; line < count; line++) {
    const was = from ? (from[line] ?? -1) : line
    if (was < 0) {
      // Typed since the file was read: an addition git has not been asked
      // about, and a line whose own place in what git read is gone with it. So
      // the gone lines above it are placed by the next line that still has one:
      // a row that jumped below the line you were typing on, every time you
      // typed on it, is what reading from the line itself looks like.
      goneUpTo(origins[line] ?? Number.POSITIVE_INFINITY)
      rows.push({ line, kind: 'add', text: '' })
      continue
    }
    goneUpTo(was + 1)
    rows.push({ line, kind: added.has(was + 1) ? 'add' : 'context', text: '' })
  }
  // What was taken off the end, and anything whose line has since been deleted.
  goneUpTo(Number.POSITIVE_INFINITY)
  return rows
}

/**
 * For each line, where in the file git read the next line that still knows
 * comes from — so a line that no longer knows can still say what came before
 * it. One pass backwards, because the answer for a line is the answer for the
 * one after it until a line with an origin of its own says otherwise.
 */
function nextOrigins(from: readonly number[] | null, count: number): number[] {
  const origins: number[] = new Array(count).fill(Number.POSITIVE_INFINITY)
  let seen = Number.POSITIVE_INFINITY
  for (let line = count - 1; line >= 0; line--) {
    origins[line] = seen
    const was = from ? (from[line] ?? -1) : line
    if (was >= 0) seen = was
  }
  return origins
}

/**
 * Where a line of the file is drawn, which the gone lines above it move down.
 * A line the rows do not hold is itself: with no inline diff the two are one.
 */
export function drawnRow(rows: readonly InlineRow[] | null | undefined, line: number): number {
  if (!rows) return line
  const at = rows.findIndex((row) => row.line === line)
  return at < 0 ? line : at
}

/**
 * The other way: the line of the file a drawn row is, or the first one under it
 * where the row itself is a gone line. What the top of the view becomes when
 * the inline diff is turned off.
 */
export function lineAtRow(rows: readonly InlineRow[] | null | undefined, row: number): number {
  if (!rows) return row
  let past = 0
  for (let at = 0; at < rows.length; at++) {
    const line = rows[at]?.line
    if (line === null || line === undefined) continue
    if (at >= row) return line
    past = line + 1
  }
  return past
}

/**
 * What a diff says about the file it is of, by the line numbers git gave it:
 * which lines are new, and which are gone from before each one.
 *
 * A run of gone lines is anchored to the line of the new file it sits before —
 * the next line git kept or added — so it stays where it was however much is
 * typed above it. A run that ends a hunk, or the file, has no such line, so it
 * is anchored one past the last one there was.
 */
function marksOf(diff: ParsedDiff): { added: Set<number>; gone: Map<number, string[]> } {
  const added = new Set<number>()
  const gone = new Map<number, string[]>()
  let pending: string[] = []
  let after = 0
  const anchor = (at: number) => {
    if (pending.length === 0) return
    gone.set(at, [...(gone.get(at) ?? []), ...pending])
    pending = []
  }
  for (const line of diff.lines) {
    if (line.kind === 'hunk') {
      anchor(after + 1)
      continue
    }
    if (line.kind === 'remove') {
      pending.push(line.text)
      continue
    }
    const at = line.new
    if (at === null) continue
    anchor(at)
    if (line.kind === 'add') added.add(at)
    after = at
  }
  anchor(after + 1)
  return { added, gone }
}
