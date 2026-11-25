import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { readRuns } from '@tade/checks-core'
import { ConfigSchema, recordsDir } from '@tade/core'
import { describe, expect, it, vi } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { CI_WORKFLOW, ciWorkflow } from '../../../test/fixtures/workflow.ts'
import {
  BATCH_BY,
  batchDir,
  coveredBy,
  narrowingCommand,
  narrowRed,
  nodeWithoutTypeScript,
  runBatch,
  runsTypeScriptOnNode,
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

describe('a Node that cannot run TypeScript', () => {
  // Ubuntu 26.04's own nodejs (22.22.1+dfsg) answers exactly this: a version
  // above every floor, and `process.features.typescript` false.
  const UBUNTU = 'false v22.22.1 /usr/bin/node'

  function nodeSaying(home: string, said: string): NodeJS.ProcessEnv {
    const bin = join(home, 'fake-node')
    mkdirSync(bin, { recursive: true })
    writeFileSync(join(bin, 'node'), `#!/bin/sh\necho '${said}'\n`)
    chmodSync(join(bin, 'node'), 0o755)
    return { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ''}` }
  }

  const TS_SCRIPTS = JSON.stringify({ scripts: { coverage: 'node scripts/coverage.ts' } })

  it('is said instead of a batch, for a project that runs its .ts on Node itself', async () => {
    const { repo, at } = project()
    repo.commit('runs ts on node', { 'package.json': TS_SCRIPTS })
    const env = nodeSaying(repo.home, UBUNTU)
    const said = await nodeWithoutTypeScript({ root: at.root, commit: repo.head(), env })
    expect(said).toContain('(v22.22.1, /usr/bin/node) is built without TypeScript')
    expect(said).toContain('`node scripts/coverage.ts`')

    // And the batch is that sentence rather than a red run blamed on a commit.
    vi.stubEnv('PATH', env.PATH)
    try {
      const batch = await runBatch({ ...at, userHome: repo.home, commit: repo.head() })
      expect(batch).toEqual({ problem: said })
    } finally {
      vi.unstubAllEnvs()
    }
    expect(await readRuns(recordsDir(repo.home, 'shop', null))).toEqual([])
  })

  it('is no reason to hold a batch where either half is missing', async () => {
    const { repo, at } = project()
    // A project that never runs .ts on Node: its checks need nothing of it.
    const plain = nodeSaying(repo.home, UBUNTU)
    expect(await nodeWithoutTypeScript({ root: at.root, commit: repo.head(), env: plain })).toBe(
      null,
    )
    repo.commit('runs ts on node', { 'package.json': TS_SCRIPTS })
    // A Node that strips types, and one too old to say: neither is `false`.
    for (const answer of ['strip v22.23.5 /x/node', 'undefined v20.20.2 /x/node']) {
      const env = nodeSaying(join(repo.home, answer.split(' ')[0] ?? ''), answer)
      expect(await nodeWithoutTypeScript({ root: at.root, commit: repo.head(), env })).toBe(null)
    }
  })

  it('reads a script that runs a .ts file with node, and nothing else', () => {
    const said = (scripts: Record<string, string>) =>
      runsTypeScriptOnNode(JSON.stringify({ scripts }))
    expect(said({ test: 'vitest run', coverage: 'node scripts/coverage.ts' })).toBe(
      'node scripts/coverage.ts',
    )
    expect(said({ x: 'cd a && node --import ./r.mjs src/bin.mts --flag' })).toBe(
      'node --import ./r.mjs src/bin.mts',
    )
    expect(said({ x: 'node dist/bin.js', y: 'tsx src/x.ts', z: 'nodemon src/x.ts' })).toBe(null)
    expect(said({ x: 'node scripts/types.d.tsx' })).toBe(null)
    expect(runsTypeScriptOnNode('not json')).toBe(null)
    expect(runsTypeScriptOnNode('{"scripts": "node x.ts"}')).toBe(null)
  })
})
