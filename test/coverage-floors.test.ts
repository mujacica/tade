import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  FLOOR,
  type Measured,
  MOVES,
  measure,
  packageOf,
  readCoverage,
  SLACK,
  UNSEEN,
} from '../scripts/coverage-floors.ts'

// The coverage gate, held to its own cases.
//
// A gate fails by quietly doing nothing, and this one runs after a two-minute
// suite where nobody is watching it — so every rule in it gets a reading that
// should fire it and a reading that should not. The readings are made up on
// purpose: a test that ran the real suite to check the gate would take two
// minutes to say something these say in a millisecond, and could only ever
// assert what today's coverage happens to be.
//
// The half that cannot be made up is the tables against the repository — a
// floor for a package that is gone, an exclusion for a file that moved — and
// that is `git ls-files` and nothing else. It runs in `test:smoke`, so a table
// that has outlived its files is said at the commit rather than after the
// suite.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Repo-relative paths of every `.ts` file git tracks under `packages/`. */
function tracked(): Set<string> {
  return new Set(
    execFileSync('git', ['ls-files', '-z', '--', 'packages'], { cwd: ROOT, encoding: 'utf8' })
      .split('\0')
      .filter((path) => path.endsWith('.ts')),
  )
}

/** A reading of one file: `at(path, 90)` is 90 of 100 lines. */
const at = (path: string, covered: number, lines = 100): Measured => ({ path, lines, covered })

/** A reading where every package sits exactly on its floor, and nothing else. */
function onTheFloor(): Measured[] {
  return Object.entries(FLOOR).map(([pkg, floor]) => at(`${pkg}/src/index.ts`, floor))
}

/** Every excluded file, read as the instrument really reads it: nothing ran. */
const excluded = (): Measured[] => Object.keys(UNSEEN).map((path) => at(path, 0, 10))

const problemsOf = (measured: Measured[]): string[] =>
  readCoverage([...measured, ...excluded()], tracked()).problems

describe('which package a file belongs to', () => {
  it('reads it off the src/ the file is under, nested or not', () => {
    expect(packageOf('packages/core/src/state.ts')).toBe('packages/core')
    expect(packageOf('packages/app/src/view/lane.ts')).toBe('packages/app')
    expect(packageOf('packages/drivers/pty/src/index.ts')).toBe('packages/drivers/pty')
    expect(packageOf('packages/mcp/core/src/naming.ts')).toBe('packages/mcp/core')
  })

  it('claims nothing that is not a package source', () => {
    // A test file, a script and a config are none of anybody's coverage: the
    // report should never hold them, and if it does they are not counted in.
    expect(packageOf('packages/core/test/state.test.ts')).toBeNull()
    expect(packageOf('scripts/coverage.ts')).toBeNull()
    expect(packageOf('vitest.config.ts')).toBeNull()
  })
})

describe('counting lines', () => {
  it('counts a line once however many statements start on it', () => {
    const [file] = measure(
      {
        '/repo/packages/core/src/a.ts': {
          statementMap: {
            0: { start: { line: 1 } },
            1: { start: { line: 1 } },
            2: { start: { line: 2 } },
          },
          s: { 0: 3, 1: 0, 2: 0 },
        },
      },
      '/repo/',
    )
    // Line 1 ran (one of its two statements did), line 2 did not.
    expect(file).toEqual({ path: 'packages/core/src/a.ts', lines: 2, covered: 1 })
  })

  it('spells paths the way the tables do', () => {
    const [file] = measure(
      { '/repo/packages/core/src/a.ts': { statementMap: {}, s: {} } },
      '/repo/',
    )
    expect(file?.path).toBe('packages/core/src/a.ts')
  })
})

describe('the floors', () => {
  it('says nothing when every package is on its floor', () => {
    expect(problemsOf(onTheFloor())).toEqual([])
  })

  it('names a package that slipped under, and says what to do', () => {
    const slipped = onTheFloor().map((file) =>
      file.path.startsWith('packages/core/') ? at(file.path, FLOOR['packages/core']! - 1) : file,
    )
    const [problem, ...rest] = problemsOf(slipped)
    expect(rest).toEqual([])
    expect(problem).toContain('packages/core covers 94.0% of its lines, under its floor of 95')
    expect(problem).toContain('a test that asserts')
    expect(problem).toContain('scripts/coverage-floors.ts')
  })

  it('asks a floor to follow the coverage up once the slack is too wide', () => {
    const climbed = onTheFloor().map((file) =>
      file.path.startsWith('packages/core/')
        ? at(file.path, FLOOR['packages/core']! + SLACK + 1)
        : file,
    )
    const [problem] = problemsOf(climbed)
    expect(problem).toContain('points of slack')
    expect(problem).toContain('Raise it to 99')
  })

  it('leaves exactly the slack it allows alone', () => {
    const climbed = onTheFloor().map((file) =>
      file.path.startsWith('packages/core/')
        ? at(file.path, FLOOR['packages/core']! + SLACK)
        : file,
    )
    expect(problemsOf(climbed)).toEqual([])
  })

  it('asks nothing of a package whose coverage depends on the machine', () => {
    // `harnesses/claude` reads fifteen points higher where Claude Code is
    // installed. The floor still holds; the slack rule would fire on half the
    // machines that run it and is skipped.
    const pkg = Object.keys(MOVES)[0]!
    const wide = onTheFloor().map((file) =>
      file.path.startsWith(`${pkg}/`) ? at(file.path, FLOOR[pkg]! + SLACK + 10) : file,
    )
    expect(problemsOf(wide)).toEqual([])
  })

  it('makes a new package a decision rather than a gap', () => {
    const [problem] = problemsOf([...onTheFloor(), at('packages/newthing/src/thing.ts', 88)])
    expect(problem).toContain('packages/newthing covers 88.0% of its lines and FLOOR does not name')
    expect(problem).toContain('at 87')
  })

  it('names a floor whose package the report never reached', () => {
    const [problem] = problemsOf(
      onTheFloor().filter((file) => !file.path.startsWith('packages/telemetry/')),
    )
    expect(problem).toContain('FLOOR names packages/telemetry')
    expect(problem).toContain('Delete its line')
  })
})

describe('what the instrument cannot see', () => {
  it('fails an excluded file the moment something runs it in process', () => {
    const path = Object.keys(UNSEEN)[0]!
    const measured = [...onTheFloor(), ...excluded().filter((file) => file.path !== path)]
    const [problem] = readCoverage([...measured, at(path, 4, 10)], tracked()).problems
    expect(problem).toContain(`${path} is excluded as unmeasurable, and 4 of its 10 lines ran`)
    expect(problem).toContain('delete its line from UNSEEN')
  })

  it('tells a file that moved from a file that is gone', () => {
    const path = Object.keys(UNSEEN)[0]!
    const short = [...onTheFloor(), ...excluded().filter((file) => file.path !== path)]
    // Still tracked: the report stopped reaching it, so `include` is the suspect.
    expect(readCoverage(short, tracked()).problems[0]).toContain('coverage report does not mention')
    // Not tracked any more: the line outlived its file.
    expect(readCoverage(short, new Set<string>()).problems[0]).toContain(
      'which this repository does not have',
    )
  })
})

describe('the tables against the repository', () => {
  it('excludes no file this repository does not have', () => {
    const known = tracked()
    expect(Object.keys(UNSEEN).filter((path) => !known.has(path))).toEqual([])
  })

  it('gives a floor to every package that has source', () => {
    const packages = new Set<string>()
    for (const path of tracked()) {
      const pkg = packageOf(path)
      if (pkg !== null) packages.add(pkg)
    }
    expect([...packages].filter((pkg) => !(pkg in FLOOR)).sort()).toEqual([])
    expect(
      Object.keys(FLOOR)
        .filter((pkg) => !packages.has(pkg))
        .sort(),
    ).toEqual([])
  })

  it('names, for every package whose coverage moves with the machine, why', () => {
    for (const [pkg, why] of Object.entries(MOVES)) {
      expect(pkg in FLOOR, pkg).toBe(true)
      expect(why).not.toBe('')
    }
  })
})
