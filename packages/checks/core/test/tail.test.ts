import { describe, expect, it } from 'vitest'
import { plain, readOutcome } from '../src/outcome.ts'
import { FAILING_KEPT, keepTail } from '../src/tail.ts'

// Shaped like the related run that left this to be fixed: vitest's failure
// blocks, colour and code frame and all, ten of them in five files, which was
// recorded with the last four and three of the files.

const FILES = [
  'packages/cli/test/attach.test.ts',
  'packages/cli/test/attach.test.ts',
  'packages/cli/test/remote.test.ts',
  'packages/cli/test/cli.test.ts',
  'packages/cli/test/cli.test.ts',
  'packages/cli/test/lanes.test.ts',
  'packages/cli/test/checks.test.ts',
  'packages/cli/test/cli.test.ts',
  'packages/cli/test/tasks.test.ts',
  'packages/cli/test/tasks.test.ts',
]

function block(file: string, i: number): string {
  const frame = Array.from(
    { length: 8 },
    (_, line) =>
      `    \x1b[90m ${80 + line}|\x1b[39m   \x1b[34mexpect\x1b[39m(r\x1b[33m.\x1b[39mstdout)\x1b[33m.\x1b[39m\x1b[34mtoContain\x1b[39m(\x1b[32m'line ${line}'\x1b[39m)`,
  )
  return [
    `\x1b[41m\x1b[1m FAIL \x1b[22m\x1b[49m ${file}\x1b[2m > \x1b[22mtade CLI\x1b[2m > \x1b[22mfailure number ${i + 1}`,
    `\x1b[31m\x1b[1mError\x1b[22m: Test timed out in 30000ms.\x1b[39m`,
    `\x1b[36m \x1b[2m❯\x1b[22m ${file}:\x1b[2m${87 + i}:3\x1b[22m\x1b[39m`,
    ...frame,
    '',
    `\x1b[31m\x1b[2m⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[${i + 1}/10]⎯\x1b[22m\x1b[39m`,
    '',
  ].join('\n')
}

const RUN = [
  ...Array.from({ length: 300 }, (_, i) => ` ✓ packages/core/test/t${i}.test.ts (21 tests) 12ms`),
  '',
  '\x1b[31m⎯⎯⎯⎯⎯⎯⎯ Failed Tests 10 ⎯⎯⎯⎯⎯⎯⎯\x1b[39m',
  '',
  ...FILES.map(block),
  '\x1b[2m Test Files \x1b[22m \x1b[1m\x1b[31m5 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m782 passed (788)',
  '\x1b[2m      Tests \x1b[22m \x1b[1m\x1b[31m10 failed\x1b[39m\x1b[22m\x1b[2m | \x1b[22m12448 passed (12486)',
  '',
  '[ELIFECYCLE] Command failed with exit code 1.',
  '',
].join('\n')

function kept(text: string, room: number, chunk: number): string {
  const tail = keepTail(room)
  for (let at = 0; at < text.length; at += chunk) tail.add(text.slice(at, at + chunk))
  return tail.text()
}

describe('the tail a run is kept as', () => {
  it('names every failure and every failed file, though their blocks are more than the room', () => {
    // The premise: the end alone holds only some of them.
    expect(readOutcome(RUN.slice(-4_000)).places.filter((one) => one.note).length).toBeLessThan(10)
    const text = kept(RUN, 4_000, 512)
    expect(text.length).toBeLessThanOrEqual(4_000)
    const named = readOutcome(text, { places: 40 }).places.filter((one) => one.note)
    expect(named.map((one) => one.note)).toEqual(
      expect.arrayContaining(FILES.map((_, i) => `tade CLI > failure number ${i + 1}`)),
    )
    expect(new Set(named.map((one) => one.path))).toEqual(new Set(FILES))
    expect(text.startsWith('[cut from the front of this output, the failures it named:]')).toBe(
      true,
    )
    expect(text.endsWith('[ELIFECYCLE] Command failed with exit code 1.\n')).toBe(true)
  })

  it('names the same failures however the output arrived', () => {
    const one = kept(RUN, 4_000, RUN.length)
    expect(kept(RUN, 4_000, 7)).toBe(one)
    expect(kept(RUN, 4_000, 4_096)).toBe(one)
  })

  it('keeps the end alone, as before, when nothing cut named a failure', () => {
    const passing = Array.from({ length: 500 }, (_, i) => ` ✓ test ${i}`).join('\n')
    expect(kept(passing, 4_000, 300)).toBe(passing.slice(-4_000))
    expect(kept('short\n', 4_000, 3)).toBe('short\n')
  })

  it('counts the failures there is no room to name, rather than dropping them', () => {
    const many = [...Array.from({ length: 60 }, (_, i) => block(`a/f${i}.test.ts`, i)), 'end'].join(
      '\n',
    )
    const text = kept(many, 4_000, 1_000)
    expect(text.length).toBeLessThanOrEqual(4_000)
    const head = text.split('\n\n')[0] ?? ''
    const listed = head.split('\n').filter((line) => line.startsWith(' FAIL')).length
    const counted = Number(/\[and (\d+) more\]/.exec(head)?.[1])
    // What the end still holds is not in the list above it.
    const inEnd = plain(text.slice(head.length))
      .split('\n')
      .filter((line) => line.startsWith(' FAIL')).length
    expect(inEnd).toBeGreaterThan(0)
    expect(listed + counted + inEnd).toBe(60)
  })
})

describe('the last failure a run named', () => {
  it('is kept after the count when the names are more than the room', () => {
    const many = [...Array.from({ length: 60 }, (_, i) => block(`a/f${i}.test.ts`, i)), 'end'].join(
      '\n',
    )
    const text = kept(many, 4_000, 1_000)
    expect(text.length).toBeLessThanOrEqual(4_000)
    const head = (text.split('\n\n')[0] ?? '').split('\n')
    const count = head.findIndex((line) => /^\[and \d+ more\]$/.test(line))
    expect(count).toBeGreaterThan(0)
    // The one straight after the count is the last name the cut part held.
    const cut = plain(many.slice(0, many.length - 3_000))
      .split('\n')
      .filter((line) => line.startsWith(' FAIL'))
      .at(-1)
    expect(head[count + 1]).toBe(cut)
  })

  it("is named from vitest's listing when the run stopped before its summary", () => {
    // Timed out or killed: no `FAIL` blocks, only each file's line as it
    // finished, and a page of passing ones after it.
    const stopped = [
      ' ❯ packages/app/test/a.test.ts (8 tests | 1 failed) 719ms',
      '   × keeps the failure that stopped it 30012ms',
      ...Array.from(
        { length: 400 },
        (_, i) => ` ✓ packages/core/test/t${i}.test.ts (21 tests) 12ms`,
      ),
    ].join('\n')
    const text = kept(stopped, 4_000, 512)
    expect(text.length).toBeLessThanOrEqual(4_000)
    expect(text).toContain(' ❯ packages/app/test/a.test.ts (8 tests | 1 failed) 719ms')
    expect(text).toContain('   × keeps the failure that stopped it 30012ms')
  })

  it('never takes a stack frame or a passing file for a failure', () => {
    const passing = [
      ' ❯ packages/app/test/wire/harness.ts:206:15',
      ' ❯ packages/core/test/b.test.ts (3 tests) 9ms',
      ...Array.from({ length: 400 }, (_, i) => ` ✓ test ${i}`),
    ].join('\n')
    expect(kept(passing, 4_000, 300)).toBe(passing.slice(-4_000))
  })
})

describe('every file a run named as failing', () => {
  // Shaped like the full run at 7a487708: about 165 failing files, of which
  // the tail named the first few and `[and 159 more]`.
  const failing = Array.from({ length: 165 }, (_, i) => `packages/p${i}/test/t.test.ts`)
  const run = [
    ...failing.map((file, i) => `\x1b[31m❯\x1b[39m ${file} (${i + 2} tests | 1 failed) 30001ms`),
    ...failing.map(block),
    ' Test Files  165 failed | 500 passed (665)',
    '      Tests  165 failed | 9000 passed (9165)',
  ].join('\n')

  function read(text: string, chunk: number) {
    const tail = keepTail(4_000)
    for (let at = 0; at < text.length; at += chunk) tail.add(text.slice(at, at + chunk))
    return tail.failing()
  }

  it('is every one of them, in the order named, though the tail holds a few', () => {
    expect(readOutcome(kept(run, 4_000, 512), { places: 400 }).places.length).toBeLessThan(165)
    expect(read(run, 512)).toEqual({ files: failing, more: 0 })
  })

  it('is the same however the output arrived, a last line with no newline included', () => {
    const one = read(run, run.length)
    expect(read(run, 7)).toEqual(one)
    const unended = `${run}\n FAIL  packages/last/test/x.test.ts > stopped`
    expect(read(unended, 5).files.at(-1)).toBe('packages/last/test/x.test.ts')
    // Asking does not use the unended line up.
    const tail = keepTail(4_000)
    tail.add(' FAIL  a/b.test.ts > one')
    expect(tail.failing()).toEqual(tail.failing())
  })

  it('is at most FAILING_KEPT names, and the rest counted', () => {
    const lots = Array.from({ length: FAILING_KEPT + 25 }, (_, i) => ` FAIL  t/f${i}.test.ts > x`)
    const said = read(lots.join('\n'), 1_000)
    expect(said.files).toHaveLength(FAILING_KEPT)
    expect(said.files[0]).toBe('t/f0.test.ts')
    expect(said.more).toBe(25)
  })

  it('is nothing for a run that named none', () => {
    const passing = Array.from({ length: 500 }, (_, i) => ` ✓ t${i}.test.ts (3 tests) 2ms`)
    expect(read(passing.join('\n'), 300)).toEqual({ files: [], more: 0 })
  })
})
