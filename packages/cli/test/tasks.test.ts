import { spawn } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lockHome, Workbench } from '@wilco/workbench'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'

const bin = fileURLToPath(new URL('../src/bin.ts', import.meta.url))
const INTENT = 'the refund flow double-charges when the webhook retries'

// The CLI is spawned for real rather than called in-process: each invocation
// opens the workbench, does its work and closes it, which is the thing under
// test. Two of them at once would be refused, so they run one at a time.

describe('wilco task and run commands', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let env: Record<string, string>

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
    // tmux, because the point of the run commands is that the agent is still
    // there when the next command runs: three invocations, three processes.
    writeFileSync(
      join(home, 'config.yaml'),
      // Worktrees, because what these commands report and refuse is a worktree's.
      `workspace:\n  driver: tmux\nagents:\n  workspace: worktree\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    env = { WILCO_HOME: home, WILCO_NO_GH: '1', HOME: home }
  })

  afterEach(async () => {
    // These are real processes in a real tmux session: leave none behind.
    const wilco = await Workbench.open({ home }).catch(() => null)
    await wilco?.stopEverything().catch(() => {})
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

  it('starts an agent that is still there for the next command', async () => {
    expect((await wilco('task', 'create', 'app/refunds', '--intent', INTENT)).code).toBe(0)

    const started = await wilco('run', 'start', 'app/refunds')
    expect(started.code).toBe(0)
    expect(started.stdout).toContain('app/refunds/agent  started')
    // It says how to go and look at it, which is the whole idea.
    expect(started.stdout).toContain('tmux')

    // A different process entirely, and the agent is still working.
    const listed = await wilco('run', 'list')
    expect(listed.stdout).toContain('app/refunds/agent')

    expect((await wilco('run', 'stop', 'app/refunds')).stdout).toBe('app/refunds stopped')
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

  it('says who has it open rather than interleaving with them', async () => {
    // A window is open on this home. Only one thing may write to it.
    const held = await lockHome(home)
    try {
      const r = await wilco('run', 'list')
      expect(r.code).toBe(1)
      expect(r.stderr).toContain('already open')
      // Naming the pid is the difference between a refusal you can act on and
      // one you have to investigate.
      expect(r.stderr).toContain(String(process.pid))
    } finally {
      await held.release()
    }
  })

  it('reads what happened without taking the workbench', async () => {
    expect((await wilco('task', 'create', 'app/refunds', '--intent', INTENT)).code).toBe(0)
    const held = await lockHome(home)
    try {
      // Questions stay answerable with a window open: this is the whole reason
      // the journal is a file rather than something a server owns.
      const r = await wilco('logs', '--type', 'task_created')
      expect(r.code).toBe(0)
      expect(r.stdout).toContain('app/refunds')
    } finally {
      await held.release()
    }
  })
})
