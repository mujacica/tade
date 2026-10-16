import type { TadeEvent } from './events.ts'
import type { FindingFacts, LandingFacts, LandingFindings } from './landing.ts'
import type { TaskState, TestSignal } from './model.ts'
import type { Plan } from './plan.ts'
import { joined } from './queue.ts'
import { namedBy, type Reaches } from './reach.ts'

// A race: the same request given to several agents at once, each on its own
// harness or model and in a worktree of its own, and somebody choosing which
// one to keep (best-of-N, G4/F8).
//
// It lives nowhere new, exactly as an effort does. `TaskFile.race` is one
// optional field and a race is **the fold of the task files that name it** —
// made as an ordinary plan (`racePlan`), its entrants ordinary queued tasks the
// queue starts by its own rule, each running the project's checks and read by
// the judge like any other change. Removing one leaves the race correctly
// smaller; there is no table to fall out of step.
//
// **Nothing here picks.** The order the entrants are drawn in is the facts'
// (`raceOrder`): green checks at the head first, then whether the judge said
// the change did something other than what was asked, then findings nobody has
// settled, then finished, then the smaller change. A judge's answers move an
// entrant down and never crown one — a probability orders nothing, and the
// reason anybody is given is a sentence somebody wrote. Which one is kept is a
// person's press, or the orchestrator's when a line of the person's asks for
// that (`RACE_PICK`, checked in the window), and it is *told*: `race_won`, the
// one thing about a race nothing could derive again. The others are stopped
// and marked finished, and nothing removes their branches.
//
// Pure: facts in, answers out.

/** The fewest entrants a race has: one is a task. */
export const RACE_LEAST = 2

/**
 * The most. Every entrant is a whole agent's worth of somebody's money and a
 * worktree on their disk, so this is the cost bound — Kilo stops at four, and
 * past that the comparison stops being something a person reads.
 */
export const RACE_MOST = 4

/** The question whose answer says a change strayed from what it was asked for. */
export const STRAYED = 'did_what_was_asked'

const NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/

/** What one entrant runs on: a harness, a model its harness resolves, both, or neither. */
export interface RaceEntrant {
  harness?: string
  model?: string
}

/** What a race is started with. */
export interface RaceRequest {
  project: string
  /** Its slug: every entrant is `<name>-1`, `<name>-2`, … */
  name: string
  /** The request, verbatim: every entrant's `intent_spoken`. */
  said: string
  /** What every entrant is told, the same words to each. */
  prompt: string
  /** What the entrants run on, in order; fewer than `n` go round again. */
  entrants: readonly RaceEntrant[]
  /** How many entrants: the entrants given, or two, when unsaid. */
  n?: number
  /** What every entrant should know first, written beside each task file. */
  context?: string
}

/** The entrant at a place in the race, by its task name. */
export function racerName(race: string, place: number): string {
  return `${race}-${place}`
}

/**
 * The plan a race is: `n` agents told the same words, none waiting on another,
 * each on the entrant at its place — the entrants given going round again when
 * there are fewer of them than places. Refused whole, with every reason.
 */
export function racePlan(
  req: RaceRequest,
): { ok: true; plan: Plan } | { ok: false; problems: string[] } {
  const problems: string[] = []
  const n = req.n ?? Math.max(req.entrants.length, RACE_LEAST)
  if (!Number.isInteger(n) || n < RACE_LEAST || n > RACE_MOST) {
    problems.push(`a race has ${RACE_LEAST} to ${RACE_MOST} entrants, and ${n} was asked for`)
  }
  if (req.entrants.length > n) {
    problems.push(
      `${req.entrants.length} entrants were named for a race of ${n}: name as many as it has, or fewer`,
    )
  }
  if (!req.said.trim()) problems.push('say what was asked for, in their words')
  if (!req.prompt.trim()) problems.push('say what every entrant is told')
  if (problems.length > 0) return { ok: false, problems }
  const agents = Array.from({ length: n }, (_, at) => {
    const entrant = req.entrants.length > 0 ? req.entrants[at % req.entrants.length] : undefined
    return {
      name: racerName(req.name, at + 1),
      said: req.said,
      prompt: req.prompt,
      after: [],
      touches: [],
      ...(entrant?.harness ? { harness: entrant.harness } : {}),
      ...(entrant?.model ? { model: entrant.model } : {}),
    }
  })
  return {
    ok: true,
    plan: {
      project: req.project,
      said: req.said,
      race: req.name,
      ...(req.context?.trim() ? { context: req.context } : {}),
      agents,
    },
  }
}

/**
 * What refuses a plan as a race: `checkPlan` asks, so a race stamped out of a
 * template and one the orchestrator starts are held to one rule.
 */
export function raceProblems(plan: Plan): string[] {
  const problems: string[] = []
  const race = plan.race ?? ''
  if (!NAME.test(race)) {
    problems.push(`"${race}" is not a name for a race: lowercase letters, digits, - . _`)
  }
  const n = plan.agents.length
  if (n < RACE_LEAST || n > RACE_MOST) {
    problems.push(`a race has ${RACE_LEAST} to ${RACE_MOST} entrants, and this one has ${n}`)
  }
  const elsewhere = plan.agents.filter((one) => one.project && one.project !== plan.project)
  if (elsewhere.length > 0) {
    problems.push(
      `a race is run in one repository, and ${joined(elsewhere.map((one) => one.name))} would work in another`,
    )
  }
  const waiting = plan.agents.filter((one) => one.after.length > 0)
  if (waiting.length > 0) {
    problems.push(
      `a race's entrants run side by side, and ${joined(waiting.map((one) => one.name))} would wait on something`,
    )
  }
  const told = new Set(plan.agents.map((one) => one.prompt.trim()))
  const asked = new Set(plan.agents.map((one) => one.said.trim()))
  if (told.size > 1 || asked.size > 1) {
    problems.push('every entrant in a race is asked the same thing in the same words')
  }
  return problems
}

/**
 * How far the orchestrator reaches into picking a race's winner.
 *
 * `asked`: picking stops every other entrant and marks it finished, so it is
 * the person's — and the orchestrator's only when a line of theirs, said since
 * the race began, asks for a pick (`pickNamedBy`). Checked in the window, never
 * in the tool, for the reason every such rule is: a rule where the model lives
 * is one the model can be talked out of. Nothing is lost either way — every
 * branch is kept — so it is not `never`.
 */
export const RACE_PICK: Reaches = {
  reach: 'asked',
  because: 'picking a race stops the other entrants, so I pick one only when they ask me to',
}

/** The line of theirs that asks for a race to be picked, or null when none does. */
export function pickNamedBy(lines: readonly string[]): string | null {
  return namedBy(
    { path: 'pick', title: 'winner', keywords: ['picks', 'choose', 'apply', 'go with'] },
    lines,
  )
}

/** A race decided, as `race_won` says it. */
export interface RaceWon {
  race: string
  project: string
  task: string
  /** `you`, or `orchestrator` on a line of the person's. */
  by: string
  /** The sentence whoever picked gave, verbatim. */
  why: string
  at: string
  /** The entrants stopped and marked finished, their branches kept. */
  closed: readonly string[]
}

/** The key a race is known by: one project's name for it. */
export function raceKey(project: string, race: string): string {
  return `${project}/${race}`
}

/**
 * Every race decided, by `raceKey`, out of the journal. The first decision
 * stands: a race is decided once, and the window refuses a second.
 */
export function wonFrom(events: readonly TadeEvent[]): Map<string, RaceWon> {
  const out = new Map<string, RaceWon>()
  for (const event of events) {
    if (event.type !== 'race_won') continue
    const d = event.detail
    if (typeof d.race !== 'string' || typeof d.project !== 'string') continue
    const task = typeof d.task === 'string' ? d.task : event.task
    if (typeof task !== 'string') continue
    const key = raceKey(d.project, d.race)
    if (out.has(key)) continue
    out.set(key, {
      race: d.race,
      project: d.project,
      task,
      by: typeof d.by === 'string' ? d.by : 'you',
      why: typeof d.why === 'string' ? d.why : '',
      at: event.ts,
      closed: Array.isArray(d.closed)
        ? d.closed.filter((one): one is string => typeof one === 'string')
        : [],
    })
  }
  return out
}

/** One finding, as much of it as a race reads: the landing desk's, and which question raised it. */
export interface RaceFinding extends FindingFacts {
  question: string
}

/**
 * Whether the judge says this change did something other than what was asked:
 * a finding of that question still raised and not judged a false positive.
 * Null where no judge reads anything here — never `false`, which would say
 * somebody read it and found it kept to what was asked.
 */
export function strayedIn(findings: readonly RaceFinding[] | null, task: string): boolean | null {
  if (findings === null) return null
  return findings.some(
    (one) =>
      one.question === STRAYED &&
      one.tasks.includes(task) &&
      one.stillThere &&
      one.verdict?.was !== 'false positive',
  )
}

/** What a race reads of one entrant, every field a query somebody answered. */
export interface RacerFacts {
  task: string
  race: string
  project: string
  /** What it was asked, verbatim. */
  said: string
  /** The harness it runs in, as its task file or its project's route says. */
  harness: string
  /** The model it was started on, where one was named for it. */
  model: string | null
  /** When its task was made: the race began with its first entrant. */
  created: string
  state: TaskState
  /** The journal says it is finished (`task_done`). */
  finished: boolean
  /** The required checks rolled up at its head, or null where nothing has looked. */
  checks: TestSignal | null
  failed: readonly string[]
  /** What became of the judge's findings, or null where they could not be read. */
  findings: LandingFindings | null
  /** `strayedIn`. */
  strayed: boolean | null
  /** What its own commits changed, or null where nothing has looked. */
  size: LandingFacts['size']
  /** What it has cost over every run, or null where nothing recorded money. */
  usd: number | null
}

/** One entrant, placed. */
export interface Racer {
  facts: RacerFacts
  /** Where the facts put it, from 1: an order to read in, never a verdict. */
  place: number
  won: boolean
  /** Stopped and marked finished when another was picked; its branch is kept. */
  closed: boolean
}

export interface Race {
  name: string
  project: string
  said: string
  /** When its first entrant was made. */
  began: string
  racers: Racer[]
  won: RaceWon | null
  /** How many entrants the journal says are finished. */
  finished: number
  /**
   * What it has cost so far: the sum of what every entrant recorded, `atLeast`
   * where one recorded nothing, null where none did — never a nought.
   */
  usd: { sum: number | null; atLeast: boolean }
}

/** Lower is better: green, then nothing looked at or nothing run, then red. */
function checksRank(checks: TestSignal | null): number {
  return checks === 'pass' ? 0 : checks === 'fail' ? 2 : 1
}

/** Lower is better: kept to what was asked, then nobody could say, then strayed. */
function strayedRank(strayed: boolean | null): number {
  return strayed === false ? 0 : strayed === null ? 1 : 2
}

/** Findings nobody has settled: open, answered and not judged, confirmed. */
function unsettled(findings: LandingFindings | null): number | null {
  return findings === null ? null : findings.open + findings.answered + findings.confirmed
}

/** How many lines its own commits changed, or null where nothing could say. */
function linesIn(size: LandingFacts['size']): number | null {
  if (!size || size.added === null || size.removed === null) return null
  return size.added + size.removed
}

/** Smaller first, and what nothing could say after everything that could. */
function knownFirst(a: number | null, b: number | null): number {
  if (a === null || b === null) return a === b ? 0 : a === null ? 1 : -1
  return a - b
}

/**
 * The entrants in the order the facts put them. Each key is read only where
 * every one before it ties, and anything still tied goes by name, so two looks
 * that found the same thing draw the same order.
 */
export function raceOrder<T extends RacerFacts>(racers: readonly T[]): T[] {
  return [...racers].sort(
    (a, b) =>
      checksRank(a.checks) - checksRank(b.checks) ||
      strayedRank(a.strayed) - strayedRank(b.strayed) ||
      knownFirst(unsettled(a.findings), unsettled(b.findings)) ||
      Number(b.finished) - Number(a.finished) ||
      knownFirst(linesIn(a.size), linesIn(b.size)) ||
      (a.task < b.task ? -1 : a.task > b.task ? 1 : 0),
  )
}

/**
 * Every race among these entrants: grouped by project and name, each in the
 * order the facts put it, with what was decided and what it cost. Undecided
 * races first, then the newest.
 */
export function racesIn(
  racers: readonly RacerFacts[],
  won: ReadonlyMap<string, RaceWon> = new Map(),
): Race[] {
  const by = new Map<string, RacerFacts[]>()
  for (const one of racers) {
    const key = raceKey(one.project, one.race)
    by.set(key, [...(by.get(key) ?? []), one])
  }
  const races: Race[] = []
  for (const [key, entrants] of by) {
    const decided = won.get(key) ?? null
    const ordered = raceOrder(entrants)
    const first = ordered[0]
    if (!first) continue
    const known = entrants.filter((one) => one.usd !== null)
    races.push({
      name: first.race,
      project: first.project,
      said: first.said,
      began: entrants.map((one) => one.created).sort()[0] ?? '',
      racers: ordered.map((facts, at) => ({
        facts,
        place: at + 1,
        won: decided?.task === facts.task,
        closed: decided !== null && decided.task !== facts.task,
      })),
      won: decided,
      finished: entrants.filter((one) => one.finished).length,
      usd: {
        sum: known.length === 0 ? null : known.reduce((sum, one) => sum + (one.usd ?? 0), 0),
        atLeast: known.length > 0 && known.length < entrants.length,
      },
    })
  }
  return races.sort(
    (a, b) =>
      Number(a.won !== null) - Number(b.won !== null) ||
      (a.began < b.began ? 1 : a.began > b.began ? -1 : 0),
  )
}

/** What an entrant runs on, in a few words: `claude · sonnet`. */
export function racerRunsOn(facts: Pick<RacerFacts, 'harness' | 'model'>): string {
  return facts.model ? `${facts.harness} · ${facts.model}` : facts.harness
}

/**
 * Every fact about one entrant, as words, in the order the race reads them —
 * what the window, a phone and the orchestrator all say, so none of them says
 * a figure the others would not. What nothing could say is said as that.
 */
export function racerSays(facts: RacerFacts): string[] {
  const checks =
    facts.checks === 'pass'
      ? 'checks green'
      : facts.checks === 'fail'
        ? `checks red${facts.failed.length > 0 ? ` (${joined([...facts.failed])})` : ''}`
        : facts.checks === 'unknown'
          ? 'checks not run at its head'
          : 'checks not looked at yet'
  const strayed =
    facts.strayed === null
      ? 'no judge reads it'
      : facts.strayed
        ? 'the judge says it did something other than what was asked'
        : 'the judge raised nothing about what was asked'
  const open = unsettled(facts.findings)
  const findings =
    open === null
      ? 'findings not read'
      : open === 0
        ? 'no findings open'
        : `${open} finding${open === 1 ? '' : 's'} open`
  const lines =
    facts.size && facts.size.added !== null && facts.size.removed !== null
      ? `+${facts.size.added} −${facts.size.removed}`
      : facts.size
        ? 'size cannot be counted'
        : 'nothing looked at its commits yet'
  return [facts.finished ? 'finished' : facts.state, checks, strayed, findings, lines]
}

/** Money as a person reads it: `$0.41`, and `—` for none recorded. */
export function raceDollars(usd: number | null): string {
  return usd === null ? '—' : `$${usd.toFixed(2)}`
}

/** What a race has cost so far, in a clause: `$1.23 so far`, `≥ $0.80 so far`, `no money recorded`. */
export function raceSpentSays(race: Pick<Race, 'usd'>): string {
  if (race.usd.sum === null) return 'no money recorded'
  return `${race.usd.atLeast ? '≥ ' : ''}${raceDollars(race.usd.sum)} so far`
}

/**
 * Where a race stands, as lines a person or a model reads: the request, each
 * entrant placed with its facts, what it cost, and who decided — or that
 * nobody has, and who may.
 */
export function raceStandingSays(race: Race): string[] {
  const lines = [
    `Race ${race.name} in ${race.project}: ${race.racers.length} entrants, ${race.finished} finished, ${raceSpentSays(race)}.`,
    `Asked: ${race.said}`,
  ]
  for (const racer of race.racers) {
    const mark = racer.won ? ' — picked' : racer.closed ? ' — closed, branch kept' : ''
    lines.push(
      `  ${racer.place}. ${racer.facts.task} (${racerRunsOn(racer.facts)}, ${raceDollars(racer.facts.usd)})${mark}: ${racerSays(racer.facts).join(' · ')}`,
    )
  }
  lines.push(
    race.won
      ? `Picked ${race.won.task} (${race.won.by === 'orchestrator' ? 'by the orchestrator, on their word' : 'by them'}): ${race.won.why}`
      : 'Nobody has picked. The order is the facts’, not a pick: checks at its head, whether the judge said it did something other than what was asked, findings open, finished, then the smaller change.',
  )
  return lines
}
