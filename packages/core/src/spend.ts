import type { WilcoEvent } from './events.ts'

// What the agents have cost, and whether that is more than you meant.
//
// The numbers come from the harness, which prices each message against its own
// model catalog — the only thing that knows what was actually charged. Nothing
// here estimates: a budget built on a guess is worse than no budget, because
// you would trust it.
//
// A subscription-billed provider reports tokens and no money at all. That is
// not zero spend, it is unknown spend, and a dollar budget cannot police it —
// so a token budget exists too, and `hasCost` says which you are looking at.

export interface Spend {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
  /** Whether anything reported money. Distinguishes free from unpriced. */
  hasCost: boolean
}

export function noSpend(): Spend {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, tokens: 0, usd: 0, hasCost: false }
}

export interface Budget {
  /** Dollars per day, across the project. */
  usd_per_day?: number
  /** Tokens per day, for providers that report no money. */
  tokens_per_day?: number
}

export type BudgetVerdict = 'ok' | 'warn' | 'over'

export interface BudgetState {
  verdict: BudgetVerdict
  /** What to say about it. Empty when there is nothing to say. */
  reason: string
}

/** Warn before it stops you, so a long run does not die at 100% unannounced. */
const WARN_AT = 0.8

export interface SpendWindow {
  /** Only events at or after this. */
  since: number
}

export interface SpendReport {
  total: Spend
  byProject: Record<string, Spend>
  byModel: Record<string, Spend>
}

export function spendFrom(events: readonly WilcoEvent[], window: SpendWindow): SpendReport {
  const report: SpendReport = { total: noSpend(), byProject: {}, byModel: {} }
  for (const event of events) {
    if (event.type !== 'usage') continue
    const at = Date.parse(event.ts)
    if (Number.isFinite(at) && at < window.since) continue

    const project = (event.task ?? '').split('/')[0] || 'elsewhere'
    const model = String(event.detail.model ?? 'unknown')
    report.byProject[project] ??= noSpend()
    report.byModel[model] ??= noSpend()
    for (const bucket of [report.total, report.byProject[project], report.byModel[model]]) {
      add(bucket, event)
    }
  }
  return report
}

function add(spend: Spend, event: WilcoEvent): void {
  const number = (key: string) => {
    const value = event.detail[key]
    return typeof value === 'number' && Number.isFinite(value) ? value : 0
  }
  spend.input += number('input')
  spend.output += number('output')
  spend.cacheRead += number('cacheRead')
  spend.cacheWrite += number('cacheWrite')
  spend.tokens += number('tokens')
  const usd = number('usd')
  spend.usd += usd
  if (usd > 0) spend.hasCost = true
}

/** Whether this is within what you said, and what to say if it is not. */
export function checkBudget(spend: Spend, budget: Budget | undefined): BudgetState {
  if (!budget || (budget.usd_per_day === undefined && budget.tokens_per_day === undefined)) {
    return { verdict: 'ok', reason: '' }
  }

  const checks: Array<{ used: number; limit: number; say: (n: number) => string }> = []
  if (budget.usd_per_day !== undefined) {
    checks.push({
      used: spend.usd,
      limit: budget.usd_per_day,
      say: (n) => `$${spend.usd.toFixed(2)} of $${n.toFixed(2)} today`,
    })
  }
  if (budget.tokens_per_day !== undefined) {
    checks.push({
      used: spend.tokens,
      limit: budget.tokens_per_day,
      say: (n) => `${spend.tokens.toLocaleString()} of ${n.toLocaleString()} tokens today`,
    })
  }

  // The strictest one decides: a project that is over on either is over.
  let worst: BudgetState = { verdict: 'ok', reason: '' }
  for (const check of checks) {
    if (check.limit <= 0) continue
    const ratio = check.used / check.limit
    const verdict: BudgetVerdict = ratio >= 1 ? 'over' : ratio >= WARN_AT ? 'warn' : 'ok'
    if (rank(verdict) > rank(worst.verdict)) {
      worst = { verdict, reason: verdict === 'ok' ? '' : check.say(check.limit) }
    }
  }
  return worst
}

function rank(verdict: BudgetVerdict): number {
  return verdict === 'over' ? 2 : verdict === 'warn' ? 1 : 0
}

/** Midnight local time, which is what "today" means to a person. */
export function startOfToday(now: number): number {
  const date = new Date(now)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}
