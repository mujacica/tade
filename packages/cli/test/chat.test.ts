import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockHome } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// The conversation itself is tested against a real agent in
// packages/orchestrator. What is covered here is everything around it: the
// branches that never reach the orchestrator, and leaving the session.

function tade(args: string[], env: Record<string, string>) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
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
    // No input at all: the session should end, not wait forever.
    child.stdin.end()
  })
}

describe('tade chat', () => {
  it('says who has it open rather than failing obscurely', async () => {
    const home = tmp('tade-chat-cli-')
    const held = await lockHome(home)
    try {
      const r = await tade(['chat'], { TADE_HOME: home, HOME: home })
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('already open')
    } finally {
      await held.release()
    }
  })

  it('reports a broken config instead of starting', async () => {
    const home = tmp('tade-chat-cli-')
    writeFileSync(
      join(home, 'config.yaml'),
      'workers:\n  default: nope\n  routes:\n    a: {}\n    b: {}\n',
    )
    const r = await tade(['chat'], { TADE_HOME: home, HOME: home })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('invalid config')
  })

  it('ends the session at end of input instead of hanging', async () => {
    const repo = mkrepo()
    const home = tmp('tade-chat-eof-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    const r = await tade(['chat'], { TADE_HOME: home, HOME: home })
    // Ctrl-D and piped input both arrive here as end of input.
    expect(r.code).toBe(0)
  }, 60_000)
})
