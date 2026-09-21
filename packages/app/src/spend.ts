import {
  type Budget,
  type BudgetVerdict,
  type CheckTally,
  checkBudget,
  type PlanSource,
  type Produced,
  planLabel,
  planStandings,
  type Runtime,
  resetsIn,
  runtimeFrom,
  spendFrom,
  startOfToday,
  statsFrom,
  type TadeEvent,
} from '@tade/core'

// What the window says about money and time, as data.
//
// The journal's `usage` events are the only record of spend, and `spendFrom`
// already adds them up by task, project and model. Its `run_started` and
// `run_exited` events are the only record of how long anything ran, and
// `runtimeFrom` adds those up the same three ways. This decides the rest: what
// "this window" and "7 days" mean, which row is the orchestrator's, which model
// each agent ran on, and how every project stands against its daily budget.
//
// An agent that ran and reported no money still gets a row: the question the
// panel answers is where the effort went, and unpriced effort is still effort.

export type SpendWindow = 'today' | 'window' | 'week'
export type SpendBy = 'agent' | 'project' | 'model'

export const SPEND_WINDOWS: readonly { id: SpendWindow; label: string }[] = [
  { id: 'today', label: 'Today' },
  { id: 'window', label: 'This window' },
  { id: 'week', label: '7 days' },
]

export const SPEND_BY: readonly { id: SpendBy; label: string }[] = [
  { id: 'agent', label: 'Agent' },
  { id: 'project', label: 'Project' },
  { id: 'model', label: 'Model' },
]

export interface SpendRow {
  label: string
  /** The orchestrator, a task, a project or a model. */
  kind: 'orchestrator' | 'task' | 'project' | 'model'
  /** What it mostly ran on, where that means anything. */
  model: string | null
  tokens: number
  usd: number
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
  const report = spendFrom(usage, { since })
  const models = lastModels(usage)
  // Runs are read unwindowed and clipped to the window, because a run that
  // began before it and is still going is time spent inside it.
  const ran = runtimeFrom(opts.runs ?? events, { since, now: opts.now })

  let rows: SpendRow[]
  if (opts.by === 'project') {
    rows = keysOf(report.byProject, ran.byProject).map((project) => ({
      label: project === 'elsewhere' ? 'orchestrator' : project,
      kind: project === 'elsewhere' ? 'orchestrator' : 'project',
      model: null,
      tokens: report.byProject[project]?.tokens ?? 0,
      usd: report.byProject[project]?.usd ?? 0,
      runtime: ran.byProject[project] ?? null,
    }))
  } else if (opts.by === 'model') {
    rows = keysOf(report.byModel, ran.byModel).map((model) => ({
      label: model,
      kind: 'model',
      model,
      tokens: report.byModel[model]?.tokens ?? 0,
      usd: report.byModel[model]?.usd ?? 0,
      runtime: ran.byModel[model] ?? null,
    }))
  } else {
    const orchestrator = spendFrom(
      usage.filter((event) => event.task === null && event.detail.by === 'orchestrator'),
      { since },
    ).total
    rows = [
      ...(orchestrator.tokens > 0 || orchestrator.usd > 0
        ? [
            {
              label: 'orchestrator',
              kind: 'orchestrator' as const,
              model: models.get(null) ?? null,
              tokens: orchestrator.tokens,
              usd: orchestrator.usd,
              // The orchestrator runs for exactly as long as the window is
              // open, which is not agent time and is not measured here.
              runtime: null,
            },
          ]
        : []),
      ...keysOf(report.byTask, ran.byTask).map((task) => ({
        label: task,
        kind: 'task' as const,
        model: models.get(task) ?? null,
        tokens: report.byTask[task]?.tokens ?? 0,
        usd: report.byTask[task]?.usd ?? 0,
        runtime: ran.byTask[task] ?? null,
      })),
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
    { since: startOfToday(opts.now) },
  )
  const budgets = opts.projects.map((project): BudgetRow => {
    const spent = today.byProject[project] ?? { tokens: 0, usd: 0 }
    const budget = opts.budgets[project] ?? null
    return {
      project,
      usd: spent.usd,
      tokens: spent.tokens,
      budget,
      share: budget ? shareOf(spent, budget) : null,
      verdict: budget ? checkBudget({ ...emptySpend(), ...spent }, budget).verdict : 'ok',
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

function emptySpend() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: 0, hasCost: false }
}
