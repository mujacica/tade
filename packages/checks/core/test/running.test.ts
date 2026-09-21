import { mkdirSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { makeScriptedRunner } from '../../scripted/src/index.ts'
import type { Check } from '../src/port.ts'
import { runChecks } from '../src/run.ts'
import {
  clearRunning,
  type RunningNow,
  runningIn,
  runningPath,
  writeRunning,
} from '../src/running.ts'

/** Wait for the file to say something, rather than for a fixed time. */
async function until(
  worktree: string,
  ok: (now: RunningNow) => boolean,
  ms = 1_800,
): Promise<RunningNow> {
  const deadline = Date.now() + ms
  for (;;) {
    const now = await runningIn(worktree)
    if (now && ok(now)) return now
    if (Date.now() > deadline) throw new Error('no run was ever written down')
    await new Promise((done) => setTimeout(done, 20))
  }
}

const a = (id: string, extra: Partial<Check> = {}): Check => ({
  id,
  title: id,
  run: `echo ${id}`,
  alone: false,
  minutes: 1,
  required: true,
  ...extra,
})

describe('a run while it is still going', () => {
  it('says what is running, and takes it back when it ends', async () => {
    const worktree = tmp('tade-running-')
    const now: RunningNow = {
      pid: process.pid,
      commit: 'a'.repeat(40),
      by: 'checkout/refunds',
      at: new Date().toISOString(),
      checks: [{ check: 'tests', state: 'running', startedAt: null, finishedAt: null }],
    }
    await writeRunning(worktree, now)
    expect((await runningIn(worktree))?.checks[0]?.check).toBe('tests')
    await clearRunning(worktree, now)
    expect(await runningIn(worktree)).toBeNull()
  })

  it('is nobody’s run when the process that wrote it is gone', async () => {
    const worktree = tmp('tade-running-')
    mkdirSync(join(worktree, '.tade'), { recursive: true })
    writeFileSync(
      runningPath(worktree),
      `${JSON.stringify({
        pid: 9_999_999,
        commit: 'b'.repeat(40),
        by: 'you',
        at: 'yesterday',
        checks: [{ check: 'tests', state: 'running', startedAt: null, finishedAt: null }],
      })}\n`,
    )
    expect(await runningIn(worktree)).toBeNull()
    // And cleaned up on the way past, so nothing is running here tomorrow either.
    await expect(readFile(runningPath(worktree), 'utf8')).rejects.toThrow()
  })

  it('never clears a record another run has since written', async () => {
    const worktree = tmp('tade-running-')
    const mine: RunningNow = {
      pid: process.pid,
      commit: 'c'.repeat(40),
      by: 'you',
      at: '2026-09-19T10:00:00.000Z',
      checks: [],
    }
    const theirs: RunningNow = { ...mine, at: '2026-09-19T10:05:00.000Z' }
    await writeRunning(worktree, mine)
    await writeRunning(worktree, theirs)
    await clearRunning(worktree, mine)
    expect((await runningIn(worktree))?.at).toBe(theirs.at)
  })

  it('a bad line is nothing running, never a throw', async () => {
    const worktree = tmp('tade-running-')
    mkdirSync(join(worktree, '.tade'), { recursive: true })
    writeFileSync(runningPath(worktree), '{ half a wri')
    expect(await runningIn(worktree)).toBeNull()
  })

  it('is written while the run goes, and is gone once it has', async () => {
    const worktree = tmp('tade-running-')
    // Long enough that a machine running the whole suite beside this one still
    // has time to look: the thing under test is the file, not the clock.
    const runner = makeScriptedRunner({ answers: { format: { ms: 200 }, tests: { ms: 2_000 } } })
    const going = runChecks({
      runner,
      project: { name: 'checkout', root: worktree },
      checks: [a('format'), a('tests', { alone: true })],
      commit: 'd'.repeat(40),
      by: 'checkout/refunds',
    })
    // Watched from outside the run, which is the whole point of the file:
    // the window is not the process that started it.
    const now = await until(worktree, (seen) => seen.checks.some((one) => one.state === 'running'))
    expect(now.by).toBe('checkout/refunds')
    expect(now.checks.map((one) => one.check).sort()).toEqual(['format', 'tests'])
    await going
    expect(await runningIn(worktree)).toBeNull()
  })
})
