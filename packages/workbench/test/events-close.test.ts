import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { EventLog } from '../src/events.ts'

// A close that throws must still give the descriptor back.
//
// It did not, and nothing noticed for a reason worth keeping: every teardown
// in the repository says `.close().catch(() => {})`, because a failing close
// must not fail the thing that was closing. So a rejected write made `close()`
// throw, the handle stayed open, and the error was swallowed at every call
// site — until Node 26 collected the orphan and threw `A FileHandle object was
// closed during garbage collection` out of whichever test was unlucky.
const homes: string[] = []
afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

function home(): string {
  const made = mkdtempSync(join(tmpdir(), 'tade-close-'))
  homes.push(made)
  return made
}

describe('closing the journal', () => {
  it('gives the descriptor back even when the drain rejects', async () => {
    const log = await EventLog.open({ path: join(home(), 'events.jsonl') })
    // What a rejected append leaves behind: `close()` awaits this before it
    // would ever have reached the handle.
    ;(log as unknown as { writes: Promise<void> }).writes = Promise.reject(new Error('a write'))
    const fh = (log as unknown as { fh: { fd: number } }).fh
    await expect(log.close()).rejects.toThrow('a write')
    // -1 is what node sets a closed handle's fd to; an open one is a number.
    expect(fh.fd, 'the descriptor was still open after close() threw').toBe(-1)
  })

  it('still closes cleanly when nothing is wrong', async () => {
    const log = await EventLog.open({ path: join(home(), 'events.jsonl') })
    const fh = (log as unknown as { fh: { fd: number } }).fh
    await log.close()
    expect(fh.fd).toBe(-1)
  })
})
