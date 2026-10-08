import { authored, stringsIn } from './fields.ts'
import type { Collection, Delta, Snapshot } from './protocol.ts'
import { COLLECTIONS } from './protocol.ts'

// How big a projection is, measured without printing a word of it.
//
// DESIGN.md §10.7 asks for numbers from the owner's own machine — bytes per
// second for one viewer, for four, and the idle cost — and says plainly that an
// RSS figure is a fact about one machine and not a test threshold. The problem
// with getting those numbers is that the obvious way to get them is to dump a
// real projection and look at it, which puts every task title, every note and
// every one of the person's own words on a terminal and into a scrollback.
//
// So: the measurement is **counts, lengths and byte totals**, and the only
// strings it ever emits are its own column headings, the names of the
// collections and the names of the grants — all of which are this file's own
// vocabulary. `packages/web/scripts/measure.ts` is what points it at a real
// `TADE_HOME`; `test/measure.test.ts` asserts that a fixture stuffed with
// distinctive private strings produces a report containing none of them.
//
// Pure: no `node:`, no clock, nothing to await. `TextEncoder` is a global in
// both runtimes and is how a byte count is had without `Buffer`.

const bytesOf = (value: unknown): number => new TextEncoder().encode(JSON.stringify(value)).length

/** One collection's share of a projection. */
export interface Measured {
  collection: Collection
  /** Rows actually in the projection. */
  rows: number
  /** Rows there are inside the device's reach. */
  total: number
  omitted: number
  bytes: number
  /** The biggest single row, in bytes. */
  widest: number
}

/** What a projection weighs, and how much of it is unknown. */
export interface Measurement {
  bytes: number
  collections: readonly Measured[]
  strings: {
    all: number
    /** Free text somebody wrote. */
    authored: number
    /** Tade's own words. */
    metadata: number
    /** Code points in the longest authored string. */
    longest: number
  }
  /**
   * How many values are `null`.
   *
   * Worth a column of its own: `unknown` is a first-class answer here, so a
   * projection with none at all is more suspicious than one with many.
   */
  nulls: number
  /** What this device was granted, by name. */
  reads: readonly string[]
  warnings: number
}

export function measureOf(snapshot: Snapshot): Measurement {
  const collections: Measured[] = COLLECTIONS.map((collection) => {
    const rows = snapshot[collection] as readonly unknown[]
    const page = snapshot.pages[collection]
    return {
      collection,
      rows: rows.length,
      total: page.total,
      omitted: page.omitted,
      bytes: bytesOf(rows),
      widest: rows.reduce<number>((most, row) => Math.max(most, bytesOf(row)), 0),
    }
  })
  const found = stringsIn(snapshot)
  const mine = found.filter((one) => authored(one.at))
  return {
    bytes: bytesOf(snapshot),
    collections,
    strings: {
      all: found.length,
      authored: mine.length,
      metadata: found.length - mine.length,
      longest: mine.reduce((most, one) => Math.max(most, Array.from(one.words).length), 0),
    },
    nulls: nullsIn(snapshot),
    reads: [...snapshot.you.reads],
    warnings: snapshot.fresh.warnings.length,
  }
}

function nullsIn(value: unknown): number {
  if (value === null) return 1
  if (Array.isArray(value)) return value.reduce<number>((sum, one) => sum + nullsIn(one), 0)
  if (typeof value !== 'object') return 0
  return Object.values(value as Record<string, unknown>).reduce<number>(
    (sum, one) => sum + nullsIn(one),
    0,
  )
}

/** What one delta weighs, and how much of the tree it touched. */
export interface DeltaMeasured {
  bytes: number
  /** Rows set, in all. */
  set: number
  /** Rows deleted, in all. */
  del: number
  /** True when it carried the freshness and nothing else: a tick. */
  timeOnly: boolean
}

/**
 * A page's counts can move with no row moving — a withheld collection grows,
 * and only its `total` changes — so "carried only the clock" has to mean the
 * whole frame and not just its rows. A measurement that called that a tick
 * would under-count what a stream actually sends.
 */
function movedSomething(delta: Delta): boolean {
  return delta.pages !== undefined || delta.you !== undefined
}

export function measureDelta(delta: Delta): DeltaMeasured {
  const set = Object.values(delta.set as Record<string, object | undefined>).reduce<number>(
    (sum, one) => sum + Object.keys(one ?? {}).length,
    0,
  )
  const del = Object.values(delta.del as Record<string, string[] | undefined>).reduce<number>(
    (sum, one) => sum + (one?.length ?? 0),
    0,
  )
  return {
    bytes: bytesOf(delta),
    set,
    del,
    timeOnly: set === 0 && del === 0 && !movedSomething(delta),
  }
}

const pad = (text: string, width: number): string => text.padEnd(width)
const num = (n: number): string => n.toLocaleString('en-US')
const right = (n: number, width: number): string => num(n).padStart(width)

/**
 * The report, as text.
 *
 * Every string in what comes back is either a heading, a collection's name or
 * a grant's name. There is no path through this function that emits a value out
 * of the projection, which is the property `test/measure.test.ts` asserts
 * against a fixture built to be caught.
 */
export function sayMeasurement(found: Measurement, deltas: readonly DeltaMeasured[] = []): string {
  const lines: string[] = []
  lines.push(
    `projection  ${num(found.bytes)} bytes   reads: ${found.reads.length === 0 ? 'names and counts only' : found.reads.join(', ')}`,
  )
  lines.push(`            ${num(found.nulls)} unknown, ${num(found.warnings)} warnings`)
  lines.push(
    `            ${num(found.strings.all)} strings: ${num(found.strings.metadata)} Tade's, ${num(found.strings.authored)} authored (longest ${num(found.strings.longest)})`,
  )
  lines.push('')
  lines.push(
    `${pad('collection', 12)}${'rows'.padStart(11)}${'omitted'.padStart(9)}${'bytes'.padStart(11)}${'widest'.padStart(10)}`,
  )
  for (const one of found.collections)
    lines.push(
      `${pad(one.collection, 12)}${right(one.rows, 11)}${right(one.omitted, 9)}${right(one.bytes, 11)}${right(one.widest, 10)}`,
    )
  if (deltas.length > 0) {
    const ticks = deltas.filter((one) => one.timeOnly)
    const moved = deltas.filter((one) => !one.timeOnly)
    const bytes = deltas.reduce((sum, one) => sum + one.bytes, 0)
    lines.push('')
    lines.push(
      `${num(deltas.length)} deltas  ${num(bytes)} bytes  ${num(moved.length)} moved something, ${num(ticks.length)} carried only the clock`,
    )
    if (moved.length > 0) {
      const rows = moved.reduce((sum, one) => sum + one.set + one.del, 0)
      lines.push(
        `         ${num(rows)} rows touched, ${num(Math.round(bytes / deltas.length))} bytes each on average`,
      )
    }
  }
  return lines.join('\n')
}
