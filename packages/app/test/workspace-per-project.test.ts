import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigSchema, type Queued } from '@tade/core'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
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
  for (const one of opened.splice(0)) {
    await one.live.stop().catch(() => {})
    await one.client.close().catch(() => {})
  }
})

const NOW = Date.parse('2026-09-24T12:00:00.000Z')

const queued = (task: string, touches: string[]): Queued => ({
  task,
  project: task.split('/')[0] ?? task,
  start: { after: [], prompt: '', touches },
})

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
      pollMs: 600_000,
      now: () => NOW,
    })
    opened.push({ live, client })

    // An agent at work in each: a run the journal opened and never closed.
    for (const task of ['shop/refunds', 'docs/guide']) {
      await client.log.append({ type: 'run_started', task, detail: {} })
    }
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
    // all, and saying otherwise would hold work that cannot collide.
    expect(reality?.get('docs')).toMatchObject({
      workspace: 'worktree',
      working: ['docs/guide'],
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
      pollMs: 600_000,
      now: () => NOW,
    })
    opened.push({ live, client })

    await client.log.append({ type: 'run_started', task: 'shop/refunds', detail: {} })
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
})
