import { type RunIn, rollup } from '@tade/web'
import type { PlanRow } from './plans.ts'

// The plans as rows, out of `wire/plans.ts` because the golden scenarios make
// their rows with it and load in a browser (`scripts/browser-goldens.ts`),
// and that file's beat reaches the machine. `wire/plans.ts` hands it on.

/**
 * The plans as the screen reads them: each run with the rollups `runRow` makes
 * for a device that may read everything — how many steps finished, the checks
 * with `unknown` beating `pass` — and its cost, null where no step has a
 * figure yet rather than a nought nobody recorded.
 */
export function planRowsOf(runs: readonly RunIn[]): PlanRow[] {
  return runs.map((run): PlanRow => {
    const usd = run.steps.reduce<number | null>(
      (total, step) => (step.usd === null ? total : (total ?? 0) + step.usd),
      null,
    )
    return {
      run: run.run,
      projects: run.projects,
      steps: run.steps,
      finished: run.steps.filter((step) => step.finished).length,
      total: run.steps.length,
      from: run.from,
      stamp: run.stamp,
      retries: run.retries,
      // **`unknown` beats `pass`**: a check nobody ran is not one that passed.
      checks: rollup(run.steps),
      usd,
    }
  })
}
