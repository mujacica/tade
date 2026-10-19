import type { Said } from './protocol.ts'

// Budgets: how much of a collection goes out, and what is said about the rest.
//
// **Every list a device may read goes out whole** (`BUDGET`): the person asked
// for every screen of the away view to show everything it lists, with no line
// saying the rest is somewhere else. The conversation is the one collection
// still sent a stretch at a time, and it reads back to its first line as the
// reader scrolls (`earlier.ts`), so nothing said is only in the window.
//
// The machinery stays a cap plus a count of what it left out — `pageOf` with a
// finite `most` is how the conversation's stretch is cut, and how a test pages
// — because a cap that said nothing would lose rows without a word.
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
   * Lines of the conversation.
   *
   * The one list sent a stretch at a time, and deliberately so: a conversation
   * is read from the bottom, so what a phone needs first is the last exchange —
   * and the whole of what has ever been said to Tade is the one collection that
   * grows without bound while nobody is looking at it. The rest is read back as
   * the reader scrolls up (`earlier.ts`), never left in the window.
   */
  chat: number
  /** Requests handed to this machine, newest first. */
  intake: number
  /** The doors. There are four of them, and a cap here is a formality. */
  sources: number
  /** Runs of a workflow, newest first. */
  runs: number
  /** Stored workflows. */
  workflows: number
  /**
   * Code points of one piece of free text somebody wrote: a title, a note, a
   * reason, an account.
   *
   * `WHOLE` in `BUDGET`: the person asked to read every answer whole on a
   * phone, and a note is never shortened. Kept as a number, like the lists,
   * so a test can still see what a cut would say (`textOf`'s `more`). Code
   * points and not bytes or UTF-16 units, so a cut never breaks a character.
   */
  text: number
  /**
   * Code points of one *long* piece of text: a request's own body, a
   * workflow step's prompt, and the command an approval asks about. `WHOLE`
   * too, framed as material on the page and never cut.
   *
   * Whole costs the first snapshot and nothing after: a row that moved is
   * sent as the top-level fields that moved (`delta.ts`), so a body nobody
   * edited is not on any later frame.
   */
  material: number
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

/** No cap: the whole of a list goes out. */
const WHOLE = Number.POSITIVE_INFINITY

/**
 * The numbers. **Every list is whole**: a page holding the first twenty of
 * ninety tasks, with a line saying seventy are elsewhere, is a page nobody can
 * use from a phone — and a list on the wire is sent whole once and then only
 * as the rows that moved (`delta.ts`), so the cost is the first snapshot.
 * `packages/web/scripts/measure.ts` measures what that costs.
 *
 * Every piece of text goes out whole too — a note, a title, a request's body,
 * a step's prompt, a command — and the page wraps it and scrolls a long one in
 * its own box (`proseOf`). `chat` is the conversation's newest stretch, the
 * rest read back on scroll; `warnings` bounds the freshness that rides on
 * every frame, not anything somebody reads whole.
 */
export const BUDGET: Budget = {
  projects: WHOLE,
  tasks: WHOLE,
  tasksPerProject: WHOLE,
  queue: WHOLE,
  findings: WHOLE,
  notes: WHOLE,
  plans: WHOLE,
  chat: 120,
  intake: WHOLE,
  sources: WHOLE,
  runs: WHOLE,
  workflows: WHOLE,
  text: WHOLE,
  material: WHOLE,
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
 * A piece of free text somebody wrote, as the budget allows — whole, under
 * `BUDGET`.
 *
 * `more` rather than an ellipsis, and that is the whole point of the type.
 * The house rule about a note is *never lowercase or reword one*, and an
 * ellipsis written into the text is a reword: whoever reads it next cannot
 * tell the three dots from three dots the person typed. So a finite budget
 * sends a prefix of what was said and a flag saying there is more.
 *
 * Null for nothing said at all, because `unknown` and `''` must not be the
 * same value on the wire (`UNRECORDED` is `''` in `@tade/core`, and one
 * spelling of "nobody said" is the only way a client can be written once).
 *
 * Whole is answered without walking the text: a projection is built every
 * beat, and a 400 KiB body split into code points on each would be paid for
 * nothing. `length` counts UTF-16 units, never fewer than the code points.
 *
 * The type is `protocol.ts`'s, which is the schema, so there is one of it.
 */
export function textOf(text: string | null | undefined, most: number): Said | null {
  if (text === null || text === undefined || text === '') return null
  if (text.length <= most) return { words: text, more: false }
  const points = Array.from(text)
  if (points.length <= most) return { words: text, more: false }
  return { words: points.slice(0, Math.max(most, 0)).join(''), more: true }
}
