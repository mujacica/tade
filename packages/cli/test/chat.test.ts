import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// The conversation itself is tested against a real agent in
// packages/orchestrator. What is left here is the branch that never reaches
// the orchestrator at all.

function wilco(args: string[], env: Record<string, string>) {
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
    child.stdin.end()
  })
}

describe('wilco chat', () => {
  it('says how to start the daemon rather than failing obscurely', async () => {
    const home = tmp('wilco-chat-cli-')
    const r = await wilco(['chat'], {
      WILCO_HOME: home,
      WILCO_SOCKET: join(home, 'not-running.sock'),
      HOME: home,
    })
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('daemon not running')
  })

  it('reports a broken config instead of starting', async () => {
    const home = tmp('wilco-chat-cli-')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(
      join(home, 'config.yaml'),
      'workers:\n  default: nope\n  routes:\n    a: {}\n    b: {}\n',
    )
    const r = await wilco(['chat'], {
      WILCO_HOME: home,
      WILCO_SOCKET: join(home, 'not-running.sock'),
      HOME: home,
    })
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('invalid config')
  })
})
