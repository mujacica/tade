import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { installersHere, lookAtHarnesses, missingFrom, nativeProblems } from '../src/machine.ts'
import type { ProgramLook } from '../src/programs.ts'

// What this machine can run, for whoever is setting it up.
//
// The folds are answered with looks that are made up, because what they decide
// — whether a missing program is a reason to stop, and what command a person is
// about to be shown — is the part that has to be exact. What is real is the
// harness look and the native probe: both ask this machine, and both have to
// be honest about a machine that has none of it.

const config = ConfigSchema.parse({})
const HOME = mkdtempSync(join(tmpdir(), 'tade-machine-'))
const machine = { platform: 'darwin', managers: ['brew', 'npm'] }

const look = (over: Partial<ProgramLook> & { command: string }): ProgramLook =>
  ({
    need: {
      command: over.command,
      title: over.command,
      versionArgs: ['--version'],
      optional: false,
      inUse: true,
      needed: [{ what: 'Tade', why: 'because', inUse: true }],
      ...(over.need ?? {}),
    },
    install: null,
    version: null,
    latest: null,
    cannotTell: null,
    update: { cannot: 'nothing' },
    behind: false,
    ...over,
  }) as ProgramLook

describe('what is missing, and what would install it', () => {
  it('is only what is not here, with the exact command', () => {
    const missing = missingFrom(
      [
        look({
          command: 'tmux',
          need: {
            command: 'tmux',
            title: 'tmux',
            versionArgs: ['-V'],
            optional: false,
            inUse: true,
            needed: [{ what: 'the tmux driver', why: 'holding every lane', inUse: true }],
            install: { brew: 'tmux' },
          },
        }),
        // Here already: `install` on a look is where it was found.
        look({
          command: 'git',
          install: {
            manager: 'homebrew',
            name: 'git',
            where: '/opt/homebrew/bin/git',
            said: 'Homebrew',
          },
        }),
      ],
      machine,
    )
    expect(missing).toHaveLength(1)
    expect(missing[0]).toMatchObject({
      command: 'tmux',
      optional: false,
      why: 'holding every lane',
      install: { command: 'brew install tmux' },
    })
  })

  it('marks what nothing in use needs as optional, and keeps it in the list', () => {
    // A person switching to tmux wants to know whether tmux is there before
    // they switch, and nothing installs it on their behalf either way.
    const [only] = missingFrom(
      [
        look({
          command: 'tmux',
          need: {
            command: 'tmux',
            title: 'tmux',
            versionArgs: ['-V'],
            optional: false,
            inUse: false,
            needed: [{ what: 'the tmux driver', why: 'holding every lane', inUse: false }],
          },
        }),
      ],
      machine,
    )
    expect(only).toMatchObject({ optional: true })
  })

  it('says why there is no command rather than offering a wrong one', () => {
    const [gh] = missingFrom(
      [
        look({
          command: 'gh',
          need: {
            command: 'gh',
            title: 'GitHub CLI',
            versionArgs: ['--version'],
            optional: true,
            inUse: true,
            needed: [{ what: 'GitHub', why: 'finding your credential', inUse: true }],
            install: { brew: 'gh', instead: 'cli.github.com has the package for your system' },
          },
        }),
      ],
      { platform: 'linux', managers: [] },
    )
    expect(gh?.install).toEqual({ cannot: 'cli.github.com has the package for your system' })
  })
})

describe('what this machine installs with', () => {
  it('is only the managers that are actually on it', async () => {
    const here = installersHere()
    expect(here.platform).toBe(process.platform)
    for (const manager of here.managers) {
      expect(['brew', 'apt-get', 'dnf', 'npm']).toContain(manager)
    }
    // Nothing invented: a manager that is listed is one a lookup found.
    expect(installersHere({ PATH: '/nowhere-at-all' }).managers).toEqual([])
  })
})

describe('the native modules Tade is built on', () => {
  it('asks where the dependency is declared, so a machine that has it is left alone', async () => {
    // This package depends on better-sqlite3 and the tests run with it
    // installed, so nothing may be reported about it here. Asked from a
    // package that does not depend on it, the same `require` says it is
    // missing — which is a wizard telling somebody to fix a machine that is fine.
    const problems = await nativeProblems(HOME)
    expect(problems.map((one) => one.module)).not.toContain('better-sqlite3')
    for (const problem of problems) {
      expect(problem.clause.length).toBeGreaterThan(0)
      expect(problem.said.length).toBeGreaterThan(0)
    }
  })
})

describe('where each harness stands', () => {
  it('answers for every harness there is, and never invents one', async () => {
    const harnesses = await lookAtHarnesses(config, HOME)
    expect(harnesses.map((one) => one.id).sort()).toEqual(['claude-code', 'codex', 'pi'])
    // pi is the default, and the only one anything is set to use.
    expect(harnesses.find((one) => one.id === 'pi')?.inUse).toBe(true)
    expect(harnesses.find((one) => one.id === 'codex')?.inUse).toBe(false)
  }, 60_000)

  it('offers a sign-in only where the program is here, and an install where it is not', async () => {
    const harnesses = await lookAtHarnesses(config, HOME)
    for (const harness of harnesses) {
      // A sign-in for something that is not installed is a lane that fails;
      // one for something installed and signed out is the whole point, so
      // being signed in is never what decides it.
      if (!harness.installed) expect(harness.signIn).toBeNull()
      // And the install command is the harness's own declaration, never a
      // guess: each of the three either names a package manager or says why
      // there is nothing to run.
      if ('command' in harness.install) {
        expect(harness.install.command).toMatch(/^(brew|npm|sudo) /)
      } else {
        expect(harness.install.cannot.length).toBeGreaterThan(0)
      }
    }
  }, 60_000)
})
