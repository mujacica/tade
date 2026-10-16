import { checkProposal, type Mistake, madeTwice } from '@tade/core'
import type { ExtensionWatch, Finding } from '@tade/extensions-core'
import { allowed } from './ask.ts'
import { findingsOf } from './loop.ts'
import { CHECKABLE, titleOf } from './questions.ts'
import { recordOf } from './record.ts'
import type { ReviewRecord } from './report.ts'

// Mistakes become checks, from the verdicts.
//
// A finding somebody confirmed is a mistake that was really made; the same
// question confirmed about a second change in the same project is a mistake
// that is going to be made again, and the answer to that is a check a machine
// runs rather than a paragraph an agent reads (`core/src/mistakes.ts`, where
// the rule and the reasons are).
//
// The precision table decides which questions qualify, and nothing else does:
// the verdicts somebody wrote, counted per finding, never an agent's account of
// its own work and never a probability. And the judge only ever adds caution
// here as everywhere — what this watch makes is work **parked** for a person,
// which nothing starts until somebody picks it up.

/** The mistakes Jev's verdicts say were made twice in one project. */
export function mistakesIn(record: ReviewRecord, project: string): Mistake[] {
  return madeTwice(findingsOf(record.reviews), project, (question) =>
    CHECKABLE.includes(question),
  ).map((row) => ({
    project,
    name: row.question,
    what: titleOf(row.question),
    seen: row.seen.map((one) => ({
      task: one.unit,
      file: one.file,
      said: one.verdict?.said ?? '',
    })),
    by: 'verdicts' as const,
    tally: row.tally,
  }))
}

function findingOf(mistake: Mistake): Finding {
  const tasks = mistake.seen.map((one) => one.task).join(', ')
  return {
    // The question alone: one proposal per question per project, for ever —
    // a third confirmation is not a second proposal, and one a person removed
    // stays removed, because a watch keeps every key it ever found.
    key: mistake.name,
    title: `${mistake.name} was confirmed real about ${tasks}: a check is proposed`,
    detail: checkProposal(mistake).context,
  }
}

/**
 * The watch: a question confirmed twice in this project becomes a proposed
 * check, parked.
 *
 * Standing, because being on costs nothing anybody has to agree to — it reads
 * the review log, asks the judge nothing and spends nothing, and what it makes
 * is work that waits for a person. With no key there is no reading and so no
 * verdict, and no schedule is written at all.
 */
export const mistakesWatch: ExtensionWatch = {
  id: 'mistakes',
  title: 'Mistakes made twice',
  means:
    'looks for a question the verdicts confirmed real about two changes in this project, and proposes a check a machine runs so it is not made a third time — parked until somebody picks it up',
  every: '1h',
  standing: true,
  check: async (ctx) => {
    const found = allowed(ctx, ctx.watching)
    return { found: mistakesIn(await recordOf(ctx), found.name).map(findingOf) }
  },
  agent: async (finding, ctx) => {
    const found = allowed(ctx, ctx.watching)
    const mistake = mistakesIn(await recordOf(ctx), found.name).find(
      (one) => one.name === finding.key,
    )
    if (!mistake) {
      throw new Error(
        `${finding.key} is not confirmed twice in ${found.name} any more: a verdict on it changed since the look`,
      )
    }
    return { ...checkProposal(mistake), parked: true }
  },
}
