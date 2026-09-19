import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { heldBy, lockPath, takeRunLock, waitForRunLock } from '../src/lock.ts'

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
})
