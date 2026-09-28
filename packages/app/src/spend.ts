import {
  accountBucket,
  type Budget,
  type BudgetVerdict,
  type CheckTally,
  checkBudget,
  modelIn,
  modelsSaid,
  noSpend,
  type OnPlan,
  onPlanOf,
  type PlanSource,
  type Priced,
  type PriceTable,
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
// Where the work was billed per token and the harness declared it prices
// nothing, the fold prices it from a published rate and the row carries the
// mark that says so. What is left over — a plan's flat fee, a model no rate
// knows — is counted in `tokensUnpriced` and said as a figure, because a total
// that quietly leaves an agent's cost out is worse than one marked incomplete.
//
// And what a plan's turns would have cost at that same published rate is its
// own figure (`usdOnPlan`), in none of the money above: on the total line as a
// caveat, and beside each sign-in's own plan bar, where somebody looking at a
// subscription is already looking. Never in the COST column, which is money —
// a plan's row there is still `—`, because nobody is billed this.

export type SpendWindow = 'today' | 'window' | 'week'

/**
 * The six ways of asking where it went.
 *
 * `claude-opus-5` on a subscription, `anthropic/claude-opus-5` through an API
 * key and `openrouter/anthropic/claude-opus-5` through a router are the same
 * weights reached three ways, so Model is **one** row for all three
 * (`modelIdentity`) and the last three facets are what tell the three ways
 * apart. Which is the whole point of having them: what cost what, whose key
 * paid and which plan it ate are facts about the route, and were never
 * readable off the string.
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
  /** Of `usd`, what Tade priced itself from the tokens and a published rate. */
  usdListed: number
  /** Which of those this row's money is, so no column adds them in silence. */
  priced: Priced
  /** How long it ran in this window. Null for the orchestrator, which has no run of its own. */
  runtime: Runtime | null
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
  /**
   * What this sign-in's turns in the window the page is showing would have cost
   * at list price. Nought where nothing ran on it, or where it is billed per
   * token — there the money columns above have already said what it cost.
   *
   * Beside the bar rather than in the table, because this is the one figure a
   * plan has that looks like money and is not one: here it sits in the list
   * that is already not money, under a heading that says so.
   */
  usdOnPlan: number
  /** Whether a rate covered all of its turns, or only some. */
  onPlan: OnPlan
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
  /** Of `usd`, what a catalog priced, what a harness guessed, and what a rate here made. */
  usdExact: number
  usdEstimated: number
  usdListed: number
  /** Which of those the total is. Said as a word beside it, never left to be assumed. */
  priced: Priced
  /**
   * Of `tokens`, what no dollar here covers — a plan's flat fee, a model no
   * rate knows. Said as a figure under the total whenever there is money for
   * it to be missing from: one that quietly leaves an agent's cost out is
   * worse than one marked incomplete.
   */
  tokensUnpriced: number
  /**
   * What the turns a plan paid for would have cost at list price, and not a
   * bill: nobody is charged it, and it is in none of the figures above. Said on
   * the line under the total, beside what that total does not cover.
   */
  usdOnPlan: number
  /** Whether a rate covered all of a plan's turns, some of them, or there are none. */
  onPlan: OnPlan
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
    /** Prices per model beyond the ones Tade ships, as `config.prices` holds them. */
    prices?: PriceTable
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
  const report = spendFrom(usage, { since, runs: facts, prices: opts.prices })
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
        spend: spent[key],
        runtime: timed[key] ?? null,
      }),
    )
  } else {
    const orchestrator = spendFrom(
      usage.filter((event) => event.task === null && event.detail.by === 'orchestrator'),
      { since, runs: facts, prices: opts.prices },
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
    { since: startOfToday(opts.now), runs: facts, prices: opts.prices },
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
    usdListed: report.total.usdListed,
    tokensUnpriced: report.total.tokensUnpriced,
    usdOnPlan: report.total.usdOnPlan,
    onPlan: onPlanOf(report.total),
    priced: pricedOf(report.total),
    hasCost: report.total.hasCost,
    runtime: ran.total,
    rows,
    plan: planRows(opts.plan ?? [], opts.now, report),
    budgets,
    produced: made.produced,
    checks: made.checks,
  }
}

/**
 * The facets that are one bucket each: which bucket, and what a key is called.
 *
 * Together rather than as four branches of the same shape, because they *are*
 * the same shape. A key nobody recorded is `not recorded` and nothing else:
 * the page is figures and the names of things, and a sentence under a row
 * explaining an empty bucket is read four hundred times and wanted once.
 */
const HOW = {
  model: { spend: 'byModel', ran: 'byModel', kind: 'model', name: (key: string) => key },
  harness: { spend: 'byHarness', ran: 'byHarness', kind: 'harness', name: (key: string) => key },
  account: {
    spend: 'byAccount',
    ran: 'byAccount',
    kind: 'account',
    // The same spelling the plan list uses, so what the Spend page calls a
    // sign-in and what Settings calls one are one name.
    name: (key: string) => signIn(key),
  },
  provider: {
    spend: 'byProvider',
    ran: 'byProvider',
    kind: 'provider',
    name: (key: string) => key,
  },
} as const satisfies Record<
  string,
  {
    spend: keyof SpendReport
    ran: keyof RuntimeReport
    kind: SpendRow['kind']
    name: (key: string) => string
  }
>

/** One row, with the money taken apart the one way it may never be put together in silence. */
function rowOf(of: {
  label: string
  kind: SpendRow['kind']
  model?: string | null
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
    usdListed: spend.usdListed,
    priced: pricedOf(spend),
    runtime: of.runtime,
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
function planRows(sources: readonly PlanSource[], now: number, report: SpendReport): PlanRow[] {
  return planStandings(sources, now).map((standing) => {
    // Its own turns, found the way the Spend table finds a sign-in's row: one
    // spelling for both, so what the bar says and what the table says about the
    // same sign-in can never be two different agents' work.
    const bucket = accountBucket({
      harness: standing.harness,
      account: standing.account,
      provider: UNRECORDED,
    })
    const spent = report.byAccount[bucket] ?? noSpend()
    return {
      label: planLabel(standing),
      windows: standing.windows.map((window) => ({
        label: window.label,
        used: window.used,
        resetsIn: resetsIn(window, now),
      })),
      saidAgo: standing.at === null ? null : Math.max(0, now - standing.at),
      cannotTell: standing.cannotTell,
      usdOnPlan: spent.usdOnPlan,
      onPlan: onPlanOf(spent),
    }
  })
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

/**
 * The model each task last reported, and the orchestrator's under `null` — by
 * the model's own name, which is the name its row in the Model view has.
 */
function lastModels(usage: readonly TadeEvent[]): Map<string | null, string> {
  const models = new Map<string | null, string>()
  for (const event of usage) {
    const { name } = modelIn(event)
    if (name === UNRECORDED) continue
    if (event.task) models.set(event.task, name)
    else if (event.detail.by === 'orchestrator') models.set(null, name)
  }
  return models
}
