import type { TadeEvent } from './events.ts'
import type { TaskState, TestSignal } from './model.ts'
import type { Plan } from './plan.ts'
import { joined } from './queue.ts'
import { namedBy, type Reaches } from './reach.ts'

// A replay: your own landed work, asked for again on a candidate model or
// harness, and scored against what actually landed (B2, "your own eval").
//
// Tade already keeps a golden set without meaning to: the person's words
// verbatim (`intent_spoken`), the commit each task began from (`base`), the
// project's own checks, the trailer that says whose each commit was, and what
// every task cost. A replay takes the last few tasks that landed in a project,
// starts each again in a worktree **at its own base**, told **its own words**,
// on the candidate — and reads the result with the same instruments the
// original was read with: the checks at its head, the original change's tests
// laid over it (`replay_graded`), whether the judge says it did what was asked,
// how big it is beside the original, and what it cost and took.
//
// It lives nowhere new, exactly as a race does: a replay is a plan made of
// queued tasks the queue starts by its own rule, and **the fold of what the
// journal says about it** — `replay_started` (what was asked, on what, with
// which ceiling, and which cases could not be replayed before anything ran),
// `replay_graded` (one entrant's grading run), `replay_stopped` (the ceiling
// reached). Nothing is kept in a table.
//
// **It varies one thing.** A candidate is a model — each task on the harness
// it first ran on, or only the tasks that ran on the harness named beside it —
// or a harness alone, on that harness's own route. Never a model *and* a
// harness both moved at once: a harness change confounds a model comparison
// (Kiro, 2026-08-26), so the one that is named is the one that moves.
//
// **"Could not replay" is never a fail.** Words that were an answer to a
// conversation the replay does not have ("yes, do that") cannot be asked
// again, and an agent that stops without changing anything is what such words
// look like from the outside. Both are said as what they are and counted apart,
// so a model is never scored down for a question nobody could have answered.
//
// Pure: facts in, answers out.

/** How many landed tasks a replay takes when nobody says. */
export const REPLAY_LAST = 5

/** The most: each case is a whole agent's worth of somebody's money. */
export const REPLAY_MOST = 20

/** How many entrants run at once when nobody says: the ceiling is looked at between them. */
export const REPLAY_AT_ONCE = 2

/** The most at once: past this the ceiling is looked at too late to hold anything. */
export const REPLAY_AT_ONCE_MOST = 4

/**
 * Fewer words than this cannot stand on their own. Counted, never judged: a
 * request this short was an answer to something the replay does not have.
 */
export const WORDS_LEAST = 4

const NAME = /^[a-z0-9][a-z0-9._-]{0,47}$/

/** What a replay runs on: a model, a harness, or a model held on one harness. */
export interface ReplayCandidate {
  harness?: string
  model?: string
}

/** What is being varied, in a few words: `sonnet on each task's own harness`. */
export function candidateSays(candidate: ReplayCandidate): string {
  if (candidate.model && candidate.harness) {
    return `${candidate.model}, held on ${candidate.harness}`
  }
  if (candidate.model) return `${candidate.model} on each task’s own harness`
  if (candidate.harness) return `${candidate.harness} on its own route`
  return 'nothing named'
}

/** Why this is not something to replay on, or null. */
export function candidateProblem(candidate: ReplayCandidate): string | null {
  if (!candidate.model && !candidate.harness) {
    return 'name what to replay on: a model (each task on its own harness, or only the tasks of the harness named beside it), or a harness alone'
  }
  return null
}

/** One task that landed, as a replay reads it: everything it is asked again with and scored against. */
export interface ReplayCase {
  task: string
  project: string
  /** Its words, verbatim. */
  said: string
  /** The commit it began from, or null where nothing recorded one. */
  base: string | null
  /** Whether that commit is still in the repository. */
  baseThere: boolean
  /** What its first run was on. */
  harness: string
  model: string
  /** When it was finished, as the journal says. */
  done: number
  /** What it was given to read first, where it was given anything. */
  context: string | null
  /** What it cost over every run, or null where nothing recorded money. */
  usd: number | null
  /** How long its agent worked, or null where no run could say. */
  workedMs: number | null
  /** What its own commits changed, or null where none was seen. */
  size: { added: number; removed: number } | null
  /** The test files its own commits touched: laid over the replay's work when it is graded. */
  tests: readonly string[]
  /** Its newest own commit, which the tests are taken from. */
  head: string | null
}

/** Why a case cannot be asked again, or null. Counted and looked up, never guessed. */
export function caseProblem(one: ReplayCase): string | null {
  const said = one.said.trim()
  if (!said) return 'its words were not written down'
  const words = said.split(/\s+/).length
  if (words < WORDS_LEAST) {
    return `its words — “${said}” — are too few to stand on their own: they answered a conversation the replay does not have`
  }
  if (!one.base) return 'nothing recorded which commit it began from'
  if (!one.baseThere)
    return `the commit it began from (${one.base.slice(0, 7)}) is not in the repository any more`
  return null
}

/**
 * The cases a replay on this candidate takes: newest landed first, only the
 * harness held where one is named beside a model, at most `last`.
 */
export function casesFor(
  cases: readonly ReplayCase[],
  candidate: ReplayCandidate,
  last: number,
): ReplayCase[] {
  const held = candidate.model && candidate.harness ? candidate.harness : null
  return cases
    .filter((one) => held === null || one.harness === held)
    .sort((a, b) => b.done - a.done || (a.task < b.task ? -1 : 1))
    .slice(0, Math.max(0, last))
}

/** What a replay is started with. */
export interface ReplayRequest {
  project: string
  /** Its slug: every entrant is `<name>-1`, `<name>-2`, … */
  name: string
  /** What the person said asking for it, verbatim. */
  said: string
  candidate: ReplayCandidate
  /** The cases, newest first, as `casesFor` chose them. */
  cases: readonly ReplayCase[]
  /** The most it may cost, in billed dollars. */
  ceilingUsd: number
  /** Not before this moment, as an ISO time: a replay at night is a replay that waits. */
  at?: string
  /** How many run at once. */
  atOnce?: number
}

/**
 * One case, as the replay started it: its entrant, or why there is none — and
 * the original's own figures as they stood, so what the replay is read beside
 * never has to be looked up again (and cannot drift if the original's task goes).
 */
export interface CaseStarted {
  of: string
  task: string | null
  couldNot: string | null
  original: ReplayCase | null
}

/** The entrant at a place in a replay, by its task name. */
export function replayerName(replay: string, place: number): string {
  return `${replay}-${place}`
}

/**
 * The plan a replay is: one agent per case that can be asked again, each told
 * that case's own words, beginning at its own base, on the candidate — and
 * `atOnce` at a time, each waiting on the one `atOnce` places before it, so
 * the queue starts them by its own rule and the ceiling is looked at between
 * them. Refused whole, with every reason.
 */
export function replayPlan(
  req: ReplayRequest,
): { ok: true; plan: Plan; cases: CaseStarted[] } | { ok: false; problems: string[] } {
  const problems: string[] = []
  if (!NAME.test(req.name)) {
    problems.push(`"${req.name}" is not a name for a replay: lowercase letters, digits, - . _`)
  }
  const candidate = candidateProblem(req.candidate)
  if (candidate) problems.push(candidate)
  if (!req.said.trim()) problems.push('say what was asked for, in their words')
  if (!Number.isFinite(req.ceilingUsd) || req.ceilingUsd <= 0) {
    problems.push('a replay costs money, so it needs a ceiling: the most it may spend, in dollars')
  }
  if (req.at !== undefined && Number.isNaN(Date.parse(req.at))) {
    problems.push(`"${req.at}" is not a time to start at`)
  }
  const atOnce = req.atOnce ?? REPLAY_AT_ONCE
  if (!Number.isInteger(atOnce) || atOnce < 1 || atOnce > REPLAY_AT_ONCE_MOST) {
    problems.push(`a replay runs 1 to ${REPLAY_AT_ONCE_MOST} at once, and ${atOnce} was asked for`)
  }
  if (req.cases.length > REPLAY_MOST) {
    problems.push(
      `a replay takes at most ${REPLAY_MOST} tasks, and ${req.cases.length} were asked for`,
    )
  }
  if (req.cases.length === 0) {
    problems.push(`nothing has landed in ${req.project} on that to replay`)
  }
  const cases: CaseStarted[] = []
  const agents: Plan['agents'] = []
  for (const one of req.cases) {
    const couldNot =
      caseProblem(one) ??
      (!req.candidate.harness && !one.harness
        ? 'which harness it first ran on was not recorded, so there is nothing to hold fixed'
        : null)
    if (couldNot) {
      cases.push({ of: one.task, task: null, couldNot, original: one })
      continue
    }
    const name = replayerName(req.name, agents.length + 1)
    const before = agents[agents.length - atOnce]
    cases.push({ of: one.task, task: `${req.project}/${name}`, couldNot: null, original: one })
    agents.push({
      name,
      said: one.said,
      // Its own words and nothing else: the replay is a question about what
      // those words get done, so nothing is added to them.
      prompt: one.said,
      after: before
        ? [
            {
              agent: before.name,
              why: `a replay runs ${atOnce} at a time, so its ceiling is looked at between them`,
            },
          ]
        : [],
      touches: [],
      done: 'committed',
      from: one.base ?? '',
      harness: req.candidate.harness && !req.candidate.model ? req.candidate.harness : one.harness,
      ...(req.candidate.model ? { model: req.candidate.model } : {}),
      ...(one.context ? { context: one.context } : {}),
      ...(req.at ? { at: req.at } : {}),
    })
  }
  if (req.cases.length > 0 && agents.length === 0) {
    problems.push(
      `none of the ${req.cases.length} could be replayed: ${joined(cases.map((one) => `${one.of} (${one.couldNot})`))}`,
    )
  }
  if (problems.length > 0) return { ok: false, problems }
  return {
    ok: true,
    cases,
    plan: { project: req.project, said: req.said, replay: req.name, agents },
  }
}

/** What the plan path refuses about a replay: one repository, nothing waiting outside it. */
export function replayProblems(plan: Plan): string[] {
  const problems: string[] = []
  const replay = plan.replay ?? ''
  if (!NAME.test(replay)) {
    problems.push(`"${replay}" is not a name for a replay: lowercase letters, digits, - . _`)
  }
  if (plan.race !== undefined) problems.push('a plan is a race or a replay, not both')
  const elsewhere = plan.agents.filter((one) => one.project && one.project !== plan.project)
  if (elsewhere.length > 0) {
    problems.push(
      `a replay is run in one repository, and ${joined(elsewhere.map((one) => one.name))} would work in another`,
    )
  }
  const nowhere = plan.agents.filter((one) => !one.from)
  if (nowhere.length > 0) {
    problems.push(
      `every replayed task begins where the original did, and ${joined(nowhere.map((one) => one.name))} says nowhere`,
    )
  }
  return problems
}

/**
 * How far the orchestrator reaches into starting one: `asked`. A replay
 * spends real money on work that has already landed, so it is the person's —
 * and the orchestrator's only when a line of theirs asks for an eval
 * (`replayNamedBy`), checked in the window against the journal and never in
 * the tool.
 */
export const REPLAY_START: Reaches = {
  reach: 'asked',
  because:
    'a replay spends real money on work that already landed, so I start one only when they ask for an eval',
}

/** The line of theirs that asks for an eval, or null when none does. */
export function replayNamedBy(lines: readonly string[]): string | null {
  return namedBy(
    {
      path: 'replay',
      title: 'eval',
      keywords: ['evals', 'evaluate', 'evaluation', 'benchmark', 'benchmarks', 'replay'],
    },
    lines,
  )
}

// --- what the journal says ----------------------------------------------

/** A replay, as `replay_started` says it. */
export interface ReplayStarted {
  replay: string
  project: string
  said: string
  by: string
  at: string
  candidate: ReplayCandidate
  ceilingUsd: number
  cases: CaseStarted[]
}

/** One entrant's grading run: the project's checks at its head, the original's tests laid over it. */
export interface ReplayGraded {
  task: string
  state: 'passed' | 'failed' | 'could not run'
  /** The checks that did not pass. */
  failed: string[]
  /** The original's test files that were laid over it. */
  laid: string[]
  /** Why it could not run, where it could not. */
  why: string
}

/** Everything the journal says about replays, folded once. */
export interface ReplayRecords {
  started: Map<string, ReplayStarted>
  graded: Map<string, ReplayGraded>
  /** The entrants the ceiling stopped, by replay key. */
  stopped: Map<string, Set<string>>
}

/** The key a replay is known by: one project's name for it. */
export function replayKey(project: string, replay: string): string {
  return `${project}/${replay}`
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '')
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string') : []

/** The events a replay is folded from: one list, so no reader reads less than another. */
export const REPLAY_EVENTS = ['replay_started', 'replay_graded', 'replay_stopped'] as const

/** One case as `replay_started` writes it: what it became, and the original's figures. */
export function caseDetail(one: CaseStarted): Record<string, unknown> {
  const o = one.original
  return {
    of: one.of,
    ...(one.task ? { task: one.task } : {}),
    ...(one.couldNot ? { could_not: one.couldNot } : {}),
    ...(o
      ? {
          said: o.said,
          base: o.base,
          harness: o.harness,
          model: o.model,
          done: o.done,
          usd: o.usd,
          worked_ms: o.workedMs,
          size: o.size,
          tests: [...o.tests],
          head: o.head,
        }
      : {}),
  }
}

const numberOr = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** The original's figures out of one case's line, or null for a line written without them. */
function originalIn(c: Record<string, unknown>, project: string): ReplayCase | null {
  if (typeof c.said !== 'string') return null
  const size = (c.size ?? null) as Record<string, unknown> | null
  const added = numberOr(size?.added)
  const removed = numberOr(size?.removed)
  return {
    task: text(c.of),
    project,
    said: c.said,
    base: text(c.base) || null,
    baseThere: true,
    harness: text(c.harness),
    model: text(c.model),
    done: numberOr(c.done) ?? 0,
    context: null,
    usd: numberOr(c.usd),
    workedMs: numberOr(c.worked_ms),
    size: added !== null && removed !== null ? { added, removed } : null,
    tests: strings(c.tests),
    head: text(c.head) || null,
  }
}

/** Every replay the journal has, its grading runs and what its ceiling stopped. */
export function replayRecords(events: readonly TadeEvent[]): ReplayRecords {
  const out: ReplayRecords = { started: new Map(), graded: new Map(), stopped: new Map() }
  for (const event of events) {
    const d = event.detail
    if (event.type === 'replay_started') {
      const replay = text(d.replay)
      const project = text(d.project)
      if (!replay || !project) continue
      const key = replayKey(project, replay)
      if (out.started.has(key)) continue
      const said = (d.candidate ?? {}) as Record<string, unknown>
      out.started.set(key, {
        replay,
        project,
        said: text(d.said),
        by: text(d.by) || 'you',
        at: event.ts,
        candidate: {
          ...(text(said.harness) ? { harness: text(said.harness) } : {}),
          ...(text(said.model) ? { model: text(said.model) } : {}),
        },
        ceilingUsd: typeof d.ceiling_usd === 'number' ? d.ceiling_usd : 0,
        cases: (Array.isArray(d.cases) ? d.cases : []).flatMap((one) => {
          const c = (one ?? {}) as Record<string, unknown>
          if (!text(c.of)) return []
          return [
            {
              of: text(c.of),
              task: text(c.task) || null,
              couldNot: text(c.could_not) || null,
              original: originalIn(c, project),
            },
          ]
        }),
      })
    } else if (event.type === 'replay_graded' && event.task) {
      const state = text(d.state)
      out.graded.set(event.task, {
        task: event.task,
        state: state === 'passed' || state === 'failed' ? state : 'could not run',
        failed: strings(d.failed),
        laid: strings(d.laid),
        why: text(d.why),
      })
    } else if (event.type === 'replay_stopped') {
      const key = replayKey(text(d.project), text(d.replay))
      const into = out.stopped.get(key) ?? new Set<string>()
      for (const task of strings(d.stopped)) into.add(task)
      out.stopped.set(key, into)
    }
  }
  return out
}

/** The replay a task is an entrant in, and the case it replays, or null. */
export function replayOfTask(
  records: Pick<ReplayRecords, 'started'>,
  task: string,
): { started: ReplayStarted; of: string } | null {
  for (const started of records.started.values()) {
    const one = started.cases.find((c) => c.task === task)
    if (one) return { started, of: one.of }
  }
  return null
}

// --- scoring ---------------------------------------------------------------

/** What the window, or the CLI, knows about one entrant — every field a query somebody answered. */
export interface ReplayEntrantFacts {
  task: string
  /** The task is gone: removed by somebody. */
  removed: boolean
  /** An agent was ever started on it. */
  started: boolean
  /** The journal says it is finished. */
  finished: boolean
  state: TaskState | null
  /** The required checks at its head, as its own runs recorded them, or null where nothing looked. */
  checks: TestSignal | null
  failed: readonly string[]
  /** Whether the judge says it did something other than what was asked; null where no judge reads it. */
  strayed: boolean | null
  /** What its own commits changed, or null where nothing has looked. */
  size: { commits: number; added: number | null; removed: number | null } | null
  usd: number | null
  workedMs: number | null
}

export type ReplayOutcome =
  | 'passed'
  | 'failed'
  | 'unscored'
  | 'could not replay'
  | 'running'
  | 'waiting'
  | 'stopped at the ceiling'
  | 'removed'

/** The outcomes in the order a person reads a replay's count in. */
export const REPLAY_OUTCOMES: readonly ReplayOutcome[] = [
  'passed',
  'failed',
  'unscored',
  'could not replay',
  'running',
  'waiting',
  'stopped at the ceiling',
  'removed',
]

/** One case, replayed or not, with what came of it. */
export interface ReplayEntrant {
  case: ReplayCase | null
  of: string
  task: string | null
  facts: ReplayEntrantFacts | null
  graded: ReplayGraded | null
  outcome: ReplayOutcome
  /** Why, in a clause somebody wrote: the reasons it failed, why it could not be replayed. */
  why: string
}

/** What a stopped agent with nothing to show is, said once. */
export const NOTHING_CHANGED =
  'it stopped without changing anything, which is what words leaning on something the replay does not have look like'

/** What came of one entrant, and why. Red facts decide before green ones; nothing known is unscored. */
export function outcomeOf(
  facts: ReplayEntrantFacts | null,
  graded: ReplayGraded | null,
  stopped: boolean,
): { outcome: ReplayOutcome; why: string } {
  if (facts === null || facts.removed) return { outcome: 'removed', why: 'its task was removed' }
  const commits = facts.size?.commits ?? null
  if (stopped && !commits) {
    return { outcome: 'stopped at the ceiling', why: 'the replay reached its ceiling first' }
  }
  if (!facts.finished) {
    return facts.started
      ? { outcome: 'running', why: '' }
      : { outcome: 'waiting', why: 'queued behind the entrants before it' }
  }
  if (commits === 0) return { outcome: 'could not replay', why: NOTHING_CHANGED }
  if (commits === null) return { outcome: 'unscored', why: 'nothing has looked at its commits yet' }
  const red: string[] = []
  if (facts.checks === 'fail') {
    red.push(
      `its checks are red${facts.failed.length > 0 ? ` (${joined([...facts.failed])})` : ''}`,
    )
  }
  if (graded?.state === 'failed') {
    red.push(
      graded.laid.length > 0
        ? `with the original’s tests laid over it, ${graded.failed.length > 0 ? joined(graded.failed) : 'the checks'} failed`
        : `${graded.failed.length > 0 ? joined(graded.failed) : 'the checks'} failed at its head`,
    )
  }
  if (facts.strayed === true) red.push('the judge says it did something other than what was asked')
  if (red.length > 0) return { outcome: 'failed', why: red.join('; ') }
  if (facts.checks === 'pass' || graded?.state === 'passed') {
    return {
      outcome: 'passed',
      why:
        graded?.state === 'passed' && graded.laid.length > 0
          ? 'green, the original’s tests included'
          : 'green',
    }
  }
  return {
    outcome: 'unscored',
    why:
      graded?.state === 'could not run'
        ? `its grading run could not run: ${graded.why}`
        : 'no checks have run at its head yet',
  }
}

/** A sum of what some could say: null where none could, `atLeast` where only some could. */
export interface Summed {
  sum: number | null
  atLeast: boolean
}

function summed(values: readonly (number | null)[]): Summed {
  const known = values.filter((one): one is number => one !== null)
  return {
    sum: known.length === 0 ? null : known.reduce((a, b) => a + b, 0),
    atLeast: known.length > 0 && known.length < values.length,
  }
}

/** A replay, read. */
export interface Replay {
  name: string
  project: string
  said: string
  by: string
  began: string
  candidate: ReplayCandidate
  ceilingUsd: number
  entrants: ReplayEntrant[]
  counts: Record<ReplayOutcome, number>
  /** What the entrants have cost so far. */
  spent: Summed
  /** What the originals of the entrants that ran cost: the figure beside it. */
  originals: Summed
  /** The ceiling stopped it. */
  stopped: boolean
  /** Every entrant has an outcome that will not change. */
  over: boolean
}

/** Every replay, newest first, out of its records and what is known about each entrant. */
export function replaysIn(
  records: ReplayRecords,
  facts: (task: string) => ReplayEntrantFacts | null,
): Replay[] {
  const out: Replay[] = []
  for (const [key, started] of records.started) {
    const stopped = records.stopped.get(key) ?? new Set<string>()
    const entrants: ReplayEntrant[] = started.cases.map((one) => {
      const original = one.original
      if (one.task === null) {
        return {
          case: original,
          of: one.of,
          task: null,
          facts: null,
          graded: null,
          outcome: 'could not replay' as const,
          why: one.couldNot ?? '',
        }
      }
      const known = facts(one.task)
      const graded = records.graded.get(one.task) ?? null
      return {
        case: original,
        of: one.of,
        task: one.task,
        facts: known,
        graded,
        ...outcomeOf(known, graded, stopped.has(one.task)),
      }
    })
    const counts = Object.fromEntries(REPLAY_OUTCOMES.map((one) => [one, 0])) as Record<
      ReplayOutcome,
      number
    >
    for (const one of entrants) counts[one.outcome]++
    const ran = entrants.filter((one) => one.facts?.started)
    out.push({
      name: started.replay,
      project: started.project,
      said: started.said,
      by: started.by,
      began: started.at,
      candidate: started.candidate,
      ceilingUsd: started.ceilingUsd,
      entrants,
      counts,
      spent: summed(
        entrants.filter((one) => one.task !== null).map((one) => one.facts?.usd ?? null),
      ),
      originals: summed(ran.map((one) => one.case?.usd ?? null)),
      stopped: stopped.size > 0,
      over: counts.running === 0 && counts.waiting === 0,
    })
  }
  return out.sort((a, b) => (a.began < b.began ? 1 : a.began > b.began ? -1 : 0))
}

/** Whether a replay has spent its ceiling. Money nobody recorded is never over anything. */
export function overCeiling(replay: Pick<Replay, 'spent' | 'ceilingUsd'>): boolean {
  return replay.spent.sum !== null && replay.spent.sum >= replay.ceilingUsd
}

/** The entrants a ceiling stops: every one not finished, started or not. */
export function stoppedBy(replay: Replay): string[] {
  return replay.entrants.flatMap((one) =>
    one.task !== null && (one.outcome === 'running' || one.outcome === 'waiting') ? [one.task] : [],
  )
}

/**
 * Entrants whose agent has stopped — its turn ended and nobody is asked for an
 * approval, or it is gone — without its own rule being met: finished by the
 * replay, so the ones queued behind them start and it is scored on what it
 * left. An agent that stopped is the end of its attempt, and one with nothing
 * committed is counted as could not replay (`NOTHING_CHANGED`), never failed.
 */
export function stalledIn(replay: Replay, stopped: (task: string) => boolean): string[] {
  return replay.entrants.flatMap((one) =>
    one.task !== null && one.outcome === 'running' && stopped(one.task) ? [one.task] : [],
  )
}

/** Whether a task's agent has stopped, as status says it: idle or gone, and not asking for an approval. */
export function agentStopped(state: TaskState | null, reason: string): boolean {
  if (state === 'failed') return true
  return state === 'blocked' && !reason.startsWith('wants approval')
}

/** Entrants finished with work and no grading run yet: the next to grade, oldest first. */
export function ungraded(replay: Replay): ReplayEntrant[] {
  return replay.entrants.filter(
    (one) =>
      one.task !== null &&
      one.graded === null &&
      one.facts?.finished === true &&
      (one.facts.size?.commits ?? 0) > 0,
  )
}

/** Whether a path is a test, as the common layouts name one. */
export function isTestPath(path: string): boolean {
  return (
    /(^|\/)(test|tests|__tests__|spec|specs)\//.test(path) ||
    /[._-](test|spec)\.[a-z0-9]+$/i.test(path) ||
    /(^|\/)test_[^/]+\.py$/.test(path) ||
    /_test\.(go|py|rb|exs?)$/.test(path)
  )
}
