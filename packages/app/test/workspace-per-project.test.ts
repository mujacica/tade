import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { ConfigSchema, type Queued, queueStateOf, readyToStart } from '@tade/core'
import { ExtensionHost, object, string } from '@tade/extensions-core'
import { collectStatus } from '@tade/status'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { gitEnv, mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { Live } from '../src/live.ts'

// What the start-time look at a project's tree does, when two projects on one
// machine answer "where does an agent work" differently.
//
// Real repositories and a real workbench, because the whole of this is git
// telling the truth about files an agent has actually changed: a fixture that
// faked the tree would be a fixture that could not get this wrong.

const opened: { live: Live; client: Workbench }[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  for (const one of opened.splice(0)) {
    await one.live.stop().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

const NOW = Date.parse('2026-09-24T12:00:00.000Z')

const queued = (task: string, touches: string[]): Queued => ({
  task,
  project: task.split('/')[0] ?? task,
  parked: false,
  start: { after: [], prompt: '', touches },
})

/** An agent at work: a real task, with its own workspace, and a run the journal opened. */
async function atWork(
  client: Workbench,
  task: string,
  root: string,
  workspace: 'checkout' | 'worktree',
) {
  const [project = '', slug = ''] = task.split('/')
  const made = await client.createTask({ project, slug, intent: slug, root, workspace })
  await client.log.append({ type: 'run_started', task, run: `${task}/agent`, detail: {} })
  return made
}

describe('the look at a project’s tree before work starts', () => {
  it('reads the project’s own mode, so one is inert and the other is real at once', async () => {
    const shared = mkrepo()
    const apart = mkrepo()
    const home = mkdtempSync(join(tmpdir(), 'tade-trees-'))
    const client = await Workbench.open({ home })
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({
        agents: { workspace: 'checkout' },
        projects: {
          shop: { root: shared.root },
          docs: { root: apart.root, workspace: 'worktree' },
        },
      }),
      home,
      tadeHome: home,
      pollMs: 600_000,
      now: () => NOW,
    })
    opened.push({ live, client })

    // An agent at work in each, where its project puts it.
    await atWork(client, 'shop/refunds', shared.root, 'checkout')
    await atWork(client, 'docs/guide', apart.root, 'worktree')
    // And each has changed a file of the same name in its own repository.
    shared.write({ 'src/charge.ts': 'charged\n' })
    apart.write({ 'src/charge.ts': 'charged\n' })

    const items = [
      queued('shop/add-refunds', ['src/charge.ts']),
      queued('docs/rewrite', ['src/charge.ts']),
    ]
    await live.refresh()
    await live.lookAtTrees(items)
    const { reality } = live.queueFacts()

    // The shared checkout: read, and what is uncommitted in it is evidence.
    expect(reality?.get('shop')).toMatchObject({
      workspace: 'checkout',
      working: ['shop/refunds'],
      dirty: ['src/charge.ts'],
    })
    // A worktree each: nothing is being changed under anybody, so there is
    // nothing to read and no git call is made — the tree is not evidence at
    // all, and saying otherwise would hold work that cannot collide. Nor is
    // its agent in any checkout: it is in a tree of its own.
    expect(reality?.get('docs')).toMatchObject({
      workspace: 'worktree',
      working: [],
      dirty: [],
      committed: [],
    })
  }, 30_000)

  it('counts a commit as its own agent’s, by the trailer, in the shared checkout only', async () => {
    const shared = mkrepo()
    const home = mkdtempSync(join(tmpdir(), 'tade-trailer-'))
    const client = await Workbench.open({ home })
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({
        agents: { workspace: 'worktree' },
        // The machine says worktree; this project says otherwise, and the look
        // has to follow the project. Read the other way round it would make a
        // git call that finds nothing and let colliding work start.
        projects: { shop: { root: shared.root, workspace: 'checkout' } },
      }),
      home,
      tadeHome: home,
      pollMs: 600_000,
      now: () => NOW,
    })
    opened.push({ live, client })

    await atWork(client, 'shop/refunds', shared.root, 'checkout')
    shared.write({ 'src/charge.ts': 'charged\n' })
    shared.git('add', 'src/charge.ts')
    shared.git(
      '-c',
      `user.name=${gitEnv().GIT_AUTHOR_NAME}`,
      'commit',
      '-q',
      '-m',
      'charge it\n\nTade-Task: shop/refunds',
    )

    await live.refresh()
    await live.lookAtTrees([queued('shop/add-refunds', ['src/charge.ts'])])
    expect(live.queueFacts().reality?.get('shop')).toMatchObject({
      workspace: 'checkout',
      committed: [{ task: 'shop/refunds', paths: ['src/charge.ts'] }],
    })
  }, 30_000)

  it('counts only who is really in the checkout: not a worktree of its own, a lane gone or a task removed', async () => {
    // tade on 2026-10-11: a watch's CI fix in a worktree, relaunched and
    // removed, was named in every hold in the checkout for a day after.
    const shared = mkrepo()
    const home = mkdtempSync(join(tmpdir(), 'tade-at-work-'))
    const client = await Workbench.open({ home })
    // Written before the window opens, so what it knows of them is the
    // whole-history read, as it was when the window had been closed and opened.
    await atWork(client, 'shop/refunds', shared.root, 'checkout')
    // Work that cannot share a tree gets a worktree whatever the project says.
    await atWork(client, 'shop/ci-fix', shared.root, 'worktree')
    const gone = await atWork(client, 'shop/gone', shared.root, 'checkout')
    const { worktree, branch } = gone
    const removed = await client.removeTask({ root: shared.root, worktree, branch, task: gone.id })
    expect(removed.removed).toBe(true)
    await atWork(client, 'shop/stopped', shared.root, 'checkout')
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({
        projects: { shop: { root: shared.root, workspace: 'checkout' } },
      }),
      home,
      tadeHome: home,
      pollMs: 600_000,
      now: () => NOW,
    })
    opened.push({ live, client })
    // And one heard while it is open: an agent whose lane went, with no exit written for its run.
    await client.log.append({ type: 'lane_exited', lane: 'shop/stopped/agent', detail: {} })
    shared.write({ 'src/charge.ts': 'charged\n' })

    await live.refresh()
    await live.lookAtTrees([queued('shop/add-refunds', ['src/charge.ts'])])
    expect(live.queueFacts().reality?.get('shop')).toMatchObject({
      workspace: 'checkout',
      working: ['shop/refunds'],
      dirty: ['src/charge.ts'],
    })
  }, 30_000)
})

describe('a project whose root the config writes with ~', () => {
  // vrolta on 2026-10-17: `root: ~/vrolta` in the config, and the queue's look
  // ran git in a literal `~/vrolta` — "cannot change to '~/vrolta'" — so every
  // hold on its files stood and held work there never started. Agents started
  // fine, because their reader expanded it and this one did not. The root is
  // now absolute once the config is read, so every reader is handed the same.
  it('is read by the queue’s look, by status and by what extensions are handed', async () => {
    const shop = mkrepo()
    // The home is the fixture's own folder, so `~/repo` is that checkout.
    vi.stubEnv('HOME', dirname(shop.root))
    const config = ConfigSchema.parse({
      projects: { shop: { root: '~/repo', workspace: 'checkout' } },
    })
    const home = mkdtempSync(join(tmpdir(), 'tade-tilde-'))
    const client = await Workbench.open({ home })
    const live = await Live.start({
      client,
      config,
      home,
      tadeHome: home,
      pollMs: 600_000,
      now: () => NOW,
    })
    opened.push({ live, client })
    await atWork(client, 'shop/refunds', shop.root, 'checkout')
    shop.write({ 'src/charge.ts': 'charged\n' })

    await live.refresh()
    await live.lookAtTrees([queued('shop/add-refunds', ['src/charge.ts'])])
    const looked = live.queueFacts().reality?.get('shop')
    expect(looked?.unread).toBeUndefined()
    expect(looked).toMatchObject({ working: ['shop/refunds'], dirty: ['src/charge.ts'] })

    const world = await collectStatus({
      config,
      now: NOW,
      home,
      tadeHome: home,
      pr: false,
      processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
    })
    expect(world.warnings.filter((one) => one.includes('~'))).toEqual([])
    expect(world.projects.find((one) => one.name === 'shop')?.root).toBe(shop.root)

    // The checks and the branch's checks find a project's checkout through
    // `ctx.project`, which is what every extension is handed.
    const host = await ExtensionHost.load({
      builtin: [
        {
          name: 'where',
          title: 'Where',
          description: 'Says where a project is.',
          tools: [
            {
              name: 'where_is',
              description: 'Where a project’s checkout is.',
              parameters: object({ project: string('which project') }, ['project']),
              for: ['orchestrator'],
              run: async (input, ctx) => ({ text: ctx.project(String(input.project)).root }),
            },
          ],
        },
      ],
      config,
      home,
    })
    const answer = await host.call(
      'where_is',
      { project: 'shop' },
      { caller: { kind: 'you' }, id: 'c1' },
    )
    expect(answer.text).toBe(shop.root)
  }, 30_000)
})

describe('what the window reads out of a task file, for the queue', () => {
  // Parking is told, not derived, and until this nothing carried it as far as
  // the rule: `live.queued` filtered on `start && !started` alone, so a parked
  // task with a start condition sat in the queue reading `ready` and would
  // have been started by the next pass. Real repository, real workbench, real
  // task files, because the whole of it is one field getting from a file on
  // the disk to a pure function — and a fixture that handed the field over
  // directly could not get that wrong.
  it('carries a park from the task file to the rule, and so starts nothing', async () => {
    const shop = mkrepo()
    const home = mkdtempSync(join(tmpdir(), 'tade-parked-'))
    // The workbench reads its own config off the disk, and it is the one that
    // makes the tasks here.
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: worktree\nprojects:\n  shop:\n    root: ${shop.root}\n`,
    )
    const client = await Workbench.open({ home })
    const live = await Live.start({
      client,
      config: ConfigSchema.parse({ projects: { shop: { root: shop.root } } }),
      home,
      tadeHome: home,
      pollMs: 600_000,
      now: () => NOW,
    })
    opened.push({ live, client })

    const {
      made: [one, other],
    } = await client.planTasks({
      project: 'shop',
      said: '',
      agents: [
        { name: 'proposed', said: '', prompt: 'do it', after: [], touches: [] },
        { name: 'ordinary', said: '', prompt: 'do it', after: [], touches: [] },
      ],
    })
    if (!one || !other) throw new Error('the plan made nothing')
    await client.parkTask(one.id, true)
    await live.refresh()

    // It is still queued work — a task with a start condition is, and hiding
    // it would leave a person with nothing to pick back up.
    const item = live.queued.find((q) => q.task === one.id)
    expect(item?.parked).toBe(true)
    expect(queueStateOf(item as Queued, live.queueFacts())).toMatchObject({
      kind: 'paused',
      parked: true,
    })
    // And the one beside it, which nobody parked, is ready.
    expect(readyToStart(live.queued, live.queueFacts(), new Map())).toEqual([other.id])

    // Picked up again, by the one act that undoes it.
    await client.parkTask(one.id, false)
    await live.refresh()
    expect(readyToStart(live.queued, live.queueFacts(), new Map()).sort()).toEqual(
      [one.id, other.id].sort(),
    )
  }, 30_000)
})
