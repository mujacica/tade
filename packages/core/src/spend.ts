import type { TadeEvent } from './events.ts'

// What the agents have cost, and whether that is more than you meant.
//
// The numbers come from the harness, which prices each message against its own
// model catalog — the only thing that knows what was actually charged. Nothing
// here estimates: a budget built on a guess is worse than no budget, because
// you would trust it.
//
// A harness that can only estimate says so, every time, and what it said is
// kept apart from what was priced (`usdExact`, `usdEstimated`). A total may
// still add them — a person asking what the morning cost wants one number —
// but never in silence: `pricedOf` is what every surface says it with.
//
// A subscription-billed provider reports tokens and no money at all. That is
// not zero spend, it is unknown spend, and a dollar budget cannot police it —
// so a token budget exists too, and `hasCost` says which you are looking at.
//
// The same dollar is added to several buckets — the project, the task, the
// model, the harness it ran in, the sign-in it ran as, the provider it was
// reached through — because those are the six ways of asking one question, and
// three rows that are the same model reached three ways is exactly the
// confusion the last three exist to answer.

/**
 * The bucket for something nothing recorded: a run with no model, usage from
 * before harnesses wrote down which one they were.
 *
 * Empty, because no real name is: not a model called "unknown", not a harness
 * called "unknown". Surfaces draw it as *not recorded*, which is what it is.
 */
export const UNRECORDED = ''

/**
 * How the money in a bucket was arrived at, as the harnesses that reported it
 * declared: priced against a catalog, estimated, both, or none reported at all.
 */
export type Priced = 'exact' | 'estimate' | 'mixed' | 'none'

export interface Spend {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
  /** Of `usd`, what a harness priced against its own catalog. */
  usdExact: number
  /** Of `usd`, what a harness could only estimate. */
  usdEstimated: number
  /** Whether anything reported money. Distinguishes free from unpriced. */
  hasCost: boolean
}

export function noSpend(): Spend {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    tokens: 0,
    usd: 0,
    usdExact: 0,
    usdEstimated: 0,
    hasCost: false,
  }
}

/**
 * Which kind of money this is. Only dollars decide it: a harness that can only
 * estimate and reported nothing has estimated nothing, and a bucket of its
 * zeroes is not an estimate — it is no money at all.
 */
export function pricedOf(spend: Spend): Priced {
  const exact = spend.usdExact > 0
  const guessed = spend.usdEstimated > 0
  if (exact && guessed) return 'mixed'
  if (exact) return 'exact'
  if (guessed) return 'estimate'
  return 'none'
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

/**
 * What a run was, beyond its task: which harness ran it, which sign-in it ran
 * as, and which provider the model was reached through.
 *
 * Every field is what somebody *wrote down*, never a reading of a model id.
 * `anthropic/claude-opus-5` reached through OpenRouter is a real route on a
 * real machine, and a facet that read the provider out of the name would file
 * that spend under Anthropic and be confidently wrong. `UNRECORDED` is always
 * an allowed answer, and is what a journal written before this says.
 */
export interface RunFacts {
  /** The harness it ran in: `claude-code`, `pi`. */
  harness: string
  /** The account it ran as, or null for the harness's own sign-in. */
  account: string | null
  /** The provider the model was reached through: `openrouter`, `anthropic`. */
  provider: string
}

export function noRunFacts(): RunFacts {
  return { harness: UNRECORDED, account: null, provider: UNRECORDED }
}

/**
 * How a sign-in is filed: the harness alone for its own, `harness@account` for
 * an account's — the same spelling the adapter it runs on is filed under, so
 * what the Spend page calls a sign-in and what Settings calls one are one name.
 */
export function accountBucket(facts: RunFacts): string {
  if (facts.harness === UNRECORDED) return UNRECORDED
  return facts.account ? `${facts.harness}@${facts.account}` : facts.harness
}

/** What one event says about the run it belongs to. Absent fields stay unrecorded. */
export function runFactsOf(event: TadeEvent): RunFacts {
  const text = (key: string): string => {
    const value = event.detail[key]
    return typeof value === 'string' && value !== '' ? value : UNRECORDED
  }
  // `adapter` is what `run_started` has always called the harness; `harness` is
  // what a usage event writes. Either answers the same question.
  const harness = text('harness') || text('adapter')
  const account = event.detail.account
  return {
    harness,
    account: typeof account === 'string' && account !== '' ? account : null,
    provider: text('provider'),
  }
}

/**
 * What each run was, read off the `run_started` that opened it.
 *
 * Usage events carry this themselves now, but a journal is years long and the
 * ones already in it do not — and the run they belong to said it at the time.
 * So a usage event is asked first and its run second, which is the only way
 * the facets answer anything at all about work done before today.
 */
export function runFactsFrom(events: readonly TadeEvent[]): Map<string, RunFacts> {
  const facts = new Map<string, RunFacts>()
  for (const event of events) {
    if (event.type !== 'run_started' || !event.run) continue
    facts.set(event.run, runFactsOf(event))
  }
  return facts
}

/** What each run last said it was actually running on, as its usage reported it. */
export function modelsSaid(events: readonly TadeEvent[]): Map<string, string> {
  const models = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'usage' || !event.run) continue
    const model = event.detail.model
    if (typeof model === 'string' && model !== '') models.set(event.run, model)
  }
  return models
}

export interface SpendWindow {
  /** Only events at or after this. */
  since: number
  /**
   * What each run was, as `runFactsFrom` read it off the `run_started` that
   * opened it — for usage events written before they carried their own.
   * Built once by whoever asks several questions of one journal, rather than
   * rebuilt per question: a window redraws four times a second.
   */
  runs?: ReadonlyMap<string, RunFacts>
}

export interface SpendReport {
  total: Spend
  byProject: Record<string, Spend>
  /** Per task, which is what reconciling against an agent's session needs. */
  byTask: Record<string, Spend>
  byModel: Record<string, Spend>
  /** Per harness: `claude-code`, `pi`. `UNRECORDED` where nothing said. */
  byHarness: Record<string, Spend>
  /** Per sign-in: `claude-code`, `claude-code@work`. */
  byAccount: Record<string, Spend>
  /** Per provider the model was reached through: `openrouter`, `anthropic`. */
  byProvider: Record<string, Spend>
}

/** No window at all means everything ever recorded. */
export function spendFrom(
  events: readonly TadeEvent[],
  window: SpendWindow = { since: 0 },
): SpendReport {
  const report: SpendReport = {
    total: noSpend(),
    byProject: {},
    byTask: {},
    byModel: {},
    byHarness: {},
    byAccount: {},
    byProvider: {},
  }
  // Unwindowed on purpose: a run that began before the window still says what
  // the money spent inside it was spent on.
  const runs = window.runs
  for (const event of events) {
    if (event.type !== 'usage') continue
    const at = Date.parse(event.ts)
    if (Number.isFinite(at) && at < window.since) continue

    const project = (event.task ?? '').split('/')[0] || 'elsewhere'
    const model = modelOf(event)
    const task = event.task ?? ''
    // What the event itself says, then what its run said. Never a guess from
    // the model's name: the id and the route are different facts.
    const own = runFactsOf(event)
    const run = (event.run && runs?.get(event.run)) || noRunFacts()
    const facts: RunFacts = {
      harness: own.harness || run.harness,
      account: own.account ?? run.account,
      provider: own.provider || run.provider,
    }
    // Every bucket this event counts towards. The same numbers are added to
    // each, so a total and a per-project figure can never disagree.
    const buckets = [
      report.total,
      into(report.byProject, project),
      into(report.byModel, model),
      into(report.byHarness, facts.harness),
      into(report.byAccount, accountBucket(facts)),
      into(report.byProvider, facts.provider),
    ]
    if (task) buckets.push(into(report.byTask, task))
    for (const bucket of buckets) add(bucket, event)
  }
  return report
}

/** What this event says it ran on, or the bucket for nothing said. */
function modelOf(event: TadeEvent): string {
  const model = event.detail.model
  return typeof model === 'string' && model !== '' ? model : UNRECORDED
}

/** The bucket for this key, made on first sight. */
function into(buckets: Record<string, Spend>, key: string): Spend {
  const found = buckets[key] ?? noSpend()
  buckets[key] = found
  return found
}

function add(spend: Spend, event: TadeEvent): void {
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
  if (usd > 0) {
    spend.hasCost = true
    // Which kind of dollar this was, as the harness declared it when the turn
    // happened. A harness that never said is counted as an estimate: money
    // nobody vouched for is not money anybody priced.
    if (event.detail.priced === 'exact') spend.usdExact += usd
    else spend.usdEstimated += usd
  }
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
