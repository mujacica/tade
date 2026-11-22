// When a setting was changed, as two machines can agree on it: a hybrid
// logical clock — wall time, a counter, and the machine that wrote it — on
// every `config_changed` line (`carry.ts` reads it; the journal that writes
// the line stamps it, `@tade/workbench`'s `setting-stamps.ts`).
//
// **Why not the wall clock alone.** Two machines' clocks disagree, and a
// carry that lets the later wall time win would let a box whose clock runs a
// minute slow lose every change made on it in that minute — including one
// made *after* it was handed the other machine's. A hybrid clock never goes
// backwards past anything it has been handed: a stamp a machine receives moves
// its clock up to it, so whatever it writes next is later than what it saw,
// whatever its wall clock says. Ties are broken by the machine's name, so two
// machines comparing the same two stamps always pick the same one.
//
// Pure: `now` is handed in, never read.

/** One stamp: when, by the wall clock of the machine that wrote it, and which. */
export interface Stamp {
  /** Milliseconds, never less than any stamp the writer had seen. */
  wall: number
  /** Changes within the same millisecond of `wall`, in the order they were made. */
  count: number
  /** What the machine that wrote it calls itself (`machineLabel`); empty for a line that predates stamps. */
  machine: string
}

/** A stamp as a journal line carries it: `<wall>:<count>:<machine>`. */
export function stampText(stamp: Stamp): string {
  return `${stamp.wall}:${stamp.count}:${stamp.machine}`
}

/** A stamp read back from a line; null for anything that is not one. */
export function stampOf(text: unknown): Stamp | null {
  if (typeof text !== 'string') return null
  const found = /^(\d{1,16}):(\d{1,9}):(.{0,120})$/.exec(text)
  if (found === null) return null
  const wall = Number(found[1])
  const count = Number(found[2])
  if (!Number.isSafeInteger(wall) || !Number.isSafeInteger(count)) return null
  return { wall, count, machine: found[3] ?? '' }
}

/**
 * Which is later: negative where `a` is, positive where `b` is, nought for the
 * same stamp. Nothing (`null`, a value no line says the time of) is earlier
 * than every stamp.
 */
export function compareStamps(a: Stamp | null, b: Stamp | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? -1 : 1
  if (a.wall !== b.wall) return a.wall - b.wall
  if (a.count !== b.count) return a.count - b.count
  return a.machine < b.machine ? -1 : a.machine > b.machine ? 1 : 0
}

/** The later of two stamps. */
export function laterOf(a: Stamp | null, b: Stamp | null): Stamp | null {
  return compareStamps(a, b) >= 0 ? a : b
}

/**
 * The stamp for a change made on `machine` now: later than every stamp this
 * clock has written or been handed (`last`), and at `now` where the wall
 * clock is ahead of all of them.
 */
export function tick(last: Stamp | null, now: number, machine: string): Stamp {
  const wall = Math.max(Math.trunc(now), last?.wall ?? 0)
  const count = last !== null && wall === last.wall ? last.count + 1 : 0
  return { wall, count, machine }
}

/** A line's stamp, or for a line from before stamps, its wall time and no machine. */
export function lineStamp(detail: { hlc?: unknown } | undefined, ts?: string): Stamp | null {
  const stamped = stampOf(detail?.hlc)
  if (stamped !== null) return stamped
  const at = ts === undefined ? Number.NaN : Date.parse(ts)
  return Number.isNaN(at) ? null : { wall: at, count: 0, machine: '' }
}
