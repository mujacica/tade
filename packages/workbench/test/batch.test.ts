import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  queueDir,
  type RunnerError,
  readRuns,
  runChecks,
  runQueueDir,
  takeMachineSlot,
  takeRunLock,
  waitForMachineSlot,
} from '@tade/checks-core'
import { makeScriptedRunner } from '@tade/checks-scripted'
import { ConfigSchema, projectDir, recordsDir } from '@tade/core'
import { describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
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

  it('is never moved to another commit under a run that is reading it', async () => {
    // An agent's full run before a push uses this tree too, so a second run
    // checking out its own commit here would change what the first one reads.
    const repo = mkrepo()
    const marks = tmp('tade-batch-marks-')
    const started = join(marks, 'started')
    const go = join(marks, 'go')
    repo.commit('a gate that waits to be let go', {
      [CI_WORKFLOW]: ciWorkflow([
        { id: 'tests', run: `touch ${started}; until [ -e ${go} ]; do sleep 0.05; done` },
      ]),
    })
    const config = ConfigSchema.parse({
      projects: { shop: { root: repo.root, checks: { full: 'batched' } } },
    })
    const at = { config, home: repo.home, project: 'shop', root: repo.root, userHome: repo.home }
    const first = repo.head()
    const reading = runBatch({ ...at, commit: first, by: 'shop/one' })
    await vi.waitFor(() => expect(existsSync(started)).toBe(true), { timeout: 30_000 })

    const later = commit(repo, 'two', { 'two.txt': '2' })
    const second = await runBatch({ ...at, commit: later })
    expect(second).toMatchObject({ busy: true })
    expect('problem' in second && second.problem).toMatch(/already running in its own tree/)
    expect(repo.git('-C', batchDir(repo.home, 'shop'), 'rev-parse', 'HEAD').trim()).toBe(first)

    writeFileSync(go, '')
    const done = await reading
    if (!('runs' in done)) throw new Error(done.problem)
    expect(done.runs.map((run) => [run.state, run.by, run.commit])).toEqual([
      ['passed', 'shop/one', first],
    ])
    // Let go, so the next one gets it.
    const next = await runBatch({ ...at, commit: later })
    expect('runs' in next && next.runs[0]?.state).toBe('passed')
  })
})

describe('a place kept for the machine, while its run waits for the batch tree', () => {
  // An agent's full run gave up at its deadline waiting for the machine and
  // kept its place there. Asking again, it waits for the batch tree's turn
  // first, and its kept place stopped holding its turn two minutes after it
  // was kept: a suite that asked after it had the slot.

  /** The machine held by somebody's shell suite, and a place `as` kept behind it, past its turn. */
  async function keptPastItsTurn(home: string, as: string) {
    const shell = await takeMachineSlot(home, 1, { what: 'vitest, 424 files', where: '/work/b' })
    if ('held' in shell) throw new Error('the slot should have been free')
    await waitForMachineSlot(
      home,
      1,
      { what: 'tests', where: batchDir(home, 'shop') },
      { waitMs: 40, everyMs: 10, as },
    )
    // The two minutes it held its turn for, gone by.
    const kept = keptFile(home)
    const raw = JSON.parse(readFileSync(kept, 'utf8')) as Record<string, unknown>
    writeFileSync(kept, `${JSON.stringify({ ...raw, held: Date.now() - 1 })}\n`)
    return shell
  }

  function keptFile(home: string): string {
    const kept = readdirSync(queueDir(home)).find((name) => name.endsWith('.kept'))
    if (!kept) throw new Error('nothing was kept')
    return join(queueDir(home), kept)
  }

  const keptHeld = (home: string) => {
    try {
      return (JSON.parse(readFileSync(keptFile(home), 'utf8')) as { held: number }).held
    } catch {
      return 0
    }
  }

  const waitsIn = (dir: string) => {
    try {
      return readdirSync(dir).some((name) => name.endsWith('.wait'))
    } catch {
      return false
    }
  }

  const treeTurn = (home: string) => join(projectDir(home, 'shop'), 'batch-turn')

  it('holds its turn for the machine while the run waits for the tree', async () => {
    const { repo, at } = project()
    const shell = await keptPastItsTurn(repo.home, 'shop/one')
    const moving = await takeRunLock(treeTurn(repo.home), 'full checks at 0123abcd')
    if ('held' in moving) throw new Error('the tree should have been free')
    const waiting = runBatch({
      ...at,
      userHome: repo.home,
      commit: repo.head(),
      by: 'shop/one',
      waitMs: 20_000,
    })
    await vi.waitFor(() => expect(keptHeld(repo.home)).toBeGreaterThan(Date.now()), {
      timeout: 5_000,
    })
    await shell.release()
    const newcomer = await takeMachineSlot(repo.home, 1, {
      what: 'vitest, 424 files',
      where: '/work/c',
    })
    if (!('held' in newcomer)) await newcomer.release()
    expect('held' in newcomer).toBe(true)
    await moving.release()
    const done = await waiting
    if (!('runs' in done)) throw new Error(done.problem)
    expect(done.runs.map((run) => [run.state, run.by])).toEqual([['passed', 'shop/one']])
  })

  it('does not hold up the run that has the tree and waits for the machine behind it', async () => {
    const { repo, at } = project()
    const shell = await keptPastItsTurn(repo.home, 'shop/one')
    const ran: string[] = []
    const batch = (by: string, waitMs: number) =>
      runBatch({ ...at, userHome: repo.home, commit: repo.head(), by, waitMs }).then((done) =>
        ran.push('runs' in done ? by : `${by} gave up`),
      )
    const two = batch('shop/two', 5_000)
    await vi.waitFor(() => expect(waitsIn(queueDir(repo.home))).toBe(true), { timeout: 5_000 })
    const one = batch('shop/one', 20_000)
    await vi.waitFor(() => expect(waitsIn(runQueueDir(treeTurn(repo.home)))).toBe(true), {
      timeout: 5_000,
    })
    await shell.release()
    await Promise.all([two, one])
    expect(ran).toEqual(['shop/two', 'shop/one'])
  })

  it('does not hold up a run in the checkout that has its lock, while the tree waits for it', async () => {
    // The tree's run waits for the checkout's lock, held by a run there that
    // waits for the machine behind the kept place: held, all three wait. Let
    // go, the place still holds its last few seconds (`STILL_MS`), which the
    // tree's run waits out.
    const { repo, at } = project()
    const shell = await keptPastItsTurn(repo.home, 'shop/one')
    const ran: string[] = []
    const there = runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'shop', root: repo.root },
      records: recordsDir(repo.home, 'shop', null),
      checks: [
        { id: 'related', title: 'related', run: 'true', alone: true, minutes: 1, required: true },
      ],
      commit: repo.head(),
      by: 'shop/three',
      waitMs: 5_000,
      machine: { home: repo.home, most: 1 },
    }).then(
      () => ran.push('shop/three'),
      (err: unknown) => {
        if ((err as RunnerError).trouble !== 'busy') throw err
        ran.push('shop/three gave up')
      },
    )
    await vi.waitFor(() => expect(waitsIn(queueDir(repo.home))).toBe(true), { timeout: 5_000 })
    const batch = (by: string, waitMs: number) =>
      runBatch({ ...at, userHome: repo.home, commit: repo.head(), by, waitMs }).then((done) =>
        ran.push('runs' in done ? by : `${by} gave up`),
      )
    const two = batch('shop/two', 30_000)
    await vi.waitFor(
      () => expect(waitsIn(runQueueDir(recordsDir(repo.home, 'shop', null)))).toBe(true),
      { timeout: 10_000 },
    )
    const one = batch('shop/one', 60_000)
    await vi.waitFor(() => expect(waitsIn(runQueueDir(treeTurn(repo.home)))).toBe(true), {
      timeout: 5_000,
    })
    await shell.release()
    await Promise.all([there, two, one])
    expect(ran).toEqual(['shop/three', 'shop/two', 'shop/one'])
  })

  it('loses no turn with a batch run, a related run and a shell suite waiting together', async () => {
    // shop/one kept a place for the machine and asks again for a full run. It
    // has the tree and waits for the checkout's lock, which a related run there
    // holds while it waits for the machine behind that place: held, the two
    // wait for each other. Then a shell's suite in the checkout asks, and must
    // not go before shop/one because it waits from where the related run does.
    const { repo, at } = project()
    const shell = await keptPastItsTurn(repo.home, 'shop/one')
    const records = recordsDir(repo.home, 'shop', null)
    const ran: string[] = []
    const first = (who: string) => () => {
      if (!ran.includes(who)) ran.push(who)
    }
    const related = runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'shop', root: repo.root },
      records,
      checks: [
        { id: 'related', title: 'related', run: 'true', alone: true, minutes: 1, required: true },
      ],
      commit: repo.head(),
      by: 'shop/three',
      waitMs: 20_000,
      machine: { home: repo.home, most: 1 },
      onRun: first('shop/three'),
    }).catch((err: unknown) => {
      if ((err as RunnerError).trouble !== 'busy') throw err
      ran.push('shop/three gave up')
    })
    await vi.waitFor(() => expect(waitsIn(queueDir(repo.home))).toBe(true), { timeout: 5_000 })
    const full = runBatch({
      ...at,
      userHome: repo.home,
      commit: repo.head(),
      by: 'shop/one',
      waitMs: 30_000,
      onRun: first('shop/one'),
    }).then((done) => {
      if (!('runs' in done)) ran.push('shop/one gave up')
    })
    await vi.waitFor(() => expect(waitsIn(runQueueDir(records))).toBe(true), { timeout: 10_000 })
    // A suite somebody typed into a shell: its own process, as it is, which
    // takes the machine's turn from the suite's own setup (`test/one-suite.ts`).
    const suite = spawn(process.execPath, ['--input-type=module', '-e', SHELL_SUITE], {
      env: {
        ...process.env,
        SUITE_MACHINE: pathToFileURL(join(import.meta.dirname, '../../checks/core/src/machine.ts'))
          .href,
        SUITE_HOME: repo.home,
        SUITE_ROOT: repo.root,
      },
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    const suiteDone = new Promise<void>((done) => suite.on('exit', () => done()))
    suite.stdout.on('data', (chunk: Buffer) => {
      for (const line of chunk.toString().split('\n')) if (line) ran.push(`shell: ${line}`)
    })
    await vi.waitFor(
      () =>
        expect(
          readdirSync(queueDir(repo.home)).filter((name) => name.endsWith('.wait')),
        ).toHaveLength(2),
      { timeout: 10_000 },
    )
    await shell.release()
    await Promise.all([related, full, suiteDone])
    expect(ran).toEqual(['shop/three', 'shop/one', 'shell: has it'])
  })
})

/** A shell's suite waiting for the machine from the checkout, saying when it has it. */
const SHELL_SUITE = `
const { waitForMachineSlot } = await import(process.env.SUITE_MACHINE)
const got = await waitForMachineSlot(
  process.env.SUITE_HOME,
  1,
  { what: 'vitest, 424 files', where: process.env.SUITE_ROOT },
  { waitMs: 60000, everyMs: 20 },
)
if ('held' in got) {
  console.log('gave up')
} else {
  console.log('has it')
  await got.release()
}
`

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
    // is known green from its run, so it is never run again; and the commit it
    // came to is looked at a second time before it is named.
    expect(narrowed.steps[0]).toMatch(new RegExp(`^${c.slice(0, 8)}: failed`))
    expect(narrowed.steps.some((step) => step.startsWith(base.slice(0, 8)))).toBe(false)
    expect(narrowed.steps.at(-1)).toBe(`${b.slice(0, 8)}, a second time: failed`)
  })

  /**
   * A check whose failures vary: while `broken` is in the tree it fails the
   * runs `fails` says, by how many times it has been run there (from 1), and
   * names the tests `names` says. Its count is kept outside every tree.
   */
  function varying(
    repo: ReturnType<typeof mkrepo>,
    fails: (n: number) => boolean,
    names: (n: number) => string[] = () => [],
  ): string {
    const count = join(repo.home, 'count')
    const cases = Array.from({ length: 12 }, (_, i) => i + 1)
      .map((n) => {
        const lines = names(n).map((name) => `echo ' FAIL  ${name} > it holds'`)
        return `  ${n}) ${[...lines, `exit ${fails(n) ? 1 : 0}`].join('; ')} ;;`
      })
      .join('\n')
    const script = join(repo.home, 'varying.sh')
    writeFileSync(
      script,
      [
        'test -e broken || exit 0',
        `n=$(( $(cat '${count}' 2>/dev/null || echo 0) + 1 ))`,
        `echo "$n" > '${count}'`,
        'case "$n" in',
        cases,
        'esac',
        'exit 0',
        '',
      ].join('\n'),
    )
    return `sh '${script}'`
  }

  it('cannot tell when the commit it came to passes when the tests run there again', async () => {
    const { repo, at } = project()
    const base = repo.head()
    const a = commit(repo, 'a', { 'a.txt': 'a' })
    const b = commit(repo, 'b', { broken: 'yes' })
    const c = commit(repo, 'c', { 'c.txt': 'c' })
    // Red at c, then at b, then green at b a second time: load, not b.
    const narrowed = await narrowRed({
      ...at,
      base,
      baseGreen: true,
      commits: [a, b, c],
      command: varying(repo, (n) => n < 3),
    })
    expect(narrowed.steps).toEqual([
      `${c.slice(0, 8)}: failed`,
      `${a.slice(0, 8)}: passed`,
      `${b.slice(0, 8)}: failed`,
      `${b.slice(0, 8)}, a second time: passed`,
    ])
    expect(narrowed.culprit).toMatchObject({ commit: null, flaky: true })
  })

  it('cannot tell, and runs nothing more, when the tests fail other ones than the batch did', async () => {
    const { repo, at } = project()
    const base = repo.head()
    const a = commit(repo, 'a', { broken: 'yes' })
    const b = commit(repo, 'b', { 'b.txt': 'b' })
    const narrowed = await narrowRed({
      ...at,
      base,
      baseGreen: true,
      commits: [a, b],
      command: varying(
        repo,
        () => true,
        (n) => (n === 1 ? ['test/hook.test.ts'] : ['test/hook.test.ts', 'test/worker.test.ts']),
      ),
      failing: ['test/worker.test.ts', 'test/hook.test.ts'],
    })
    expect(narrowed.steps).toEqual([`${b.slice(0, 8)}: failed (test/hook.test.ts)`])
    expect(narrowed.culprit).toMatchObject({ commit: null, flaky: true })
    expect(narrowed.culprit.commit === null && narrowed.culprit.because).toMatch(
      /did not fail the same way/,
    )
  })

  it('names the commit when the same tests fail the same way at every look', async () => {
    const { repo, at } = project()
    const base = repo.head()
    const a = commit(repo, 'a', { broken: 'yes' })
    const b = commit(repo, 'b', { 'b.txt': 'b' })
    const both = ['test/hook.test.ts', 'test/worker.test.ts']
    const narrowed = await narrowRed({
      ...at,
      base,
      baseGreen: true,
      commits: [a, b],
      command: varying(
        repo,
        () => true,
        (n) => (n % 2 === 0 ? both : [...both].reverse()),
      ),
      failing: both,
    })
    expect(narrowed.culprit).toEqual({ commit: a })
    expect(narrowed.steps.at(-1)).toMatch(new RegExp(`^${a.slice(0, 8)}, a second time: failed`))
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
    // One that stopped before its summary names its files in the listing; and
    // what its record says failed is run too, though the tail no longer holds it.
    const stopped = {
      ...slow,
      state: 'timed out' as const,
      tail: ' ❯ packages/app/test/frame.test.ts (12 tests | 3 failed) 4567ms',
      failing: {
        files: ['packages/cli/test/attach.test.ts', 'packages/app/test/frame.test.ts'],
        more: 0,
      },
    }
    expect(narrowingCommand(stopped, checks)).toEqual({
      run: 'pnpm run test:related packages/cli/test/attach.test.ts packages/app/test/frame.test.ts',
      files: ['packages/cli/test/attach.test.ts', 'packages/app/test/frame.test.ts'],
    })
    expect(narrowingCommand({ ...stopped, failing: undefined }, checks)).toEqual({
      run: 'pnpm run test:related packages/app/test/frame.test.ts',
      files: ['packages/app/test/frame.test.ts'],
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
