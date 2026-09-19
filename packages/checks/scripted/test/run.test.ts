import type { Check } from '@tade/checks-core'
import { RunnerError, readRuns, runChecks, takeRunLock } from '@tade/checks-core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
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
      checks: [check('format'), check('tests')],
      commit: 'a1b2c3d4e5',
      by: 'demo/task',
    })
    expect(runs.map((one) => one.state).sort()).toEqual(['failed', 'passed'])
    const written = await readRuns(root)
    expect(written.map((one) => one.check).sort()).toEqual(['format', 'tests'])
    expect(written.every((one) => one.commit === 'a1b2c3d4e5')).toBe(true)
  })

  it('reports what cannot run here as skipped, with why, and never runs it', async () => {
    const root = tmp('tade-run-')
    const runs = await runChecks({
      runner: makeScriptedRunner({}),
      project: { name: 'demo', root },
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
      checks: [check('tests', { alone: true })],
      commit: 'a1b2c3d4e5',
      by: 'you',
    }
    await runChecks(args)
    await runChecks(args)
    expect((await readRuns(root)).length).toBe(2)
  })
})
