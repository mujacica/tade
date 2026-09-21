import {
  type Budget,
  type BudgetVerdict,
  type CheckTally,
  checkBudget,
  modelsSaid,
  noSpend,
  type PlanSource,
  type Priced,
  type Produced,
  planLabel,
  planStandings,
  pricedOf,
  type Runtime,
  type RuntimeReport,
  resetsIn,
  runFactsFrom,
  runtimeFrom,
  type Spend,
  type SpendReport,
  spendFrom,
  startOfToday,
  statsFrom,
  type TadeEvent,
  UNRECORDED,
} from '@tade/core'

// What the window says about money and time, as data.
//
// The journal's `usage` events are the only record of spend, and `spendFrom`
// already adds them up by task, project, model, harness, sign-in and provider.
// Its `run_started` and `run_exited` events are the only record of how long
// anything ran, and `runtimeFrom` adds those up the same six ways. This
// decides the rest: what "this window" and "7 days" mean, which row is the
// orchestrator's, which model each agent ran on, and how every project stands
// against its daily budget.
//
// An agent that ran and reported no money still gets a row: the question the
// panel answers is where the effort went, and unpriced effort is still effort.

export type SpendWindow = 'today' | 'window' | 'week'

/**
 * The six ways of asking where it went.
 *
 * The last three are what tell three rows of one model apart. `claude-opus-5`
 * on a subscription, `anthropic/claude-opus-5` through an API key and
 * `openrouter/anthropic/claude-opus-5` through a router are the same weights
 * reached three ways, and the difference that matters — what it cost, whose
 * key paid, which plan it ate — is the harness, the sign-in and the provider,
 * not the string.
 */
export type SpendBy = 'agent' | 'project' | 'model' | 'harness' | 'account' | 'provider'

export const SPEND_WINDOWS: readonly { id: SpendWindow; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'window', label: 'This window' },
  { id: 'week', label: '7 days' },
]

export const SPEND_BY: readonly { id: SpendBy; label: string }[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'project', label: 'Project' },
  { id: 'model', label: 'Model' },
  { id: 'harness', label: 'Harness' },
  { id: 'account', label: 'Sign-in' },
  { id: 'provider', label: 'Provider' },
]

export interface SpendRow {
  label: string
  /** The orchestrator, a task, a project, a model, a harness, a sign-in or a provider. */
  kind: 'orchestrator' | 'task' | 'project' | 'model' | 'harness' | 'account' | 'provider'
  /** What it mostly ran on, where that means anything. */
  model: string | null
  tokens: number
  usd: number
  /** Of `usd`, what a harness priced against its own catalog. */
  usdExact: number
  /** Of `usd`, what a harness could only estimate. */
  usdEstimated: number
  /** Which of those this row's money is, so no column adds the two in silence. */
  priced: Priced
  /** How long it ran in this window. Null for the orchestrator, which has no run of its own. */
  runtime: Runtime | null
  /**
   * Why this row is what it is, where the name alone would be read as a thing
   * that exists. A run whose `run_started` named no model is not an agent on a
   * model called `unknown`, and saying so is the difference between a row that
   * reads as a bug and one that reads as a gap.
   */
  note: string | null
}

/**
 * How one account's plan stands, as the panel draws it: shares of windows and
 * how long until each comes back, or the harness's own sentence for why there
 * is nothing to say. Never money, and in no total on the page.
 */
export interface PlanRow {
  /** `claude-code`, `codex @work`. */
  label: string
  /** The windows still running. Empty when nothing can be said. */
  windows: readonly { label: string; used: number; resetsIn: number | null }[]
  /** How long ago the harness said it. Null when nothing can be said. */
  saidAgo: number | null
  /** Why there is nothing to show, in the harness's words. Null when there is. */
  cannotTell: string | null
}

export interface BudgetRow {
  project: string
  /** Spent today, which is what a daily budget is measured against. */
  usd: number
  tokens: number
  budget: Budget | null
  /** How much of the tightest limit is used, 0 to 1 and beyond. Null without a budget. */
  share: number | null
  verdict: BudgetVerdict
}

export interface SpendView {
  window: SpendWindow
  by: SpendBy
  tokens: number
  usd: number
  /** Of `usd`, what was priced against a catalog and what was only estimated. */
  usdExact: number
  usdEstimated: number
  /** Which of those the total is. Said in the footer, never left for the reader to assume. */
  priced: Priced
  /** Whether any price was reported. Subscription providers report none. */
  hasCost: boolean
  /** Every agent's time in this window added up: two running at once count as two. */
  runtime: Runtime
  rows: SpendRow[]
  /**
   * How much of each account's plan is used now. Not money and never added to
   * it: a subscription has no price per turn, so the figures here are shares
   * of a window and belong to no total on this page.
   *
   * Always now, whichever window the rest of the panel is showing — a plan is
   * what is left today, and there is no such thing as last Tuesday's.
   */
  plan: readonly PlanRow[]
  budgets: BudgetRow[]
  /** What the money bought: commits, and how big they were. */
  produced: Produced
  /** How each of the project's checks has been going, busiest first. */
  checks: CheckTally[]
}

const DAY = 86_400_000

/** When a window starts: midnight, when Tade opened, or six midnights ago. */
export function sinceOf(window: SpendWindow, now: number, openedAt: number): number {
  if (window === 'window') return openedAt
  if (window === 'week') return startOfToday(now) - 6 * DAY
  return startOfToday(now)
}

export function spendView(
  events: readonly TadeEvent[],
  opts: {
    window: SpendWindow
    by: SpendBy
    now: number
    openedAt: number
    projects: readonly string[]
    budgets: Readonly<Record<string, Budget | undefined>>
    /** Where runtime is read from, when the run events are not in `events` themselves. */
    runs?: readonly TadeEvent[]
    /** Where commits and check runs are read from. The same events, unless said. */
    made?: readonly TadeEvent[]
    /** What each harness account can say about its plan, and what it last said. */
    plan?: readonly PlanSource[]
  },
): SpendView {
  const since = sinceOf(opts.window, opts.now, opts.openedAt)
  const usage = events.filter((event) => event.type === 'usage' && Date.parse(event.ts) >= since)
  const runEvents = opts.runs ?? events
  // Runs are read unwindowed on both sides: what a run *was* does not depend
  // on which window you are looking at, and a run that began before this one
  // and is still going is time spent inside it.
  // Built once and asked three times: the panel redraws four times a second,
  // and rebuilding it per question is a pass over the whole journal each time.
  const facts = runFactsFrom(runEvents)
  const report = spendFrom(usage, { since, runs: facts })
  const models = lastModels(usage)
  // What each run turned out to be on, so the hours and the dollars of one
  // agent land on one row. A route asks for `anthropic/claude-opus-5` and
  // Claude Code answers `claude-opus-5`; timed by the ask and priced by the
  // answer, one agent was drawn as two models that never ran together.
  const ran = runtimeFrom(runEvents, { since, now: opts.now, said: modelsSaid(events) })

  let rows: SpendRow[]
  if (opts.by === 'project') {
    rows = keysOf(report.byProject, ran.byProject).map((project) =>
      rowOf({
        label: project === 'elsewhere' ? 'orchestrator' : project,
        kind: project === 'elsewhere' ? 'orchestrator' : 'project',
        spend: report.byProject[project],
        runtime: ran.byProject[project] ?? null,
      }),
    )
  } else if (opts.by in HOW) {
    const facet = HOW[opts.by as keyof typeof HOW]
    const spent = report[facet.spend]
    const timed = ran[facet.ran]
    rows = keysOf(spent, timed).map((key) =>
      rowOf({
        label: key === UNRECORDED ? 'not recorded' : facet.name(key),
        kind: facet.kind,
        // The name column *is* the thing here, so a second column of the
        // model says nothing and takes the room the first one needs.
        model: null,
        note: key === UNRECORDED ? facet.unrecorded : facet.about(key),
        spend: spent[key],
        runtime: timed[key] ?? null,
      }),
    )
  } else {
    const orchestrator = spendFrom(
      usage.filter((event) => event.task === null && event.detail.by === 'orchestrator'),
      { since, runs: facts },
    ).total
    rows = [
      ...(orchestrator.tokens > 0 || orchestrator.usd > 0
        ? [
            rowOf({
              label: 'orchestrator',
              kind: 'orchestrator',
              model: models.get(null) ?? null,
              spend: orchestrator,
              // The orchestrator runs for exactly as long as the window is
              // open, which is not agent time and is not measured here.
              runtime: null,
            }),
          ]
        : []),
      ...keysOf(report.byTask, ran.byTask).map((task) =>
        rowOf({
          label: task,
          kind: 'task',
          model: models.get(task) ?? null,
          spend: report.byTask[task],
          runtime: ran.byTask[task] ?? null,
        }),
      ),
    ]
  }
  // Biggest first: the question a spend list answers is where it went.
  rows.sort(
    (a, b) =>
      b.usd - a.usd ||
      b.tokens - a.tokens ||
      (b.runtime?.ms ?? 0) - (a.runtime?.ms ?? 0) ||
      a.label.localeCompare(b.label),
  )

  const today = spendFrom(
    events.filter((event) => event.type === 'usage'),
    { since: startOfToday(opts.now), runs: facts },
  )
  const budgets = opts.projects.map((project): BudgetRow => {
    const spent = today.byProject[project] ?? noSpend()
    const budget = opts.budgets[project] ?? null
    return {
      project,
      usd: spent.usd,
      tokens: spent.tokens,
      budget,
      share: budget ? shareOf(spent, budget) : null,
      verdict: budget ? checkBudget(spent, budget).verdict : 'ok',
    }
  })

  // What the money bought. Read over the same window, from events written
  // once each at the moment they were true — a commit that has since been
  // rebased away still counts, because the work was still done.
  const made = statsFrom(opts.made ?? events, { since })

  return {
    window: opts.window,
    by: opts.by,
    tokens: report.total.tokens,
    usd: report.total.usd,
    usdExact: report.total.usdExact,
    usdEstimated: report.total.usdEstimated,
    priced: pricedOf(report.total),
    hasCost: report.total.hasCost,
    runtime: ran.total,
    rows,
    plan: planRows(opts.plan ?? [], opts.now),
    budgets,
    produced: made.produced,
    checks: made.checks,
  }
}

/**
 * The facets that are one bucket each: which bucket, what a key is called, and
 * what to say about one nobody can read at a glance.
 *
 * Together rather than as five branches of the same shape, because they *are*
 * the same shape — and because what a row of nothing recorded says is the
 * thing most easily left out of the fifth copy.
 */
const HOW = {
  model: {
    spend: 'byModel',
    ran: 'byModel',
    kind: 'model',
    name: (key: string) => key,
    about: () => null,
    unrecorded: 'no model was written down for these runs',
  },
  harness: {
    spend: 'byHarness',
    ran: 'byHarness',
    kind: 'harness',
    name: (key: string) => key,
    about: () => null,
    unrecorded: 'ran before Tade wrote the harness down',
  },
  account: {
    spend: 'byAccount',
    ran: 'byAccount',
    kind: 'account',
    // The same spelling the plan list uses, so what the Spend page calls a
    // sign-in and what Settings calls one are one name.
    name: (key: string) => signIn(key),
    about: (key: string) => (key.includes('@') ? null : "the harness's own sign-in"),
    unrecorded: 'ran before Tade wrote the sign-in down',
  },
  provider: {
    spend: 'byProvider',
    ran: 'byProvider',
    kind: 'provider',
    name: (key: string) => key,
    about: () => null,
    // Never read out of the model's name: `anthropic/claude-opus-5` reached
    // through OpenRouter is a real route on a real machine, and guessing would
    // file that spend under Anthropic and look certain about it.
    unrecorded: 'no provider was written down for these runs',
  },
} as const satisfies Record<
  string,
  {
    spend: keyof SpendReport
    ran: keyof RuntimeReport
    kind: SpendRow['kind']
    name: (key: string) => string
    about: (key: string) => string | null
    unrecorded: string
  }
>

/** One row, with the money taken apart the one way it may never be put together in silence. */
function rowOf(of: {
  label: string
  kind: SpendRow['kind']
  model?: string | null
  note?: string | null
  spend: Spend | undefined
  runtime: Runtime | null
}): SpendRow {
  const spend = of.spend ?? noSpend()
  return {
    label: of.label,
    kind: of.kind,
    model: of.model ?? null,
    tokens: spend.tokens,
    usd: spend.usd,
    usdExact: spend.usdExact,
    usdEstimated: spend.usdEstimated,
    priced: pricedOf(spend),
    runtime: of.runtime,
    note: of.note ?? null,
  }
}

/** A sign-in as a person reads it: the same spelling the plan list uses. */
function signIn(key: string): string {
  const at = key.indexOf('@')
  return at === -1
    ? planLabel({ harness: key, account: null })
    : planLabel({ harness: key.slice(0, at), account: key.slice(at + 1) })
}

/**
 * What each account's plan standing looks like on the page: the standing
 * itself is `planStandings`' to decide, and this only turns the moments in it
 * into the lengths of time a person reads.
 */
function planRows(sources: readonly PlanSource[], now: number): PlanRow[] {
  return planStandings(sources, now).map((standing) => ({
    label: planLabel(standing),
    windows: standing.windows.map((window) => ({
      label: window.label,
      used: window.used,
      resetsIn: resetsIn(window, now),
    })),
    saidAgo: standing.at === null ? null : Math.max(0, now - standing.at),
    cannotTell: standing.cannotTell,
  }))
}

/** Every bucket either side knows about, in the order money found them. */
function keysOf(spend: Record<string, unknown>, ran: Record<string, unknown>): string[] {
  return [...new Set([...Object.keys(spend), ...Object.keys(ran)])]
}

/** The tightest limit decides, as it does when an agent is refused. */
function shareOf(spent: { tokens: number; usd: number }, budget: Budget): number | null {
  const shares: number[] = []
  if (budget.usd_per_day && budget.usd_per_day > 0) shares.push(spent.usd / budget.usd_per_day)
  if (budget.tokens_per_day && budget.tokens_per_day > 0) {
    shares.push(spent.tokens / budget.tokens_per_day)
  }
  return shares.length === 0 ? null : Math.max(...shares)
}

/** The model each task last reported, and the orchestrator's under `null`. */
function lastModels(usage: readonly TadeEvent[]): Map<string | null, string> {
  const models = new Map<string | null, string>()
  for (const event of usage) {
    const model = event.detail.model
    if (typeof model !== 'string' || model === '') continue
    if (event.task) models.set(event.task, model)
    else if (event.detail.by === 'orchestrator') models.set(null, model)
  }
  return models
}
