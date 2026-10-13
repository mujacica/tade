import type { CheckLog } from '@tade/checks-core'
import type { ChecksIn, CheckTreeIn } from '@tade/web'
import type { ActionsView } from './frame.ts'

// What the away view is told about checks: the rollup at a task's head, and
// what the run records say ran in each tree. Pure, like `away.ts` beside it.

/**
 * The rollup at a task's head, as the last look said.
 *
 * `unknown` wherever nothing has looked, and that is the whole point: a check
 * nobody ran is not a check that passed, and the away view may not start a
 * look to find out. `failed` and `missing` are named so a phone can say which,
 * and a check that was queued, running, skipped or cancelled is **missing**
 * rather than fine — that is the bug that draws a red thing green.
 */
export function checksIn(work: ActionsView | null, overridden: boolean): ChecksIn {
  if (work === null) {
    return { state: 'unknown', failed: [], missing: [], overridden }
  }
  const required = work.checks.filter((check) => check.required)
  const failed = required
    .filter((check) => check.state === 'failed' || check.state === 'timed out')
    .map((check) => check.id)
  const missing = required
    .filter(
      (check) =>
        check.state !== 'passed' && check.state !== 'failed' && check.state !== 'timed out',
    )
    .map((check) => check.id)
  return { state: work.rollup, failed, missing, overridden }
}

/**
 * One tree's run record, field by field: the check, how it went, whether it
 * was required, when, how long, and who asked — the agent somebody would go
 * and tell. **Not the rest of a run**: its commit, the tree it read, the
 * command and the tail of what it printed stay at the machine, because the
 * tail is a project's own output and the command is a line from its CI, and
 * neither is what a strip of moments needs.
 */
export function checkTreeIn(
  project: string,
  task: string | null,
  runs: readonly CheckLog[],
): CheckTreeIn {
  return {
    project,
    task,
    runs: runs.map((run) => {
      const started = Date.parse(run.startedAt ?? '')
      const finished = Date.parse(run.finishedAt ?? '')
      return {
        check: run.check,
        state: run.state,
        required: run.required,
        // When it ran, as `lookAtChecks` writes it to the journal: the finish,
        // or the start where that is all the record has.
        at: Number.isFinite(finished) ? finished : Number.isFinite(started) ? started : null,
        ms:
          Number.isFinite(started) && Number.isFinite(finished) && finished >= started
            ? finished - started
            : null,
        by: run.by,
      }
    }),
  }
}
