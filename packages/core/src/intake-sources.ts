import type { IntakeGrantRead, IntakeMode } from './intake.ts'
import { type LookTrouble, TROUBLE_SAYS, type Watched } from './watch-looks.ts'

// Where each source of outside work stands: whether it is on, whether anything
// is looking with it, and what its last look came to.
//
// **The question this exists to answer is the one an empty list cannot.** An
// inbox with nothing in it has five completely different meanings — the
// surface is off, this source's grant is off, nothing is watching with it, it
// has been looked with and found nothing, or every look for the last two days
// has failed — and four of those are somebody at the machine's to fix. A page
// that drew them all as *nothing yet* is a page that says the factory is quiet
// while a connector has been answering `429` since Tuesday.
//
// **Nine states and not three**, for `inboxStateOf`'s reason: the collapsed
// version is unreadable in exactly the cases that matter. Each of the nine
// names one thing to do next, and `because` is Tade's own sentence about it.
//
// **The kind of trouble is read, never parsed.** `WatchLook.trouble` is
// recorded by the `catch` that held the error (`watch-looks.ts`), and
// `unreachable` / `rate-limited` / `refused` are three different things to do
// next — wait, wait until a moment the source itself named, go and look at a
// credential or a grant. A classifier over `problem` sentences would be a
// second answer that breaks the first time somebody rewords one.
//
// Pure: grants, watches and folds in, rows out. Every rule that needs the
// moment takes `now`.

/**
 * Where one source stands, as a person reads it.
 *
 * The order is off-to-working, and it is also the order the rules below are
 * asked in: the cheapest and most final first, because a source whose grant is
 * off has nothing a look could say about it.
 */
export const SOURCE_STATES = [
  /** Outside work is off altogether: nothing from any source becomes work here. */
  'off',
  /** The surface is on and this source's own grant does not accept. */
  'ungranted',
  /** Granted, and nothing looks with it: there is no watch schedule for it. */
  'unwatched',
  /** A watch exists and somebody paused it. */
  'paused',
  /** Watching, and it has never looked. */
  'unlooked',
  /** Its last look could not reach it at all. */
  'unreachable',
  /** Its last look was told a budget is spent. */
  'rate-limited',
  /** Its last look reached it and could not read it: a key, a permission, a 500. */
  'trouble',
  /** Its last look worked and there was nothing addressed to Tade. */
  'quiet',
  /** Its last look worked and found something. */
  'found',
] as const
export type SourceState = (typeof SOURCE_STATES)[number]

/** Which of them is somebody at this machine's to fix rather than to wait out. */
export const SOURCE_NEEDS_YOU: readonly SourceState[] = ['trouble', 'unreachable']

/** What a watch looking with one source is, as the caller already holds it. */
export interface SourceWatch {
  /** `<extension>.<id>`, which is what a schedule names and the journal keys by. */
  id: string
  /** The schedule it runs as, or the empty string where nothing runs it. */
  schedule: string
  /** How often it looks, as a schedule says it: `5m`, `1h`. */
  every: string
  /** Whether somebody paused that schedule. */
  paused: boolean
  /** What that watch has done, folded out of the journal (`watchedFrom`). */
  watched: Watched | null
}

/**
 * One source, as a surface draws it.
 *
 * Every field is either the owner's own grant or Tade's own record of a look.
 * **Nothing a stranger wrote is in it** — not a ticket title, not a channel
 * name, not a handle: what a source said is the inbox's, and this is about the
 * door rather than about what came through it.
 */
export interface SourceStanding {
  /** The source, by the name the config spells it: `cli`, `github`, `slack`, `linear`. */
  source: string
  /** The dotted config path of its grant, so what allowed something can be gone and removed. */
  grant: string
  state: SourceState
  /** Tade's own sentence about why it is in that state. */
  because: string
  /** What else a person would have to decide before this door does anything. */
  accept: boolean
  reply: boolean
  names: boolean
  mode: IntakeMode | null
  /** The published template its work is stamped from, or the empty string for one task. */
  template: string
  /** Which projects it may make work in. Empty is nowhere, and reads as nowhere. */
  projects: readonly string[]
  /** How many handles its grant lists. A count: a handle is the inbox's to show. */
  allowed: number
  /** The watch looking with it, where there is one. */
  watch: string
  /**
   * The schedule that runs that watch, or empty where nothing does.
   *
   * **Two fields and not one**, because a watch an extension offers and a
   * schedule somebody turned on are different facts: a source with a watch and
   * no schedule is `unwatched` — nothing looks with it — and a surface that
   * read only the watch's id would draw it as waiting for a look that is never
   * coming.
   */
  schedule: string
  every: string
  /** When it last looked, and when it last looked *and worked*. Two facts. */
  lookedAt: number | null
  workedAt: number | null
  /** What that last working look found, and how much of it waits for the next one. */
  found: number
  fresh: number
  left: number
  /** The kind of trouble the last look ran into, where it ran into one. */
  trouble: LookTrouble | null
  /** When a spent budget is clear again, as the source itself said. */
  until: number | null
  /** How many requests it has ever handed over, as the journal's own keys count them. */
  handed: number
}

/**
 * Where one source stands, from its grant and the watch looking with it.
 *
 * Nothing here reads a config or a journal: the caller has both and hands in
 * what it already folded. `now` is taken and not read, so the whole of this is
 * a function of its arguments.
 */
export function sourceStandingOf(req: {
  source: string
  grant: IntakeGrantRead
  watch: SourceWatch | null
}): SourceStanding {
  const { source, grant, watch } = req
  const watched = watch?.watched ?? null
  const looks = watched?.looks ?? []
  const last = looks[0] ?? null
  const worked = looks.find((look) => look.problem === null) ?? null
  const base = {
    source,
    grant: grant.path,
    accept: grant.accept,
    reply: grant.reply,
    names: grant.names,
    mode: grant.mode,
    template: grant.template,
    projects: [...grant.projects],
    allowed: grant.from.length,
    watch: watch?.id ?? '',
    schedule: watch?.schedule ?? '',
    every: watch?.every ?? '',
    lookedAt: last?.at ?? null,
    workedAt: worked?.at ?? null,
    found: worked?.found ?? 0,
    fresh: worked?.fresh ?? 0,
    left: worked?.left ?? 0,
    trouble: last?.trouble ?? null,
    until: last?.until ?? null,
    handed: watched?.seen.size ?? 0,
  }
  const { state, because } = stateOf(base, { on: grant.on, paused: watch?.paused === true, last })
  return { ...base, state, because }
}

/** What a look came to, as the state rules need it. */
type Last = { problem: string | null; trouble: LookTrouble | null; said: string | null } | null

/**
 * The state, and Tade's sentence about it.
 *
 * Asked cheapest-and-most-final first: a surface that is off says nothing
 * about a grant, a grant that does not accept says nothing about a watch, and
 * a watch nobody runs says nothing about a look. Reading them the other way
 * round is how a page comes to say *nothing found* about a door that is shut.
 */
function stateOf(
  one: Omit<SourceStanding, 'state' | 'because'>,
  how: { on: boolean; paused: boolean; last: Last },
): { state: SourceState; because: string } {
  if (!how.on) {
    return {
      state: 'off',
      because: 'work from outside this machine is off: nothing from any source becomes work here',
    }
  }
  if (!one.accept) {
    return {
      state: 'ungranted',
      because: `${one.grant}.accept is off, so nothing ${one.source} hands over is made`,
    }
  }
  if (one.projects.length === 0) {
    return {
      state: 'ungranted',
      because: `${one.grant}.projects lists no project, so there is nowhere for ${one.source}’s work to go`,
    }
  }
  if (one.watch === '' || one.schedule === '') {
    return {
      state: 'unwatched',
      because: `${one.source} is granted and nothing looks with it: its watch is off in Settings › Extensions`,
    }
  }
  if (how.paused) {
    return { state: 'paused', because: `the schedule that looks with ${one.source} is paused` }
  }
  const last = how.last
  if (last === null) {
    return {
      state: 'unlooked',
      because: `${one.source} has not been looked with yet: the next look is in at most ${one.every}`,
    }
  }
  if (last.problem !== null) {
    const kind = last.trouble
    const says = kind === null ? 'it could not be looked at' : TROUBLE_SAYS[kind]
    const until =
      kind === 'rate-limited' && one.until !== null ? ', and it said when that is over' : ''
    return {
      state:
        kind === 'unreachable'
          ? 'unreachable'
          : kind === 'rate-limited'
            ? 'rate-limited'
            : 'trouble',
      because: `the last look with ${one.source} did not work: ${says}${until} — ${last.problem}`,
    }
  }
  if (one.found === 0) {
    return {
      state: 'quiet',
      because: last.said
        ? `the last look with ${one.source} worked and found nothing: ${last.said}`
        : `the last look with ${one.source} worked and there was nothing addressed to Tade`,
    }
  }
  const waits = one.left > 0 ? `, ${one.left} waiting for the next look` : ''
  return {
    state: 'found',
    because: `the last look with ${one.source} found ${one.found}, ${one.fresh === 0 ? 'nothing new' : `${one.fresh} new`}${waits}`,
  }
}

/**
 * Every source, in the order `INTAKE_SOURCES` declares them.
 *
 * Declared order and not sorted by state: a list that reorders itself when a
 * connector has a bad minute is a list somebody has to re-read every time they
 * look at it, and which one is in trouble is said on the row.
 */
export function sourcesStanding(
  sources: readonly string[],
  of: (source: string) => { grant: IntakeGrantRead; watch: SourceWatch | null },
): SourceStanding[] {
  return sources.map((source) => sourceStandingOf({ source, ...of(source) }))
}

/**
 * What an empty inbox means, in the words of the reason it is empty.
 *
 * `inboxEmptySays`' argument carried the whole way: the reason a list is empty
 * is more useful than the emptiness, and here there are as many reasons as
 * there are sources. The answer names the most-final state among them, which
 * is the one thing to do next.
 */
export function nothingHandedSays(rows: readonly SourceStanding[]): string {
  if (rows.length === 0) return 'no source is implemented here'
  const worst = SOURCE_STATES.find((state) => rows.every((row) => row.state === state))
  if (worst !== undefined) return rows[0]?.because ?? ''
  const trouble = rows.find((row) => SOURCE_NEEDS_YOU.includes(row.state))
  if (trouble) return trouble.because
  const working = rows.filter((row) => row.state === 'quiet' || row.state === 'found')
  if (working.length > 0) {
    return `${working.length} ${working.length === 1 ? 'source is' : 'sources are'} being looked with and nothing has been handed over`
  }
  return rows.find((row) => row.state !== 'off')?.because ?? rows[0]?.because ?? ''
}
