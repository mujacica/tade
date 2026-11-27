import { describe, expect, it } from 'vitest'
import { readOutcome, summaryOf } from '../src/outcome.ts'

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

  it('names the files of a vitest run that stopped before its summary, from its listing', () => {
    // Timed out: what it printed is the listing as each file finished, and
    // nothing under it. Each failing file is still a place, so narrowing a red
    // batch has something to run again.
    const tail = [
      ' \x1b[32m✓\x1b[39m packages/core/test/state.test.ts \x1b[2m(40 tests)\x1b[22m 30ms',
      ' \x1b[31m❯\x1b[39m packages/app/test/frame.test.ts \x1b[2m(12 tests | \x1b[22m\x1b[31m3 failed\x1b[39m\x1b[2m)\x1b[22m 4567ms',
      '   \x1b[31m×\x1b[39m draws the strip 30ms',
      ' ❯ packages/workbench/test/lanes.test.ts (8 tests | 1 failed | 2 skipped) 900ms',
      ' ❯ packages/app/test/wire/queue.test.ts 3/20',
    ].join('\n')
    const outcome = readOutcome(tail)
    expect(outcome.counts).toEqual([])
    expect(outcome.places).toEqual([
      { path: 'packages/app/test/frame.test.ts', at: null, note: '12 tests | 3 failed' },
      {
        path: 'packages/workbench/test/lanes.test.ts',
        at: null,
        note: '8 tests | 1 failed | 2 skipped',
      },
    ])
    expect(outcome.read).toBe(true)
  })

  it('names a listed file once when a FAIL line names it too', () => {
    const tail = [
      ' ❯ packages/app/test/frame.test.ts (12 tests | 1 failed) 4567ms',
      ' ❯ packages/app/test/view.test.ts (3 tests | 1 failed) 10ms',
      ' FAIL  packages/app/test/frame.test.ts > the strip > draws',
      ' Test Files  2 failed | 1 passed (3)',
      '      Tests  2 failed | 13 passed (15)',
    ].join('\n')
    expect(readOutcome(tail).places).toEqual([
      { path: 'packages/app/test/frame.test.ts', at: null, note: 'the strip > draws' },
      { path: 'packages/app/test/view.test.ts', at: null, note: '3 tests | 1 failed' },
    ])
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

describe('the one line a run is recorded with', () => {
  it('is what a vitest tail counted, not the isolate hint it ends on', () => {
    const tail = [
      '\x1b[31m\x1b[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[2/2]⎯\x1b[22m\x1b[39m',
      '',
      '',
      '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m2 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m660 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m1 skipped\x1b[39m\x1b[90m (663)\x1b[39m',
      '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m1 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[1m\x1b[32m10698 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m18 skipped\x1b[39m\x1b[90m (10717)\x1b[39m',
      '\x1b[2m   Start at \x1b[22m 10:47:48',
      '\x1b[2m   Duration \x1b[22m 337.51s\x1b[2m (tests 93%, import 7%)\x1b[22m',
      '',
      '\x1b[2m    Isolate \x1b[22m \x1b[33m663 workers spawned\x1b[39m\x1b[2m · ~202ms startup each (spawn + environment, per file)\x1b[22m',
      '\x1b[2m            \x1b[22m \x1b[2mat least ~18.90s faster with \x1b[22m\x1b[33misolate: false\x1b[39m\x1b[2m — reuses workers across files instead of one per file\x1b[22m',
      '',
      '',
    ].join('\n')
    expect(summaryOf(tail)).toBe('1 failed · 10698 passed · 18 skipped · 2 files failed')
  })

  it('is the last thing said, without its colour, where nothing was counted', () => {
    expect(summaryOf('one\n\x1b[31m8 failed\x1b[39m\n\x1b[0m\n')).toBe('8 failed')
    expect(summaryOf('\x1b[0m\n\n')).toBeNull()
  })

  // `pnpm coverage` red on a floor with every test passed: the suite's own
  // summary, its isolate hint, then the floors' problems, each a paragraph.
  const passedSuite = [
    '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[32m671 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m1 skipped\x1b[39m\x1b[90m (672)\x1b[39m',
    '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[32m10814 passed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m\x1b[33m18 skipped\x1b[39m\x1b[90m (10832)\x1b[39m',
    '\x1b[2m   Start at \x1b[22m 12:00:38',
    '\x1b[2m   Duration \x1b[22m 261.68s\x1b[2m (tests 90%, import 8%, transform 1%)\x1b[22m',
    '',
    '\x1b[2m    Isolate \x1b[22m \x1b[33m672 workers spawned\x1b[39m\x1b[2m · ~175ms startup each (spawn + environment, per file)\x1b[22m',
    '\x1b[2m            \x1b[22m \x1b[2mat least ~16.61s faster with \x1b[22m\x1b[33misolate: false\x1b[39m\x1b[2m — reuses workers across files instead of one per file\x1b[22m',
    '',
    '',
  ]

  it('goes on with what a run said below counts that had no failure in them', () => {
    const tail = [
      ...passedSuite,
      'packages/cli/src/commands/setup.ts is excluded as unmeasurable, and 8 of its functions ran where loading it runs 1.',
      'Something runs what it does in process now, so it can be measured: delete its lines from',
      "UNSEEN and LOADED (scripts/coverage-floors.ts) and let its package's floor account for it. If what ran",
      'is still only what loading it runs, its count in LOADED is 8.',
      '',
      'packages/extensions/checks covers 83.1% of its lines, under its floor of 89.',
      'Cover what this change left behind — and cover it with a test that asserts',
      'something, because a test written to move this number is worse than none.',
      'If the floor is wrong, lower it in FLOOR (scripts/coverage-floors.ts) and say why in the commit',
      'message: a floor may go UP in the commit that earns it, and going down is an',
      'argument somebody has to make.',
      '',
      '',
    ].join('\n')
    expect(summaryOf(tail)).toBe(
      '10814 passed · 18 skipped · packages/extensions/checks covers 83.1% of its lines, under its floor of 89.',
    )
  })

  // The batch `a3e7e72:tests:here:4`, under Ubuntu's own Node: recorded as
  // `Node.js v22.22.1`, which is its last line and no reason at all.
  const noStripping = [
    'node:internal/modules/esm/get_format:219',
    '  throw new ERR_UNKNOWN_FILE_EXTENSION(ext, filepath);',
    '        ^',
    '',
    'TypeError [ERR_UNKNOWN_FILE_EXTENSION]: Unknown file extension ".ts" for ~/.tade/projects/tade/batch/scripts/coverage.ts',
    '    at Object.getFileProtocolModuleFormat [as file:] (node:internal/modules/esm/get_format:219:9)',
    '    at defaultGetFormat (node:internal/modules/esm/get_format:245:36)',
    '}',
    '',
    'Node.js v22.22.1',
    '',
  ].join('\n')

  it('says a Node that cannot run .ts has no type stripping, naming the Node it printed', () => {
    expect(summaryOf(noStripping)).toBe(
      'Node v22.22.1 cannot run .ts files: it has no type stripping (process.features.typescript is false)',
    )
    expect(summaryOf(noStripping.replace('Node.js v22.22.1', ''))).toMatch(
      /^This Node cannot run \.ts/,
    )
  })

  it('reads another unknown extension, or the same error under counts, as it did before', () => {
    expect(summaryOf(noStripping.replace('".ts"', '".vue"'))).toBe('Node.js v22.22.1')
    // The commit hook's smoke run: one test spawned that Node, and vitest counted it.
    const counted = `${noStripping}\n      Tests  1 failed | 1993 passed (1994)\n`
    expect(summaryOf(counted)).toBe('1 failed · 1993 passed')
  })

  it('is the counts alone where nothing below them is more than the suite’s own hint', () => {
    // A test's own output above the counts is not why they went red.
    const tail = ['stderr | packages/core/test/run.test.ts > logs', '', ...passedSuite].join('\n')
    expect(summaryOf(tail)).toBe('10814 passed · 18 skipped')
  })
})
