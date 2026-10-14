import { describe, expect, it } from 'vitest'
import {
  ConfigSchema,
  composeAgentPrompt,
  fromCursor,
  fromDevcontainer,
  fromLockfiles,
  type PrepareSources,
  parseJsonc,
  readingOf,
  setupLine,
} from '../src/index.ts'

const NOTHING: PrepareSources = {
  worktreeinclude: null,
  cursor: null,
  devcontainer: null,
  packageJson: null,
  lockfiles: [],
}

describe('readingOf', () => {
  it('reads nothing into a project that says nothing', () => {
    expect(readingOf(NOTHING)).toEqual({
      files: [],
      filesFrom: null,
      link: false,
      setup: null,
      unread: [],
    })
  })

  it('takes the files to bring from .worktreeinclude, comments and blanks skipped', () => {
    const reading = readingOf({ ...NOTHING, worktreeinclude: '# secrets\n.env\n\n.env.local\n' })
    expect(reading.files).toEqual(['.env', '.env.local'])
    expect(reading.filesFrom).toBe('.worktreeinclude')
  })

  it('believes Cursor over a devcontainer over a lockfile, and stops at the first', () => {
    const all: PrepareSources = {
      ...NOTHING,
      cursor: '{ "setup-worktree": ["pnpm install", "cp $ROOT_WORKTREE_PATH/.env .env"] }',
      devcontainer: {
        path: '.devcontainer/devcontainer.json',
        text: '{"postCreateCommand": "make"}',
      },
      packageJson: '{}',
      lockfiles: ['pnpm-lock.yaml'],
    }
    expect(readingOf(all).setup).toEqual({
      command: 'pnpm install && cp $ROOT_WORKTREE_PATH/.env .env',
      from: '.cursor/worktrees.json setup-worktree',
      deadline_s: 600,
    })
    expect(readingOf({ ...all, cursor: null }).setup?.command).toBe('make')
    expect(readingOf({ ...all, cursor: null, devcontainer: null }).setup?.command).toBe(
      'pnpm install --frozen-lockfile',
    )
  })

  it('lets Tade’s config answer over the project, empty meaning nothing at all', () => {
    const read: PrepareSources = {
      ...NOTHING,
      worktreeinclude: '.env\n',
      packageJson: '{}',
      lockfiles: ['package-lock.json'],
    }
    const own = readingOf(read, {
      files: ['certs/*.pem'],
      link: true,
      command: 'make dev',
      deadline_minutes: 2,
    })
    expect(own).toMatchObject({
      files: ['certs/*.pem'],
      filesFrom: 'Tade’s config',
      link: true,
      setup: { command: 'make dev', from: 'Tade’s config', deadline_s: 120 },
    })
    expect(readingOf(read, { files: [], command: '' })).toMatchObject({
      files: [],
      filesFrom: null,
      setup: null,
    })
  })
})

describe('fromCursor', () => {
  it('prefers the unix list, and names a script path rather than running it', () => {
    const unread: string[] = []
    expect(
      fromCursor('{"setup-worktree-unix": ["npm ci"], "setup-worktree": ["nope"]}', unread)
        ?.command,
    ).toBe('npm ci')
    expect(fromCursor('{"setup-worktree": "setup.sh"}', unread)).toBeNull()
    expect(fromCursor('not json', unread)).toBeNull()
    expect(unread).toEqual([
      '.cursor/worktrees.json: setup-worktree names a script (setup.sh), which says nothing about what it runs',
      '.cursor/worktrees.json: not JSON this can read',
    ])
  })
})

describe('fromDevcontainer', () => {
  const at = (text: string) => ({ path: '.devcontainer/devcontainer.json', text })

  it('takes a postCreateCommand this machine can run as written', () => {
    const unread: string[] = []
    expect(
      fromDevcontainer(at('{\n // comment\n "postCreateCommand": "npm ci",\n}'), unread),
    ).toEqual({
      command: 'npm ci',
      from: '.devcontainer/devcontainer.json postCreateCommand',
    })
    expect(
      fromDevcontainer(at('{"postCreateCommand": ["npm", "run", "a b"]}'), unread)?.command,
    ).toBe("npm run 'a b'")
    expect(unread).toEqual([])
  })

  it('names what only a container could run, and runs none of it', () => {
    const unread: string[] = []
    for (const text of [
      '{"postCreateCommand": "sudo apt-get install -y jq"}',
      '{"postCreateCommand": "curl -fsSL https://example.com/x | bash"}',
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the devcontainer's own interpolation, verbatim
      '{"postCreateCommand": "cd ${containerWorkspaceFolder} && npm ci"}',
      '{"postCreateCommand": {"a": "npm ci", "b": "npm run watch"}}',
      '{"onCreateCommand": "npm ci"}',
    ]) {
      expect(fromDevcontainer(at(text), unread)).toBeNull()
    }
    expect(unread).toHaveLength(5)
    expect(unread[0]).toContain('installs a program on the machine')
    expect(unread[1]).toContain('installs a program on the machine')
    expect(unread[2]).toContain('interpolates')
    expect(unread[3]).toContain('side by side')
    expect(unread[4]).toContain('onCreateCommand')
  })
})

describe('fromLockfiles', () => {
  it('installs with the declared package manager, else the one lockfile there is', () => {
    const unread: string[] = []
    expect(
      fromLockfiles(
        '{"packageManager": "pnpm@9.1.0"}',
        ['pnpm-lock.yaml', 'package-lock.json'],
        unread,
      )?.command,
    ).toBe('pnpm install --frozen-lockfile')
    expect(fromLockfiles('{}', ['package-lock.json'], unread)?.command).toBe('npm ci')
    expect(fromLockfiles('{}', [], unread)).toBeNull()
    // No package.json: a lockfile alone is not a project to install.
    expect(fromLockfiles(null, ['yarn.lock'], unread)).toBeNull()
    expect(unread).toEqual([])
  })

  it('refuses to guess between two managers, or past a declaration with no lockfile', () => {
    const unread: string[] = []
    expect(fromLockfiles('{}', ['yarn.lock', 'package-lock.json'], unread)).toBeNull()
    expect(fromLockfiles('{"packageManager": "bun@1"}', ['yarn.lock'], unread)).toBeNull()
    expect(unread).toEqual([
      'lockfiles for npm and yarn and no packageManager to say which',
      'package.json declares bun, and there is no bun lockfile to install from',
    ])
  })
})

describe('parseJsonc', () => {
  it('keeps comment markers inside strings, drops real comments and trailing commas', () => {
    expect(parseJsonc('{"url": "http://x//y", /* a */ "b": [1, 2,], // c\n}')).toEqual({
      url: 'http://x//y',
      b: [1, 2],
    })
    expect(parseJsonc('{ nope')).toBeUndefined()
  })
})

describe('setupLine', () => {
  it('runs the setup and then execs the agent’s own line, unchanged', () => {
    const line = setupLine({
      setup: { command: 'pnpm install', from: 'pnpm-lock.yaml', deadline_s: 600 },
      log: '/home/t/setup.log',
      root: '/src/app',
      node: '/usr/bin/node',
      line: { command: 'claude', args: ['--session-id', 'x', 'do it'] },
    })
    expect(line.command).toBe('/bin/sh')
    expect(line.args.slice(-3)).toEqual(['--session-id', 'x', 'do it'])
    expect(line.args.at(-4)).toBe('claude')
    expect(line.args[1]).toContain('exec "$@"')
  })
})

describe('the config', () => {
  it('takes a project’s prepare answer, and names a bad key by its path', () => {
    const ok = ConfigSchema.safeParse({
      projects: {
        app: { root: '~/app', prepare: { files: ['.env'], command: 'make', deadline_minutes: 5 } },
      },
    })
    expect(ok.success).toBe(true)
    expect(
      ConfigSchema.parse({ projects: { app: { root: '~/app' } } }).projects.app?.prepare,
    ).toBeUndefined()
    const bad = ConfigSchema.safeParse({
      projects: { app: { root: '~/app', prepare: { deadline_minutes: 0 } } },
    })
    expect(bad.success).toBe(false)
    expect(bad.error?.issues[0]?.path).toEqual(['projects', 'app', 'prepare', 'deadline_minutes'])
  })
})

describe('what the agent is told', () => {
  it('says the setup ran and where what it printed is, in a worktree', () => {
    const prompt = composeAgentPrompt({
      task: 'app/x',
      project: 'app',
      worktree: '/w/app-x',
      root: '/src/app',
      workspace: 'worktree',
      intent: 'fix it',
      branch: 'tade/x',
      context: null,
      setup: { command: 'pnpm install', log: '/home/t/setup.log' },
    })
    expect(prompt).toContain('`pnpm install`')
    expect(prompt).toContain('/home/t/setup.log')
  })
})
