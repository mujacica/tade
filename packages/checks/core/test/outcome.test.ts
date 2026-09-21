import { describe, expect, it } from 'vitest'
import { readOutcome } from '../src/outcome.ts'

// Real tails, colour and all: what these commands actually print here, taken
// from `.tade/checks.jsonl`. A fixture that is tidier than the output is a
// fixture that passes while the page says nothing.

describe('what a run printed, read back', () => {
  it('reads vitest: the tests, the failing files, and nothing it did not say', () => {
    const tail = [
      ' \x1b[31m FAIL \x1b[0m packages/app/test/screens.test.ts > what-an-agent-has-done',
      '',
      ' ❯ packages/app/test/screens.test.ts:37:5',
      '',
      '\x1b[2m Test Files \x1b[22m \x1b[31m1 failed\x1b[39m\x1b[2m | \x1b[22m131 passed | 1 skipped\x1b[90m (133)\x1b[39m',
      '\x1b[2m      Tests \x1b[22m \x1b[31m4 failed\x1b[39m\x1b[2m | \x1b[22m2072 passed | 3 skipped\x1b[90m (2079)\x1b[39m',
      '\x1b[2m   Duration \x1b[22m 121.44s',
    ].join('\n')
    const outcome = readOutcome(tail)
    expect(outcome.counts).toEqual([
      { label: 'failed', count: 4, tone: 'bad' },
      { label: 'passed', count: 2072, tone: 'good' },
      { label: 'skipped', count: 3, tone: 'quiet' },
      { label: 'files failed', count: 1, tone: 'bad' },
    ])
    expect(outcome.places[0]).toEqual({
      path: 'packages/app/test/screens.test.ts',
      at: null,
      note: 'what-an-agent-has-done',
    })
    // The same file twice — once as FAIL, once as ❯ — is one place.
    expect(outcome.places).toHaveLength(2)
    expect(outcome.read).toBe(true)
  })

  it('reads a green vitest run without inventing a failure', () => {
    const tail = [
      '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m152 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m1 skipped\x1b[39m\x1b[90m (153)\x1b[39m',
      '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m2559 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m3 skipped\x1b[39m\x1b[90m (2562)\x1b[39m',
    ].join('\n')
    const outcome = readOutcome(tail)
    expect(outcome.counts).toEqual([
      { label: 'passed', count: 2559, tone: 'good' },
      { label: 'skipped', count: 3, tone: 'quiet' },
    ])
    expect(outcome.places).toEqual([])
  })

  it('reads biome: how many files it checked, what it found, and which files', () => {
    const tail = [
      'packages/app/src/view.ts:367:1 lint/complexity/noForEach  FIXABLE  ━━━━━━━━━━━━━━━━━━',
      '',
      '  × Prefer for...of',
      '',
      './packages/app/test/scenarios.ts format ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '',
      '  × File content differs from formatting output',
      '',
      'Checked 493 files in 297ms. No fixes applied.',
      'Found 9 errors.',
      'Found 4 warnings.',
      'ci ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
    ].join('\n')
    const outcome = readOutcome(tail)
    expect(outcome.counts).toEqual([
      { label: 'files checked', count: 493, tone: 'quiet' },
      { label: 'errors', count: 9, tone: 'bad' },
      { label: 'warnings', count: 4, tone: 'quiet' },
    ])
    expect(outcome.places).toEqual([
      { path: 'packages/app/src/view.ts', at: '367:1', note: 'lint/complexity/noForEach' },
      { path: 'packages/app/test/scenarios.ts', at: null, note: 'format' },
    ])
  })

  it('reads tsc: where the type errors are, counted as it counted them', () => {
    const tail = [
      "packages/checks/core/src/coverage.ts(5,15): error TS2305: Module './records.ts' has no exported member 'At'.",
      "packages/app/src/view.ts(2283,7): error TS2304: Cannot find name 'actionRows'.",
    ].join('\n')
    const outcome = readOutcome(tail)
    expect(outcome.counts).toEqual([{ label: 'type errors', count: 2, tone: 'bad' }])
    expect(outcome.places[0]?.path).toBe('packages/checks/core/src/coverage.ts')
    expect(outcome.places[0]?.at).toBe('5:15')
    expect(outcome.places[0]?.note).toContain('TS2305')
  })

  it('takes tsc at its own word when it counted them itself', () => {
    const tail = ['src/a.ts(1,1): error TS1005: expected.', 'Found 12 errors in 4 files.'].join(
      '\n',
    )
    expect(readOutcome(tail).counts).toEqual([{ label: 'type errors', count: 12, tone: 'bad' }])
  })

  it('keeps a handful of places and counts the rest, rather than a page of rows', () => {
    const tail = Array.from(
      { length: 9 },
      (_, i) => `src/file${i}.ts(${i + 1},1): error TS2304: Cannot find name 'x'.`,
    ).join('\n')
    const outcome = readOutcome(tail, { places: 4 })
    expect(outcome.places).toHaveLength(4)
    expect(outcome.more).toBe(5)
  })

  it('says it read nothing rather than inventing a shape it does not know', () => {
    expect(readOutcome('some other tool, some other words\nand a second line')).toEqual({
      counts: [],
      places: [],
      more: 0,
      read: false,
    })
    expect(readOutcome('').read).toBe(false)
  })

  it('reads jest’s summary where nothing else recognised the output', () => {
    const outcome = readOutcome('Tests:       3 failed, 40 passed, 43 total')
    expect(outcome.counts).toEqual([
      { label: 'failed', count: 3, tone: 'bad' },
      { label: 'passed', count: 40, tone: 'good' },
    ])
  })
})
