import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { askWhatIsCurrent, lookAtPrograms, programsNeeded, whereIs } from '../src/programs.ts'

// What Tade runs, read off this machine.
//
// Nothing here reaches the network: what a registry would say is answered by
// a `fetch` that is handed in, and what a program would print is answered by
// an `exec` that is. What is real is the PATH walk and the link-following,
// because that is the part that decides whether a person is told `brew
// upgrade gh` or nothing at all.

const config = ConfigSchema.parse({})
const HOME = '/tmp/tade-programs-test'

const exec = (answers: Record<string, string>) => async (command: string) => ({
  code: answers[command] === undefined ? 127 : 0,
  stdout: answers[command] ?? '',
  stderr: answers[command] === undefined ? `${command}: not found` : '',
})

describe('what the ports say Tade needs', async () => {
  const needs = await programsNeeded(config, HOME)
  const commandOf = (command: string) => needs.find((need) => need.command === command)

  it('asks every driver, harness and forge rather than holding a list', () => {
    // Each of these is declared by something — none of them is written down
    // here — and every one of them must arrive with a reason attached.
    for (const command of ['git', 'node', 'tmux', 'pi', 'claude', 'gh']) {
      const need = commandOf(command)
      expect(need, `nothing declared ${command}`).toBeTruthy()
      expect(need?.needed.length ?? 0).toBeGreaterThan(0)
      for (const one of need?.needed ?? []) expect(one.why.length).toBeGreaterThan(5)
    }
  })

  it('says each program once, however many things need it', () => {
    const commands = needs.map((need) => need.command)
    expect(new Set(commands).size).toBe(commands.length)
  })

  it('knows which are for what Tade is actually set up to use', () => {
    // The default config runs pi under the pty driver: tmux is registered and
    // nothing in use needs it, which is a row that says so rather than no row.
    expect(commandOf('pi')?.inUse).toBe(true)
    expect(commandOf('tmux')?.inUse).toBe(false)
    expect(commandOf('git')?.inUse).toBe(true)
  })

  it('carries the arguments that make each say its version', () => {
    expect(commandOf('tmux')?.versionArgs).toEqual(['-V'])
    expect(commandOf('git')?.versionArgs).toEqual(['--version'])
  })

  it('follows the config when the driver or harness changes', async () => {
    const onTmux = await programsNeeded(ConfigSchema.parse({ workspace: { driver: 'tmux' } }), HOME)
    expect(onTmux.find((need) => need.command === 'tmux')?.inUse).toBe(true)
    const claude = await programsNeeded(
      ConfigSchema.parse({ workers: { routes: { default: { harness: 'claude-code' } } } }),
      HOME,
    )
    expect(claude.find((need) => need.command === 'claude')?.inUse).toBe(true)
  })
})

describe('finding a program on this machine', () => {
  const bin = mkdtempSync(join(tmpdir(), 'tade-bin-'))

  it('reads a global npm install back as the package it came from', () => {
    const modules = join(bin, 'lib', 'node_modules', '@acme', 'tool')
    mkdirSync(join(modules, 'bin'), { recursive: true })
    writeFileSync(
      join(modules, 'package.json'),
      JSON.stringify({ name: '@acme/tool', version: '1.2.3' }),
    )
    writeFileSync(join(modules, 'bin', 'tool.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    symlinkSync(join(modules, 'bin', 'tool.js'), join(bin, 'acmetool'))
    const found = whereIs('acmetool', { PATH: bin })
    expect(found?.manager).toBe('npm')
    expect(found?.name).toBe('@acme/tool')
    expect(found?.version).toBe('1.2.3')
  })

  it('answers with nothing at all when nothing on PATH answers to it', () => {
    expect(whereIs('no-such-program-anywhere', { PATH: bin })).toBeNull()
  })

  it('reads what ships with Tade where it is, rather than off PATH', () => {
    // pi is not on anybody's PATH: Tade runs the copy in its own
    // node_modules, which is the one to read a version from and the one that
    // moves when Tade does.
    const inside = join(bin, 'node_modules', 'agent')
    mkdirSync(inside, { recursive: true })
    writeFileSync(join(inside, 'package.json'), JSON.stringify({ name: 'agent', version: '0.8.0' }))
    writeFileSync(join(inside, 'cli.js'), '#!/usr/bin/env node\n', { mode: 0o755 })
    const found = whereIs(
      'agent',
      { PATH: '/nowhere' },
      { at: join(inside, 'cli.js'), within: bin },
    )
    expect(found?.manager).toBe('tade')
    expect(found?.version).toBe('0.8.0')
  })

  it('says nothing where the path it was given is not there', () => {
    expect(whereIs('agent', { PATH: bin }, { at: join(bin, 'gone.js') })).toBeNull()
  })
})

describe('looking at what is here', () => {
  const need = {
    command: 'git',
    title: 'git',
    versionArgs: ['--version'],
    optional: false,
    needed: [{ what: 'Tade', why: 'reading a project', inUse: true }],
    inUse: true,
  }

  it('reads the version the program prints, wherever it prints it', async () => {
    const [look] = await lookAtPrograms([need], {
      env: { PATH: '/usr/bin' },
      exec: exec({ git: 'git version 2.39.5 (Apple Git-154)' }),
    })
    expect(look?.version).toBe('2.39.5')
    expect(look?.install?.where).toContain('git')
  })

  it('says it is not installed rather than that it is out of date', async () => {
    const [look] = await lookAtPrograms([{ ...need, command: 'no-such-program-anywhere' }], {
      env: { PATH: '/nowhere' },
      exec: exec({}),
    })
    expect(look?.install).toBeNull()
    expect(look?.version).toBeNull()
    expect(look?.behind).toBe(false)
    expect(look?.update).toHaveProperty('cannot')
  })

  it('knows nothing about what is current until somebody asks', async () => {
    const [look] = await lookAtPrograms([need], {
      env: { PATH: '/usr/bin' },
      exec: exec({ git: 'git version 2.39.5' }),
    })
    expect(look?.latest).toBeNull()
    expect(look?.cannotTell).toContain('nobody has been asked')
  })
})

describe('asking what is current', () => {
  const look = {
    need: {
      command: 'claude',
      title: 'Claude Code',
      versionArgs: ['--version'],
      optional: false,
      needed: [{ what: 'claude-code', why: 'being the agent', inUse: true }],
      inUse: true,
    },
    install: {
      manager: 'npm' as const,
      name: '@anthropic-ai/claude-code',
      where: '/usr/local/lib/node_modules/@anthropic-ai/claude-code/cli.js',
      said: 'a global npm package',
    },
    version: '2.0.5',
    latest: null,
    cannotTell: 'nobody has been asked what is current',
    update: { command: 'npm install --global @anthropic-ai/claude-code@latest' },
    behind: false,
  }

  const answering = (version: string) =>
    (async () =>
      new Response(JSON.stringify({ version }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch

  it('asks the registry the package came from, and says how far behind', async () => {
    const [asked] = await askWhatIsCurrent([look], { fetch: answering('2.1.0') })
    expect(asked?.latest).toBe('2.1.0')
    expect(asked?.behind).toBe(true)
    expect(asked?.cannotTell).toBeNull()
  })

  it('is not behind when it is the newest there is', async () => {
    const [asked] = await askWhatIsCurrent([look], { fetch: answering('2.0.5') })
    expect(asked?.behind).toBe(false)
  })

  it('says it cannot tell, rather than guessing, when nobody answers', async () => {
    const [asked] = await askWhatIsCurrent([look], {
      fetch: (async () => {
        throw new Error('getaddrinfo ENOTFOUND registry.npmjs.org')
      }) as unknown as typeof fetch,
    })
    expect(asked?.latest).toBeNull()
    expect(asked?.behind).toBe(false)
    expect(asked?.cannotTell).toContain('could not be reached')
  })

  it('says it cannot tell for something no manager claims', async () => {
    const [asked] = await askWhatIsCurrent(
      [
        {
          ...look,
          install: {
            manager: 'path',
            name: 'tmux',
            where: '/home/x/bin/tmux',
            said: 'a binary on PATH',
          },
        },
      ],
      {
        fetch: (() => {
          throw new Error('nothing should be asked')
        }) as unknown as typeof fetch,
      },
    )
    expect(asked?.latest).toBeNull()
    expect(asked?.cannotTell).toContain('a binary on PATH')
  })

  it('leaves what is not installed alone', async () => {
    const [asked] = await askWhatIsCurrent([{ ...look, install: null }], {
      fetch: (() => {
        throw new Error('nothing should be asked')
      }) as unknown as typeof fetch,
    })
    expect(asked?.latest).toBeNull()
  })
})
