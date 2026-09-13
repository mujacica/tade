import {
  type Budget,
  type BudgetVerdict,
  checkBudget,
  spendFrom,
  startOfToday,
  type WilcoEvent,
} from '@wilco/core'

// What the window says about money, as data.
//
// The journal's `usage` events are the only record of spend, and `spendFrom`
// already adds them up by task, project and model. This decides the rest: what
// "this window" and "7 days" mean, which row is the orchestrator's, which model
// each agent ran on, and how every project stands against its daily budget.

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
  rows: SpendRow[]
  budgets: BudgetRow[]
}

const DAY = 86_400_000

/** When a window starts: midnight, when Wilco opened, or six midnights ago. */
export function sinceOf(window: SpendWindow, now: number, openedAt: number): number {
  if (window === 'window') return openedAt
  if (window === 'week') return startOfToday(now) - 6 * DAY
  return startOfToday(now)
}

export function spendView(
  events: readonly WilcoEvent[],
  opts: {
    window: SpendWindow
    by: SpendBy
    now: number
    openedAt: number
    projects: readonly string[]
    budgets: Readonly<Record<string, Budget | undefined>>
  },
): SpendView {
  const since = sinceOf(opts.window, opts.now, opts.openedAt)
  const usage = events.filter((event) => event.type === 'usage' && Date.parse(event.ts) >= since)
  const report = spendFrom(usage, { since })
  const models = lastModels(usage)

  let rows: SpendRow[]
  if (opts.by === 'project') {
    rows = Object.entries(report.byProject).map(([project, spend]) => ({
      label: project === 'elsewhere' ? 'orchestrator' : project,
      kind: project === 'elsewhere' ? 'orchestrator' : 'project',
      model: null,
      tokens: spend.tokens,
      usd: spend.usd,
    }))
  } else if (opts.by === 'model') {
    rows = Object.entries(report.byModel).map(([model, spend]) => ({
      label: model,
      kind: 'model',
      model,
      tokens: spend.tokens,
      usd: spend.usd,
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
            },
          ]
        : []),
      ...Object.entries(report.byTask).map(([task, spend]) => ({
        label: task,
        kind: 'task' as const,
        model: models.get(task) ?? null,
        tokens: spend.tokens,
        usd: spend.usd,
      })),
    ]
  }
  // Biggest first: the question a spend list answers is where it went.
  rows.sort((a, b) => b.usd - a.usd || b.tokens - a.tokens || a.label.localeCompare(b.label))

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

  return {
    window: opts.window,
    by: opts.by,
    tokens: report.total.tokens,
    usd: report.total.usd,
    hasCost: report.total.hasCost,
    rows,
    budgets,
  }
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
function lastModels(usage: readonly WilcoEvent[]): Map<string | null, string> {
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
