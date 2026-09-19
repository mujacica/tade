import { appendFileSync, readFileSync, statSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import type { Check, CheckLog } from '../src/port.ts'
import { readRuns, recordsPath, rollup, writeRun } from '../src/records.ts'

const run = (over: Partial<CheckLog> = {}): CheckLog => ({
  id: `a1b2c3d:${over.check ?? 'tests'}:here:1`,
  check: 'tests',
  commit: 'a1b2c3d',
  state: 'passed',
  where: { kind: 'here', runner: 'local', host: 'mbp' },
  required: true,
  startedAt: '2026-09-19T05:11:02.114Z',
  finishedAt: '2026-09-19T05:12:06.802Z',
  code: 0,
  summary: null,
  by: 'demo/task',
  tail: '',
  ...over,
})

const check = (id: string, required = true): Check => ({
  id,
  title: id,
  run: 'true',
  alone: false,
  minutes: 1,
  required,
})

describe('the run record', () => {
  it('writes a finished run and reads it back', async () => {
    const worktree = tmp('tade-runs-')
    await writeRun(worktree, run())
    const back = await readRuns(worktree)
    expect(back).toHaveLength(1)
    expect(back[0]?.check).toBe('tests')
    expect(statSync(recordsPath(worktree)).mode & 0o777).toBe(0o600)
  })

  it('writes nothing for a run that has not finished', async () => {
    const worktree = tmp('tade-runs-')
    await writeRun(worktree, run({ state: 'running', finishedAt: null }))
    expect(await readRuns(worktree)).toEqual([])
  })

  it('takes anything credential-shaped out of the tail before it lands on disk', async () => {
    const worktree = tmp('tade-runs-')
    await writeRun(
      worktree,
      run({ state: 'failed', tail: 'token: ghp_0123456789abcdefghij fail' }),
      {
        home: '/Users/nobody',
      },
    )
    const text = readFileSync(recordsPath(worktree), 'utf8')
    expect(text).not.toContain('ghp_0123456789abcdefghij')
  })

  it('keeps the newest runs and forgets the rest', async () => {
    const worktree = tmp('tade-runs-')
    for (let n = 0; n < 6; n++) {
      await writeRun(worktree, run({ id: `run-${n}` }), { keep: 3 })
    }
    const back = await readRuns(worktree)
    expect(back.map((one) => one.id)).toEqual(['run-3', 'run-4', 'run-5'])
  })

  it('skips a line that will not parse rather than losing the rest', async () => {
    const worktree = tmp('tade-runs-')
    await writeRun(worktree, run())
    appendFileSync(recordsPath(worktree), 'not json at all\n')
    await writeRun(worktree, run({ id: 'second', check: 'format' }))
    expect((await readRuns(worktree)).map((one) => one.check)).toEqual(['tests', 'format'])
  })
})

describe('what the required checks add up to', () => {
  const checks = [check('format'), check('types'), check('tests'), check('slow', false)]

  it('is green only when every required check passed at this commit', () => {
    const runs = [
      run({ check: 'format' }),
      run({ check: 'types' }),
      run({ check: 'tests' }),
      run({ check: 'slow', state: 'failed' }),
    ]
    expect(rollup(checks, runs, 'a1b2c3d').state).toBe('pass')
  })

  it('is unknown when one required check never ran — never green', () => {
    const runs = [run({ check: 'format' }), run({ check: 'types' })]
    const said = rollup(checks, runs, 'a1b2c3d')
    expect(said.state).toBe('unknown')
    expect(said.missing).toContain('tests')
  })

  it('is red when a required check failed or was stopped', () => {
    const runs = [
      run({ check: 'format' }),
      run({ check: 'types' }),
      run({ check: 'tests', state: 'timed out' }),
    ]
    expect(rollup(checks, runs, 'a1b2c3d')).toMatchObject({ state: 'fail', failed: ['tests'] })
  })

  it('says nothing about a commit it did not run against', () => {
    const runs = [run({ check: 'format' }), run({ check: 'types' }), run({ check: 'tests' })]
    expect(rollup(checks, runs, 'ffffff').state).toBe('unknown')
    expect(rollup(checks, runs, null).state).toBe('unknown')
  })

  it('reads the newest run of a check, not the first', () => {
    const runs = [
      run({ check: 'format' }),
      run({ check: 'types' }),
      run({ check: 'tests', state: 'failed', finishedAt: '2026-09-19T05:00:00.000Z' }),
      run({ check: 'tests', state: 'passed', finishedAt: '2026-09-19T06:00:00.000Z' }),
    ]
    expect(rollup(checks, runs, 'a1b2c3d').state).toBe('pass')
  })

  it('never counts a run that happened somewhere else as one that happened here', () => {
    const runs = [
      run({ check: 'format' }),
      run({ check: 'types' }),
      run({
        check: 'tests',
        where: { kind: 'forge', forge: 'github', job: 'tests (ubuntu)', url: null },
      }),
    ]
    expect(rollup(checks, runs, 'a1b2c3d').state).toBe('unknown')
  })
})
