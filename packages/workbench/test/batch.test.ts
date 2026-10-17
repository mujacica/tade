import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readRuns } from '@tade/checks-core'
import { ConfigSchema, recordsDir } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../test/fixtures/workflow.ts'
import {
  BATCH_BY,
  batchDir,
  coveredBy,
  narrowingCommand,
  narrowRed,
  runBatch,
  treeAt,
} from '../src/batch.ts'
import { checksAt } from '../src/checks.ts'

// The full checks for a batch, in a tree of their own at exactly the commit,
// and a red one narrowed to whose commit broke it. Real repositories, real
// runs: the check is a shell line that fails while a file called `broken` is
// in the tree.

const CHECK = 'test ! -e broken'

function project() {
  const repo = mkrepo()
  repo.commit('the gate', {
    [CI_WORKFLOW]: ciWorkflow([{ id: 'tests', run: CHECK }]),
  })
  const config = ConfigSchema.parse({
    projects: { shop: { root: repo.root, checks: { full: 'batched' } } },
  })
  const at = { config, home: repo.home, project: 'shop', root: repo.root }
  return { repo, config, at }
}

const commit = (repo: ReturnType<typeof mkrepo>, task: string, files: Record<string, string>) =>
  repo.commit(`work of ${task}\n\nTade-Task: shop/${task}`, files)

describe('a batch tree', () => {
  it('is a clone under Tade’s home at exactly the commit, with nothing a run left behind', async () => {
    const { repo, at } = project()
    const first = repo.head()
    // Somebody's work in progress in the checkout is never in the batch.
    writeFileSync(join(repo.root, 'half-written.txt'), 'wip')
    const tree = await treeAt({ ...at, commit: first })
    if (!('dir' in tree)) throw new Error(tree.problem)
    expect(tree.dir).toBe(batchDir(repo.home, 'shop'))
    expect(existsSync(join(tree.dir, 'half-written.txt'))).toBe(false)
    expect(repo.git('-C', tree.dir, 'rev-parse', 'HEAD').trim()).toBe(first)

    // And the checkout is exactly as it was.
    expect(repo.git('status', '--porcelain')).toBe('?? half-written.txt\n')

    writeFileSync(join(tree.dir, 'left-by-a-run.txt'), 'x')
    const second = commit(repo, 'a', { 'a.txt': 'a' })
    const moved = await treeAt({ ...at, commit: second })
    if (!('dir' in moved)) throw new Error(moved.problem)
    expect(repo.git('-C', moved.dir, 'rev-parse', 'HEAD').trim()).toBe(second)
    expect(existsSync(join(moved.dir, 'left-by-a-run.txt'))).toBe(false)
  })
})

describe('a batch', () => {
  it('runs the full checks at the commit and records them as the checkout’s', async () => {
    const { repo, config, at } = project()
    const head = repo.head()
    const batch = await runBatch({ ...at, userHome: repo.home, commit: head })
    if (!('runs' in batch)) throw new Error(batch.problem)
    expect(batch.runs.map((run) => [run.check, run.state])).toEqual([['tests', 'passed']])
    const runs = await readRuns(recordsDir(repo.home, 'shop', null))
    expect(runs.at(-1)).toMatchObject({ by: BATCH_BY, commit: head })
    // Read from the clean tree, so it carries to any commit with the same bytes.
    expect(runs.at(-1)?.covered?.dirty).toEqual([])
    const stood = await checksAt({
      config,
      project: 'shop',
      worktree: repo.root,
      tadeHome: repo.home,
      commit: head,
    })
    expect(stood.rollup.state).toBe('pass')
    expect(stood.batched).toBe(true)
  })

  it('reads what the commit says it checks, never an edit to CI sitting in the checkout', async () => {
    const { repo, at } = project()
    writeFileSync(join(repo.root, CI_WORKFLOW), ciWorkflow([{ id: 'tests', run: 'false' }]))
    const batch = await runBatch({ ...at, userHome: repo.home, commit: repo.head() })
    if (!('runs' in batch)) throw new Error(batch.problem)
    expect(batch.runs.map((run) => run.state)).toEqual(['passed'])
  })
})

describe('a red batch, narrowed', () => {
  it('names the commit that broke it and the task its trailer says it is', async () => {
    const { repo, at } = project()
    const green = await runBatch({ ...at, userHome: repo.home, commit: repo.head() })
    expect('runs' in green && green.runs[0]?.state).toBe('passed')
    const base = repo.head()
    const a = commit(repo, 'a', { 'a.txt': 'a' })
    const b = commit(repo, 'b', { broken: 'yes' })
    const c = commit(repo, 'c', { 'c.txt': 'c' })

    const red = await runBatch({ ...at, userHome: repo.home, commit: c })
    if (!('runs' in red)) throw new Error(red.problem)
    const failed = red.runs.find((run) => run.state === 'failed')
    if (!failed) throw new Error('the batch at c should have failed')

    const covered = await coveredBy({ ...at, head: c })
    expect(covered).toMatchObject({ base, green: true })
    expect(covered.commits.map((one) => [one.commit, one.task])).toEqual([
      [a, 'shop/a'],
      [b, 'shop/b'],
      [c, 'shop/c'],
    ])

    const command = narrowingCommand(failed, [
      { id: 'tests', title: 'tests', run: CHECK, alone: true, minutes: 1, required: true },
    ])
    if (!('run' in command)) throw new Error(command.cannot)
    const narrowed = await narrowRed({
      ...at,
      base,
      baseGreen: covered.green,
      commits: covered.commits.map((one) => one.commit),
      command: command.run,
    })
    expect(narrowed.culprit).toEqual({ commit: b })
    // HEAD first, so a failure that does not come back is nobody's; the base
    // is known green from its run, so it is never run again.
    expect(narrowed.steps[0]).toMatch(new RegExp(`^${c.slice(0, 8)}: failed`))
    expect(narrowed.steps.some((step) => step.startsWith(base.slice(0, 8)))).toBe(false)
  })

  it('says a suite that named no failing test cannot be narrowed, rather than running all of it again', () => {
    const slow = {
      id: 'c:tests:here:1',
      check: 'tests',
      commit: 'c',
      state: 'failed' as const,
      where: { kind: 'here' as const, runner: 'local', host: 'h' },
      required: true,
      startedAt: '2026-10-17T10:00:00.000Z',
      finishedAt: '2026-10-17T10:05:00.000Z',
      code: 1,
      summary: null,
      by: BATCH_BY,
      tail: 'packages/core: lines 91.2% is below its floor of 92',
    }
    const checks = [
      {
        id: 'tests',
        title: 'tests',
        run: 'node scripts/coverage.ts',
        alone: true,
        minutes: 10,
        required: true,
      },
      {
        id: 'related',
        title: 'related',
        run: 'pnpm run test:related',
        alone: false,
        minutes: 15,
        required: false,
        related: true,
      },
    ]
    expect(narrowingCommand(slow, checks)).toMatchObject({
      cannot: expect.stringMatching(/without naming a test/),
    })
    // And one that named its failing tests runs those, through the related check.
    const named = {
      ...slow,
      tail: [
        ' FAIL  packages/app/test/wire/queue.test.ts > the queue > holds work',
        '',
        ' Test Files  1 failed | 661 passed (662)',
        '      Tests  1 failed | 10737 passed (10738)',
      ].join('\n'),
    }
    expect(narrowingCommand(named, checks)).toEqual({
      run: 'pnpm run test:related packages/app/test/wire/queue.test.ts',
      files: ['packages/app/test/wire/queue.test.ts'],
    })
  })
})
