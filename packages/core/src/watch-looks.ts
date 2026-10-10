import type { TadeEvent } from './events.ts'

// What a watch has done, folded out of the journal: its looks, what each one
// found, and what kind of trouble one ran into.
//
// **Out of `schedule.ts` because it is a different subject, and that file was
// at the length a file is allowed to be.** A schedule is *when* something
// runs; this is the record of the one kind of schedule that looks before it
// acts — and all of it is a fold over `watch_checked` and `watch_found`.
// Nothing is kept: the journal is the truth, and a second copy of it is a
// thing to get out of step with.
//
// Pure: events in, facts out. No clock reads, no I/O.

/**
 * What kind of trouble a look ran into, where it ran into one.
 *
 * **Four words, because a surface that drew them as one answers the wrong
 * question.** A source nobody can reach, a budget that is spent, a service
 * that was reached and said no, and anything else are four different things to
 * do next — wait, wait until a stated moment, go and look at a credential or a
 * grant, and read the sentence. A page with one word for them says *trouble*
 * and leaves somebody to read a sentence to find out which, which is what
 * `problem` already is.
 *
 * It is **recorded at the look** rather than read back out of `problem`, for
 * the reason nothing in Tade parses its own prose: the thing that knows is the
 * `catch` that holds the error, and a classifier over sentences is a second
 * answer that goes wrong the first time somebody rewords one.
 */
export const LOOK_TROUBLES = ['unreachable', 'rate-limited', 'refused', 'other'] as const
export type LookTrouble = (typeof LOOK_TROUBLES)[number]

/** Whether a word out of the journal is one of them. A line is a line somebody wrote. */
export function lookTroubleOf(value: unknown): LookTrouble | null {
  return typeof value === 'string' && (LOOK_TROUBLES as readonly string[]).includes(value)
    ? (value as LookTrouble)
    : null
}

/** One look a watch took, as the journal has it. */
export interface WatchLook {
  at: number
  found: number
  /** How many of those it had not found before. */
  fresh: number
  /** How many new ones wait for its next look, past the most one look acts on. */
  left: number
  /** Why it could not look; null when it did. */
  problem: string | null
  /**
   * Which kind of trouble that was, as the look itself said.
   *
   * Null where it looked, **and null where an older journal line holds a
   * problem and no kind** — which is `unknown` and is not `other`: a line
   * written before this field existed says nothing about which kind it was,
   * and reading it as *anything else* would be inventing the one answer that
   * tells somebody to stop looking for a cause.
   */
  trouble: LookTrouble | null
  /** When a spent budget is clear again, as the source itself said; null for no answer. */
  until: number | null
  /**
   * Why it found nothing, where the watch had something to say about that, and
   * never a problem: "nothing pushed yet" is a fact about a branch, not a
   * failure to look at one.
   */
  said: string | null
}

/** Something a watch found, and what became of it. */
export interface WatchFinding {
  at: number
  key: string
  title: string
  /** The work started on it; null when it was told instead, or could not start. */
  task: string | null
  /** Who was told about it instead of work starting. */
  told: string | null
  problem: string | null
}

/** What a watch has done: where its next look starts, what it has found, and its looks. */
export interface Watched {
  /** Where its next look starts, as its last look that worked said; null before one has. */
  since: string | null
  /** Every key it has found, so one finding never starts work twice. */
  seen: ReadonlySet<string>
  /** Newest first. */
  looks: WatchLook[]
  /** Newest first. */
  findings: WatchFinding[]
}

/** What a watch schedule has done, from the journal. Pure: events in, facts out. */
export function watchedFrom(events: readonly TadeEvent[], schedule: string): Watched {
  let since: string | null = null
  const seen = new Set<string>()
  const looks: WatchLook[] = []
  const findings: WatchFinding[] = []
  for (const event of events) {
    if (event.detail.schedule !== schedule) continue
    const at = Date.parse(event.ts)
    const text = (value: unknown) => (typeof value === 'string' && value !== '' ? value : null)
    const count = (value: unknown) => (typeof value === 'number' ? value : 0)
    if (event.type === 'watch_checked') {
      const problem = text(event.detail.problem)
      if (!problem && 'since' in event.detail) since = text(event.detail.since)
      const until = count(event.detail.until)
      looks.push({
        at,
        found: count(event.detail.found),
        fresh: Array.isArray(event.detail.fresh) ? event.detail.fresh.length : 0,
        left: count(event.detail.left),
        problem,
        // Only ever beside a problem: a look that worked and carried a kind
        // would be two answers to one question, and the one a surface reads
        // first is whichever it happened to check.
        trouble: problem ? lookTroubleOf(event.detail.trouble) : null,
        until: until > 0 ? until : null,
        said: text(event.detail.said),
      })
    } else if (event.type === 'watch_found') {
      const key = text(event.detail.key)
      if (!key) continue
      seen.add(key)
      findings.push({
        at,
        key,
        title: text(event.detail.title) ?? key,
        task: event.task,
        told: text(event.detail.told),
        problem: text(event.detail.problem),
      })
    }
  }
  return { since, seen, looks: looks.reverse(), findings: findings.reverse() }
}

/** How one look went, in a few words: `found 3, 2 new, 1 waits for the next look`, or why it could not look. */
export function describeLook(look: WatchLook): string {
  // The kind goes in front of the sentence rather than replacing it: the kind
  // is what a person decides on and the sentence is what they chase, and a
  // look written down before the kind existed has only the sentence — which is
  // `unknown`, and reads as the line it always did rather than as `other`.
  if (look.problem) {
    const kind = look.trouble === null ? '' : ` (${look.trouble})`
    return `could not look${kind}: ${look.problem}`
  }
  // A look that found nothing and a look that had nothing to find are not the
  // same answer, and this is where the second one gets to say so.
  if (look.found === 0) return look.said ? `found nothing: ${look.said}` : 'found nothing'
  const fresh = look.fresh === 0 ? 'nothing new' : `${look.fresh} new`
  const waits =
    look.left > 0 ? `, ${look.left} ${look.left === 1 ? 'waits' : 'wait'} for the next look` : ''
  return `found ${look.found}, ${fresh}${waits}`
}

/**
 * What in a look is new, and what of that is acted on now: the first `most`
 * of what was never found before, in the order the watch gave them. How many
 * more wait is said, so a look that leaves some can start its next look where
 * this one started, and find them again.
 */
export function newFindings<T extends { key: string }>(
  found: readonly T[],
  seen: ReadonlySet<string>,
  most: number,
): { fresh: T[]; acting: T[]; left: number } {
  const fresh = found.filter((one) => !seen.has(one.key))
  const acting = fresh.slice(0, Math.max(0, most))
  return { fresh, acting, left: fresh.length - acting.length }
}

/**
 * What kind of trouble the last look ran into, and when it may be over.
 *
 * `null` where the last look worked, **and `null` where there has never been
 * one** — which is `unknown` and is the answer a surface has to be able to
 * draw: a source nobody has looked with yet has found nothing and is not in
 * trouble, and collapsing the two is how a page tells somebody their
 * connector is broken on the day they turned it on.
 */
export function lastTrouble(
  watched: Watched,
): { trouble: LookTrouble | null; because: string; until: number | null } | null {
  const last = watched.looks[0]
  if (last === undefined || !last.problem) return null
  return { trouble: last.trouble, because: last.problem, until: last.until }
}

/** One word for a kind of trouble, in the words a surface says it in. */
export const TROUBLE_SAYS: Readonly<Record<LookTrouble, string>> = {
  unreachable: 'nothing came back from it at all',
  'rate-limited': 'it says a budget is spent',
  refused: 'it was reached and said no',
  other: 'it could not be looked at',
}
