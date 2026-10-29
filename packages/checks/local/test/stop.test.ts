import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { describe, expect, it } from 'vitest'
import { stop } from '../src/stop.ts'

// Through a run, whether a check's group is already gone when it is killed is
// a race (`stop.ts` says which), so the gone case is held here to a process
// that certainly is: one with no children, reaped before it is signalled.

describe('stopping what a check started', () => {
  it('is no trouble once the group and its leader are already gone', async () => {
    const child = spawn('true', { detached: true, stdio: 'ignore' })
    await once(child, 'exit')
    const pid = child.pid as number
    // Reaped, so neither the group nor the process is there to signal.
    expect(() => process.kill(-pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }))
    // SIGCONT, so that should the number already be somebody else's, nothing
    // of theirs is ended by a test.
    expect(() => stop(pid, 'SIGCONT')).not.toThrow()
  })
})
