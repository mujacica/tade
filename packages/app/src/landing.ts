import {
  conflictsFor,
  type FindingFacts,
  findingsFor,
  type LandingFacts,
  landingDesk,
  onTheDesk,
  sizeOf,
  type Workspace,
} from '@tade/core'
import { checksIn } from './away-checks.ts'
import type { ActionsView, DeskRow } from './frame.ts'

// The landing desk, as the window folds it: core's rule (`landingDesk`) over
// what the window already holds.
//
// Pure, and asks nobody anything. The world is status's last look; the checks
// and what the commits changed are the ACTIONS page's last look at each task
// (`seenActions`), so a task nobody has looked at yet says so rather than
// reading green; the findings are what the extensions' judges last said; and
// the money is a fold the window keeps for its own drawing. What could not be
// said is null all the way to the screen.

/** What the window hands the fold. */
export interface DeskInputs {
  world: Workspace
  /** The tasks the journal says are finished (`task_done`), out of the whole journal. */
  finished: ReadonlySet<string>
  /** The tasks whose agent asked something, or waits on an approval. */
  waiting: ReadonlySet<string>
  /** The last look at a task's commits and checks, never a look. */
  work: (task: string) => ActionsView | null
  /** What the judges last said, or null where none could be read. */
  findings: readonly FindingFacts[] | null
  /** What a task has cost over every run, or null where nothing recorded money. */
  usd: (task: string) => number | null
}

/** Every piece of work on the desk, every project's, in the order it is cheapest to trust. */
export function deskOf(inputs: DeskInputs): DeskRow[] {
  const facts: LandingFacts[] = []
  const project = new Map<string, string>()
  for (const one of inputs.world.projects) {
    for (const task of one.tasks) {
      const review = task.git?.pr?.state ?? null
      const finished = inputs.finished.has(task.id)
      if (!onTheDesk({ state: task.state, finished, review })) continue
      const work = inputs.work(task.id)
      const checks = checksIn(work, false)
      project.set(task.id, one.name)
      facts.push({
        task: task.id,
        state: task.state,
        finished,
        wantsYou: inputs.waiting.has(task.id),
        review,
        checks: work === null ? null : checks.state,
        failed: checks.failed,
        missing: checks.missing,
        findings: inputs.findings === null ? null : findingsFor(inputs.findings, task.id),
        conflicts: conflictsFor(one.conflicts, task.id),
        size: sizeOf(work?.mine ?? null),
        waitingSince: movedAt(task),
      })
    }
  }
  return landingDesk(facts).map(({ facts: one, landing }) => ({
    task: one.task,
    project: project.get(one.task) ?? '',
    tier: landing.tier,
    why: landing.why,
    also: landing.also,
    checks: one.checks,
    findings: one.findings,
    conflicts: one.conflicts === null ? null : one.conflicts.length,
    size: one.size,
    usd: inputs.usd(one.task),
    waitingSince: one.waitingSince,
    review: one.review === 'open' || one.review === 'draft' ? one.review : null,
  }))
}

/**
 * The last time anything about a task was seen to move: its newest commit or
 * its agent's last act, whichever is later — the moment it began waiting.
 */
export function movedAt(task: Workspace['projects'][number]['tasks'][number]): number | null {
  const moments = [task.git?.headTime ?? null, ...task.agents.map((one) => one.lastActivityAt)]
  const known = moments.filter((at): at is number => at !== null && Number.isFinite(at))
  return known.length === 0 ? null : Math.max(...known)
}
