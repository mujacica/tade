import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { effortSays, effortsIn, workspaceFor } from '@tade/core'
import { collectStatus } from '@tade/status'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { Workbench } from '../src/workbench.ts'

// Two projects on one machine, answering "where does an agent work" differently
// at the same moment, and a change that spans both.
//
// Both modes live at once here on purpose: every bug this is about is a bug
// where one project's answer was read for another's. Real repositories, real
// worktrees, real task files — a fixture that shared a root would hide exactly
// the thing being tested.

describe('two projects, two answers', () => {
  let shared: ReturnType<typeof mkrepo>
  let apart: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    shared = mkrepo()
    apart = mkrepo()
    home = tmp('tade-many-')
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'agents:',
        '  workspace: checkout',
        'projects:',
        `  shop:`,
        `    root: ${shared.root}`,
        `  docs:`,
        `    root: ${apart.root}`,
        `    workspace: worktree`,
        '',
      ].join('\n'),
    )
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('reads the project’s own answer, and the machine’s where a project has none', () => {
    const config = client.config
    expect(workspaceFor(config, 'shop')).toBe('checkout')
    expect(workspaceFor(config, 'docs')).toBe('worktree')
    // A project Tade has never heard of, and no project at all, are the
    // machine's answer: a default that changes meaning is the whole thing
    // this must not do.
    expect(workspaceFor(config, 'nowhere')).toBe('checkout')
    expect(workspaceFor(config, null)).toBe('checkout')
  })

  it('puts each project’s agents where that project says, in the one window', async () => {
    const inShop = await client.createTask({ project: 'shop', slug: 'refunds', intent: 'refunds' })
    const inDocs = await client.createTask({ project: 'docs', slug: 'guide', intent: 'guide' })

    // Shared: a folder under the project's own checkout, on the branch it is on.
    expect(inShop).toMatchObject({ workspace: 'checkout', worktree: shared.root, branch: 'main' })
    expect(existsSync(join(shared.root, '.tade', 'tasks', 'refunds', 'task.yaml'))).toBe(true)
    // Its own: a worktree and a branch named for the work.
    expect(inDocs).toMatchObject({ workspace: 'worktree', branch: 'tade/guide' })
    expect(inDocs.worktree).not.toBe(apart.root)
    expect(existsSync(join(inDocs.worktree, '.tade', 'task.yaml'))).toBe(true)
  })

  it('refuses a done rule the shared checkout cannot keep, and keeps it where it can', async () => {
    await expect(
      client.createTask({ project: 'shop', slug: 'a', intent: 'a', done: 'merged' }),
    ).rejects.toThrow(/share one branch/)
    const made = await client.createTask({
      project: 'docs',
      slug: 'b',
      intent: 'b',
      done: 'merged',
    })
    expect(made.workspace).toBe('worktree')
  })

  it('sees both kinds of task at once, and removes each the right way', async () => {
    await client.createTask({ project: 'shop', slug: 'refunds', intent: 'refunds' })
    const docs = await client.createTask({ project: 'docs', slug: 'guide', intent: 'guide' })

    const seen = await collectStatus({ config: client.config, now: Date.now(), home, pr: false })
    const found = Object.fromEntries(
      seen.projects.flatMap((project) => project.tasks.map((task) => [task.id, task])),
    )
    expect(found['shop/refunds']?.workspace).toBe('checkout')
    expect(found['shop/refunds']?.worktree).toBe(shared.root)
    // A task with a worktree of its own says so by having one: `workspace` is
    // written in a task file only where it is `checkout`, since that is the
    // one that cannot be read off the directory.
    expect(found['docs/guide']?.workspace).toBeUndefined()
    expect(found['docs/guide']?.worktree).not.toBe(apart.root)
    expect(found['docs/guide']?.branch).toBe('tade/guide')

    // Removing a shared task takes its folder and nothing else: the checkout
    // is everyone's and is never removed.
    const gone = await client.removeTask({
      root: shared.root,
      worktree: shared.root,
      branch: 'main',
      task: 'shop/refunds',
    })
    expect(gone).toEqual({ removed: true, branchDeleted: false })
    expect(existsSync(join(shared.root, '.tade', 'tasks', 'refunds'))).toBe(false)
    expect(existsSync(shared.root)).toBe(true)
    expect(shared.git('rev-parse', '--abbrev-ref', 'HEAD').trim()).toBe('main')

    // Removing one with a worktree takes the worktree and its branch.
    const wentToo = await client.removeTask({
      root: apart.root,
      worktree: docs.worktree,
      branch: docs.branch,
      task: 'docs/guide',
    })
    expect(wentToo.removed).toBe(true)
    expect(existsSync(docs.worktree)).toBe(false)
  })
})

describe('a change that spans repositories', () => {
  let one: ReturnType<typeof mkrepo>
  let other: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    one = mkrepo()
    other = mkrepo()
    home = tmp('tade-effort-')
    writeFileSync(
      join(home, 'config.yaml'),
      [
        'agents:',
        '  workspace: worktree',
        'projects:',
        `  api:`,
        `    root: ${one.root}`,
        `  cli:`,
        `    root: ${other.root}`,
        '',
      ].join('\n'),
    )
    client = await Workbench.open({ home, version: '9.9.9' })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  const plan = {
    project: 'api',
    said: 'widen the oauth scopes and bump the client',
    effort: 'oauth-scopes',
    agents: [
      {
        name: 'oauth-scopes',
        said: 'widen the scopes',
        prompt: 'widen them',
        after: [],
        touches: ['src/auth.ts'],
      },
      {
        name: 'oauth-scopes',
        project: 'cli',
        said: 'bump the client',
        prompt: 'bump it',
        after: [{ agent: 'api/oauth-scopes', why: 'the scopes have to land first' }],
        touches: ['src/auth.ts'],
      },
    ],
  }

  it('makes one task per repository, each waiting on the other repository’s', async () => {
    const made = await client.planTasks(plan)
    expect(made.made.map((task) => task.id)).toEqual(['api/oauth-scopes', 'cli/oauth-scopes'])

    // The wait is kept as the qualified id, which is what lets it cross.
    const file = parseYaml(
      readFileSync(
        join(
          made.made.find((task) => task.project === 'cli')?.worktree ?? '',
          '.tade',
          'task.yaml',
        ),
        'utf8',
      ),
    )
    expect(file.start.after).toEqual([
      { task: 'api/oauth-scopes', why: 'the scopes have to land first' },
    ])
    expect(file.effort).toBe('oauth-scopes')
  })

  it('does not warn that two repositories’ files collide, because they are not one file', async () => {
    const made = await client.planTasks(plan)
    // Both touch `src/auth.ts`. In one repository that is a warning; across
    // two it is two different files and saying otherwise is a lie.
    expect(made.warnings).toEqual([])
  })

  it('writes the effort’s sentence down once, verbatim, before anything is made', async () => {
    await client.planTasks(plan)
    const [named] = await client.events({ types: ['effort_named'] })
    expect(named?.detail).toMatchObject({
      effort: 'oauth-scopes',
      projects: ['api', 'cli'],
      intent_spoken: 'widen the oauth scopes and bump the client',
    })
  })

  it('refuses the whole plan when one of its repositories is not a project here', async () => {
    await expect(
      client.planTasks({
        ...plan,
        agents: [{ ...(plan.agents[1] as (typeof plan.agents)[number]), project: 'ghost' }],
      }),
    ).rejects.toThrow(/unknown project "ghost"/)
    expect(existsSync(join(home, 'worktrees', 'ghost-oauth-scopes'))).toBe(false)
  })

  it('is a list until every part of it has finished, and says which part is not', async () => {
    await client.planTasks(plan)
    const seen = await collectStatus({ config: client.config, now: Date.now(), home, pr: false })
    const tasks = seen.projects.flatMap((project) => project.tasks)

    const nothingDone = effortsIn(tasks)
    expect(nothingDone).toHaveLength(1)
    expect(effortSays(nothingDone[0]!)).toContain('oauth-scopes (api, cli): 0 of 2 finished')

    // Finished is what the journal says, never what state a task happens to
    // be in — the same rule as everywhere else.
    const halfDone = effortsIn(tasks, new Set(['api/oauth-scopes']))
    expect(halfDone[0]?.finished).toBe(1)
    expect(effortSays(halfDone[0]!)).toBe(
      'oauth-scopes (api, cli): 1 of 2 finished — cli/oauth-scopes queued',
    )
  })
})
