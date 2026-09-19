import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { until } from '@tade/drivers-core/conformance'
import { sessionIdFor } from '@tade/harnesses-pi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// Tasks and runs over the socket: the path the CLI and the orchestrator both
// take. Uses a real repository and a real workbench; only the agent's model is
// absent, so runs start but are never prompted.

const INTENT = 'the refund flow double-charges when the webhook retries'

describe('task and run RPC', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let _socket: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-rpc-')
    // Two agents allowed, so the per-task rule is reachable: with the default
    // of one, `max_parallel` would answer first and the narrower guard would
    // never be exercised.
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\n    max_parallel: 2\n`,
    )
    _socket = join(home, 'w.sock')
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('creates a task in the configured project and records the intent verbatim', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })

    expect(task).toMatchObject({ id: 'app/refunds', branch: 'tade/refunds' })
    expect(existsSync(join(task.worktree, '.tade', 'task.yaml'))).toBe(true)

    const [event] = await client.events({ types: ['task_created'] })
    expect(event?.task).toBe('app/refunds')
    expect(event?.detail.intent_spoken).toBe(INTENT)
  })

  it('creates tasks side by side in the checkout, and removing one leaves the checkout alone', async () => {
    const one = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    const two = await client.createTask({ project: 'app', slug: 'search', intent: 'faster search' })
    expect(one).toMatchObject({ workspace: 'checkout', worktree: repo.root, branch: 'main' })
    expect(two.worktree).toBe(repo.root)
    expect(existsSync(join(repo.root, '.tade', 'tasks', 'refunds', 'task.yaml'))).toBe(true)
    await expect(
      client.createTask({ project: 'app', slug: 'refunds', intent: 'again' }),
    ).rejects.toThrow(/used before/)
    const removed = await client.removeTask({
      root: repo.root,
      worktree: one.worktree,
      branch: one.branch,
      task: one.id,
      force: true,
    })
    expect(removed).toEqual({ removed: true, branchDeleted: false })
    expect(existsSync(join(repo.root, '.tade', 'tasks', 'refunds'))).toBe(false)
    expect(existsSync(join(repo.root, '.tade', 'tasks', 'search', 'task.yaml'))).toBe(true)
    expect(existsSync(repo.root)).toBe(true)
  })

  it('never gives a name out twice, even once its task is gone', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      by: 'orchestrator',
    })
    await client.removeTask({
      root: repo.root,
      worktree: task.worktree,
      branch: task.branch,
      task: task.id,
      force: true,
    })
    // Nothing on disk remembers it, and pi would still carry on its conversation.
    await expect(
      client.createTask({ project: 'app', slug: 'refunds', intent: 'again' }),
    ).rejects.toThrow(/app\/refunds was used before/)
    await client.createTask({ project: 'app', slug: 'a.b', intent: INTENT })
    await expect(
      client.createTask({ project: 'app', slug: 'a-b', intent: INTENT }),
    ).rejects.toThrow(/carry on app\/a\.b's conversation/)
  })

  it('keeps who asked for a task, in its file and in the journal', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'fix',
      intent: INTENT,
      by: 'extension:sentry',
    })
    expect(
      readFileSync(join(task.worktree, '.tade', 'tasks', 'fix', 'task.yaml'), 'utf8'),
    ).toContain('by: extension:sentry')
    const [created] = await client.events({ types: ['task_created'] })
    expect(created?.detail.by).toBe('extension:sentry')
  })

  it('runs a task in a harness of its own, and refuses one that cannot run yet', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: INTENT })
    await expect(
      client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'codex' }),
    ).rejects.toThrow(/not supported yet/)
    await expect(
      client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'nope' }),
    ).rejects.toThrow(/no harness called nope/)
    expect(
      await client.setAgentHarness({ task: task.id, worktree: task.worktree, harness: 'pi' }),
    ).toEqual({ harness: 'pi', restarted: false })
    expect(
      readFileSync(join(repo.root, '.tade', 'tasks', 'refunds', 'task.yaml'), 'utf8'),
    ).toContain('harness: pi')
  })

  it('refuses a project it has never heard of', async () => {
    await expect(client.createTask({ project: 'nope', slug: 'x', intent: 'y' })).rejects.toThrow(
      /unknown project/,
    )
  })

  it('removes a finished task and records that too', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
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
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
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

  it('starts an agent in a lane in the task worktree, then stops it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
    // No prompt: the agent starts and waits, so this needs no model.
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })

    // The lane, the run and the task are one thing under one name.
    expect(lane).toMatchObject({ id: 'app/refunds/agent', task: 'app/refunds', alive: true })
    expect((await client.runs()).map((r) => r.run)).toEqual(['app/refunds/agent'])
    expect((await client.info()).runs).toBe(1)

    const [started] = await client.events({ types: ['run_started'] })
    expect(started?.task).toBe('app/refunds')
    expect(started?.detail).toMatchObject({ adapter: 'pi', approvals: 'bypass' })

    await client.stopAgent('app/refunds')
    expect(await client.runs()).toEqual([])
    expect(client.lane('app/refunds/agent' as never)?.alive).toBe(false)
  }, 60_000)

  it('says the opening instruction once: reopening an agent says nothing to it', async () => {
    const task = await client.createTask({
      project: 'app',
      slug: 'refunds',
      intent: INTENT,
      workspace: 'worktree',
    })
    const lane = await client.startAgent({
      task: task.id,
      cwd: task.worktree,
      prompt: 'start with the webhook',
    })
    // Said to the agent once, when it started...
    const launched = (await client.driver.list()).find((one) => one.id === lane.id)
    expect(launched?.spec.args).toContain('start with the webhook')
    // ...and left out of what is written down, which is how it comes back.
    expect(lane.spec.args).not.toContain('start with the webhook')
    expect(readFileSync(join(home, 'lanes.json'), 'utf8')).not.toContain('start with the webhook')

    // The window closed on it, and opens it again where it left off.
    await client.stopAgent(task.id)
    const back = await client.reopenAgent({ task: task.id, cwd: task.worktree })
    const again = (await client.driver.list()).find((one) => one.id === back.id)
    expect(again?.spec.args).not.toContain('start with the webhook')
    // The same conversation, not a new one: the session id is the task's.
    expect(again?.spec.args).toContain(sessionIdFor(task.id))
  }, 60_000)

  it('starts new agents on the model last chosen for one, and a returning one on its own', async () => {
    const sessionsRoot = tmp('tade-sessions-')
    await client.close()
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot })
    client.keepAgentModel('app/refunds', { provider: 'openrouter', id: 'anthropic/claude-opus-5' })
    // Kept where Settings shows the agent model, so the next window starts there too.
    expect(readFileSync(join(home, 'config.yaml'), 'utf8')).toContain('anthropic/claude-opus-5')

    const fresh = await client.createTask({ project: 'app', slug: 'fresh', intent: INTENT })
    const lane = await client.startAgent({ task: fresh.id, cwd: fresh.worktree, prompt: '' })
    expect(lane.spec.args.join(' ')).toContain(
      '--provider openrouter --model anthropic/claude-opus-5',
    )

    // A conversation to come back to keeps the model it was on: pi remembers it.
    const back = await client.createTask({ project: 'app', slug: 'back', intent: INTENT })
    const dir = join(sessionsRoot, '-src-app-')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `2026-09-13T04-14-42-404Z_${sessionIdFor('app/back')}.jsonl`),
      '{"type":"session","version":3}\n',
    )
    const returning = await client.startAgent({ task: back.id, cwd: back.worktree, prompt: '' })
    expect(returning.spec.args).not.toContain('--model')
  }, 60_000)

  it('starts new agents as hard-thinking as was last chosen, and refuses a level there is not', async () => {
    await expect(client.setAgentThinking('app/refunds', 'ludicrous')).rejects.toThrow(
      /not a thinking level/,
    )
    writeFileSync(
      join(home, 'config.yaml'),
      `projects:\n  app:\n    root: ${repo.root}\n    max_parallel: 2\nworkers:\n  routes:\n    default:\n      thinking: high\n`,
    )
    await client.close()
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
    const task = await client.createTask({ project: 'app', slug: 'deep', intent: INTENT })
    const lane = await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    expect(lane.spec.args.join(' ')).toContain('--thinking high')
  }, 60_000)

  it('refuses a second agent on the same task, even when the project allows two', async () => {
    const task = await client.createTask({ project: 'app', slug: 'search', intent: INTENT })
    await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    // Two agents in one worktree is two agents editing the same files.
    await expect(
      client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' }),
    ).rejects.toThrow(/already has an agent/)
  }, 60_000)

  it('forgets an agent whose process ended on its own, so it neither counts nor blocks a restart', async () => {
    const one = await client.createTask({ project: 'app', slug: 'one', intent: INTENT })
    const two = await client.createTask({ project: 'app', slug: 'two', intent: INTENT })
    const lane = await client.startAgent({ task: one.id, cwd: one.worktree, prompt: '' })
    await client.startAgent({ task: two.id, cwd: two.worktree, prompt: '' })
    expect(client.runs()).toHaveLength(2)

    // Nobody stopped it: the process just went, the way a crash or `/quit` does.
    process.kill(lane.pid ?? 0, 'SIGKILL')
    await until(() => client.runs().length === 1)
    expect(client.runs().map((run) => run.task)).toEqual([two.id])
    const exited = await until(
      async () => (await client.events({ types: ['run_exited'], task: one.id }))[0],
    )
    expect(exited?.detail).toHaveProperty('code')

    // Its slot is free, and the same task starts again rather than "run already exists".
    await expect(
      client.startAgent({ task: one.id, cwd: one.worktree, prompt: '' }),
    ).resolves.toMatchObject({ id: `${one.id}/agent` })
  }, 90_000)

  it('refuses more agents than the project allows', async () => {
    for (const slug of ['one', 'two']) {
      const task = await client.createTask({ project: 'app', slug, intent: INTENT })
      await client.startAgent({ task: task.id, cwd: task.worktree, prompt: '' })
    }
    const third = await client.createTask({ project: 'app', slug: 'three', intent: INTENT })
    await expect(
      client.startAgent({ task: third.id, cwd: third.worktree, prompt: '' }),
    ).rejects.toThrow(/max_parallel is 2/)
  }, 90_000)
})
