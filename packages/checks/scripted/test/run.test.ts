import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Check, Runner } from '@tade/checks-core'
import {
  carryOver,
  heldBy,
  insideHeldSlot,
  queueDir,
  RunnerError,
  readRuns,
  runChecks,
  runQueueDir,
  SLOT_ENV,
  slotHolders,
  takeMachineSlot,
  takeRunLock,
  waitForMachineSlot,
} from '@tade/checks-core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../../test/fixtures/mkrepo.ts'
import { makeScriptedRunner } from '../src/index.ts'

// Running checks the way Tade runs them: the lock, the record, and what is
// skipped said rather than dropped.

const check = (id: string, over: Partial<Check> = {}): Check => ({
  id,
  title: id,
  run: `echo ${id}`,
  alone: false,
  minutes: 1,
  required: true,
  ...over,
})

describe('running a project\u2019s checks', () => {
  it('writes down every finished run against the commit it was about', async () => {
    const root = tmp('tade-run-')
    const runs = await runChecks({
      runner: makeScriptedRunner({ answers: { tests: { state: 'failed', tail: 'boom' } } }),
      project: { name: 'demo', root },
      records: root,
      checks: [check('format'), check('tests')],
      commit: 'a1b2c3d4e5',
      by: 'demo/task',
    })
    expect(runs.map((one) => one.state).sort()).toEqual(['failed', 'passed'])
    const written = await readRuns(root)
    expect(written.map((one) => one.check).sort()).toEqual(['format', 'tests'])
    expect(written.every((one) => one.commit === 'a1b2c3d4e5')).toBe(true)
  })

  it('writes down what it read, so the commit made a second later is still checked', async () => {
    const repo = mkrepo()
    repo.commit('start', { 'a.txt': 'a\n' })
    repo.write({ 'a.txt': 'a, edited\n' })
    const ran = await runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'demo', root: repo.root },
      records: repo.root,
      checks: [check('format'), check('tests')],
      commit: repo.head(),
      by: 'demo/task',
    })
    expect(ran.every((one) => one.covered?.dirty.some((path) => path.path === 'a.txt'))).toBe(true)

    repo.git('add', 'a.txt')
    repo.git('commit', '-q', '-m', 'the work')
    const written = await readRuns(repo.root)
    const at = await carryOver(repo.root, written, repo.head())
    expect([...(at.carried ?? [])].sort()).toEqual(written.map((one) => one.id).sort())
  })

  it('reports what cannot run here as skipped, with why, and never runs it', async () => {
    const root = tmp('tade-run-')
    const runs = await runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'demo', root },
      records: root,
      checks: [check('deploy', { skip: 'needs CI: it uses a secret' })],
      commit: 'a1b2c3d4e5',
      by: 'you',
    })
    expect(runs[0]?.state).toBe('skipped')
    expect(runs[0]?.summary).toContain('needs CI')
  })

  it('refuses to start a second suite in a worktree that is already running one', async () => {
    const root = tmp('tade-run-')
    const held = await takeRunLock(root, 'the suite')
    try {
      await runChecks({
        runner: makeScriptedRunner({}),
        project: { name: 'demo', root },
        records: root,
        checks: [check('tests', { alone: true })],
        commit: 'a1b2c3d4e5',
        by: 'you',
      })
      expect.unreachable('a second run must not start')
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerError)
      expect((err as RunnerError).trouble).toBe('busy')
      expect((err as RunnerError).message).toContain('the suite')
      expect((err as RunnerError).message).toContain('Wait for them')
    } finally {
      if (!('held' in held)) await held.release()
    }
    // And nothing was written: no run, no record claiming one happened.
    expect(await readRuns(root)).toEqual([])
  })

  it('says it waited when it gives up after a wait, so it never reads as refusing at once', async () => {
    const root = tmp('tade-run-')
    const held = await takeRunLock(root, 'the suite')
    try {
      const err = await runChecks({
        runner: makeScriptedRunner({}),
        project: { name: 'demo', root },
        records: root,
        checks: [check('tests', { alone: true })],
        commit: 'a1b2c3d4e5',
        by: 'you',
        waitMs: 50,
      }).catch((caught: unknown) => caught)
      expect((err as RunnerError).trouble).toBe('busy')
      expect((err as RunnerError).message).toMatch(/This run waited \d+s for them and gave up/)
      expect((err as RunnerError).message).not.toContain('Wait for them')
    } finally {
      if (!('held' in held)) await held.release()
    }
  })

  it('lets the lock go afterwards, so the next run is not blocked by the last', async () => {
    const root = tmp('tade-run-')
    const args = {
      runner: makeScriptedRunner({}),
      project: { name: 'demo', root },
      records: root,
      checks: [check('tests', { alone: true })],
      commit: 'a1b2c3d4e5',
      by: 'you',
    }
    await runChecks(args)
    await runChecks(args)
    expect((await readRuns(root)).length).toBe(2)
  })
})

describe('one suite on the machine, from any worktree', () => {
  it('refuses a suite in a second worktree while the first holds the machine', async () => {
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    const held = await takeMachineSlot(home, 1, { what: 'tests', where: '/work/other' })
    try {
      await runChecks({
        runner: makeScriptedRunner({}),
        project: { name: 'demo', root },
        records: root,
        checks: [check('tests', { alone: true })],
        commit: 'a1b2c3d4e5',
        by: 'you',
        machine: { home, most: 1 },
      })
      expect.unreachable('a second suite must not start on this machine')
    } catch (err) {
      expect((err as RunnerError).trouble).toBe('busy')
      expect((err as RunnerError).message).toContain('tests in /work/other')
      expect((err as RunnerError).message).toContain('checks.suites')
      expect((err as RunnerError).message).toContain('Wait for them')
    } finally {
      if (!('held' in held)) await held.release()
    }
    // Its own worktree is let go again, so the next run here is not told it is busy.
    expect(await heldBy(root)).toBeNull()
    expect(await readRuns(root)).toEqual([])
  })

  it('waits for the machine when asked to, and says who it is waiting for', async () => {
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    const held = await takeMachineSlot(home, 1, { what: 'tests', where: '/work/other' })
    setTimeout(() => {
      if (!('held' in held)) void held.release()
    }, 100)
    const told: string[] = []
    const ran = await runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'demo', root },
      records: root,
      checks: [check('tests', { alone: true })],
      commit: 'a1b2c3d4e5',
      by: 'you',
      waitMs: 10_000,
      machine: { home, most: 1 },
      onWait: (ahead) => told.push(ahead.map((one) => one.where).join()),
    })
    expect(ran.map((one) => one.state)).toEqual(['passed'])
    expect(told).toEqual(['/work/other'])
  })

  it('says it waited when the machine stays held past the wait', async () => {
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    const held = await takeMachineSlot(home, 1, { what: 'tests', where: '/work/other' })
    try {
      const err = await runChecks({
        runner: makeScriptedRunner({}),
        project: { name: 'demo', root },
        records: root,
        checks: [check('tests', { alone: true })],
        commit: 'a1b2c3d4e5',
        by: 'you',
        waitMs: 50,
        machine: { home, most: 1 },
      }).catch((caught: unknown) => caught)
      expect((err as RunnerError).trouble).toBe('busy')
      expect((err as RunnerError).message).toContain('checks.suites')
      expect((err as RunnerError).message).toMatch(/This run waited \d+s for them and gave up/)
    } finally {
      if (!('held' in held)) await held.release()
    }
  })

  it('tells its commands which slot they are under, and gives it back after', async () => {
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    const scripted = makeScriptedRunner({})
    let inside = false
    const runner: Runner = {
      ...scripted,
      run: async (project, checks, ctx) => {
        // What the suite's own guard asks: is the slot I was handed held?
        inside = await insideHeldSlot(home, { [SLOT_ENV]: ctx.env?.[SLOT_ENV] ?? '' })
        return scripted.run(project, checks, ctx)
      },
    }
    await runChecks({
      runner,
      project: { name: 'demo', root },
      records: root,
      checks: [check('tests', { alone: true })],
      commit: 'a1b2c3d4e5',
      by: 'you',
      machine: { home, most: 1 },
    })
    expect(inside).toBe(true)
    expect(await slotHolders(home)).toEqual([])
  })

  it('lets its worktree go when the machine cannot be asked at all', async () => {
    const home = join(tmp('tade-run-home-'), 'not-a-folder')
    writeFileSync(home, '')
    const root = tmp('tade-run-')
    await expect(
      runChecks({
        runner: makeScriptedRunner({}),
        project: { name: 'demo', root },
        records: root,
        checks: [check('tests', { alone: true })],
        commit: 'a1b2c3d4e5',
        by: 'you',
        machine: { home, most: 1 },
      }),
    ).rejects.toThrow()
    expect(await heldBy(root)).toBeNull()
  })

  it('keeps its place for the checkout when it had it and gave up waiting for the machine', async () => {
    // What a checks_run lost eight times in 85 minutes: it had the checkout,
    // waited ten minutes for a shell's suite to give up the machine, and let
    // the checkout go with its place. The run queued behind it had it 0.8 s
    // later, 14 s before it asked again, and then the machine too.
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    const shell = await takeMachineSlot(home, 1, { what: 'vitest, 424 files', where: root })
    if ('held' in shell) throw new Error('the slot should have been free')
    const ran: string[] = []
    const run = (by: string, waitMs: number) =>
      runChecks({
        runner: makeScriptedRunner({}),
        project: { name: 'demo', root },
        records: root,
        checks: [check('related', { alone: true })],
        commit: 'a1b2c3d4e5',
        by,
        waitMs,
        machine: { home, most: 1 },
      }).then(
        () => ran.push(by),
        (err: unknown) => {
          if ((err as RunnerError).trouble !== 'busy') throw err
          ran.push(`${by} gave up`)
        },
      )
    let checkoutHeld = false
    const first = run('task-a', 300)
    // Asked once task-a has the checkout, a millisecond later than it did.
    while (!checkoutHeld) {
      checkoutHeld = (await heldBy(root)) !== null
      await new Promise((done) => setTimeout(done, 2))
    }
    const behind = run('task-b', 20_000)
    await first
    expect(ran).toEqual(['task-a gave up'])
    await shell.release()
    await Promise.all([run('task-a', 20_000), behind])
    expect(ran).toEqual(['task-a gave up', 'task-a', 'task-b'])
  })

  it('holds its turn for the machine while it waits for the checkout, past the turn it was kept with', async () => {
    // Kept for the machine, then waiting for the checkout first, a run's place
    // stopped holding its turn two minutes after it was kept, and a shell's
    // suite that asked after it had the slot.
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    const shell = await takeMachineSlot(home, 1, { what: 'vitest, 424 files', where: '/work/b' })
    if ('held' in shell) throw new Error('the slot should have been free')
    await waitForMachineSlot(
      home,
      1,
      { what: 'related', where: root },
      {
        waitMs: 40,
        everyMs: 10,
        as: 'task-a',
      },
    )
    const late = pastItsTurn(home)
    const sync = await takeRunLock(root, 'keeping demo in step')
    if ('held' in sync) throw new Error('the checkout should have been free')
    const waiting = runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'demo', root },
      records: root,
      checks: [check('related', { alone: true })],
      commit: 'a1b2c3d4e5',
      by: 'task-a',
      waitMs: 20_000,
      machine: { home, most: 1 },
      now: late,
    })
    const by = Date.now() + 5_000
    while (keptHeld(home) <= late() && Date.now() < by)
      await new Promise((done) => setTimeout(done, 5))
    await shell.release()
    const newcomer = await takeMachineSlot(
      home,
      1,
      { what: 'vitest, 424 files', where: '/work/c' },
      late,
    )
    if (!('held' in newcomer)) await newcomer.release()
    expect('held' in newcomer).toBe(true)
    await sync.release()
    expect((await waiting).map((one) => one.state)).toEqual(['passed'])
  })

  it('does not hold up, with a place it kept, the run that has its checkout and waits for the machine behind it', async () => {
    // That run cannot let the checkout go before it has the machine, and the
    // kept place cannot go before it has the checkout: held, each waits for the other.
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    const shell = await takeMachineSlot(home, 1, { what: 'vitest, 424 files', where: '/work/b' })
    if ('held' in shell) throw new Error('the slot should have been free')
    await waitForMachineSlot(
      home,
      1,
      { what: 'related', where: root },
      {
        waitMs: 40,
        everyMs: 10,
        as: 'task-a',
      },
    )
    const late = pastItsTurn(home)
    const ran: string[] = []
    const run = (by: string, waitMs: number) =>
      runChecks({
        runner: makeScriptedRunner({}),
        project: { name: 'demo', root },
        records: root,
        checks: [check('related', { alone: true })],
        commit: 'a1b2c3d4e5',
        by,
        waitMs,
        machine: { home, most: 1 },
        now: late,
      }).then(
        () => ran.push(by),
        (err: unknown) => {
          if ((err as RunnerError).trouble !== 'busy') throw err
          ran.push(`${by} gave up`)
        },
      )
    const f = run('task-f', 5_000)
    while (!readdirSync(queueDir(home)).some((name) => name.endsWith('.wait')))
      await new Promise((done) => setTimeout(done, 2))
    const a = run('task-a', 20_000)
    while (!waitsIn(runQueueDir(root))) await new Promise((done) => setTimeout(done, 2))
    await shell.release()
    await Promise.all([f, a])
    expect(ran).toEqual(['task-f', 'task-a'])
  })

  it('takes nothing of the machine for checks that do not need it to themselves', async () => {
    const home = tmp('tade-run-home-')
    const root = tmp('tade-run-')
    await takeMachineSlot(home, 1, { what: 'tests', where: '/work/other' })
    const ran = await runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'demo', root },
      records: root,
      checks: [check('lint')],
      commit: 'a1b2c3d4e5',
      by: 'you',
      machine: { home, most: 1 },
    })
    expect(ran.map((one) => one.state)).toEqual(['passed'])
  })
})

/** When the place kept in the machine's queue stops holding its turn, as it says; 0 for none. */
function keptHeld(home: string): number {
  const kept = readdirSync(queueDir(home)).find((name) => name.endsWith('.kept'))
  if (!kept) return 0
  try {
    return (JSON.parse(readFileSync(join(queueDir(home), kept), 'utf8')) as { held: number }).held
  } catch {
    return 0
  }
}

/** A clock a second past the turn the kept place was kept with. */
function pastItsTurn(home: string): () => number {
  const by = keptHeld(home) - Date.now() + 1_000
  return () => Date.now() + by
}

function waitsIn(dir: string): boolean {
  try {
    return readdirSync(dir).some((name) => name.endsWith('.wait'))
  } catch {
    return false
  }
}
