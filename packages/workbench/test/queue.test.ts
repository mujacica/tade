import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { PlannedAgent } from '@tade/core'
import { sessionIdFor } from '@tade/harnesses-pi'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// Work asked for now and started later, against real git: a plan made in
// order, and queued work beginning where it should — on top of what it waited
// on — before its agent starts.

const agent = (name: string, over: Partial<PlannedAgent> = {}): PlannedAgent => ({
  name,
  said: `do ${name}`,
  prompt: `please do ${name}`,
  after: [],
  touches: [],
  ...over,
})

describe('queued work', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-queue-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: worktree\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('makes a plan in order, each task waiting on what it should, or none of it', async () => {
    const plan = await client.planTasks({
      project: 'app',
      said: 'fix the charge and add refunds',
      agents: [
        agent('add-refunds', { after: [{ agent: 'fix-charge', why: 'same file' }] }),
        agent('fix-charge', { done: 'committed', touches: ['src/charge.ts'] }),
      ],
    })
    expect(plan.made.map((task) => task.id)).toEqual(['app/fix-charge', 'app/add-refunds'])
    const [, refunds] = plan.made
    const file = readFileSync(join(refunds?.worktree ?? '', '.tade', 'task.yaml'), 'utf8')
    expect(file).toContain('task: app/fix-charge')
    expect(file).toContain('why: same file')
    expect(file).toContain('prompt: please do add-refunds')
    const created = await client.events({ types: ['task_created'], task: 'app/add-refunds' })
    expect(created[0]?.detail).toMatchObject({ by: 'orchestrator', after: ['app/fix-charge'] })

    await expect(
      client.planTasks({
        project: 'app',
        said: '',
        agents: [agent('lost', { after: [{ agent: 'ghost', why: '' }] }), agent('fine')],
      }),
    ).rejects.toThrow(/ghost, which is neither in the plan nor a task in app/)
    // Refused whole: not even the part that was fine was made.
    expect(existsSync(join(home, 'worktrees', 'app-fine'))).toBe(false)
  })

  it('begins on top of what it waited on, and its agent is told what was planned', async () => {
    const {
      made: [fix, refunds],
    } = await client.planTasks({
      project: 'app',
      said: '',
      agents: [
        agent('fix-charge'),
        agent('add-refunds', { after: [{ agent: 'fix-charge', why: '' }] }),
      ],
    })
    if (!fix || !refunds) throw new Error('the plan made nothing')
    repo.commit('charge once', { 'charge.ts': 'once' }, fix.worktree)
    const lane = await client.startQueued({
      task: refunds.id,
      worktree: refunds.worktree,
      from: ['tade/fix-charge'],
      why: 'app/fix-charge has finished',
    })
    expect(repo.head(refunds.worktree)).toBe(repo.head(fix.worktree))
    const own = readFileSync(join(refunds.worktree, '.tade', 'task.yaml'), 'utf8')
    // Still its own task, though what it waited on committed its task file over it...
    expect(own).toContain('id: app/add-refunds')
    // ...and its own work is what comes after this, not after where it was planned.
    expect(own).toContain(`base: ${repo.head(fix.worktree)}`)
    // Told at launch and nowhere else: what is written down is the line that
    // comes back to it, which cannot say its instruction a second time.
    expect(lane.spec.args).not.toContain('please do add-refunds')
    expect((await client.driver.list()).find((one) => one.id === lane.id)?.spec.args).toContain(
      'please do add-refunds',
    )
    const [started] = await client.events({ types: ['queue_started'] })
    expect(started).toMatchObject({
      task: 'app/add-refunds',
      detail: { why: 'app/fix-charge has finished', after: ['app/fix-charge'] },
    })
    expect(started?.detail.reopened).toBeUndefined()
  }, 60_000)

  it('tells queued work what it is for once, and brings back what has already been told', async () => {
    // Its own sessions directory, so what pi remembers is this test's alone.
    const sessionsRoot = tmp('tade-sessions-')
    await client.close()
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot })
    const {
      made: [again],
    } = await client.planTasks({ project: 'app', said: '', agents: [agent('again')] })
    if (!again) throw new Error('the plan made nothing')

    // It ran before — pi kept the conversation — and whatever said so was
    // lost, so the queue is looking at it as though it had never started.
    const dir = join(sessionsRoot, 'worktree')
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, `2026-09-13T04-14-42-404Z_${sessionIdFor(again.id)}.jsonl`),
      '{"type":"session","version":3}\n',
    )

    const lane = await client.startQueued({
      task: again.id,
      worktree: again.worktree,
      why: 'there was room for it',
    })
    // Nothing said to it: it comes back where it left off instead of being
    // set off on work it has already done.
    expect((await client.driver.list()).find((one) => one.id === lane.id)?.spec.args).not.toContain(
      'please do again',
    )
    const [started] = await client.events({ types: ['queue_started'] })
    expect(started?.detail).toMatchObject({ reopened: true })
  }, 60_000)

  it('puts two things it waited on together, and will not begin from two that conflict', async () => {
    const { made } = await client.planTasks({
      project: 'app',
      said: '',
      agents: [
        agent('one'),
        agent('two'),
        agent('both', {
          after: [
            { agent: 'one', why: '' },
            { agent: 'two', why: '' },
          ],
        }),
      ],
    })
    const [one, two, both] = made
    if (!one || !two || !both) throw new Error('the plan made nothing')
    repo.commit('one', { 'one.ts': '1' }, one.worktree)
    repo.commit('two', { 'two.ts': '2' }, two.worktree)
    await client.startQueued({
      task: both.id,
      worktree: both.worktree,
      from: ['tade/one', 'tade/two'],
      why: '',
    })
    expect(existsSync(join(both.worktree, 'one.ts'))).toBe(true)
    expect(existsSync(join(both.worktree, 'two.ts'))).toBe(true)

    const clash = await client.planTasks({
      project: 'app',
      said: '',
      agents: [
        agent('left'),
        agent('right'),
        agent('middle', {
          after: [
            { agent: 'left', why: '' },
            { agent: 'right', why: '' },
          ],
        }),
      ],
    })
    const [left, right, middle] = clash.made
    if (!left || !right || !middle) throw new Error('the plan made nothing')
    repo.commit('left', { 'README.md': 'left\n' }, left.worktree)
    repo.commit('right', { 'README.md': 'right\n' }, right.worktree)
    const planned = repo.head(middle.worktree)
    await expect(
      client.startQueued({
        task: middle.id,
        worktree: middle.worktree,
        from: ['tade/left', 'tade/right'],
        why: '',
      }),
    ).rejects.toThrow(/cannot begin from both tade\/left and tade\/right: they conflict/)
    // Back where it was planned, so it can be tried again from the same place.
    expect(repo.head(middle.worktree)).toBe(planned)
  }, 60_000)

  it('writes an order down like any other choice, and refuses one that names nothing', async () => {
    await client.planTasks({
      project: 'app',
      said: 'two things',
      agents: [agent('docs'), agent('payouts')],
    })
    await client.changeQueued({
      change: 'order',
      order: ['app/payouts', 'app/docs'],
      by: 'orchestrator',
    })
    const [written] = await client.events({ types: ['queue_changed'] })
    expect(written?.detail).toMatchObject({
      change: 'order',
      by: 'orchestrator',
      order: ['app/payouts', 'app/docs'],
    })
    // An order is about particular work, never a choice about a whole queue.
    expect(written?.detail.all).toBeUndefined()
    await expect(client.changeQueued({ change: 'order', order: [], by: 'you' })).rejects.toThrow(
      /say which comes first/,
    )
  })

  it('leaves queued work that somehow has work of its own where it is', async () => {
    const {
      made: [early],
    } = await client.planTasks({ project: 'app', said: '', agents: [agent('early')] })
    if (!early) throw new Error('the plan made nothing')
    repo.commit('already', { 'early.ts': 'x' }, early.worktree)
    await expect(
      client.startQueued({ task: early.id, worktree: early.worktree, from: ['main'], why: '' }),
    ).rejects.toThrow(/already has work of its own/)
  })
})
