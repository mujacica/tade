import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  installersHere,
  lookAtHarnesses,
  missingFrom,
  nativeProblems,
  serviceUnitPath,
  unattendedHere,
} from '../src/machine.ts'
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

  describe('a tmux older than its driver can use', () => {
    // The VPS this was found on: tmux 3.1 from the distribution, ticked in the
    // Programs list beside a workspace step calling it too old.
    const need = {
      command: 'tmux',
      title: 'tmux',
      versionArgs: ['-V'],
      optional: false,
      inUse: true,
      oldest: '3.2',
      needed: [{ what: 'the tmux driver', why: 'holding every lane', inUse: true }],
      install: { brew: 'tmux', apt: 'tmux', dnf: 'tmux' },
    }
    const debian = look({
      command: 'tmux',
      need,
      version: '3.1',
      tooOld: true,
      install: { manager: 'system', name: 'tmux', where: '/usr/bin/tmux', said: '' },
    })
    const brewed = look({
      command: 'tmux',
      need,
      version: '3.1c',
      tooOld: true,
      install: {
        manager: 'homebrew',
        name: 'tmux',
        brew: 'formula',
        where: '/opt/homebrew/Cellar/tmux/3.1c/bin/tmux',
        said: 'Homebrew',
      },
    })

    it('is missing on a server, with the apt line that brings it up to date', () => {
      const [tmux] = missingFrom([debian], { platform: 'linux', managers: ['apt-get'] })
      expect(tmux).toMatchObject({
        command: 'tmux',
        optional: false,
        tooOld: { have: '3.1', needs: '3.2' },
        install: { command: 'sudo apt-get update && sudo apt-get install -y tmux' },
      })
    })

    it('is missing on a Mac, with Homebrew’s upgrade', () => {
      const [tmux] = missingFrom([brewed], machine)
      expect(tmux).toMatchObject({
        tooOld: { have: '3.1c', needs: '3.2' },
        install: { command: 'brew upgrade tmux' },
      })
    })

    it('is optional where nothing in use needs it, and absent where it is new enough', () => {
      const spare = { ...need, inUse: false }
      expect(missingFrom([{ ...debian, need: spare }], machine)[0]).toMatchObject({
        optional: true,
        tooOld: { have: '3.1', needs: '3.2' },
      })
      expect(missingFrom([{ ...debian, version: '3.4', tooOld: false }], machine)).toEqual([])
      // A kept answer from before there were floors says nothing either way.
      const { tooOld: _, ...kept } = debian
      expect(missingFrom([kept as ProgramLook], machine)).toEqual([])
    })
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
    expect(harnesses.map((one) => one.id).sort()).toEqual(['acp', 'claude-code', 'codex', 'pi'])
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

describe('a server, read off three files', () => {
  /** A machine's root: systemd as its init or not, linger for `you` or not. */
  function machine(opts: { systemd: boolean; linger: boolean }) {
    const root = mkdtempSync(join(tmpdir(), 'tade-host-'))
    if (opts.systemd) mkdirSync(join(root, 'run', 'systemd', 'system'), { recursive: true })
    mkdirSync(join(root, 'var', 'lib', 'systemd', 'linger'), { recursive: true })
    if (opts.linger) writeFileSync(join(root, 'var', 'lib', 'systemd', 'linger', 'you'), '')
    const home = join(root, 'home', 'you')
    return { root, home, user: 'you' }
  }
  const ssh = { SSH_CONNECTION: '10.0.0.2 51022 10.0.0.1 22' }

  it('reads linger and the unit on a Linux box under systemd that nobody sits at', () => {
    const box = machine({ systemd: true, linger: false })
    const look = { ...box, env: ssh, platform: 'linux' as const }
    expect(unattendedHere(look)).toMatchObject({ user: 'you', linger: false, unit: null })

    writeFileSync(join(box.root, 'var', 'lib', 'systemd', 'linger', 'you'), '')
    const unit = serviceUnitPath(ssh, box.home)
    mkdirSync(join(unit, '..'), { recursive: true })
    writeFileSync(unit, '[Service]\n')
    expect(unattendedHere(look)).toMatchObject({ linger: true, unit })
    expect(unit).toBe(join(box.home, '.config', 'systemd', 'user', 'tade.service'))
  })

  it('puts the unit where XDG_CONFIG_HOME says, when it says', () => {
    expect(serviceUnitPath({ XDG_CONFIG_HOME: '/cfg' }, '/home/you')).toBe(
      '/cfg/systemd/user/tade.service',
    )
  })

  it('asks nothing of a Mac, a Linux desktop, or a box systemd does not run', () => {
    const box = machine({ systemd: true, linger: true })
    expect(unattendedHere({ ...box, env: ssh, platform: 'darwin' })).toBeNull()
    expect(unattendedHere({ ...box, env: { DISPLAY: ':0' }, platform: 'linux' })).toBeNull()
    const bare = machine({ systemd: false, linger: true })
    expect(unattendedHere({ ...bare, env: {}, platform: 'linux' })).toBeNull()
  })

  it('counts a service on a server, with nobody logged in, as a server', () => {
    const box = machine({ systemd: true, linger: true })
    expect(unattendedHere({ ...box, env: {}, platform: 'linux' })).toMatchObject({ linger: true })
  })
})
