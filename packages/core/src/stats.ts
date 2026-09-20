import type { TadeEvent } from './events.ts'

// What the agents produced, and what was verified — the other half of what
// they cost.
//
// `spendFrom` answers what was spent and `runtimeFrom` how long it took; both
// are about the asking. This is about the answering: how many commits, how
// much of a diff, and how the project's own checks have been going.
//
// A pure fold over the journal, like the others: events in, an account out, no
// I/O and no clock read. Everything here is read back out of `commit_seen` and
// `check_ran`, which are written once each at the moment they were true —
// because `git log` gives a different answer after every rebase, and a
// worktree's record of its runs goes when the worktree does.

/** What was committed. */
export interface Produced {
  commits: number
  /** How many of them said whose they were. The rest belong to nobody. */
  attributed: number
  added: number
  removed: number
  files: number
}

export function nothingProduced(): Produced {
  return { commits: 0, attributed: 0, added: 0, removed: 0, files: 0 }
}

/** How one check has been going. */
export interface CheckTally {
  check: string
  runs: number
  passed: number
  failed: number
  /** Everything else: skipped, cancelled, timed out. */
  other: number
  /** How long it takes, as the middle of what was recorded. Null where nothing was timed. */
  medianMs: number | null
}

export interface StatsReport {
  produced: Produced
  byProject: Record<string, Produced>
  /** Busiest check first, so the one that runs most is the one you read. */
  checks: CheckTally[]
}

export interface StatsWindow {
  /** Only events at or after this. */
  since: number
}

/** No window at all means everything ever recorded. */
export function statsFrom(
  events: readonly TadeEvent[],
  window: StatsWindow = { since: 0 },
): StatsReport {
  const report: StatsReport = { produced: nothingProduced(), byProject: {}, checks: [] }
  const checks = new Map<string, { tally: CheckTally; times: number[] }>()

  for (const event of events) {
    const at = Date.parse(event.ts)
    if (Number.isFinite(at) && at < window.since) continue

    if (event.type === 'commit_seen') {
      const project = String(event.detail.project ?? event.task?.split('/')[0] ?? 'elsewhere')
      const into = report.byProject[project] ?? nothingProduced()
      report.byProject[project] = into
      // The same numbers added to both, so a total and a per-project figure
      // can never disagree.
      for (const bucket of [report.produced, into]) {
        bucket.commits += 1
        if (event.detail.attributed === true) bucket.attributed += 1
        bucket.added += number(event.detail.added)
        bucket.removed += number(event.detail.removed)
        bucket.files += number(event.detail.files)
      }
      continue
    }

    if (event.type === 'check_ran') {
      const id = String(event.detail.check ?? 'unknown')
      const found = checks.get(id) ?? {
        tally: { check: id, runs: 0, passed: 0, failed: 0, other: 0, medianMs: null },
        times: [],
      }
      checks.set(id, found)
      found.tally.runs += 1
      const state = String(event.detail.state ?? '')
      if (state === 'passed') found.tally.passed += 1
      else if (state === 'failed' || state === 'timed out') found.tally.failed += 1
      else found.tally.other += 1
      const ms = number(event.detail.ms)
      if (ms > 0) found.times.push(ms)
    }
  }

  report.checks = [...checks.values()]
    .map(({ tally, times }) => ({ ...tally, medianMs: median(times) }))
    .sort((one, other) => other.runs - one.runs || one.check.localeCompare(other.check))
  return report
}

/**
 * The middle of what was recorded, not the mean: one check that hung for
 * twenty minutes would otherwise be reported as how long the suite takes.
 */
function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((one, other) => one - other)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0
    ? Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2)
    : (sorted[middle] ?? null)
}

function number(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

/** What `statsFrom` reads. One list, so a second reader cannot read less than the first. */
export const STATS_EVENTS = ['commit_seen', 'check_ran'] as const
