import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

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
    ])
    for (const view of views)
      expect(typeof (view.status as { signedIn: unknown }).signedIn).toBe('boolean')
  }, 30_000)

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
