import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { claim, heldBy, lockPath, runQueueDir, takeRunLock, waitForRunLock } from '../src/lock.ts'

/** Until `ready` says so, looking every few milliseconds: paced by what is waited for. */
async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((done) => setTimeout(done, 2))
}

const tickets = (worktree: string) =>
  existsSync(runQueueDir(worktree)) ? readdirSync(runQueueDir(worktree)) : []

describe('one run at a time, per worktree', () => {
  it('lets the first in and tells the second who is running', async () => {
    const worktree = tmp('tade-lock-')
    const first = await takeRunLock(worktree, 'tests')
    expect('held' in first).toBe(false)
    const second = await takeRunLock(worktree, 'tests')
    expect('held' in second && second.held.pid).toBe(process.pid)
    expect('held' in second && second.held.what).toBe('tests')
    if (!('held' in first)) await first.release()
    const third = await takeRunLock(worktree, 'format')
    expect('held' in third).toBe(false)
  })

  it('takes over a lock whose process is gone — a crash must not lock you out', async () => {
    const worktree = tmp('tade-lock-')
    mkdirSync(join(worktree, '.tade'), { recursive: true })
    writeFileSync(
      lockPath(worktree),
      `${JSON.stringify({ pid: 999_999_9, what: 'tests', at: 'yesterday' })}\n`,
    )
    expect(await heldBy(worktree)).toBeNull()
    const got = await takeRunLock(worktree, 'tests')
    expect('held' in got).toBe(false)
  })

  it('waits for the worktree, and gives up saying who has it', async () => {
    const worktree = tmp('tade-lock-')
    const held = await takeRunLock(worktree, 'the suite')
    const waited = await waitForRunLock(worktree, 'tests', { waitMs: 60, everyMs: 10 })
    expect('held' in waited && waited.held.what).toBe('the suite')
    if (!('held' in held)) await held.release()
    const now = await waitForRunLock(worktree, 'tests', { waitMs: 60, everyMs: 10 })
    expect('held' in now).toBe(false)
  })

  it('lets exactly one of several takers racing for it in — none sees it half-made', async () => {
    // Made and then written, a lock was empty for a moment, an empty one read
    // as nobody's, and a second taker removed it and took it too: two runs in
    // one checkout. Twenty rounds of four at once found that every time.
    for (let round = 0; round < 20; round++) {
      const worktree = tmp('tade-lock-')
      const got = await Promise.all([1, 2, 3, 4].map(() => takeRunLock(worktree, 'tests')))
      expect(got.filter((one) => !('held' in one))).toHaveLength(1)
    }
  })

  it("lets exactly one of several takers over a dead holder's lock", async () => {
    // Each taker who found the holder dead removed the lock and linked its
    // own, so the second removed the first's fresh one: two held it. Twenty
    // rounds of four at once found that in one to four of them.
    for (let round = 0; round < 20; round++) {
      const worktree = tmp('tade-lock-')
      mkdirSync(worktree, { recursive: true })
      writeFileSync(
        lockPath(worktree),
        `${JSON.stringify({ pid: 999_999_9, what: 'tests', at: 'yesterday', claim: 'gone-0' })}\n`,
      )
      const got = await Promise.all([1, 2, 3, 4].map(() => takeRunLock(worktree, 'tests')))
      expect(got.filter((one) => !('held' in one))).toHaveLength(1)
      expect(readdirSync(worktree).filter((name) => name !== 'checks.lock')).toEqual([])
    }
  })

  it('takes back only the lock it wrote, never one somebody took since', async () => {
    // Every run in the window has the window's pid. A release that removed
    // whatever lock was there let a third run in beside the second.
    const worktree = tmp('tade-lock-')
    const path = lockPath(worktree)
    const first = await claim(path, { what: 'tests' })
    if ('held' in first) throw new Error('the lock should have been free')
    writeFileSync(
      path,
      `${JSON.stringify({ pid: process.pid, what: 'someone else', at: 'now' })}\n`,
    )
    await first.release()
    expect((await heldBy(worktree))?.what).toBe('someone else')
  })

  it('hands the worktree to whoever has waited longest, not whoever looks next', async () => {
    // Waiting was polling, so a lock let go went to whoever looked first: a
    // checks_run that had waited ten minutes lost it to one that had just
    // asked. The later waiter looks ten times as often, and a newcomer asks
    // the moment it is free: neither may go before the first.
    const worktree = tmp('tade-lock-')
    const first = await takeRunLock(worktree, 'the suite')
    if ('held' in first) throw new Error('the lock should have been free')
    const order: string[] = []
    const waiting = (what: string, everyMs: number) =>
      waitForRunLock(worktree, what, { waitMs: 20_000, everyMs }).then(async (lock) => {
        order.push('held' in lock ? `${what} gave up` : what)
        if (!('held' in lock)) await lock.release()
      })
    const longest = waiting('longest', 50)
    await until(() => tickets(worktree).length === 1)
    const later = waiting('later', 5)
    await until(() => tickets(worktree).length === 2)
    await first.release()
    const newcomer = await waitForRunLock(worktree, 'newcomer', { waitMs: 0 })
    expect('held' in newcomer && newcomer.held.what).toBe('longest')
    await Promise.all([longest, later])
    expect(order).toEqual(['longest', 'later'])
    expect(tickets(worktree)).toEqual([])
  })

  it('gives up its place in the queue when it stops waiting', async () => {
    const worktree = tmp('tade-lock-')
    const held = await takeRunLock(worktree, 'the suite')
    await waitForRunLock(worktree, 'tests', { waitMs: 40, everyMs: 10 })
    expect(tickets(worktree)).toEqual([])
    if (!('held' in held)) await held.release()
    expect('held' in (await waitForRunLock(worktree, 'tests', { waitMs: 0 }))).toBe(false)
  })
})
