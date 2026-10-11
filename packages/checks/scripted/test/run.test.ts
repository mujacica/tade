import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Check, Runner } from '@tade/checks-core'
import {
  carryOver,
  heldBy,
  insideHeldSlot,
  RunnerError,
  readRuns,
  runChecks,
  SLOT_ENV,
  slotHolders,
  takeMachineSlot,
  takeRunLock,
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
    } finally {
      if (!('held' in held)) await held.release()
    }
    // And nothing was written: no run, no record claiming one happened.
    expect(await readRuns(root)).toEqual([])
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
