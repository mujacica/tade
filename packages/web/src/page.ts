import type { Said } from './protocol.ts'

// Budgets: how much of a collection goes out, and what is said about the rest.
//
// The shape is `composeBriefing`'s, deliberately — **a cap plus a count of
// what it left out**, never a cap on its own. A flat cap that says nothing
// loses four repositories without a word, and a page that quietly holds the
// first twenty of ninety tasks is a page that answers "is anything waiting for
// me" wrongly and looks complete doing it.
//
// Pure, and keyed to nothing but the rows it is handed.

/** How much of each collection a projection carries. */
export interface Budget {
  projects: number
  tasks: number
  /** Per project as well, so one busy repository cannot crowd out three quiet ones. */
  tasksPerProject: number
  queue: number
  findings: number
  notes: number
  plans: number
  /**
   * Code points of one piece of free text somebody wrote.
   *
   * Code points and not bytes or UTF-16 units: a cut in the middle of a
   * surrogate pair is a broken character, and a cut by bytes makes the budget
   * mean something different for every language.
   */
  text: number
  /**
   * How many of status's warnings cross, past which they are counted.
   *
   * Bounded for a reason the other collections do not have: the freshness
   * rides on **every** frame, including a `tick`, whose whole job is to move a
   * client's clock without growing with the tree (`delta.ts`). A machine with
   * forty unreadable projects would otherwise put forty sentences on the wire
   * every two seconds, for ever, to say what one line says.
   */
  warnings: number
}

/**
 * The numbers, and they are a first guess rather than a measurement.
 *
 * `tasksPerProject: 60` is over twice what the owner's busiest project holds;
 * `notes: 200` is what the window already keeps. What makes them safe to be
 * wrong about is that every one of them is reported as a count of what was
 * left out, so being wrong is visible rather than silent. `packages/web/scripts/measure.ts`
 * is how they get replaced by measurements.
 */
export const BUDGET: Budget = {
  projects: 40,
  tasks: 400,
  tasksPerProject: 60,
  queue: 200,
  findings: 100,
  notes: 200,
  plans: 20,
  text: 600,
  warnings: 10,
}

/** One collection's share of a projection: what is here, and what is not. */
export interface Page<T> {
  rows: readonly T[]
  /** How many there are in all, inside this device's reach. */
  total: number
  /** How many of them are not in `rows`. Written down, not left to be worked out. */
  omitted: number
  /** The id to carry on after, or null when this page reaches the end. */
  next: string | null
  /**
   * True when the cursor named a row that is no longer there, so this page
   * started over from the beginning.
   *
   * A list somebody is paging through can lose a row underneath them — a task
   * finished, a note was forgotten. Starting silently at the top would look
   * like the list repeating itself; this is how the page gets to say *the list
   * moved* instead.
   */
  restarted: boolean
}

/**
 * A collection whose rows this device was not granted: the count, and nothing
 * of it.
 *
 * `total` is the real number and every one of them is `omitted`, which is the
 * honest shape of a read scope — *there are forty-one notes, and you may not
 * read them from here* — rather than a nought that reads as "you have none".
 */
export function withheld<T>(total: number): Page<T> {
  return { rows: [], total, omitted: total, next: null, restarted: false }
}

/**
 * The rows that fit, from `after` onwards.
 *
 * `rows` arrive in the order the collection chooses between them — newest
 * first for notes, by name for everything else — and that order is what
 * `after` walks. The caller sorts what comes back for the wire; a cursor into
 * the choosing order and a sort for the wire are two different jobs and
 * conflating them is how pagination starts skipping rows.
 *
 * A `most` of nought is not a budget and is not how a collection says none:
 * `withheld` is, and it is the one that keeps the count.
 */
export function pageOf<T>(
  rows: readonly T[],
  most: number,
  id: (row: T) => string,
  after: string | null = null,
): Page<T> {
  const found = after === null ? -1 : rows.findIndex((row) => id(row) === after)
  const restarted = after !== null && found < 0
  const start = restarted ? 0 : found + 1
  const taken = rows.slice(start, start + Math.max(most, 0))
  const end = start + taken.length
  const last = taken.at(-1)
  return {
    rows: taken,
    total: rows.length,
    omitted: rows.length - taken.length,
    next: end < rows.length && last !== undefined ? id(last) : null,
    restarted,
  }
}

/**
 * As much of a piece of free text somebody wrote as the budget allows.
 *
 * `more` rather than an ellipsis, and that is the whole point of the type.
 * The house rule about a note is *never lowercase or reword one*, and an
 * ellipsis written into the text is a reword: whoever reads it next cannot
 * tell the three dots from three dots the person typed. So what goes out is a
 * prefix of what was said and a flag saying there is more, and the page is
 * what draws the affordance.
 *
 * Null for nothing said at all, because `unknown` and `''` must not be the
 * same value on the wire (`UNRECORDED` is `''` in `@tade/core`, and one
 * spelling of "nobody said" is the only way a client can be written once).
 *
 * The type is `protocol.ts`'s, which is the schema, so there is one of it.
 */
export function textOf(text: string | null | undefined, most: number): Said | null {
  if (text === null || text === undefined || text === '') return null
  const points = Array.from(text)
  if (points.length <= most) return { words: text, more: false }
  return { words: points.slice(0, Math.max(most, 0)).join(''), more: true }
}
