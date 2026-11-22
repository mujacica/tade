import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConfigSchema, type Inventory, inventoryChanges, keyDigest, runProgram } from '@tade/core'
import { about } from '@tade/telemetry'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { scanEnv } from '../src/env-scan.ts'
import {
  emailIn,
  ghStatusIn,
  inventoryHere,
  keepInventory,
  type Look,
  machineFolder,
  pushCheck,
  readInventory,
} from '../src/inventory.ts'
import { setupWalk, walkLines } from '../src/setup-walk.ts'

// This machine's inventory, looked at out of a fixture home: where each key is
// set, by file and line, with no value anywhere it goes — the journal's lines,
// what telemetry would keep of them, the answer another machine reads — and
// every look that runs a program answered within its deadline or `unknown`.

const VALUES = ['sk-or-zshenv-111', 'sk-ant-zshrc-222', 'ghp-envrc-333', 'sk-live-444']

/** A home with keys in `~/.zshenv`, `~/.zshrc` and a project's `.envrc`, and a unit for `tade serve`. */
function fixtureHome() {
  const homeDir = tmp('tade-inv-home-')
  writeFileSync(
    join(homeDir, '.zshenv'),
    ['# zsh, everywhere', `export OPENROUTER_API_KEY="${VALUES[0]}"`, ''].join('\n'),
  )
  writeFileSync(
    join(homeDir, '.zshrc'),
    [
      'alias ll="ls -l"',
      'export PATH="$HOME/bin:$PATH"',
      `export ANTHROPIC_API_KEY='${VALUES[1]}'`,
      '',
    ].join('\n'),
  )
  const project = join(homeDir, 'code', 'shop')
  mkdirSync(project, { recursive: true })
  writeFileSync(join(project, '.envrc'), `export GITHUB_TOKEN=${VALUES[2]}\n`)
  writeFileSync(join(project, '.env.example'), 'GITHUB_TOKEN=placeholder\n')
  mkdirSync(join(homeDir, '.config', 'systemd', 'user'), { recursive: true })
  writeFileSync(
    join(homeDir, '.config', 'systemd', 'user', 'tade.service'),
    ['[Service]', `Environment=STRIPE_SECRET_KEY=${VALUES[3]}`, ''].join('\n'),
  )
  writeFileSync(join(homeDir, '.npmrc'), '//registry.npmjs.org/:_authToken=npm-token-555\n')
  return { homeDir, project }
}

/** `gh` answered as a machine never signed in to GitHub answers; everything else asked for real. */
const quiet: Look = async (command, args, opts) =>
  command === 'gh'
    ? {
        code: 1,
        stdout: '',
        stderr: 'You are not logged into any GitHub hosts. To log in, run: gh auth login',
        timedOut: false,
        missing: false,
      }
    : runProgram(command, args, opts)

/** A git config of its own, naming who commits: what `git config --global user.email` reads. */
function gitconfig(): string {
  const path = join(tmp('tade-inv-git-'), 'gitconfig')
  writeFileSync(path, '[user]\n\temail = me@example.com\n')
  return path
}

describe('the scan', () => {
  it('names each key at its file and line, and keeps a digest rather than the value', async () => {
    const { homeDir, project } = fixtureHome()
    const scan = await scanEnv({
      homeDir,
      projects: [{ name: 'shop', root: project }],
      names: new Set(),
      platform: 'linux',
      env: {},
    })
    const at = (name: string) => scan.places.get(name)?.map((one) => `${one.file}:${one.line}`)
    expect(at('OPENROUTER_API_KEY')).toEqual(['~/.zshenv:2'])
    expect(at('ANTHROPIC_API_KEY')).toEqual(['~/.zshrc:3'])
    expect(at('GITHUB_TOKEN')).toEqual(['shop/.envrc:1'])
    expect(at('STRIPE_SECRET_KEY')).toEqual(['~/.config/systemd/user/tade.service:2'])
    expect(scan.places.has('PATH')).toBe(false)
    expect(scan.places.get('OPENROUTER_API_KEY')?.[0]?.digest).toBe(keyDigest(VALUES[0]))
    expect(scan.places.get('STRIPE_SECRET_KEY')?.[0]?.read).toBe('service')
    expect(scan.unit).toBe(true)
    expect(scan.others).toEqual([{ file: '~/.npmrc', holds: ['_authToken'] }])
    expect(JSON.stringify([...scan.places])).not.toMatch(/sk-|ghp-/)
  })
})

describe('the inventory', () => {
  it('says where each key is, which ones `tade serve` never reads, and holds no value anywhere it goes', async () => {
    const { homeDir, project } = fixtureHome()
    const scan = await scanEnv({
      homeDir,
      projects: [{ name: 'shop', root: project }],
      names: new Set(),
      platform: 'linux',
      env: {},
    })
    const config = ConfigSchema.parse({ extensions: { jev: { key: 'jev-config-666' } } })
    const inventory = await inventoryHere({
      config,
      machine: 'vps',
      now: Date.parse('2026-11-22T12:00:00Z'),
      env: {
        PATH: process.env.PATH ?? '',
        GIT_CONFIG_GLOBAL: gitconfig(),
        SENTRY_AUTH_TOKEN: 'sntrys-777',
      },
      accounts: [],
      secrets: [
        {
          path: 'extensions.jev.key',
          title: 'Jev',
          label: 'API key',
          variables: ['JEV_API_KEY'],
          value: 'jev-config-666',
          from: 'config.yaml',
        },
        {
          path: 'extensions.sentry.token',
          title: 'Sentry',
          label: 'auth token',
          variables: ['SENTRY_AUTH_TOKEN'],
          value: '',
          from: '$SENTRY_AUTH_TOKEN',
        },
        {
          path: 'extensions.linear.key',
          title: 'Linear',
          label: 'API key',
          variables: ['LINEAR_API_KEY'],
          value: '',
          from: null,
        },
      ],
      mcp: [],
      projects: [],
      scan,
      askOrigins: false,
      caddy: false,
      look: quiet,
    })
    const by = new Map(inventory.items.map((one) => [one.id, one]))
    expect(by.get('env:OPENROUTER_API_KEY')).toMatchObject({
      state: 'set',
      where: ['~/.zshenv:2'],
      service: false,
    })
    expect(by.get('env:OPENROUTER_API_KEY')?.said).toContain('`tade serve` never reads ~/.zshenv')
    expect(by.get('env:STRIPE_SECRET_KEY')).toMatchObject({ service: true, said: null })
    expect(by.get('env:SENTRY_AUTH_TOKEN')?.where).toEqual(['Tade’s environment'])
    expect(by.get('secret:extensions.jev.key')).toMatchObject({
      state: 'set',
      where: ['config.yaml'],
    })
    expect(by.get('secret:extensions.sentry.token')?.digest).toBe(keyDigest('sntrys-777'))
    expect(by.get('secret:extensions.linear.key')).toMatchObject({
      state: 'missing',
      said: 'Linear turns off without it',
    })
    expect(by.get('git:github')).toMatchObject({ state: 'missing' })
    expect(by.get('git:identity')?.digest).toBe(keyDigest('me@example.com'))
    expect(by.get('file:~/.npmrc')?.state).toBe('set')

    const secrets = [...VALUES, 'jev-config-666', 'sntrys-777', 'npm-token-555', 'me@example.com']
    const lines = inventoryChanges(new Map(), inventory).map((one) => ({
      type: 'inventory_changed',
      detail: { item: one.item, now: one.now },
    }))
    const sent = lines.map((one) => about(one.detail, homeDir))
    // The answer another machine reads, the journal's lines, and what telemetry keeps of them.
    for (const text of [JSON.stringify(inventory), JSON.stringify(lines), JSON.stringify(sent)]) {
      for (const value of secrets) expect(text).not.toContain(value)
    }
    expect(sent.every((one) => Object.keys(one).length === 0)).toBe(true)
  })

  it('is unknown, with why, where a look ran out of time — never missing', async () => {
    const config = ConfigSchema.parse({})
    // gh never answers; git is asked for real, of a config that names nobody.
    const late: Look = async (command, args, opts) =>
      command === 'gh'
        ? { code: 128 + 15, stdout: '', stderr: '', timedOut: true, missing: false }
        : runProgram(command, args, opts)
    const inventory = await inventoryHere({
      config,
      machine: 'vps',
      now: 0,
      env: { PATH: process.env.PATH ?? '', GIT_CONFIG_GLOBAL: '/dev/null' },
      accounts: null,
      secrets: [],
      mcp: [],
      projects: [],
      scan: null,
      askOrigins: false,
      caddy: false,
      look: late,
    })
    const by = new Map(inventory.items.map((one) => [one.id, one]))
    expect(by.get('git:github')).toMatchObject({
      state: 'unknown',
      said: 'gh did not answer in time',
    })
    expect(by.get('git:identity')?.state).toBe('missing')
    expect(by.get('sign-in:pi')).toMatchObject({ state: 'unknown' })
  })

  it('asks origin with this machine’s credentials, and a dry-run push writes nothing', async () => {
    const repo = mkrepo({ remote: true })
    const config = ConfigSchema.parse({})
    const inventory = await inventoryHere({
      config,
      machine: 'mac',
      now: 0,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      accounts: [],
      secrets: [],
      mcp: [],
      projects: [{ name: 'shop', root: repo.root }],
      scan: null,
      askOrigins: true,
      caddy: false,
    })
    expect(inventory.items.find((one) => one.id === 'origin:shop')?.state).toBe('set')
    const before = repo.git('ls-remote', 'origin')
    expect((await pushCheck(repo.root, { env: process.env })).ok).toBe(true)
    expect(repo.git('ls-remote', 'origin')).toBe(before)
  })
})

describe('what a status command said', () => {
  it('is read, and anything else is null rather than a throw', () => {
    expect(ghStatusIn(0, 'github.com\n  ✓ Logged in to github.com account me (keyring)')).toEqual({
      signedIn: true,
    })
    expect(
      ghStatusIn(1, 'You are not logged into any GitHub hosts. To log in, run: gh auth login'),
    ).toEqual({
      signedIn: false,
    })
    expect(ghStatusIn(0, 'something new')).toBeNull()
    expect(ghStatusIn(4, 'a crash')).toBeNull()
    expect(emailIn('  me@example.com\n')).toBe('me@example.com')
    expect(emailIn('')).toBeNull()
  })
})

describe('keeping another machine’s', () => {
  it('reads back what was kept, and nothing out of a file that is not one', async () => {
    const dir = tmp('tade-inv-kept-')
    const path = join(dir, 'machines', 'vps', 'inventory.json')
    const one: Inventory = {
      machine: 'vps',
      at: '2026-11-22T12:00:00.000Z',
      items: [],
      shell: null,
      service: true,
    }
    await keepInventory(path, one, 42)
    expect(await readInventory(path)).toEqual({ inventory: one, heardAt: 42 })
    writeFileSync(path, '{"inventory": {"machine": 1}}')
    expect(await readInventory(path)).toBeNull()
    expect(machineFolder('Amirs-MacBook-Pro.local')).toBe('amirs-macbook-pro-local')
    expect(machineFolder('…')).toBeNull()
  })
})

describe('the guided walk', () => {
  it('walks what the target lacks, in the order of the steps, and ends with the checklist', () => {
    const item = (id: string, kind: Inventory['items'][number]['kind'], fields = {}) => ({
      id,
      kind,
      label: id,
      state: 'set' as const,
      digest: null,
      until: null,
      where: [],
      said: null,
      variables: [],
      service: null,
      ...fields,
    })
    const source: Inventory = {
      machine: 'mac',
      at: '',
      shell: 'zsh',
      service: false,
      items: [
        item('git:identity', 'git'),
        item('env:OPENROUTER_API_KEY', 'env', {
          label: 'OPENROUTER_API_KEY',
          where: ['~/.zshenv:2'],
        }),
        item('secret:extensions.jev.key', 'secret', {
          variables: ['JEV_API_KEY'],
          said: 'Jev turns off without it',
        }),
        item('sign-in:claude-code:work', 'sign-in', { label: 'claude-code · work' }),
        item('app:github', 'app'),
        item('origin:shop', 'origin'),
      ],
    }
    const target: Inventory = { ...source, machine: 'vps', items: [item('git:identity', 'git')] }
    const how = {
      target: 'vps',
      source: 'mac',
      there: (command: string) => `\`ssh -t vps ${command}\``,
      sendKeys: '`tade remote carry vps --keys`',
      connect: '`tade remote connect vps`',
    }
    const walk = setupWalk(source, target, how)
    expect(walk.steps.map((one) => one.item)).toEqual([
      'sign-in:claude-code:work',
      'secret:extensions.jev.key',
      'env:OPENROUTER_API_KEY',
      'app:github',
    ])
    const text = walkLines(walk, how).join('\n')
    expect(text).toContain('`ssh -t vps tade accounts sign-in claude-code work`')
    expect(text).toContain('`tade remote carry vps --keys`')
    expect(text).toContain("JEV_API_KEY='…' in ~/.config/tade/env")
    expect(text).toContain('or leave it unset: Jev turns off without it')
    expect(text).toContain("add OPENROUTER_API_KEY='…' to ~/.config/tade/env on vps")
    expect(text).toContain('`tade remote connect vps`')
    expect(text).toContain('checklist: 1 of 5')
  })
})
