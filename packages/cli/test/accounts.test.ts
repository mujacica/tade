import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// `tade accounts` is a question: it asks each harness who it is signed in as,
// needs no window, and — with a home made for the test — reads nobody's own.

describe('tade accounts', () => {
  let home: string
  let env: Record<string, string>

  const tade = (
    ...args: string[]
  ): Promise<{ code: number | null; stdout: string; stderr: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      let stderr = ''
      child.stdout.setEncoding('utf8')
      child.stderr.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.stderr.on('data', (d: string) => {
        stderr += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim(), stderr: stderr.trim() }))
    })

  beforeEach(() => {
    home = tmp('tade-cli-accounts-')
    env = { TADE_HOME: home, TADE_NO_GH: '1', HOME: home }
  })

  it('lists each harness’s own sign-in, and the accounts added beside it', async () => {
    writeFileSync(
      join(home, 'config.yaml'),
      'accounts:\n  work:\n    harness: claude-code\nworkers:\n  accounts:\n    claude-code: work\n',
    )
    const result = await tade('accounts', '--json', '-c', join(home, 'config.yaml'))
    expect(result.code).toBe(0)
    const views = JSON.parse(result.stdout) as Array<Record<string, unknown>>
    expect(views.map((view) => [view.harness, view.name, view.forNewAgents])).toEqual([
      ['pi', null, true],
      ['claude-code', null, false],
      ['claude-code', 'work', true],
      ['codex', null, true],
      ['acp', null, true],
    ])
    for (const view of views)
      expect(typeof (view.status as { signedIn: unknown }).signedIn).toBe('boolean')
  }, 30_000)

  it('adds one, has a project’s new agents run as it, and takes it away again', async () => {
    const repo = mkrepo()
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const config = () => parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8'))
    const added = await tade('accounts', 'add', 'claude-code', 'work')
    expect(added.code).toBe(0)
    // Nobody at a keyboard here, so its sign-in is said rather than run.
    expect(added.stdout).toContain('tade accounts sign-in claude-code work')
    expect(config().accounts.work).toMatchObject({ harness: 'claude-code' })

    const used = await tade('accounts', 'use', 'claude-code', 'work', '--project', 'app')
    expect(used.code).toBe(0)
    expect(used.stdout).toContain('in app run as work')
    expect(config().projects.app.accounts).toEqual({ 'claude-code': 'work' })
    const listed = await tade('accounts', '-c', join(home, 'config.yaml'))
    expect(listed.stdout).toContain('new agents in app')

    expect((await tade('accounts', 'use', 'claude-code', '--unset')).code).toBe(1)
    await tade('accounts', 'use', 'claude-code', '--project', 'app', '--unset')
    expect(config().projects.app.accounts?.['claude-code']).toBeUndefined()

    await tade('accounts', 'use', 'claude-code', 'work')
    expect(config().workers.accounts['claude-code']).toBe('work')
    const removed = await tade('accounts', 'remove', 'work')
    expect(removed.code).toBe(0)
    expect(config().accounts ?? {}).toEqual({})
    expect(config().workers?.accounts?.['claude-code']).toBeUndefined()
  }, 60_000)

  it('names a harness’s own sign-in, lists it by that name, and takes it as that sign-in', async () => {
    const repo = mkrepo()
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const config = () => parseYaml(readFileSync(join(home, 'config.yaml'), 'utf8'))
    const named = await tade('accounts', 'name', 'claude-code', 'sentry')
    expect(named.code).toBe(0)
    expect(named.stdout).toContain('own sign-in is called sentry')
    expect(config().workers.default_names).toEqual({ 'claude-code': 'sentry' })
    const listed = await tade('accounts', '-c', join(home, 'config.yaml'))
    expect(listed.stdout).toContain('claude-code · sentry')
    // Chosen by it, it is the own sign-in, written as one.
    expect((await tade('accounts', 'use', 'claude-code', 'sentry', '--project', 'app')).code).toBe(
      0,
    )
    expect(config().projects.app.accounts).toEqual({ 'claude-code': 'default' })
    const bad = await tade('accounts', 'name', 'claude-code', 'Not A Name')
    expect(bad.code).not.toBe(0)
    expect(bad.stderr).toContain('cannot name a sign-in')
    expect((await tade('accounts', 'name', 'claude-code')).stdout).toContain('has no name')
    expect(config().workers.default_names?.['claude-code']).toBeUndefined()
  }, 60_000)

  it('says which account it does not know, rather than signing in to another', async () => {
    const result = await tade(
      'accounts',
      'sign-in',
      'claude-code',
      'nope',
      '-c',
      join(home, 'c.yaml'),
    )
    expect(result.code).toBe(2)
    expect(result.stderr).toContain('no claude-code account called nope')
  })
})
