import { createHash } from 'node:crypto'
import type { Watched } from '@tade/core'
import {
  WATCH_SEEN_MOST,
  type WatchSeenAnswer,
  WatchSeenAnswerSchema,
  type WebWatchSeen,
} from '@tade/web'
import type { Wiring } from './context.ts'

// A watch handed between machines: what one that looks with it answers about
// what it has already found (`@tade/web`'s `watch-seen.ts`), and what the
// machine that left it there writes down of that answer, so a watch taken back
// never offers again what the other machine acted on.
//
// **Asked every time the watch is due here and left there**, not once at the
// moment it comes back: a watch usually comes back because the machine it was
// left to stopped answering, which is the one moment it cannot be asked. So
// each quiet look here (`notLooking`) carries what that machine had found by
// then, and only the keys this machine had not already seen go in the line.
//
// **The cursor only where the two watches look at the same thing.** A key is a
// source's own id for an item, true whatever the watch was told to look at; a
// cursor is where one look got to over one input, and taken over another it
// would skip what this machine's watch was asked to find. So the cursor goes
// over only where both machines' inputs hash the same (`inputDigest`).

/** A watch's input, hashed so two machines can tell whether their watches look at the same thing. */
export function inputDigest(input: Readonly<Record<string, unknown>>): string {
  return createHash('sha256').update(stable(input)).digest('hex').slice(0, 32)
}

/** JSON with every object's keys in order, so two machines that wrote one input differently hash it alike. */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, one]) => one !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([key, one]) => `${JSON.stringify(key)}:${stable(one)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

/** What this machine answers about one of its watches: every key it has seen, newest first, and its cursor. */
export function watchSeenFrom(wire: Wiring): WebWatchSeen {
  return async ({ project, watch }) => {
    const at = new Date(wire.now()).toISOString()
    const none: WatchSeenAnswer = { at, found: false, since: null, input: '', seen: [], more: 0 }
    const live = wire.live
    const schedule = wire.opts.client
      .schedules()
      .find(
        (one) => one.project === project && one.does.kind === 'watch' && one.does.watch === watch,
      )
    if (live === null || schedule === undefined || schedule.does.kind !== 'watch') return none
    const watched = live.watchedOf(schedule.id)
    const keys = seenNewestFirst(watched)
    return {
      at,
      found: true,
      since: watched.since,
      input: inputDigest(schedule.does.input),
      seen: keys.slice(0, WATCH_SEEN_MOST),
      more: Math.max(0, keys.length - WATCH_SEEN_MOST),
    }
  }
}

/** Every key a watch has seen, the ones its findings name newest first and then the rest. */
function seenNewestFirst(watched: Watched): string[] {
  const named = watched.findings.map((one) => one.key)
  const kept = new Set(named)
  return [...named, ...[...watched.seen].filter((key) => !kept.has(key))]
}

/** What a machine a watch is left to had already found with it, as this machine takes it. */
export interface FoundThere {
  /** The keys it had found that this machine has not seen. */
  handed: string[]
  /** Its cursor, where its watch looks at what this one's does; null otherwise. */
  since: string | null
}

/**
 * What another machine answered, read for its shape like everything it wrote,
 * and narrowed to what this machine's watch takes from it: the keys it has
 * not seen, and the cursor only where the inputs match. Null where the answer
 * is not one, or that machine has no such watch.
 */
export function foundThereOf(
  answer: unknown,
  watched: Watched,
  input: Readonly<Record<string, unknown>>,
): FoundThere | null {
  const read = WatchSeenAnswerSchema.safeParse(answer)
  if (!read.success || !read.data.found) return null
  const handed = read.data.seen.filter((key) => key !== '' && !watched.seen.has(key))
  const same = read.data.input === inputDigest(input)
  return { handed, since: same ? read.data.since : null }
}
