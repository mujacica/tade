import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Daemon } from '@wilco/daemon/server'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const INTENT = 'the refund flow double-charges when the webhook retries'

// The daemon runs inside this process, so the CLI must be spawned
// ASYNCHRONOUSLY: spawnSync would block the event loop the daemon needs to
// answer the request, and the two would deadlock forever.

describe('wilco task and run commands', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let env: Record<string, string>
  let daemon: Daemon

  interface Result {
    code: number | null
    stdout: string
    stderr: string
  }

  const wilco = (...args: string[]): Promise<Result> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [bin, ...args], {
        env: { ...process.env, ...env },
      })
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

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('wilco-cli-tasks-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    env = { WILCO_HOME: home, WILCO_SOCKET: join(home, 'w.sock'), WILCO_NO_GH: '1', HOME: home }
    daemon = await Daemon.start({ home, socket: env.WILCO_SOCKET })
  })

  afterEach(async () => {
    await daemon.stop().catch(() => {})
  })

  it('creates a task and reports where it lives', async () => {
    const r = await wilco('task', 'create', 'app/refunds', '--intent', INTENT)
    expect(r.code).toBe(0)
    expect(r.stdout).toMatch(/^app\/refunds\s+wilco\/refunds\s+\S+/)
    const worktree = r.stdout.split(/\s+/)[2]!
    expect(existsSync(join(worktree, '.wilco', 'task.yaml'))).toBe(true)
  })

  it('rejects a task id that is not <project>/<name>', async () => {
    const r = await wilco('task', 'create', 'refunds', '--intent', 'x')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('invalid task id')
  })

  it('starts an agent in the task worktree, lists it, and stops it', async () => {
    expect((await wilco('task', 'create', 'app/refunds', '--intent', INTENT)).code).toBe(0)

    const started = await wilco('run', 'start', 'app/refunds')
    expect(started.code).toBe(0)
    expect(started.stdout).toContain('app/refunds  started')
    const run = started.stdout.split(/\s+/)[0]!

    const listed = await wilco('run', 'list')
    expect(listed.stdout).toContain(run)
    expect(listed.stdout).toContain('app/refunds')

    expect((await wilco('run', 'stop', run)).stdout).toBe(`${run} stopped`)
    expect((await wilco('run', 'list')).stdout).toBe('no agents running')
  }, 60_000)

  it('refuses to start an agent for a task that does not exist', async () => {
    const r = await wilco('run', 'start', 'app/ghost')
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('no such task')
  })

  it('reports nothing waiting when approvals are off', async () => {
    expect((await wilco('approvals')).stdout).toBe('nothing waiting')
  })

  it('refuses to remove a task holding unmerged work, unless forced', async () => {
    const created = await wilco('task', 'create', 'app/refunds', '--intent', INTENT)
    const worktree = created.stdout.split(/\s+/)[2]!
    repo.commit('unmerged work', { 'a.ts': '1' }, worktree)

    const kept = await wilco('task', 'remove', 'app/refunds')
    expect(kept.code).toBe(1)
    expect(kept.stderr).toContain('not merged')
    expect(existsSync(worktree)).toBe(true)

    const forced = await wilco('task', 'remove', 'app/refunds', '--force')
    expect(forced.code).toBe(0)
    expect(existsSync(worktree)).toBe(false)
  }, 30_000)

  it('says so plainly when the daemon is not running', async () => {
    await daemon.stop()
    const r = await wilco('run', 'list')
    expect(r.code).toBe(1)
    expect(r.stderr).toContain('daemon not running')
  })
})
