import { describe, expect, it } from 'vitest'
import { blobName, blobSetProblem, durationLines, shardOf } from '../scripts/shards.ts'

// The suite split across CI's machines, and the two ways that could go green
// while checking less: a shard told something it misreads, and a merge missing
// a shard that died before it wrote anything.

describe('which shard a run is', () => {
  it('runs the whole suite with nothing set, as it always has', () => {
    expect(shardOf(undefined)).toBeNull()
    expect(shardOf('')).toBeNull()
    expect(shardOf('  ')).toBeNull()
  })

  it('reads i/N', () => {
    expect(shardOf('2/4')).toEqual({ index: 2, total: 4 })
    expect(shardOf('1/1')).toEqual({ index: 1, total: 1 })
  })

  it('refuses anything else rather than run some other slice', () => {
    for (const raw of ['0/4', '5/4', '2', '2/0', 'two/four', '/4', '2/4/8', '-1/4']) {
      expect(shardOf(raw), raw).toMatch(/is not a shard/)
    }
  })
})

describe('a set of blobs', () => {
  const blobs = (total: number, ...indexes: number[]): string[] =>
    indexes.map((index) => blobName({ index, total }))

  it('is merged when it is every shard of one split', () => {
    expect(blobSetProblem(blobs(4, 1, 2, 3, 4))).toBeNull()
    expect(blobSetProblem(blobs(4, 4, 2, 1, 3))).toBeNull()
  })

  it('is refused with a shard missing, empty, or mixed', () => {
    expect(blobSetProblem(blobs(4, 1, 2, 4))).toBe('Shard 3 of 4 left no blob.')
    expect(blobSetProblem(blobs(4, 1))).toBe('Shards 2, 3, 4 of 4 left no blob.')
    expect(blobSetProblem([])).toBe('There are no blobs to merge.')
    expect(blobSetProblem([...blobs(4, 1, 2, 3, 4), ...blobs(2, 1)])).toBe(
      'The blobs are from different splits (2, 4 ways).',
    )
    expect(blobSetProblem([...blobs(2, 1, 2), 'stray.json'])).toBe(
      "stray.json is not a shard's blob (blob-<i>-<N>.json).",
    )
  })
})

describe('per-file durations', () => {
  it('names every file, slowest first, relative to the checkout', () => {
    const lines = durationLines(
      {
        testResults: [
          { name: '/repo/packages/a/test/quick.test.ts', startTime: 1000, endTime: 1250 },
          { name: '/repo/packages/cli/test/serve.test.ts', startTime: 0, endTime: 121_000 },
          { name: '/repo/test/guide.test.ts', startTime: 10, endTime: 3010 },
        ],
      },
      '/repo',
    )
    expect(lines).toEqual([
      'per-file durations, slowest first: 3 files, 124.3s of test time',
      '  121.0s  packages/cli/test/serve.test.ts',
      '    3.0s  test/guide.test.ts',
      '    0.3s  packages/a/test/quick.test.ts',
    ])
  })

  it('lists a file with no times last and as unknown, never as nought', () => {
    const lines = durationLines(
      {
        testResults: [
          { name: '/repo/test/silent.test.ts' },
          { name: '/repo/test/timed.test.ts', startTime: 0, endTime: 2000 },
        ],
      },
      '/repo',
    )
    expect(lines).toEqual([
      'per-file durations, slowest first: 2 files, 2.0s of test time in the 1 that said',
      '    2.0s  test/timed.test.ts',
      '       —  test/silent.test.ts',
    ])
  })
})
