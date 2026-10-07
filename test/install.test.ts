import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { COMMAND, PUBLISHED, rootManifest } from '../scripts/release/repo.ts'

// What has to be true of `curl -fsSL https://tade.sh/install.sh | sh`.
//
// The script is twenty lines of shell that run one command, and the reason it
// has a test file of its own is that none of what makes it trustworthy is
// about whether it installs: it is about what it tells you first, what it
// refuses to touch, and that the numbers in it are still the numbers in
// `package.json`. None of that fails loudly on its own — a stale Node floor
// turns somebody away from an install that would have worked, and a `sudo` or
// a line written into a shell profile would be found by whoever read the
// script afterwards, which is nobody.
//
// What it does *not* do is install anything. The suite is held to zero network
// calls, and the thing that proves an install works is the release's own dry
// run, which installs the tarball into a directory of its own and runs the
// `tade` inside it.

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const PATH_IN_REPO = 'scripts/install.sh'
const SCRIPT = join(ROOT, PATH_IN_REPO)
const text = readFileSync(SCRIPT, 'utf8')
const lines = text.split('\n')

const scratch = mkdtempSync(join(tmpdir(), 'tade-install-'))
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** The script, run with `sh`, which is what a pipe into `sh` is. */
function run(args: string[], env: Record<string, string> = {}) {
  // `/bin/sh` by path, because some of these runs hand the script a PATH with
  // nothing on it, and a shell that cannot be found is a different test.
  return spawnSync('/bin/sh', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 30_000,
  })
}

/**
 * A directory holding a `node` that answers like an old one, plus the real
 * `sh` and friends. Point PATH at it and the script's own version check is
 * what gets exercised, rather than this machine's Node.
 */
function fakeNode(says: string, exits: number): string {
  const bin = mkdtempSync(join(scratch, 'bin-'))
  const shim = join(bin, 'node')
  writeFileSync(
    shim,
    `#!/bin/sh\ncase "$1" in --version) echo '${says}' ;; --eval) exit ${exits} ;; esac\n`,
  )
  chmodSync(shim, 0o755)
  return bin
}

/**
 * The same, plus an `npm` answering the version given — a Node new enough to
 * pass the floor, so what the run exercises is the npm branch and nothing
 * else.
 *
 * What the script passes npm depends on npm's own version (`--allow-scripts`
 * landed in 11.19), so a dry run that reads whichever npm the machine happens
 * to have is a test about the machine. That is not a hypothetical: the lines
 * below were written on a laptop with npm 11.19.1 and went red on CI's 10.9.9,
 * where the flag is correctly left off.
 */
function fakeNpm(version: string): string {
  const bin = fakeNode(`v${process.versions.node}`, 0)
  const shim = join(bin, 'npm')
  writeFileSync(shim, `#!/bin/sh\ncase "$1" in --version) echo '${version}' ;; esac\n`)
  chmodSync(shim, 0o755)
  return bin
}

describe('the script itself', () => {
  it('is POSIX sh, and stops on an error rather than carrying on', () => {
    expect(lines[0]).toBe('#!/bin/sh')
    expect(lines).toContain('set -eu')
  })

  it('parses as sh, not only as whatever this machine calls bash', () => {
    // `sh` on macOS is bash in disguise and forgives things dash does not,
    // which is most of Linux. Both where both are here.
    expect(spawnSync('/bin/sh', ['-n', SCRIPT]).status).toBe(0)
    const dash = spawnSync('dash', ['-n', SCRIPT])
    if (dash.error === undefined) expect(dash.status).toBe(0)
  })

  it('passes shellcheck, where the machine has one', () => {
    const checked = spawnSync('shellcheck', ['--shell=sh', SCRIPT], { encoding: 'utf8' })
    // A check that could not run is not a check that found nothing: say which
    // it was, rather than letting an absent shellcheck read as a green one.
    if (checked.error !== undefined) {
      expect(checked.error.message).toMatch(/ENOENT/)
      return
    }
    expect(`${checked.stdout}${checked.stderr}`).toBe('')
    expect(checked.status).toBe(0)
  })

  // The budget is on the lines that *do* something, so explaining itself
  // costs nothing and a wall of shell is still a wall. 125 today; this may go
  // DOWN in the commit that earns it and never up, because the day this needs
  // half as much again is the day it is doing something a person piping it
  // into a shell cannot check. Same ratchet as `test/modularity.test.ts`.
  it('is small enough that somebody can read all of it', () => {
    const doing = lines.filter((line) => line.trim() !== '' && !line.trim().startsWith('#'))
    expect(doing.length).toBeLessThanOrEqual(135)
  })
})

describe('what it says it will do', () => {
  it('prints the command before the line that runs it', () => {
    // Structural, because this is the one promise the script makes that no
    // run can demonstrate: what is printed and what is run are the same list
    // of words — `$*` and then `"$@"`, in that order and with nothing between
    // them that could change it.
    const printed = text.indexOf('say "  $*"')
    const ran = text.indexOf('\n  "$@"\n')
    expect(printed).toBeGreaterThan(0)
    expect(ran).toBeGreaterThan(printed)
    expect(text.slice(printed, ran)).not.toMatch(/\bset --/)
  })

  it('does nothing at all until its last line, so half of it does nothing', () => {
    // The failure this is about has been seen on the URL it is served from:
    // ask for a file a static host does not have and some of them answer a
    // page of HTML with a 200. A dropped connection is the same shape. So
    // every prefix of this file must be inert — a prefix may fail to parse,
    // and may not print or install anything.
    expect(lines.filter((line) => line.trim() !== '').at(-1)).toBe('main "$@"')
    for (const cut of [0.25, 0.5, 0.75, 0.95]) {
      const half = join(scratch, `cut-${cut}.sh`)
      writeFileSync(half, lines.slice(0, Math.floor(lines.length * cut)).join('\n'))
      const said = spawnSync('/bin/sh', [half], { encoding: 'utf8', timeout: 30_000 })
      expect(said.stdout, `${cut} of the script printed something`).toBe('')
    }
  })

  it('says the package it installs is the one this repository publishes', () => {
    expect(text).toContain(`PACKAGE='${PUBLISHED}'`)
    expect(text).toContain(`COMMAND='${COMMAND}'`)
  })

  it('needs the Node that `engines` declares, to the same two numbers', () => {
    // A floor that drifts turns somebody away from an install that would have
    // worked — or lets them through to a `tade` that refuses at the door for
    // a reason the installer could have given them first.
    const declared = rootManifest().engines.node
    const floor = /^>=(\d+\.\d+)/.exec(declared ?? '')?.[1]
    expect(floor).toBeTruthy()
    expect(text).toContain(`NEEDS_NODE='${floor}'`)
  })

  it('names the two native dependencies the manifest says are built', () => {
    const built = rootManifest().pnpm.onlyBuiltDependencies
    expect(built).toContain('node-pty')
    expect(built).toContain('better-sqlite3')
    for (const one of built) expect(text).toContain(`'${one}'`)
  })
})

describe('what it will not touch', () => {
  // Each of these is a thing an install script is routinely expected to do and
  // this one may not, because a script arriving down a pipe is a script
  // nobody read: what the package manager changes is the whole of what
  // changes.
  const forbidden: Array<[string, RegExp]> = [
    ['run anything as root', /\bsudo\b|\bdoas\b/],
    // Shell `eval` only. `node --eval` with a literal expression is a line of
    // this script like any other; `eval` on text that arrived from anywhere is
    // the thing a piped installer must never contain.
    ['evaluate text as code', /(?<![-\w])eval\b/],
    ['fetch anything of its own', /\bcurl\b|\bwget\b|\bfetch\b/],
    ['delete anything', /\brm\b/],
    ['append to any file', />>/],
    ['write a shell profile', /\.(?:zshrc|bashrc|bash_profile|profile)\b/],
  ]
  for (const [what, pattern] of forbidden) {
    it(`does not ${what}`, () => {
      // The comments talk about PATH and profiles, so only what runs counts.
      const doing = lines.filter((line) => !line.trim().startsWith('#')).join('\n')
      expect(doing).not.toMatch(pattern)
    })
  }

  it('never asks a question, because a pipe leaves nothing to answer with', () => {
    const doing = lines.filter((line) => !line.trim().startsWith('#')).join('\n')
    expect(doing).not.toMatch(/\bread\b|\/dev\/tty/)
  })
})

describe('a dry run', () => {
  // The three install lines in full: what the script passes on a person's
  // behalf, and **not** what anybody quotes. The README and the site quote the
  // short forms — `npm install -g tade-sh`, with `pnpm approve-builds -g` or
  // `bun pm -g trust --all` beside the other two — and the flags below are the
  // whole reason the one-liner is worth having. Putting these four lines on a
  // page would be quoting the wrong thing; an agent syncing the site nearly
  // did, off an earlier version of this comment.
  //
  // Every one of them runs against a PATH of this file's own making rather
  // than the machine's, so each line is a fact about the script — see
  // `fakeNpm`, and the two tests under these for the npm the flag is held
  // back from.
  const NEW_NPM = '11.19.1'
  const expected: Record<string, string> = {
    npm: `npm install --global --allow-scripts=${PUBLISHED},node-pty,better-sqlite3 ${PUBLISHED}`,
    pnpm: `pnpm add --global --allow-build=${PUBLISHED} --allow-build=node-pty --allow-build=better-sqlite3 ${PUBLISHED}`,
    bun: `bun add --global --trust ${PUBLISHED}`,
  }

  for (const [manager, line] of Object.entries(expected)) {
    it(`with --${manager} prints the whole command and installs nothing`, () => {
      const said = run([`--${manager}`, '--dry-run'], { PATH: fakeNpm(NEW_NPM) })
      expect(said.status).toBe(0)
      expect(said.stdout).toContain(`\n  ${line}\n`)
      expect(said.stdout).toContain('from npm')
    })
  }

  // The other half of the npm line, and the half nothing held: an older npm
  // ran a dependency's install scripts anyway, so there is nothing to ask it
  // for, and asking would be a warning about a config it does not know plus a
  // flag that does nothing. The install is still the right install — which is
  // why this asserts the whole line rather than only the absence.
  it('leaves --allow-scripts off an npm that would not understand it', () => {
    const said = run(['--npm', '--dry-run'], { PATH: fakeNpm('10.9.9') })
    expect(said.status).toBe(0)
    expect(said.stdout).toContain(`\n  npm install --global ${PUBLISHED}\n`)
    expect(said.stdout).not.toContain('--allow-scripts')
  })

  // 11.18 and 11.19 differ by the minor, and shell has no version compare, so
  // the script picks the number apart itself. A test per side of the one
  // boundary, because "11 is new enough" is the shape that mistake takes.
  it('reads the minor rather than the major, on either side of 11.19', () => {
    const sides: Array<[string, boolean]> = [
      ['10.9.9', false],
      ['11.18.4', false],
      ['11.19.0', true],
      ['12.0.0', true],
    ]
    for (const [version, flagged] of sides) {
      const said = run(['--npm', '--dry-run'], { PATH: fakeNpm(version) })
      expect(said.status, version).toBe(0)
      expect(said.stdout.includes('--allow-scripts='), version).toBe(flagged)
    }
  })

  it('asks for a version where one was given, and never otherwise', () => {
    expect(run(['--dry-run', '--version', '0.2.0']).stdout).toContain(`${PUBLISHED}@0.2.0`)
    expect(run(['--dry-run'], { TADE_INSTALL_VERSION: '0.3.0' }).stdout).toContain(
      `${PUBLISHED}@0.3.0`,
    )
    expect(run(['--dry-run']).stdout).not.toContain('@')
  })

  it('takes the manager from the environment too, which is all a pipe allows', () => {
    expect(run(['--dry-run'], { TADE_INSTALL_WITH: 'bun' }).stdout).toContain('bun add')
  })

  it('hands a version to the package manager as one word, never to a shell', () => {
    // The version is one argv word to the package manager and never a line
    // for a shell, so the worst a semicolon can do is fail to resolve.
    const said = run(['--dry-run', '--version', '0.2.0; touch /tmp/tade-install-test'])
    expect(said.status).toBe(0)
    expect(said.stdout).toContain('0.2.0; touch /tmp/tade-install-test')
  })
})

describe('what it refuses, and how', () => {
  it('says what it takes, and stops, where a flag is not one of them', () => {
    const said = run(['--yarn'])
    expect(said.status).toBe(1)
    expect(said.stderr).toContain('--help')
    expect(said.stdout).toBe('')
  })

  it('answers --help without installing anything', () => {
    const said = run(['--help'])
    expect(said.status).toBe(0)
    expect(said.stdout).toContain('--pnpm')
    expect(said.stdout).toContain('--bun')
    expect(said.stdout).toContain('--dry-run')
  })

  it('names the version it needs where Node is too old, not just that it is', () => {
    const said = run(['--dry-run'], { PATH: fakeNode('v20.11.0', 1) })
    expect(said.status).toBe(1)
    expect(said.stderr).toContain('22.19')
    expect(said.stderr).toContain('v20.11.0')
  })

  it('says where to get Node where there is none, rather than failing at npm', () => {
    const empty = mkdtempSync(join(scratch, 'empty-'))
    const said = run(['--dry-run'], { PATH: empty })
    expect(said.status).toBe(1)
    expect(said.stderr).toContain('nodejs.org')
    expect(said.stderr).not.toContain('command not found')
  })

  it('names the manager that is missing where it was asked for by name', () => {
    // Not a dry run — a dry run prints the line whether or not the manager is
    // there, which is half of what makes the three lines above testable
    // anywhere. Only half: the npm line also depends on npm's *version*, so
    // being present is not enough and `fakeNpm` pins that too. A PATH with
    // nothing on it but a Node that answers is how this stays the same test on
    // a machine that happens to have all three.
    const said = run(['--bun'], { PATH: fakeNode(`v${process.versions.node}`, 0) })
    expect(said.status).toBe(1)
    expect(said.stderr).toContain('bun')
  })

  it('names all three where the machine has none of them', () => {
    const said = run([], { PATH: fakeNode(`v${process.versions.node}`, 0) })
    expect(said.status).toBe(1)
    for (const one of ['npm', 'pnpm', 'bun']) expect(said.stderr).toContain(one)
  })
})

describe('the repository around it', () => {
  it('is tracked and executable, so what the website serves is what ran here', () => {
    const listed = execFileSync('git', ['ls-files', '-s', '--', PATH_IN_REPO], {
      cwd: ROOT,
      encoding: 'utf8',
    })
    expect(listed).toMatch(/^100755 /)
  })
})
