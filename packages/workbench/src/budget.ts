import {
  noSpend,
  pricesFrom,
  spendFrom,
  startBudget,
  startOfToday,
  type TadeEvent,
} from '@tade/core'
import type { Workbench } from './workbench.ts'

/**
 * Refuse to start a run that would take its project, or this machine, past
 * what it may spend in a day, and say so before it gets close: a long run that
 * dies at 100% with no warning is how people lose work. Priced as the Spend
 * page prices it, and the rule — two budgets, the worse one deciding, both
 * named where both are spent — is core's (`startBudget`).
 *
 * Out of `workbench.ts`, which is at its budget, beside nothing because it
 * needs nothing else: the config as the window last handed it over, and the
 * journal's usage lines.
 */
export async function guardBudget(
  tade: Pick<Workbench, 'config' | 'log'>,
  task: string,
  now: number,
): Promise<void> {
  const project = task.split('/')[0] ?? ''
  const budgets = { project: tade.config.projects[project]?.budget, machine: tade.config.budget }
  if (!budgets.project && !budgets.machine.usd_per_day && !budgets.machine.tokens_per_day) return
  let events: TadeEvent[]
  try {
    events = await tade.log.read({ types: ['usage'] })
  } catch (err) {
    // What was spent is unknown, which is not nought — and a start is not
    // refused over a journal that would not open, so it goes ahead and says
    // that nothing was checked for it.
    const why = err instanceof Error ? err.message : String(err)
    await tade.log.append({
      type: 'warning',
      task,
      detail: {
        message: `could not read the journal (${why}), so no budget was checked before ${task} started: what was spent today is unknown, not nought`,
      },
    })
    return
  }
  const prices = pricesFrom(tade.config.prices)
  const today = spendFrom(events, { since: startOfToday(now), prices })
  const state = startBudget({
    project,
    spent: { project: today.byProject[project] ?? noSpend(), machine: today.total },
    budgets,
  })
  if (state.verdict === 'over') throw new Error(state.said)
  if (state.verdict === 'warn') {
    await tade.log.append({
      type: 'warning',
      task,
      // Said out loud, not just journalled: by the time an earcon sends you
      // to look, the budget is spent.
      detail: { message: state.said },
    })
  }
}
