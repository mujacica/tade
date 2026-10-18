import { execFileSync, spawn, spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmp } from './fixtures/mkrepo.ts'
import {
  ENDINGS,
  GUARDED,
  guarded,
  leftBehind,
  leftSaid,
  MADE_ENV,
  madeHere,
  ownTmp,
  prefixOf,
  ROOT,
  STALE_MS,
  serversSaid,
  stopServersUnder,
  sweepRoots,
} from './own-tmp.ts'

// The suite's temp root: every run writes under one of its own and takes it
// away at the end, a killed run's root is removed by a later one, and a full
// run that left anything in the machine's temp folder fails and says what.

/** A pid nothing can have: above the largest either macOS or Linux hands out. */
const GONE = 2 ** 22 + 1

/**
 * Run `make` as a process of the run `env` belongs to: what this process makes
 * goes in that run's ledger while it runs (`recordMade`, which every test file
 * loads), as it would for a test of that run.
 */
const asThisRun = (env: NodeJS.ProcessEnv, make: () => void) => {
  const was = process.env[MADE_ENV]
  process.env[MADE_ENV] = env[MADE_ENV]
  try {
    make()
  } finally {
    process.env[MADE_ENV] = was
  }
}

/** Something beside the suite making a folder: another process, which loaded nothing of it. */
const beside = (path: string) => execFileSync('mkdir', [path])

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
    expect(process.env.TADE_RUNTIME_DIR).toBe(root)
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
    expect(env).toEqual({
      TMPDIR: own.root,
      TMUX_TMPDIR: own.root,
      TADE_RUNTIME_DIR: own.root,
      // Where what it makes outside the root is written down: in the root.
      [MADE_ENV]: join(realpathSync(own.root), '.made-outside'),
    })
    mkdirSync(join(own.root, 'tade-repo-abc123', 'repo'), { recursive: true })
    await own.done()
    expect(existsSync(own.root)).toBe(false)
    expect(env).toEqual({ TMPDIR: '/somewhere/else/' })
  })
})

describe('a run ended before its teardown takes its root away as it goes', () => {
  /**
   * A process that makes a root the way the suite does and listens the way the
   * suite does — after a listener that exits a millisecond later, as vitest's
   * own does on SIGINT and SIGTERM — with a child of its own that has a child,
   * ended by `signal` once it has said where its root is. Answers the root,
   * the two processes it started and the status it ended with.
   */
  async function endedBy(
    signal: NodeJS.Signals,
  ): Promise<{ root: string; started: number[]; code: number | null }> {
    const dir = tmp('tade-run-')
    const script = join(dir, 'run.ts')
    const ownTmpAt = fileURLToPath(new URL('./own-tmp.ts', import.meta.url))
    writeFileSync(
      script,
      [
        'import { spawn } from "node:child_process"',
        `import { endWhatItStarted, onEnding, ownTmp } from ${JSON.stringify(ownTmpAt)}`,
        'for (const signal of ["SIGINT", "SIGTERM"]) {',
        '  process.once(signal, (_, number) => {',
        '    process.exitCode ??= 128 + number',
        '    setTimeout(() => process.exit(), 1)',
        '  })',
        '}',
        `const own = await ownTmp({ env: process.env, guard: false, base: ${JSON.stringify(dir)}, watch: [] })`,
        'onEnding(() => {',
        '  endWhatItStarted()',
        '  own.abandon()',
        '})',
        'const sh = spawn("sh", ["-c", "sleep 600 & echo $!; wait"], { stdio: ["ignore", "pipe", "ignore"] })',
        'let its = ""',
        'for await (const chunk of sh.stdout) {',
        '  its += String(chunk)',
        '  if (its.includes("\\n")) break',
        '}',
        'process.stdout.write([own.root, sh.pid, its.trim()].join(" ") + "\\n")',
        'setInterval(() => {}, 1_000)',
      ].join('\n'),
    )
    const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'inherit'] })
    const ended = new Promise<number | null>((done) => child.once('exit', (code) => done(code)))
    let said = ''
    for await (const chunk of child.stdout) {
      said += String(chunk)
      if (said.includes('\n')) break
    }
    if (!said.includes('\n')) throw new Error(`the run ended before it said its root: ${said}`)
    child.kill(signal)
    const [root = '', ...started] = said.trim().split(' ')
    return { root, started: started.map(Number), code: await ended }
  }

  /** Whether a pid is still a process. */
  const running = (pid: number) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  for (const signal of ENDINGS) {
    it(`on ${signal}, once what it started has ended, and ends with that signal's status`, async () => {
      const { root, started, code } = await endedBy(signal)
      expect(basename(root)).toMatch(new RegExp(`^${ROOT}\\d+-`))
      expect(code).toBe(128 + constants.signals[signal])
      expect(existsSync(root)).toBe(false)
      expect(started).toHaveLength(2)
      for (const pid of started) await expect.poll(() => running(pid)).toBe(false)
    })
  }

  it('safely twice, and before the teardown', async () => {
    const own = await ownTmp({ env: {}, guard: false, base: tmp('tade-base-'), watch: [] })
    mkdirSync(join(own.root, 'tade-repo-abc123'))
    own.abandon()
    own.abandon()
    expect(existsSync(own.root)).toBe(false)
    await expect(own.done()).resolves.toBeUndefined()
  })

  it('stopping a tmux server still running under it, and naming its sessions', () => {
    const root = tmp('tade-base-')
    const env = { ...process.env, TMUX_TMPDIR: root }
    const tmux = (...args: string[]) => spawnSync('tmux', ['-L', 'left', ...args], { env })
    expect(tmux('new-session', '-d', '-s', 'conf-abc12345', 'sleep 600').status).toBe(0)
    expect(stopServersUnder(root)).toEqual([{ socket: 'left', sessions: ['conf-abc12345'] }])
    expect(tmux('has-session').status).not.toBe(0)
    // Its socket is still there, and nothing answers on it.
    expect(stopServersUnder(root)).toEqual([])
    expect(stopServersUnder(join(root, 'none'))).toEqual([])
    expect(serversSaid([{ socket: 'left', sessions: ['conf-abc12345'] }])).toContain(
      'tmux -L left: conf-abc12345',
    )
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

  it('stopping a tmux server still running under it first, and naming it', async () => {
    const base = tmp('tade-base-')
    const left = join(base, `${ROOT}${GONE}-aaaaaa`)
    mkdirSync(left)
    const env = { ...process.env, TMUX_TMPDIR: left }
    const tmux = (...args: string[]) => spawnSync('tmux', ['-L', 'left', ...args], { env })
    expect(tmux('new-session', '-d', '-s', 'conf-abc12345', 'sleep 600').status).toBe(0)
    try {
      aged(left, STALE_MS + 60_000)
      const said: string[] = []
      expect(await sweepRoots(base, Date.now(), (line) => said.push(line))).toEqual([left])
      expect(tmux('has-session').status).not.toBe(0)
      expect(said.join('')).toContain('tmux -L left: conf-abc12345')
    } finally {
      tmux('kill-server')
    }
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
    asThisRun(env, () => {
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
    })

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

  it('answers only for what it made: what turned up beside it is named, and no failure', async () => {
    const real = tmp('tade-real-')
    const env: NodeJS.ProcessEnv = { TMPDIR: real }
    const said: string[] = []
    const own = await ownTmp({
      env,
      guard: true,
      base: tmp('tade-base-'),
      watch: [real],
      settleMs: 1,
      say: (line) => said.push(line),
    })
    // What another agent's fixture and a tool of the same name from outside
    // this repository made in the same folder while the run went on.
    beside(join(real, 'tade-repo-Oth3r1'))
    beside(join(real, 'tade-drive-Ext3r1'))
    await expect(own.done()).resolves.toBeUndefined()
    expect(said.join('')).toContain(
      `2 things under this repository's names turned up in the temp folders during this suite, made by something beside it`,
    )
    expect(said.join('')).toContain(join(real, 'tade-drive-Ext3r1'))
  })

  it('still fails for what it left among them, made in any of the ways a folder is made', async () => {
    const real = tmp('tade-real-')
    const env: NodeJS.ProcessEnv = { TMPDIR: real }
    const said: string[] = []
    const own = await ownTmp({
      env,
      guard: true,
      base: tmp('tade-base-'),
      watch: [real],
      settleMs: 1,
      say: (line) => said.push(line),
    })
    beside(join(real, 'tade-repo-Oth3r1'))
    // A test of this run that built its path from somewhere other than its
    // root, each way there is of making a folder in this process.
    const fs = await import('node:fs')
    const promised = await import('node:fs/promises')
    asThisRun(env, () => fs.mkdtempSync(join(real, 'tade-repo-')))
    asThisRun(env, () => fs.mkdirSync(join(real, 'tade-home-Abc123', 'deep'), { recursive: true }))
    process.env[MADE_ENV] = env[MADE_ENV]
    try {
      await new Promise<void>((done, fail) =>
        fs.mkdtemp(join(real, 'tcc-'), (err) => (err ? fail(err) : done())),
      )
      await new Promise<void>((done, fail) =>
        fs.mkdir(join(real, 'tcx-Abc123'), (err) => (err ? fail(err) : done())),
      )
      await promised.mkdtemp(join(real, 'wd-'))
      await promised.mkdir(join(real, 'wl-Abc123'))
    } finally {
      delete process.env[MADE_ENV]
    }
    // And a child of it that loaded the suite's setup, as a worker does.
    const child = spawnSync(
      process.execPath,
      [
        '--import',
        fileURLToPath(new URL('./made-here.ts', import.meta.url)),
        '--input-type=module',
        '-e',
        "import { mkdtempSync } from 'node:fs'; mkdtempSync(process.argv[1] + '/tade-child-')",
        real,
      ],
      { env: { ...process.env, ...env }, encoding: 'utf8' },
    )
    expect(child.stderr).toBe('')

    const failed = await own.done().then(
      () => null,
      (err: Error) => err.message,
    )
    expect(failed).toContain(`This suite left 7 things in ${real}`)
    for (const prefix of [
      'tade-repo-',
      'tade-home-',
      'tcc-',
      'tcx-',
      'wd-',
      'wl-',
      'tade-child-',
    ]) {
      expect(failed).toContain(`${prefix}*  1: ${join(real, prefix)}`)
    }
    expect(failed).not.toContain('Oth3r1')
    expect(said.join('')).toContain(`1 thing under this repository's names turned up`)
  })

  it('compares what it made as the path really is', () => {
    const real = tmp('tade-real-')
    const linked = `${tmp('tade-link-')}/to`
    execFileSync('ln', ['-s', real, linked])
    mkdirSync(join(real, 'tade-repo-Abc123'))
    expect(
      madeHere(
        [join(linked, 'tade-repo-Abc123'), join(linked, 'tade-repo-Def456')],
        new Set([join(real, 'tade-repo-Abc123')]),
      ),
    ).toEqual({
      mine: [join(linked, 'tade-repo-Abc123')],
      beside: [join(linked, 'tade-repo-Def456')],
    })
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
