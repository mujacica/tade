import { describe, expect, it } from 'vitest'
import {
  compareVersions,
  declarationProblems,
  installOf,
  installWith,
  isBehind,
  neededPrograms,
  parseVersion,
  type RequiredProgram,
  TADE_PROGRAMS,
  updateWith,
} from '../src/programs.ts'

// What Tade runs, and what it takes to keep it current.
//
// Every version string here is one a real program actually prints, and every
// path is one a real install actually produces — the point of the whole
// exercise is that Tade says `brew upgrade gh` to somebody who installed gh
// with Homebrew and says nothing at all to somebody who dropped a binary in
// ~/bin, and a fixture kinder than reality would hide exactly that.
//
// Nothing here reaches the network or the disk: the look-up is the caller's,
// and what it found is the argument.

describe('reading a version out of whatever a program prints', () => {
  it('reads the versions the programs Tade runs actually print', () => {
    expect(parseVersion('git version 2.39.5 (Apple Git-154)')).toBe('2.39.5')
    expect(parseVersion('tmux 3.4')).toBe('3.4')
    expect(parseVersion('v22.18.0')).toBe('22.18.0')
    expect(
      parseVersion('gh version 2.62.0 (2024-11-14)\nhttps://github.com/cli/cli/releases'),
    ).toBe('2.62.0')
    expect(parseVersion('2.0.5 (Claude Code)')).toBe('2.0.5')
    expect(parseVersion('pi 0.9.1-beta.3')).toBe('0.9.1-beta.3')
  })

  it('says nothing rather than inventing a number', () => {
    expect(parseVersion('')).toBeNull()
    expect(parseVersion('command not found')).toBeNull()
    expect(parseVersion('unknown option --version')).toBeNull()
  })

  it('orders versions, with a release ahead of its own prereleases', () => {
    expect(compareVersions('2.39.5', '2.40.0')).toBe(-1)
    expect(compareVersions('2.40.0', '2.39.5')).toBe(1)
    expect(compareVersions('3.4', '3.4.0')).toBe(0)
    expect(compareVersions('1.0.0-rc1', '1.0.0')).toBe(-1)
    expect(compareVersions('1.0.0', '1.0.0-rc1')).toBe(1)
    expect(compareVersions('1.10.0', '1.9.0')).toBe(1)
  })

  it('is never behind on a version nobody could read', () => {
    expect(isBehind(null, '2.0.0')).toBe(false)
    expect(isBehind('2.0.0', null)).toBe(false)
    expect(isBehind('1.0.0', '2.0.0')).toBe(true)
    expect(isBehind('2.0.0', '2.0.0')).toBe(false)
  })
})

describe('how a program got onto this machine', () => {
  it('reads Homebrew off the Cellar the link points into', () => {
    const install = installOf({
      path: '/opt/homebrew/bin/gh',
      realPath: '/opt/homebrew/Cellar/gh/2.62.0/bin/gh',
    })
    expect(install.manager).toBe('homebrew')
    expect(install.name).toBe('gh')
    expect(updateWith(install)).toEqual({ command: 'brew upgrade gh' })
  })

  it('tells a cask from a formula, because they are two different namespaces', () => {
    // The cask `claude` is Anthropic's desktop app and the cask
    // `claude-code` is the agent: asking about the wrong one answers
    // confidently about something else, which is how this was found.
    const install = installOf({
      path: '/opt/homebrew/bin/claude',
      realPath: '/opt/homebrew/Caskroom/claude-code/2.1.236/claude',
    })
    expect(install.manager).toBe('homebrew')
    expect(install.brew).toBe('cask')
    expect(install.name).toBe('claude-code')
    expect(updateWith(install)).toEqual({ command: 'brew upgrade --cask claude-code' })
  })

  it('says what ships with Tade is Tade’s, whatever package it looks like', () => {
    // `npm install --global @earendil-works/pi-coding-agent` would install a
    // second copy that nothing would ever run: pi moves when Tade moves.
    const install = installOf({
      path: '/Users/x/tade/packages/harnesses/pi/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      realPath:
        '/Users/x/tade/node_modules/.pnpm/@earendil-works+pi-coding-agent@0.85.1/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js',
      package: { name: '@earendil-works/pi-coding-agent', version: '0.85.1', dir: '/x' },
      withinTade: true,
    })
    expect(install.manager).toBe('tade')
    expect(install.version).toBe('0.85.1')
    expect(updateWith(install)).toMatchObject({ cannot: expect.stringContaining('updating Tade') })
  })

  it('reads an Intel-Mac Homebrew, whose bin is /usr/local', () => {
    const install = installOf({
      path: '/usr/local/bin/tmux',
      realPath: '/usr/local/Cellar/tmux/3.5a/bin/tmux',
    })
    expect(install.manager).toBe('homebrew')
    expect(install.name).toBe('tmux')
  })

  it('reads a global npm package as the package it is, not the command it answers to', () => {
    const install = installOf({
      path: '/usr/local/bin/claude',
      realPath: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      package: { name: '@anthropic-ai/claude-code', version: '2.0.5', dir: '/x' },
    })
    expect(install.manager).toBe('npm')
    expect(install.name).toBe('@anthropic-ai/claude-code')
    expect(install.version).toBe('2.0.5')
    expect(updateWith(install)).toEqual({
      command: 'npm install --global @anthropic-ai/claude-code@latest',
    })
  })

  it('tells pnpm from npm by the folder the package lives in', () => {
    const install = installOf({
      path: '/Users/x/Library/pnpm/pi',
      realPath: '/Users/x/Library/pnpm/global/5/node_modules/@pi/cli/bin/pi.js',
      package: { name: '@pi/cli', version: '0.9.1', dir: '/y' },
    })
    expect(install.manager).toBe('pnpm')
    expect(updateWith(install)).toEqual({ command: 'pnpm add --global @pi/cli@latest' })
  })

  it('tells Volta, which owns the package rather than merely holding it', () => {
    const install = installOf({
      path: '/Users/x/.volta/bin/pi',
      realPath: '/Users/x/.volta/tools/image/packages/pi/lib/node_modules/pi/bin/pi.js',
      package: { name: 'pi', version: '0.9.1', dir: '/y' },
    })
    expect(install.manager).toBe('volta')
    expect(updateWith(install)).toEqual({ command: 'volta install pi@latest' })
  })

  it('calls what came with the system the system’s, and says who updates it', () => {
    const install = installOf({ path: '/usr/bin/git', realPath: '/usr/bin/git' })
    expect(install.manager).toBe('system')
    expect(updateWith(install)).toMatchObject({ cannot: expect.stringContaining('xcode-select') })
  })

  it('says it cannot tell for a binary somebody dropped on their PATH', () => {
    const install = installOf({ path: '/Users/x/bin/tmux', realPath: '/Users/x/bin/tmux' })
    expect(install.manager).toBe('path')
    const update = updateWith(install)
    expect(update).toMatchObject({ cannot: expect.stringContaining('nothing here claims') })
  })

  it('names the version manager where one owns the runtime itself', () => {
    expect(
      installOf({
        path: '/Users/x/.nvm/versions/node/v22.18.0/bin/node',
        realPath: '/Users/x/.nvm/versions/node/v22.18.0/bin/node',
      }).manager,
    ).toBe('nvm')
    expect(
      installOf({
        path: '/Users/x/.local/share/mise/installs/node/22/bin/node',
        realPath: '/Users/x/.local/share/mise/installs/node/22/bin/node',
      }).manager,
    ).toBe('mise')
    expect(
      installOf({
        path: '/Users/x/.asdf/shims/node',
        realPath: '/Users/x/.asdf/installs/nodejs/22.18.0/bin/node',
      }).manager,
    ).toBe('asdf')
  })

  it('never offers a command it is not sure of', () => {
    for (const manager of ['asdf', 'nvm', 'system', 'path'] as const) {
      const update = updateWith({ manager, name: 'node', where: '/x', said: 'x' })
      expect(update).not.toHaveProperty('command')
      expect((update as { cannot: string }).cannot.length).toBeGreaterThan(20)
    }
  })
})

describe('folding what the ports declare into one list', () => {
  const tmux: RequiredProgram = {
    command: 'tmux',
    title: 'tmux',
    why: 'holding every lane',
    versionArgs: ['-V'],
  }
  const git: RequiredProgram = {
    command: 'git',
    title: 'git',
    why: 'reading a project',
    versionArgs: ['--version'],
  }

  it('says a program once, with every reason it is needed under it', () => {
    const needs = neededPrograms([
      { what: 'Tade', inUse: true, programs: [git] },
      { what: 'the tmux driver', inUse: false, programs: [tmux, git] },
    ])
    expect(needs.map((need) => need.command)).toEqual(['git', 'tmux'])
    expect(needs[0]?.needed.map((one) => one.what)).toEqual(['Tade', 'the tmux driver'])
  })

  it('keeps a program nothing in use needs, and says so', () => {
    const needs = neededPrograms([{ what: 'the tmux driver', inUse: false, programs: [tmux] }])
    expect(needs[0]?.inUse).toBe(false)
  })

  it('is required if anything requires it, however many call it optional', () => {
    const needs = neededPrograms([
      { what: 'GitHub', inUse: true, programs: [{ ...git, optional: true }] },
      { what: 'Tade', inUse: true, programs: [git] },
    ])
    expect(needs[0]?.optional).toBe(false)
    expect(
      neededPrograms([{ what: 'GitHub', inUse: true, programs: [{ ...git, optional: true }] }])[0]
        ?.optional,
    ).toBe(true)
  })
})

describe('what a port may declare', () => {
  it('lets a port declare nothing', () => {
    expect(declarationProblems(undefined)).toEqual([])
    expect(declarationProblems([])).toEqual([])
  })

  it('refuses one nobody could look up or ask', () => {
    expect(
      declarationProblems([
        { command: '/usr/local/bin/gh', title: 'gh', why: 'because', versionArgs: ['--version'] },
      ]),
    ).toHaveLength(1)
    expect(
      declarationProblems([{ command: 'gh', title: '', why: 'because', versionArgs: ['-v'] }]),
    ).toHaveLength(1)
    expect(
      declarationProblems([{ command: 'gh', title: 'gh', why: 'because', versionArgs: [] }]),
    ).toHaveLength(1)
  })

  it('holds Tade’s own declarations to the same rule', () => {
    expect(declarationProblems(TADE_PROGRAMS)).toEqual([])
  })
})

describe('what would install a program that is not here', () => {
  const machine = (managers: string[], platform = 'darwin') => ({ platform, managers })

  it('prefers the machine’s own package manager over a global npm install', () => {
    const how = { brew: 'tmux', apt: 'tmux', npm: 'tmux-but-not-really' }
    expect(installWith(how, machine(['brew', 'npm']))).toEqual({ command: 'brew install tmux' })
    expect(installWith(how, machine(['apt-get', 'npm'], 'linux'))).toEqual({
      command: 'sudo apt-get install -y tmux',
    })
    // npm is the fallback and the only one that is the same everywhere.
    expect(installWith(how, machine(['npm'], 'linux'))).toEqual({
      command: 'npm install --global tmux-but-not-really',
    })
  })

  it('says which of the two Homebrew namespaces it means', () => {
    expect(installWith({ brew: 'claude-code', cask: true }, machine(['brew']))).toEqual({
      command: 'brew install --cask claude-code',
    })
  })

  it('offers only a manager this machine actually has', () => {
    // A `brew install` on a machine with no Homebrew is a command that fails
    // in a terminal somebody is watching, which is worse than a sentence.
    const answer = installWith({ brew: 'gh' }, machine([], 'linux'))
    expect(answer).toEqual({
      cannot: 'it installs with Homebrew, and this machine has none of them',
    })
  })

  it('says what to do instead where there is nothing to run', () => {
    expect(installWith({ brew: 'git', instead: 'xcode-select --install' }, machine([]))).toEqual({
      cannot: 'xcode-select --install',
    })
    expect(installWith(undefined, machine(['brew']))).toEqual({
      cannot: 'nothing here says how to install it',
    })
  })

  it('carries a declaration’s install through the fold, and never loses one', () => {
    const tmux = {
      command: 'tmux',
      title: 'tmux',
      why: 'holding lanes',
      versionArgs: ['-V'],
      install: { brew: 'tmux' },
    }
    // Two ports needing one program is one row, and the row keeps the way to
    // install it whichever of them declared it.
    const both = neededPrograms([
      { what: 'a driver with no idea', inUse: false, programs: [{ ...tmux, install: undefined }] },
      { what: 'the tmux driver', inUse: true, programs: [tmux] },
    ])
    expect(both).toHaveLength(1)
    expect(installWith(both[0]?.install, machine(['brew']))).toEqual({
      command: 'brew install tmux',
    })
  })

  it('refuses an install declaration that offers nothing', () => {
    expect(
      declarationProblems([
        { command: 'gh', title: 'gh', why: 'because', versionArgs: ['-v'], install: {} },
      ]),
    ).toHaveLength(1)
    expect(
      declarationProblems([
        {
          command: 'gh',
          title: 'gh',
          why: 'because',
          versionArgs: ['-v'],
          install: { cask: true },
        },
      ]),
    ).toHaveLength(2)
  })
})
