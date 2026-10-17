import { z } from 'zod'
import type { Spend } from './spend.ts'

// What may be spent in a day, and whether a start is still inside it.
//
// Two budgets, and a start is held to both: its project's own
// (`projects.<name>.budget`) and the machine's (`budget`), which is every
// project's agents together — and the orchestrator's own turns, which are this
// machine's money too. Refused at the start (`startBudget`, asked by the
// workbench before any agent starts), warned at 80%, never a run cut off half
// way: a long run that dies at 100% is how people lose work.
//
// **Why the machine's, beside the project's** (REMOTE-TADE.md §5.2). A budget
// per project does not stop a schedule that fans out across six projects, each
// well inside its own: on a machine that runs with nobody there, that is a
// night's money with no line anywhere it stops at. One line in the same check
// is that line.
//
// **No amount unless somebody writes one.** Any figure Tade picked would be
// wrong for somebody — too low and it stops work at noon on a day it was
// wanted, too high and it is a cap that never caps — so the setting is there
// with nothing in it, and nothing is held until the person says how much.
//
// **Billed money and tokens, never a plan's list price** (`usdOnPlan`):
// refusing an agent over dollars nobody is charged is a stop nobody can argue
// with. On a plan the dollars are nought and stay nought, so a plan is held by
// its own window (`planTooTight`) — and by `tokens_per_day`, which is the cap
// that means something there.

export const BudgetSchema = z.strictObject({
  /** Dollars a day, billed. */
  usd_per_day: z.number().positive().optional(),
  /** Tokens a day: the cap that means something where a plan pays and nobody is billed. */
  tokens_per_day: z.int().positive().optional(),
})

export type Budget = z.infer<typeof BudgetSchema>

export type BudgetVerdict = 'ok' | 'warn' | 'over'

export interface BudgetState {
  verdict: BudgetVerdict
  /** What to say about it. Empty when there is nothing to say. */
  reason: string
}

/** Warn before it stops you, so a long run does not die at 100% unannounced. */
const WARN_AT = 0.8

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

/** What one start is held to, and the sentence for it: empty where it is inside both. */
export interface StartBudget {
  verdict: BudgetVerdict
  said: string
}

/**
 * Whether one start in `project` is inside its project's budget and the
 * machine's. The worse verdict decides, and **every budget at that verdict is
 * said**: a start refused by the machine's while its project's was also spent
 * is two facts somebody has to act on, and naming one would send them to raise
 * the wrong number.
 */
export function startBudget(req: {
  project: string
  spent: { project: Spend; machine: Spend }
  budgets: { project: Budget | undefined; machine: Budget | undefined }
}): StartBudget {
  const own = checkBudget(req.spent.project, req.budgets.project)
  const machine = checkBudget(req.spent.machine, req.budgets.machine)
  const verdict = rank(own.verdict) >= rank(machine.verdict) ? own.verdict : machine.verdict
  if (verdict === 'ok') return { verdict, said: '' }
  const said = [
    ...(own.verdict === verdict ? [`${req.project} ${spentWords(verdict)}: ${own.reason}`] : []),
    ...(machine.verdict === verdict
      ? [`this machine ${spentWords(verdict)}, every project together: ${machine.reason}`]
      : []),
  ]
  return { verdict, said: said.join('; and ') }
}

function spentWords(verdict: BudgetVerdict): string {
  return verdict === 'over' ? 'has spent its budget for today' : 'is near its budget'
}
