import type { Conflict, ReviewState, TaskState, TestSignal } from './model.ts'

// The landing desk: every piece of finished work, and every review still open,
// in the order it is cheapest to trust.
//
// A view and nothing else. Every fact it reads somebody else already derived —
// the state (`deriveState`), the checks rolled up at the head (the rollup), the
// judge's findings with the agent's accounts and the verdicts, the conflict
// forecast, what the commits touched, what was spent — and nothing here is
// remembered, so there is no desk to fall out of step with the work.
//
// **The order is whose move it is.** First what can be landed with the least
// reading: green, nothing open, nothing waiting on anybody, smallest first.
// Then what waits on the person — an answer, a verdict, a check nobody ran, a
// draft — each with the one sentence saying why. Then what waits on its agent:
// still working, a red check, a finding nobody answered, a collision. A row is
// in the last tier any of its reasons puts it in, because a change whose agent
// still has to move is not the person's to read yet, whatever else it waits on.
//
// **A judge only ever adds caution here.** A finding can keep a change off the
// top of the desk and never put one on it, and a probability orders nothing:
// what is counted is findings, by what became of them.

/** Whose move it is: nobody's but landing it, the person's, or its agent's. */
export const LANDING_TIERS = ['ready', 'yours', 'theirs'] as const
export type LandingTier = (typeof LANDING_TIERS)[number]

/** A heading for each tier, said the same way in the window and on a phone. */
export const LANDING_SAID: Readonly<Record<LandingTier, string>> = {
  ready: 'ready to land',
  yours: 'waiting on you',
  theirs: 'waiting on its agent',
}

/**
 * What became of the findings about one change: none of them a probability.
 *
 * `open` nobody has answered; `answered` its agent accounted for and nobody
 * has judged; `confirmed` somebody judged real and the newest reading still
 * raises; `dismissed` somebody judged a false positive. A finding a later
 * reading no longer raises, and nobody judged, is in none of them: it went.
 */
export interface LandingFindings {
  open: number
  answered: number
  confirmed: number
  dismissed: number
}

/** One finding, as much of it as the desk reads. */
export interface FindingFacts {
  tasks: readonly string[]
  stillThere: boolean
  account: { did: string } | null
  verdict: { was: 'confirmed' | 'false positive' } | null
}

/** One collision the forecast found: the other task, or null for its own base. */
export interface LandingConflict {
  with: string | null
  files: number
}

/** What the desk reads of one piece of work, every field a query somebody answered. */
export interface LandingFacts {
  task: string
  state: TaskState
  /** The journal says it is finished (`task_done`). */
  finished: boolean
  /** Its agent asked something, or waits on an approval. */
  wantsYou: boolean
  /** The review it is out for, by its forge's neutral word. */
  review: ReviewState | null
  /** The required checks rolled up at its head, or null where nothing has looked. */
  checks: TestSignal | null
  /** The required checks that failed at its head, by name. */
  failed: readonly string[]
  /** The required checks that never ran at its head, by name. */
  missing: readonly string[]
  /** What became of the judge's findings, or null where they could not be read. */
  findings: LandingFindings | null
  /** What the forecast found, or null where nobody looked. */
  conflicts: readonly LandingConflict[] | null
  /**
   * What its own commits — the ones whose trailer names it — changed, or null
   * where nothing has looked at them yet. A count git could not give is null.
   */
  size: { commits: number; added: number | null; removed: number | null } | null
  /** Since anything about it last moved. */
  waitingSince: number | null
}

/** Why one piece of work is where it is on the desk. */
export interface Landing {
  tier: LandingTier
  /**
   * The one sentence saying why, for anything that is not ready; null for
   * what is, whose figures say it.
   */
  why: string | null
  /** How many more reasons stand behind that one. */
  also: number
}

/**
 * Whether a piece of work belongs on the desk: finished, stopped for review,
 * or out for a review that is still open. Queued, parked, merged and failed
 * work is somewhere else's to show.
 */
export function onTheDesk(facts: {
  state: TaskState
  finished: boolean
  review: ReviewState | null
}): boolean {
  if (facts.state === 'merged' || facts.state === 'queued' || facts.state === 'parked') {
    return false
  }
  if (facts.review === 'merged' || facts.review === 'closed') return false
  if (facts.review === 'open' || facts.review === 'draft') return true
  return facts.finished || facts.state === 'review'
}

/** What became of the findings about one task (`LandingFindings`). */
export function findingsFor(findings: readonly FindingFacts[], task: string): LandingFindings {
  const out: LandingFindings = { open: 0, answered: 0, confirmed: 0, dismissed: 0 }
  for (const one of findings) {
    if (!one.tasks.includes(task)) continue
    if (one.verdict?.was === 'false positive') out.dismissed++
    else if (one.verdict?.was === 'confirmed') {
      if (one.stillThere) out.confirmed++
    } else if (!one.stillThere) continue
    else if (one.account !== null) out.answered++
    else out.open++
  }
  return out
}

/**
 * What the forecast found about one task: each collision with the other side
 * named, or its base for a branch that no longer merges. Null where nobody
 * looked, which is not the same as nothing found.
 */
export function conflictsFor(
  conflicts: readonly Conflict[] | undefined,
  task: string,
): LandingConflict[] | null {
  if (conflicts === undefined) return null
  return conflicts
    .filter((one) => one.tasks.includes(task))
    .map((one) => ({
      with: one.kind === 'base' ? null : (one.tasks.find((other) => other !== task) ?? null),
      files: one.files.length,
    }))
}

/** One commit, as git's `--shortstat` counted it: `files` null where it printed no stat line. */
interface Counted {
  files: number | null
  added: number | null
  removed: number | null
}

/**
 * What a task's own commits changed, added up; null where nothing looked at
 * them. A commit git printed a stat line for and that line left a half out of
 * changed none of that half — git writes no `0 deletions(-)` — while a commit
 * with no stat line at all, a merge, is one nobody can count.
 */
export function sizeOf(mine: readonly Counted[] | null): LandingFacts['size'] {
  if (mine === null) return null
  const sum = (pick: (one: Counted) => number | null): number | null =>
    mine.reduce<number | null>((total, one) => {
      const n = one.files === null ? null : (pick(one) ?? 0)
      return total === null || n === null ? null : total + n
    }, 0)
  return {
    commits: mine.length,
    added: sum((one) => one.added),
    removed: sum((one) => one.removed),
  }
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`

/** A list of names as a person says it, the first two and how many more. */
function named(names: readonly string[]): string {
  if (names.length <= 2) return names.join(' and ')
  return `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`
}

/** The name a task goes by on a row: the half after the project. */
function shortName(task: string): string {
  return task.split('/')[1] ?? task
}

/**
 * Where one piece of work stands on the desk, and the sentence saying why.
 *
 * Every reason is read in a fixed order inside its tier, so the sentence is the
 * one that matters most to whoever moves next.
 */
export function landingOf(facts: LandingFacts): Landing {
  const yours: string[] = []
  const theirs: string[] = []

  if (facts.wantsYou) yours.push('its agent is waiting on your answer')
  if (facts.findings && facts.findings.answered > 0) {
    yours.push(
      `its agent answered ${plural(facts.findings.answered, 'finding')}, and ${facts.findings.answered === 1 ? 'it waits' : 'they wait'} on your verdict`,
    )
  }
  if (facts.checks === null) yours.push('nothing has looked at its checks yet')
  else if (facts.checks === 'unknown') {
    yours.push(
      facts.missing.length > 0
        ? `${named(facts.missing)} ${facts.missing.length === 1 ? 'has' : 'have'} not run at its head`
        : 'no required check has run at its head',
    )
  }
  if (facts.review === 'draft') yours.push('its review is still a draft')

  if (!facts.finished && (facts.state === 'working' || facts.state === 'blocked')) {
    if (!facts.wantsYou) theirs.push('its agent is still working')
  }
  if (facts.checks === 'fail') {
    theirs.push(
      facts.failed.length > 0
        ? `${named(facts.failed)} failed at its head`
        : 'a required check failed at its head',
    )
  }
  if (facts.findings && facts.findings.confirmed > 0) {
    theirs.push(`${plural(facts.findings.confirmed, 'confirmed finding')} still in it`)
  }
  if (facts.findings && facts.findings.open > 0) {
    theirs.push(`${plural(facts.findings.open, 'finding')} nobody has answered`)
  }
  for (const one of facts.conflicts ?? []) {
    theirs.push(
      one.with === null
        ? `it no longer merges into its base cleanly (${plural(one.files, 'file')})`
        : `it would conflict with ${shortName(one.with)} in ${plural(one.files, 'file')}`,
    )
  }

  if (theirs.length > 0) {
    return { tier: 'theirs', why: theirs[0] ?? null, also: theirs.length - 1 + yours.length }
  }
  if (yours.length > 0) return { tier: 'yours', why: yours[0] ?? null, also: yours.length - 1 }
  return { tier: 'ready', why: null, also: 0 }
}

/** How many lines its own commits changed, or null where nothing could say. */
export function linesOf(size: LandingFacts['size']): number | null {
  if (!size || size.added === null || size.removed === null) return null
  return size.added + size.removed
}

/**
 * The desk in order: ready first, then the person's, then the agents'. What is
 * ready goes smallest first — the least reading — and inside the other two the
 * longest waiting goes first. Anything still tied goes by name, so the order
 * never shuffles between two looks that found the same thing.
 */
export function deskOrder<T extends { facts: LandingFacts; landing: Landing }>(
  rows: readonly T[],
): T[] {
  const tier = (row: T): number => LANDING_TIERS.indexOf(row.landing.tier)
  return [...rows].sort((a, b) => {
    const byTier = tier(a) - tier(b)
    if (byTier !== 0) return byTier
    if (a.landing.tier === 'ready') {
      const bySize = knownFirst(linesOf(a.facts.size), linesOf(b.facts.size))
      if (bySize !== 0) return bySize
    }
    const byWait = knownFirst(a.facts.waitingSince, b.facts.waitingSince)
    if (byWait !== 0) return byWait
    return a.facts.task < b.facts.task ? -1 : a.facts.task > b.facts.task ? 1 : 0
  })
}

/** Smaller first, and what nothing could say after everything that could. */
function knownFirst(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  return a - b
}

/** Every piece of work on the desk, placed and in order. */
export function landingDesk(
  facts: readonly LandingFacts[],
): { facts: LandingFacts; landing: Landing }[] {
  return deskOrder(facts.map((one) => ({ facts: one, landing: landingOf(one) })))
}

/**
 * The desk in one clause, for the brief and a heading: `2 ready to land, 1
 * waiting on you`. Null where nothing is on it.
 */
export function deskSays(landings: readonly { tier: LandingTier }[]): string | null {
  if (landings.length === 0) return null
  const parts = LANDING_TIERS.map((tier) => {
    const n = landings.filter((one) => one.tier === tier).length
    return n > 0 ? `${n} ${LANDING_SAID[tier]}` : null
  }).filter((part): part is string => part !== null)
  return parts.join(', ')
}
