import { existsSync, readdirSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { heldBy, lockPath, runQueueDir, waitForRunLock } from '../src/lock.ts'

// What happens between a waiter looking at the queue and its taking the lock,
// made to happen there rather than left to a loaded machine to find. The lock
// is taken by linking it into place, so whatever is to happen in that moment
// is done just before the link this file is waiting for.
const between = vi.hoisted(() => ({ at: '', first: null as null | (() => Promise<void>) }))
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>()
  const link: typeof fs.link = async (from, to) => {
    const first = between.first
    if (first && to === between.at) {
      between.first = null
      await first()
    }
    return fs.link(from, to)
  }
  return { ...fs, link, default: { ...fs, link } }
})

async function until(ready: () => boolean): Promise<void> {
  while (!ready()) await new Promise((done) => setTimeout(done, 2))
}

const tickets = (worktree: string) =>
  existsSync(runQueueDir(worktree)) ? readdirSync(runQueueDir(worktree)) : []

describe('a place kept while somebody is taking the lock', () => {
  it('is ahead of a waiter that looked at the queue before it was kept and took the lock after', async () => {
    // A macOS runner had task-b run within 50 ms of task-a giving up: it
    // looked, found nobody ahead, and by the time it took the lock task-a had
    // kept its place and let go of it.
    const worktree = tmp('tade-lock-')
    const had = await waitForRunLock(worktree, 'related', { waitMs: 0, as: 'task-a' })
    if ('held' in had) throw new Error('the lock should have been free')
    const order: string[] = []
    const waiting = (as: string) =>
      waitForRunLock(worktree, as, { waitMs: 20_000, everyMs: 5, as }).then(async (lock) => {
        order.push('held' in lock ? `${as} gave up` : as)
        if (!('held' in lock)) await lock.release()
      })
    const since = Date.now()
    await until(() => Date.now() > since)
    const behind = waiting('task-b')
    await until(() => tickets(worktree).length === 1)
    let gaveUp = false
    between.at = lockPath(worktree)
    between.first = async () => {
      await had.giveUp()
      gaveUp = true
    }
    await until(() => gaveUp)
    await until(() => tickets(worktree).some((name) => name.endsWith('.kept')))
    expect(order).toEqual([])
    await Promise.all([waiting('task-a'), behind])
    expect(order).toEqual(['task-a', 'task-b'])
    expect(tickets(worktree)).toEqual([])
    expect(await heldBy(worktree)).toBeNull()
  })
})
