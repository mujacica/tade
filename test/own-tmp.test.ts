import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, realpathSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmp } from './fixtures/mkrepo.ts'
import {
  GUARDED,
  guarded,
  leftBehind,
  leftSaid,
  ownTmp,
  prefixOf,
  ROOT,
  STALE_MS,
  sweepRoots,
} from './own-tmp.ts'

// The suite's temp root: every run writes under one of its own and takes it
// away at the end, a killed run's root is removed by a later one, and a full
// run that left anything in the machine's temp folder fails and says what.

/** A pid nothing can have: above the largest either macOS or Linux hands out. */
const GONE = 2 ** 22 + 1

const aged = (path: string, ms: number) => {
  const at = (Date.now() - ms) / 1000
  utimesSync(path, at, at)
}

describe('a suite run has a temp root of its own', () => {
  it('is where this test, its home and anything it starts write', () => {
    const root = process.env.TMPDIR ?? ''
    expect(basename(root)).toMatch(new RegExp(`^${ROOT}\\d+-[A-Za-z0-9]{6}$`))
    expect(tmpdir()).toBe(root)
    expect(process.env.TMUX_TMPDIR).toBe(root)
    // test/own-home.ts made this file's home before any test ran.
    expect(realpathSync(process.env.HOME ?? '')).toContain(realpathSync(root))
    const child = execFileSync(
      process.execPath,
      ['-e', 'process.stdout.write(require("node:os").tmpdir())'],
      { encoding: 'utf8' },
    )
    expect(child).toBe(root)
  })

  it('points the environment at a new root, and puts it back and removes the root when done', async () => {
    const base = tmp('tade-base-')
    const env: NodeJS.ProcessEnv = { TMPDIR: '/somewhere/else/' }
    const own = await ownTmp({ env, guard: false, base, watch: [] })
    expect(dirname(own.root)).toBe(base)
    expect(basename(own.root)).toMatch(new RegExp(`^${ROOT}${process.pid}-`))
    expect(env).toEqual({ TMPDIR: own.root, TMUX_TMPDIR: own.root })
    mkdirSync(join(own.root, 'tade-repo-abc123', 'repo'), { recursive: true })
    await own.done()
    expect(existsSync(own.root)).toBe(false)
    expect(env).toEqual({ TMPDIR: '/somewhere/else/' })
  })
})

describe('a root a killed run left is removed by the next', () => {
  it('only once it is old and its suite is gone', async () => {
    const base = tmp('tade-base-')
    const make = (name: string, ms: number) => {
      const path = join(base, name)
      mkdirSync(join(path, 'tade-repo-abc123'), { recursive: true })
      aged(path, ms)
      return path
    }
    const old = STALE_MS + 60_000
    const left = make(`${ROOT}${GONE}-aaaaaa`, old)
    const running = make(`${ROOT}${process.pid}-bbbbbb`, old)
    const recent = make(`${ROOT}${GONE}-cccccc`, 60_000)
    // A folder a test called `tade-suite-…` is not a root: it has no pid.
    const notOne = make(`${ROOT}dddddd`, old)
    const other = make('tade-repo-eeeeee', old)

    expect(await sweepRoots(base, Date.now())).toEqual([left])
    expect(existsSync(left)).toBe(false)
    for (const kept of [running, recent, notOne, other]) expect(existsSync(kept)).toBe(true)
  })
})

describe('a full run leaves the temp folder as it found it', () => {
  it('fails naming each thing it left, by the prefix it was made with', async () => {
    const real = tmp('tade-real-')
    mkdirSync(join(real, 'tade-repo-before'))
    const env: NodeJS.ProcessEnv = { TMPDIR: real }
    const own = await ownTmp({
      env,
      guard: true,
      base: tmp('tade-base-'),
      watch: [real],
      settleMs: 1,
    })
    // Under the root goes with it.
    mkdirSync(join(own.root, 'tade-repo-inside'))
    // Beside it is left behind.
    for (const name of ['tade-repo-Abc123', 'tade-repo-Def456', 'tcc-Ghi789', 'tade-x y']) {
      mkdirSync(join(real, name))
    }
    // Not this repository's, a Tade window's own, and another run's root.
    for (const name of ['pi-editor-Jkl012', 'tade-tmux-Mno345', `${ROOT}${GONE}-pqr678`]) {
      mkdirSync(join(real, name))
    }

    const failed = await own.done().then(
      () => null,
      (err: Error) => err.message,
    )
    expect(failed).toContain(`This suite left 4 things in ${real}`)
    expect(failed).toContain(
      `tade-repo-*  2: ${join(real, 'tade-repo-Abc123')}, ${join(real, 'tade-repo-Def456')}`,
    )
    expect(failed).toContain(`tcc-*  1: ${join(real, 'tcc-Ghi789')}`)
    expect(failed).toContain(`tade-x y*  1: ${join(real, 'tade-x y')}`)
    for (const not of ['before', 'inside', 'pi-editor', 'tade-tmux', `${ROOT}${GONE}`]) {
      expect(failed).not.toContain(not)
    }
    expect(existsSync(own.root)).toBe(false)
  })

  it('passes when nothing new is there', async () => {
    const real = tmp('tade-real-')
    mkdirSync(join(real, 'tade-repo-before'))
    const own = await ownTmp({
      env: { TMPDIR: real },
      guard: true,
      base: tmp('tade-base-'),
      watch: [real],
    })
    mkdirSync(join(own.root, 'tade-repo-inside'))
    await expect(own.done()).resolves.toBeUndefined()
  })

  it('does not count what went again while it looked', async () => {
    const real = tmp('tade-real-')
    mkdirSync(join(real, 'tade-speech-Abc123'))
    const after = new Map([[real, new Set(['tade-speech-Abc123', 'tade-kh-Gone12'])]])
    expect(await leftBehind(new Map([[real, new Set()]]), after, 1)).toEqual([
      join(real, 'tade-speech-Abc123'),
    ])
  })

  it('is not asked of a narrow run', async () => {
    const real = tmp('tade-real-')
    const own = await ownTmp({ env: { TMPDIR: real }, guard: false, base: real, watch: [real] })
    mkdirSync(join(real, 'tade-repo-Abc123'))
    await expect(own.done()).resolves.toBeUndefined()
  })

  it('says a few of each prefix and how many more', () => {
    const paths = Array.from({ length: 7 }, (_, n) => `/t/tade-repo-abc12${n}`)
    const said = leftSaid([...paths, '/t/tcx-zzzzzz'], ['/t'])
    expect(said).toContain('This suite left 8 things in /t')
    expect(said).toContain(`tade-repo-*  7: ${paths.slice(0, 5).join(', ')}, and 2 more`)
    expect(said.indexOf('tade-repo-*')).toBeLessThan(said.indexOf('tcx-*'))
    expect(prefixOf('tade-test-home-Ab12cd')).toBe('tade-test-home-')
    expect(prefixOf('tade')).toBe('tade')
  })
})

describe('the guard knows every name this repository makes', () => {
  // Every prefix the code hands `tmp()` or `mkdtemp`, or joins onto
  // `tmpdir()`, as a literal. One the guard does not know is a folder a run
  // could leave in the temp folder without anybody being told.
  const ROOT_DIR = fileURLToPath(new URL('..', import.meta.url))
  const MADE = /(?:\btmp\(\s*|tmpdir\(\)\s*,\s*|tmpdir\(\)\}\/)(['"`])([^'"`$]+)/g

  it('guards each of them', () => {
    // The files that could say either, as git finds them, new ones included.
    const listed = execFileSync(
      'git',
      [
        'grep',
        '-l',
        '-z',
        '--untracked',
        '-F',
        '-e',
        'tmp(',
        '-e',
        'tmpdir()',
        '--',
        'packages',
        'test',
        'scripts',
      ],
      { cwd: ROOT_DIR, encoding: 'utf8' },
    )
      .split('\0')
      // Not this file, whose `git grep` patterns read as a call.
      .filter((path) => /\.(ts|m?js)$/.test(path) && path !== 'test/own-tmp.test.ts')
    const made = new Map<string, string>()
    for (const path of listed) {
      const text = readFileSync(join(ROOT_DIR, path), 'utf8')
      for (const match of text.matchAll(MADE)) {
        const prefix = match[2] ?? ''
        if (!made.has(prefix)) made.set(prefix, path)
      }
    }
    expect(made.size).toBeGreaterThan(50)
    const unguarded = [...made]
      .filter(([prefix]) => !GUARDED.some((one) => prefix.startsWith(one)))
      .map(([prefix, path]) => `'${prefix}' (${path})`)
    expect(
      unguarded,
      'Each of these is made in a temp folder under a name test/own-tmp.ts does not guard: ' +
        'add it to GUARDED, or name it after one that is there.',
    ).toEqual([])
    expect(guarded('tade-repo-Abc123')).toBe(true)
  })
})
