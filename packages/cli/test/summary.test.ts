import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Daemon } from '@wilco/daemon/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))

// The daemon runs inside this process, so the CLI must be spawned
// ASYNCHRONOUSLY: spawnSync would block the event loop the daemon needs to
// answer the request, and the two would deadlock forever.

describe('wilco summary', () => {
  let home: string
  let env: Record<string, string>
  let daemon: Daemon

  const wilco = (...args: string[]): Promise<{ code: number | null; stdout: string }> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], { env: { ...process.env, ...env } })
      let stdout = ''
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (d: string) => {
        stdout += d
      })
      child.on('exit', (code) => resolve({ code, stdout: stdout.trim() }))
    })

  beforeEach(async () => {
    home = tmp('wilco-cli-summary-')
    env = { WILCO_HOME: home, WILCO_SOCKET: join(home, 'w.sock'), WILCO_NO_GH: '1', HOME: home }
    daemon = await Daemon.start({ home, socket: env.WILCO_SOCKET })
  })

  afterEach(async () => {
    await daemon.stop().catch(() => {})
  })

  it('says plainly when the journal has nothing about it', async () => {
    const result = await wilco('summary', 'app/refunds')
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('Nothing recorded for refunds.')
  })

  it('accounts for what an agent did', async () => {
    for (const tool of ['bash', 'bash', 'edit']) {
      await daemon.log.append({
        type: 'tool_call',
        task: 'app/refunds',
        run: 'r1',
        detail: { tool },
      })
    }
    await daemon.log.append({
      type: 'turn_done',
      task: 'app/refunds',
      run: 'r1',
      detail: { status: 'ok' },
    })

    const result = await wilco('summary', 'app/refunds')
    expect(result.stdout).toContain('3 tool calls and 1 turn, mostly bash and edit')
  })

  it('reports what it is waiting on, and what ran unasked', async () => {
    await daemon.log.append({
      type: 'tool_call',
      task: 'app/refunds',
      run: 'r1',
      detail: { tool: 'bash', tier: 'hard', summary: 'git push --force' },
    })
    await daemon.log.append({
      type: 'permission_request',
      task: 'app/refunds',
      run: 'r1',
      detail: { requestId: 'q1', summary: 'bash: npm i stripe@15' },
    })

    const result = await wilco('summary', 'app/refunds')
    expect(result.stdout).toContain('waiting on bash: npm i stripe@15')
    // Approvals are off by default, so this is when you hear about it.
    expect(result.stdout).toContain('It ran git push --force.')
  })

  it("keeps one agent out of another's account", async () => {
    await daemon.log.append({
      type: 'tool_call',
      task: 'search/pagination',
      run: 'r2',
      detail: { tool: 'edit' },
    })
    expect((await wilco('summary', 'app/refunds')).stdout).toBe('Nothing recorded for refunds.')
  })

  it('has a machine-readable form', async () => {
    await daemon.log.append({
      type: 'tool_call',
      task: 'app/refunds',
      run: 'r1',
      detail: { tool: 'bash' },
    })
    const summary = JSON.parse((await wilco('summary', 'app/refunds', '--json')).stdout)
    expect(summary).toMatchObject({ task: 'app/refunds', tools: 1, turns: 0, empty: false })
    expect(summary.used).toEqual([{ tool: 'bash', count: 1 }])
  })
})
