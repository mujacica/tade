import { type Calibrated, type Calibration, calibrationOf, ENOUGH } from './calibration.ts'
import type { TadeEvent } from './events.ts'
import {
  modelIn,
  noSpend,
  onPlanOf,
  type Priced,
  pricedOf,
  runFactsOf,
  type Spend,
  UNRECORDED,
} from './spend.ts'

// What the work came to, per harness, model, persona and template — the
// scorecards.
//
// `spendFrom` says what the agents cost and `statsFrom` what they produced;
// this asks the question both of them stop short of: *of the work done on this,
// how much landed, and what did landing it cost?* Vendors publish the
// flattering version of that number, graded by themselves; the honest version
// needs exactly the facts Tade already writes down, so it is one more fold over
// the journal and nothing is kept anywhere.
//
// What each figure is read from, and why that and nothing else:
//
//   · **done** is `task_done`, the journal's own answer to whether a task is
//     finished, and **time to done** runs from its `task_created`.
//   · **merged** is a `task_done` whose rule was `merged`, plus whatever the
//     caller can ask a forge again (`EvalFacts.merged`, status's last look in
//     the window). A merge is a fact the forge keeps, so it is asked rather
//     than journalled; where nobody asked, the figure is the journal's alone
//     and says so (`mergedFrom`).
//   · **landed** is merged, *or* committed straight onto a shared checkout: an
//     agent working in the project's own checkout has no branch to merge, and
//     its commits — read back by their `Tade-Task:` trailer (`commit_seen`) —
//     are on the project's branch the moment they are made. A scorecard that
//     only knew `merged` said `0 of 496` for a project worked that way, which
//     is a true count of the wrong thing. The cost is divided by this.
//   · **first push green** is about the first push an agent tried: held by the
//     checks rule (`permission_denied`, `rule: checks`) or let through with a
//     red run behind it (a `tool_call` carrying the gate's `checks` note) is
//     not green. A task nobody saw push is in neither count — a harness that
//     does not ask Tade before it runs a command leaves no push to read, and
//     that is *cannot tell*, never a red.
//   · **reds caught here** are `check_ran` lines that failed on this machine:
//     each is a red CI never had to find.
//   · **findings** are what any judge raised about a task's change (the
//     `findings` hook), with how its verdicts came out — `null` where no judge
//     reads anything here, which is not a judge that found nothing.
//   · **cost per landed task** is the landed tasks' own spend over every run
//     they had, divided by how many landed. Money keeps its three kinds and the
//     plan's list-price figure stays out of it, exactly as `spendFrom` keeps
//     them, because the row is a `Spend` and every surface already says one.
//
// A task is filed under what its **first** run was on: the harness that
// opened it and the model that run turned out to be on. A task that moved is
// counted where it began and in `moved`, because filing it under both would
// count one piece of work twice and filing it under the last would credit a
// rescue to the model that rescued it *and* hide what needed rescuing.
//
// Counts before rates, always: a rate is drawn only from `ENOUGH` (`countSaid`)
// and every surface says the two numbers it is made of.

/** The four ways of asking which way of working lands work. */
export type EvalBy = 'harness' | 'model' | 'persona' | 'template'

export const EVAL_BY: readonly { id: EvalBy; label: string }[] = [
  { id: 'harness', label: 'Harness' },
  { id: 'model', label: 'Model' },
  { id: 'persona', label: 'Persona' },
  { id: 'template', label: 'Template' },
]

/**
 * A task that came from no template, or a template step with no persona.
 *
 * Not `UNRECORDED`, which is a fact nobody wrote down: this is a fact that was
 * written down and is *nothing* — the work was asked for in somebody's own
 * words. A character no persona or template name can contain, so it can never
 * be one.
 */
export const WITHOUT = '∅'

/** What a judge raised about a change, as far as a scorecard reads it. */
export interface EvalFinding extends Calibrated {
  /** The tasks whose work the change was. */
  tasks: readonly string[]
}

/** What the fold is handed beside the journal: what is asked again, never written down. */
export interface EvalFacts {
  /** Only tasks made at or after this. Zero is the whole journal. */
  since: number
  /** What each task cost over every run (`spendFrom(...).byTask`). */
  spent: Readonly<Record<string, Spend>>
  /** What the judges raised, or null where no judge reads anything here. */
  findings: readonly EvalFinding[] | null
  /** Tasks a forge said were merged at the last look, where anybody looked. */
  merged?: ReadonlySet<string> | null
  /**
   * Only work in these projects; every project where absent. A device that
   * reads two projects is scored over those two, never handed a figure made
   * partly of work it may not see.
   */
  projects?: ReadonlySet<string> | null
}

/** One task, as the scorecards read it. */
export interface TaskOutcome {
  task: string
  harness: string
  model: string
  persona: string
  template: string
  /** Whether a later run was on another harness or model than the first. */
  moved: boolean
  created: number
  done: number | null
  merged: boolean
  /** Merged, or committed onto a shared checkout under its own trailer. */
  landed: boolean
  /** Commits seen with its trailer. */
  commits: number
  /** Where it worked: its own worktree, or the project's checkout. */
  workspace: 'checkout' | 'worktree' | null
  /** How its first push went: null where nobody saw it push. */
  firstPush: 'green' | 'red' | null
  /** Check runs on this machine, and how many of them were red. */
  checkedHere: number
  redsHere: number
}

/** Findings about one row's changes, by what became of them. */
export interface EvalFindings {
  fired: number
  /** How many of the row's tasks a judge raised anything about. */
  on: number
  confirmed: number
  wrong: number
  open: number
}

/** One harness's, model's, persona's or template's record. */
export interface Scorecard {
  /** The harness, model, persona or template — `UNRECORDED` or `WITHOUT` where that is the answer. */
  key: string
  tasks: number
  done: number
  merged: number
  /** Merged, or committed straight onto a shared checkout. */
  landed: number
  /** Tasks a push was seen from. */
  pushed: number
  /** Of those, the ones whose first push was not held or told red. */
  firstPushGreen: number
  /** Tasks that ran a check here, and the red runs among all of theirs. */
  checkedHere: number
  redsHere: number
  /** Null where no judge reads anything here. */
  findings: EvalFindings | null
  /** Every task's spend, over every run. */
  spend: Spend
  /** The landed tasks' spend, all of it: divided by `landed`, the tokens per landed task. */
  landedSpend: Spend
  /**
   * The landed tasks somebody was billed for, and those a plan paid for — each
   * with its own spend, because a cost per landed task is one divided by the
   * tasks it is the cost *of*: billed money spread over work a plan paid for
   * reads as cheap work, and is a figure about nothing.
   */
  landedBilled: { tasks: number; spend: Spend }
  landedOnPlan: { tasks: number; spend: Spend }
  /** How long from made to done, as the middle of the tasks that finished. */
  toDoneMs: number | null
  /** Tasks filed here whose later runs were on something else. */
  moved: number
}

export interface Evaluations {
  total: Scorecard
  byHarness: Scorecard[]
  byModel: Scorecard[]
  byPersona: Scorecard[]
  byTemplate: Scorecard[]
  /** Precision per question and per band, or null where no judge reads anything. */
  calibration: Calibration | null
  /** Whether merges are the journal's alone, or a forge was asked too. */
  mergedFrom: 'journal' | 'journal and forge'
}

/** What `evaluationsFrom` reads. One list, so a second reader cannot read less than the first. */
export const EVALUATION_EVENTS = [
  'task_created',
  'template_used',
  'run_started',
  'run_model',
  'usage',
  'task_done',
  'tool_call',
  'permission_denied',
  'check_ran',
  'commit_seen',
] as const

/** A command that pushes, as the checks gate reads one (`pushOrCommit`). */
const PUSH = /\bgit\s+push\b/

/** Each task's outcome, in the order the tasks were made. */
export function outcomesFrom(
  events: readonly TadeEvent[],
  facts: Pick<EvalFacts, 'since' | 'merged' | 'projects'>,
): TaskOutcome[] {
  const tasks = new Map<string, TaskOutcome>()
  const firstRun = new Map<string, string>()
  /** Tasks whose first run has said what it turned out to be on. */
  const said = new Set<string>()
  /**
   * Tasks somebody made. The orchestrator and a chat spend and run without
   * ever being a task, and a scorecard is about work that was asked for.
   */
  const made = new Set<string>()
  const templates = new Map<string, { template: string; persona: string }>()
  const at = (event: TadeEvent) => Date.parse(event.ts) || 0
  const of = (task: string, event: TadeEvent): TaskOutcome => {
    const had = tasks.get(task)
    if (had) return had
    const outcome: TaskOutcome = {
      task,
      harness: UNRECORDED,
      model: UNRECORDED,
      persona: WITHOUT,
      template: WITHOUT,
      moved: false,
      created: at(event),
      done: null,
      merged: false,
      landed: false,
      commits: 0,
      workspace: null,
      firstPush: null,
      checkedHere: 0,
      redsHere: 0,
    }
    tasks.set(task, outcome)
    return outcome
  }

  for (const event of events) {
    if (event.type === 'template_used') {
      const template = text(event.detail.template) || UNRECORDED
      const personas = event.detail.personas
      const listed = Array.isArray(event.detail.tasks) ? event.detail.tasks : []
      for (const task of listed) {
        if (typeof task !== 'string') continue
        // A line written before it said which persona each step was told from
        // is a persona nobody recorded, not one the step did not have.
        const persona =
          typeof personas === 'object' && personas !== null
            ? text((personas as Record<string, unknown>)[task]) || WITHOUT
            : UNRECORDED
        templates.set(task, { template, persona })
      }
      continue
    }
    // A check an agent ran in a shared checkout is written with no task, and
    // says whose it was in `by`.
    const by = text(event.detail.by)
    const task = event.task ?? (event.type === 'check_ran' && by.includes('/') ? by : null)
    if (!task) continue
    switch (event.type) {
      case 'task_created': {
        const one = of(task, event)
        one.created = at(event)
        const workspace = event.detail.workspace
        if (workspace === 'checkout' || workspace === 'worktree') one.workspace = workspace
        made.add(task)
        break
      }
      case 'commit_seen':
        of(task, event).commits += 1
        break
      case 'run_started': {
        const one = of(task, event)
        const harness = runFactsOf(event).harness
        if (!firstRun.has(task)) {
          firstRun.set(task, event.run ?? '')
          one.harness = harness
          one.model = modelIn(event).name
        } else if (harness !== UNRECORDED && harness !== one.harness) one.moved = true
        break
      }
      case 'run_model':
      case 'usage': {
        const one = of(task, event)
        const model = modelIn(event).name
        if (model === UNRECORDED) break
        // What the first run turned out to be on is the answer over what it
        // asked for; a later run on something else is the task having moved.
        const first = firstRun.get(task)
        if (first === undefined || first === event.run) {
          if (!said.has(task)) one.model = model
          said.add(task)
        } else if (model !== one.model) one.moved = true
        break
      }
      case 'task_done': {
        const one = of(task, event)
        if (one.done === null) one.done = at(event)
        if (event.detail.rule === 'merged') one.merged = true
        break
      }
      case 'tool_call': {
        if (!PUSH.test(text(event.detail.summary))) break
        const one = of(task, event)
        if (one.firstPush === null) one.firstPush = event.detail.checks ? 'red' : 'green'
        break
      }
      case 'permission_denied': {
        if (event.detail.rule !== 'checks' || !PUSH.test(text(event.detail.summary))) break
        const one = of(task, event)
        if (one.firstPush === null) one.firstPush = 'red'
        break
      }
      case 'check_ran': {
        if (event.detail.where !== 'here') break
        const one = of(task, event)
        one.checkedHere += 1
        const state = text(event.detail.state)
        if (state === 'failed' || state === 'timed out') one.redsHere += 1
        break
      }
    }
  }

  const out: TaskOutcome[] = []
  for (const one of tasks.values()) {
    if (!made.has(one.task) || one.created < facts.since) continue
    if (facts.projects && !facts.projects.has(one.task.split('/')[0] ?? '')) continue
    const stamped = templates.get(one.task)
    if (stamped) {
      one.template = stamped.template
      one.persona = stamped.persona
    }
    if (facts.merged?.has(one.task)) one.merged = true
    one.landed = one.merged || (one.workspace === 'checkout' && one.commits > 0)
    out.push(one)
  }
  return out
}

/** Every scorecard, out of the journal and what was asked again. */
export function evaluationsFrom(events: readonly TadeEvent[], facts: EvalFacts): Evaluations {
  const outcomes = outcomesFrom(events, facts)
  const findings = facts.findings
  const shown = new Set(outcomes.map((one) => one.task))
  // Only findings about work in the window: a finding is about a change, and a
  // change belongs to the tasks whose it was.
  const about =
    findings === null ? null : findings.filter((one) => one.tasks.some((task) => shown.has(task)))
  const card = (key: string, rows: readonly TaskOutcome[]) => scorecardOf(key, rows, facts, about)
  const by = (pick: (one: TaskOutcome) => string): Scorecard[] => {
    const groups = new Map<string, TaskOutcome[]>()
    for (const one of outcomes) {
      const key = pick(one)
      groups.set(key, [...(groups.get(key) ?? []), one])
    }
    return [...groups]
      .map(([key, rows]) => card(key, rows))
      .sort((a, b) => b.tasks - a.tasks || b.landed - a.landed || a.key.localeCompare(b.key))
  }
  return {
    total: card('', outcomes),
    byHarness: by((one) => one.harness),
    byModel: by((one) => one.model),
    byPersona: by((one) => one.persona),
    byTemplate: by((one) => one.template),
    calibration: about === null ? null : calibrationOf(about),
    mergedFrom: facts.merged ? 'journal and forge' : 'journal',
  }
}

/** The scorecards for one way of asking. */
export function scorecardsBy(evaluations: Evaluations, by: EvalBy): Scorecard[] {
  if (by === 'harness') return evaluations.byHarness
  if (by === 'model') return evaluations.byModel
  if (by === 'persona') return evaluations.byPersona
  return evaluations.byTemplate
}

function scorecardOf(
  key: string,
  rows: readonly TaskOutcome[],
  facts: EvalFacts,
  findings: readonly EvalFinding[] | null,
): Scorecard {
  const card: Scorecard = {
    key,
    tasks: rows.length,
    done: 0,
    merged: 0,
    landed: 0,
    pushed: 0,
    firstPushGreen: 0,
    checkedHere: 0,
    redsHere: 0,
    findings: null,
    spend: noSpend(),
    landedSpend: noSpend(),
    landedBilled: { tasks: 0, spend: noSpend() },
    landedOnPlan: { tasks: 0, spend: noSpend() },
    toDoneMs: null,
    moved: 0,
  }
  const times: number[] = []
  for (const one of rows) {
    if (one.done !== null) {
      card.done += 1
      if (one.done >= one.created) times.push(one.done - one.created)
    }
    if (one.firstPush !== null) card.pushed += 1
    if (one.firstPush === 'green') card.firstPushGreen += 1
    if (one.checkedHere > 0) card.checkedHere += 1
    card.redsHere += one.redsHere
    if (one.moved) card.moved += 1
    const spent = facts.spent[one.task]
    if (spent) addSpend(card.spend, spent)
    if (one.merged) card.merged += 1
    if (one.landed) {
      card.landed += 1
      if (spent) {
        addSpend(card.landedSpend, spent)
        // Billed wherever any of it was money, which is the claim a bill makes;
        // otherwise a plan's, where its turns have a list price to say.
        const into = spent.hasCost
          ? card.landedBilled
          : spent.usdOnPlan > 0
            ? card.landedOnPlan
            : null
        if (into) {
          into.tasks += 1
          addSpend(into.spend, spent)
        }
      }
    }
  }
  card.toDoneMs = median(times)
  if (findings !== null) {
    const mine = new Set(rows.map((one) => one.task))
    const counted: EvalFindings = { fired: 0, on: 0, confirmed: 0, wrong: 0, open: 0 }
    const raisedOn = new Set<string>()
    for (const finding of findings) {
      const whose = finding.tasks.filter((task) => mine.has(task))
      if (whose.length === 0) continue
      for (const task of whose) raisedOn.add(task)
      counted.fired += 1
      if (!finding.verdict) counted.open += 1
      else if (finding.verdict.was === 'confirmed') counted.confirmed += 1
      else counted.wrong += 1
    }
    counted.on = raisedOn.size
    card.findings = counted
  }
  return card
}

/**
 * A count out of a count, and a rate only once there are enough of them.
 *
 * The same three answers `precisionSaid` gives, for the same reason: `—` where
 * there is nothing to count out of, the two numbers under `ENOUGH`, and the
 * percentage after them — never instead of them.
 */
export function countSaid(count: number, of: number): string {
  if (of === 0) return '—'
  if (of < ENOUGH) return `${count} of ${of}`
  return `${count} of ${of} · ${Math.round((count / of) * 100)}%`
}

/** A figure divided per landed task, or null where nothing landed to divide by. */
export function perLanded(card: Scorecard, figure: (spend: Spend) => number): number | null {
  return card.landed === 0 ? null : figure(card.landedSpend) / card.landed
}

/**
 * The one character that says who worked a figure of money out: nothing for a
 * bill, `~` for the harness's own guess, `≈` for Tade's off a published rate.
 * The Spend page draws its money with the same table.
 */
export const MONEY_MARK: Readonly<Record<Priced, string>> = {
  exact: '',
  estimate: '~',
  listed: '≈',
  mixed: '~',
  none: '',
}

/** One part of what a landed task cost: what it says, and what kind of claim it is. */
export interface CostPart {
  said: string
  kind: 'billed' | 'worked out' | 'at list' | 'none'
}

/**
 * What one landed task cost, as every surface says it: money per billed task,
 * and what a plan's turns would have cost per task a plan paid for — two
 * figures over two denominators where a row has both, and never one figure
 * made of the two.
 *
 * `billed` is money somebody was charged, `worked out` is money with a mark
 * (the harness's guess or a published rate), and `at list` is what a plan's
 * turns would have cost — nobody's bill, and said as one so no surface can draw
 * it as money. `none` is `—`: nothing landed, or nothing priced. `≥` where some
 * of it was billed per token at a rate nothing here knows, or a plan's turns
 * ran on a model no rate knows, so the figure is a floor and drawn as one.
 */
export function perLandedCost(card: Scorecard): CostPart[] {
  const parts: CostPart[] = []
  const billed = card.landedBilled
  if (billed.tasks > 0) {
    const spend = billed.spend
    const priced = pricedOf(spend)
    const floor = spend.tokensUnpriced > spend.tokensOnPlan ? '≥' : ''
    parts.push({
      said: `${floor}${MONEY_MARK[priced]}${money(spend.usd / billed.tasks)}`,
      kind: priced === 'exact' ? 'billed' : 'worked out',
    })
  }
  const plan = card.landedOnPlan
  if (plan.tasks > 0) {
    const floor = onPlanOf(plan.spend) === 'partly' ? '≥' : ''
    parts.push({ said: `${floor}≈${money(plan.spend.usdOnPlan / plan.tasks)}`, kind: 'at list' })
  }
  return parts.length > 0 ? parts : [{ said: '—', kind: 'none' }]
}

function money(usd: number): string {
  return usd >= 100 ? `$${Math.round(usd)}` : `$${usd.toFixed(2)}`
}

/** One spend added into another, every count and every kind of money kept apart. */
export function addSpend(into: Spend, from: Spend): void {
  into.input += from.input
  into.output += from.output
  into.cacheRead += from.cacheRead
  into.cacheWrite += from.cacheWrite
  into.tokens += from.tokens
  into.usd += from.usd
  into.usdExact += from.usdExact
  into.usdEstimated += from.usdEstimated
  into.usdListed += from.usdListed
  into.usdOnPlan += from.usdOnPlan
  into.tokensOnPlan += from.tokensOnPlan
  into.tokensOnPlanUnrated += from.tokensOnPlanUnrated
  into.tokensUnpriced += from.tokensUnpriced
  into.hasCost = into.hasCost || from.hasCost
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((one, other) => one - other)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? null)
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}
