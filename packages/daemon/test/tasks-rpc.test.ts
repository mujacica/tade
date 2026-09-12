import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { DaemonClient } from '../src/client.ts'
import { Daemon } from '../src/server.ts'

// Tasks and runs over the socket: the path the CLI and the orchestrator both
// take. Uses a real repository and a real daemon; only the agent's model is
// absent, so runs start but are never prompted.

const INTENT = 'the refund flow double-charges when the webhook retries'

describe('task and run RPC', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let socket: string
  let daemon: Daemon
  let client: DaemonClient

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('wilco-rpc-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    socket = join(home, 'w.sock')
    daemon = await Daemon.start({ home, socket })
    client = await DaemonClient.connect(socket)
  })

  afterEach(async () => {
    await client.close().catch(() => {})
    await daemon.stop().catch(() => {})
  })

  it('creates a task in the configured project and records the intent verbatim', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })

    expect(task).toMatchObject({ id: 'app/refunds', branch: 'wilco/refunds' })
    expect(existsSync(join(task.worktree, '.wilco', 'task.yaml'))).toBe(true)

    const [event] = await client.events({ types: ['task_created'] })
    expect(event?.task).toBe('app/refunds')
    expect(event?.detail.intent_spoken).toBe(INTENT)
  })

  it('refuses a project it has never heard of', async () => {
    await expect(client.createTask({ project: 'nope', slug: 'x', intent: 'y' })).rejects.toThrow(
      /unknown project/,
    )
  })

  it('removes a finished task and records that too', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    const result = await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })

    expect(result).toMatchObject({ removed: true })
    expect(existsSync(task.worktree)).toBe(false)
    expect((await client.events({ types: ['task_removed'] })).length).toBe(1)
  })

  it('refuses to remove work nobody has merged', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    repo.commit('unmerged work', { 'a.ts': '1' }, task.worktree)

    const result = await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
    })
    expect(result).toMatchObject({ removed: false, reason: expect.stringContaining('not merged') })
    expect(existsSync(task.worktree)).toBe(true)
    expect(await client.events({ types: ['task_removed'] })).toEqual([])
  })

  it('reports the default posture and no work in flight', async () => {
    expect(await client.runs()).toEqual([])
    expect(await client.pendingApprovals()).toEqual([])
    expect(await client.info()).toMatchObject({ runs: 0, approvals: 'bypass' })
  })

  it('starts a supervised run in a task worktree, then stops it', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    const handle = await client.startRun({
      run: 'r1',
      task: task.id,
      cwd: task.worktree,
      // No prompt: the agent starts and waits, so this needs no model.
      prompt: '',
    })

    expect(handle).toMatchObject({ run: 'r1', task: 'app/refunds' })
    expect((await client.runs()).map((r) => r.run)).toEqual(['r1'])
    expect((await client.info()).runs).toBe(1)

    const [started] = await client.events({ types: ['run_started'] })
    expect(started?.task).toBe('app/refunds')
    expect(started?.detail).toMatchObject({ adapter: 'pi', approvals: 'bypass' })

    await client.stopRun('r1')
    expect(await client.runs()).toEqual([])
    expect((await client.events({ types: ['run_exited'] })).length).toBeGreaterThan(0)
  }, 60_000)
})
