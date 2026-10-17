// What is known about one change beside its state: what became of the judge's
// findings about it, and what its own commits changed — each a count, and none
// of them a probability.
//
// A fold and nothing else. The findings are what a judge's own record says
// (the extensions' `findings` hook), the commits what git counted, and nothing
// here is remembered. A race reads both about every entrant (`race.ts`), and a
// replay what a change touched.

/**
 * What became of the findings about one change: none of them a probability.
 *
 * `open` nobody has answered; `answered` its agent accounted for and nobody
 * has judged; `confirmed` somebody judged real and the newest reading still
 * raises; `dismissed` somebody judged a false positive. A finding a later
 * reading no longer raises, and nobody judged, is in none of them: it went.
 */
export interface FindingCounts {
  open: number
  answered: number
  confirmed: number
  dismissed: number
}

/** One finding, as much of it as a count reads. */
export interface FindingFacts {
  tasks: readonly string[]
  stillThere: boolean
  account: { did: string } | null
  verdict: { was: 'confirmed' | 'false positive' } | null
}

/**
 * What a task's own commits — the ones whose trailer names it — changed, or
 * null where nothing has looked at them yet. A count git could not give is null.
 */
export type ChangeSize = { commits: number; added: number | null; removed: number | null } | null

/** What became of the findings about one task (`FindingCounts`). */
export function findingsFor(findings: readonly FindingFacts[], task: string): FindingCounts {
  const out: FindingCounts = { open: 0, answered: 0, confirmed: 0, dismissed: 0 }
  for (const one of findings) {
    if (!one.tasks.includes(task)) continue
    if (one.verdict?.was === 'false positive') out.dismissed++
    else if (one.verdict?.was === 'confirmed') {
      if (one.stillThere) out.confirmed++
    } else if (!one.stillThere) continue
    else if (one.account !== null) out.answered++
    else out.open++
  }
  return out
}

/** One commit, as git's `--shortstat` counted it: `files` null where it printed no stat line. */
interface Counted {
  files: number | null
  added: number | null
  removed: number | null
}

/**
 * What a task's own commits changed, added up; null where nothing looked at
 * them. A commit git printed a stat line for and that line left a half out of
 * changed none of that half — git writes no `0 deletions(-)` — while a commit
 * with no stat line at all, a merge, is one nobody can count.
 */
export function sizeOf(mine: readonly Counted[] | null): ChangeSize {
  if (mine === null) return null
  const sum = (pick: (one: Counted) => number | null): number | null =>
    mine.reduce<number | null>((total, one) => {
      const n = one.files === null ? null : (pick(one) ?? 0)
      return total === null || n === null ? null : total + n
    }, 0)
  return {
    commits: mine.length,
    added: sum((one) => one.added),
    removed: sum((one) => one.removed),
  }
}
