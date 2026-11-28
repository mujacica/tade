import { relative } from 'node:path'

// What `scripts/coverage.ts` decides about a sharded suite, with no machine
// under it, so `test/shards.test.ts` can hold it to its cases.
//
// CI splits the suite four ways per OS (`ci.yml`): each shard runs one quarter
// of the files with the blob reporter, and one job per OS merges the blobs with
// `vitest --merge-reports` and holds the merged coverage to the floors. A shard
// is told which it is by `VITEST_SHARD` in its job's `env:` and never by its
// step's `run:`, because Tade reads that step as the local `tests` check and a
// `run:` with `${{ … }}` in it is one it cannot run here
// (`packages/checks/core/src/ci.ts`). With the variable unset — on a laptop, in
// a batch, in `checks_run` — the whole suite runs as it always has.

/** The variable a shard's job sets: `i/N`, the i-th of N, from 1. */
export const SHARD_ENV = 'VITEST_SHARD'

/** Where a shard writes its blob, and where the merge reads them: vitest's own default. */
export const BLOBS = '.vitest-reports'

export interface Shard {
  index: number
  total: number
}

/**
 * Which shard this run is: null for the whole suite (unset or empty), the
 * shard where it is well formed, and a sentence where it is not — a typo here
 * would otherwise run some other slice, or all of it, and still go green.
 */
export function shardOf(raw: string | undefined): Shard | null | string {
  const text = (raw ?? '').trim()
  if (text === '') return null
  const match = /^(\d+)\/(\d+)$/.exec(text)
  const index = Number(match?.[1])
  const total = Number(match?.[2])
  if (!match || index < 1 || total < 1 || index > total) {
    return `${SHARD_ENV} is ${JSON.stringify(raw)}, which is not a shard: it is i/N, the i-th of N counted from 1, such as 2/4.`
  }
  return { index, total }
}

/** The blob a shard writes, named so the merge can tell a set from part of one. */
export function blobName(shard: Shard): string {
  return `blob-${shard.index}-${shard.total}.json`
}

/**
 * What is wrong with a set of blobs, or null when it is every shard of one
 * split exactly once. A shard that died before writing its blob would
 * otherwise merge as a suite with a quarter of its files missing, and its
 * coverage would read as the floors failing rather than as the shard failing.
 */
export function blobSetProblem(names: readonly string[]): string | null {
  const blobs = names.filter((name) => name.endsWith('.json'))
  if (blobs.length === 0) return 'There are no blobs to merge.'
  const shards: Shard[] = []
  for (const name of blobs) {
    const match = /^blob-(\d+)-(\d+)\.json$/.exec(name)
    if (!match) return `${name} is not a shard's blob (blob-<i>-<N>.json).`
    shards.push({ index: Number(match[1]), total: Number(match[2]) })
  }
  const totals = new Set(shards.map((shard) => shard.total))
  if (totals.size > 1) {
    return `The blobs are from different splits (${[...totals].sort((a, b) => a - b).join(', ')} ways).`
  }
  const total = shards[0]?.total ?? 0
  const have = new Set(shards.map((shard) => shard.index))
  const missing: number[] = []
  for (let index = 1; index <= total; index++) if (!have.has(index)) missing.push(index)
  if (missing.length > 0) {
    return `Shard${missing.length === 1 ? '' : 's'} ${missing.join(', ')} of ${total} left no blob.`
  }
  return null
}

/** The part of vitest's JSON report this reads. */
export interface JsonReport {
  success?: boolean
  testResults?: readonly { name?: string; startTime?: number; endTime?: number }[]
}

/**
 * Every test file and how long it took, slowest first, as lines to print. A
 * shard is never shorter than its slowest file, so these are the names that
 * decide how far splitting can go. A file whose times are missing is listed
 * with `—`, last, rather than as nought.
 */
export function durationLines(report: JsonReport, root: string): string[] {
  const rows = (report.testResults ?? []).map((file) => {
    const ms =
      typeof file.startTime === 'number' && typeof file.endTime === 'number'
        ? file.endTime - file.startTime
        : null
    return { path: relative(root, file.name ?? '') || (file.name ?? '?'), ms }
  })
  rows.sort((a, b) => (b.ms ?? -1) - (a.ms ?? -1) || a.path.localeCompare(b.path))
  const known = rows.filter((row) => row.ms !== null)
  const total = known.reduce((sum, row) => sum + (row.ms ?? 0), 0)
  const said = (ms: number | null): string => (ms === null ? '—' : `${(ms / 1000).toFixed(1)}s`)
  return [
    `per-file durations, slowest first: ${rows.length} files, ${said(total)} of test time${
      known.length < rows.length ? ` in the ${known.length} that said` : ''
    }`,
    ...rows.map((row) => `${said(row.ms).padStart(8)}  ${row.path}`),
  ]
}
