import { findingsFor, type LandingFacts, landingDesk, onTheDesk } from '@tade/core'
import type { FindingIn, TaskIn } from './input.ts'
import type { LandingOut } from './protocol.ts'

// The landing desk, as a device reads it: core's own rule (`landingDesk`) over
// the rows that device may read, so the page sorts by a number and draws a
// sentence and decides nothing.
//
// Per device, like the rest of the projection: the order is among the rows
// this device reads, and the findings it is folded from are ones its grant
// lets it read. It is built only for a device granted `findings` — the desk
// reads the judge, and a desk drawn without it would put a change with an open
// finding at the top as though nothing were open.

/** Where each piece of work on the desk stands, by task id; work not on it is absent. */
export function landingsFor(
  tasks: readonly TaskIn[],
  findings: readonly FindingIn[] | null,
): Map<string, LandingOut> {
  const facts: LandingFacts[] = []
  for (const task of tasks) {
    const review = task.review?.state ?? null
    if (!onTheDesk({ state: task.state, finished: task.finished, review })) continue
    facts.push({
      task: task.id,
      state: task.state,
      finished: task.finished,
      // The window's own rule for the same question, so the two desks agree.
      wantsYou: task.question || task.approval !== null,
      review,
      checks: task.looked ? task.checks.state : null,
      failed: task.checks.failed,
      missing: task.checks.missing,
      findings: findings === null ? null : findingsFor(findings, task.id),
      conflicts: task.conflicts,
      size: task.size,
      waitingSince: task.movedAt,
    })
  }
  return new Map(
    landingDesk(facts).map(({ facts: one, landing }, rank) => [
      one.task,
      { rank, tier: landing.tier, why: landing.why, also: landing.also, findings: one.findings },
    ]),
  )
}
