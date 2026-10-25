import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { until } from '@tade/drivers-core/conformance'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mastersHeld, PtyDriver } from '../src/index.ts'

// What is typed into a lane, and what becomes of it when the lane goes away
// while it is being written.
//
// `close()` lets the master go before it returns. node-pty's own queue wrote
// on after that: a write still queued when a lane was closed went to a
// descriptor that was closed ("Unhandled pty write error … EBADF", printed in
// the middle of a CI run) or, once the number had been handed out again, into
// whatever file was opened next.

const sh = (script: string) => ({ cwd: process.cwd(), command: '/bin/sh', args: ['-c', script] })

describe('what is typed into a lane', () => {
  let driver: PtyDriver
  let troubles: Error[]
  let dir: string
  beforeEach(() => {
    troubles = []
    driver = new PtyDriver({ trouble: (problem) => troubles.push(problem) })
    dir = mkdtempSync(join(tmpdir(), 'tade-typing-'))
  })
  afterEach(async () => {
    await driver.shutdown()
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('is all taken, however much more it is than the pseudo-terminal holds at once', async () => {
    const id = 'typing/paste' as LaneId
    const lines = 2000
    await driver.open({ id, ...sh(`stty -echo; head -n ${lines} >/dev/null; echo took-it`) })
    let out = ''
    driver.onOutput(id, (bytes) => (out += bytes.toString()), { replay: true })
    const paste = `${'x'.repeat(99)}\n`.repeat(lines)
    await driver.write(id, new TextEncoder().encode(paste))
    await until(async () => out.includes('took-it'))
    expect(troubles).toEqual([])
  })

  it('goes nowhere once the lane is closed under it, not even to the file opened next', async () => {
    const said = vi.spyOn(console, 'error')
    for (let i = 0; i < 20; i++) {
      const id = `typing/closed/${i}` as LaneId
      // Never read, so what is typed stays in flight until the lane is closed.
      await driver.open({ id, ...sh('exec sleep 30') })
      void driver.write(id, new TextEncoder().encode('y'.repeat(64 * 1024)))
      await driver.close(id)
      // Most likely under the number the lane's master had.
      const path = join(dir, `next-${i}`)
      const next = openSync(path, 'w+')
      // One more lane typed into and answered, so whatever was in flight has
      // had its turn before the files are read.
      const echo = `typing/echo/${i}` as LaneId
      await driver.open({ id: echo, ...sh('read line; echo "got $line"') })
      let out = ''
      driver.onOutput(echo, (bytes) => (out += bytes.toString()), { replay: true })
      await driver.write(echo, new TextEncoder().encode('it\n'))
      await until(async () => out.includes('got it'))
      closeSync(next)
      expect(readFileSync(path, 'utf8')).toBe('')
    }
    expect(said).not.toHaveBeenCalled()
    expect(troubles).toEqual([])
  })

  it('is nothing once the program has ended, and nothing is said', async () => {
    const id = 'typing/ended' as LaneId
    await driver.open({ id, ...sh('exit 0') })
    await new Promise<void>((resolve) => driver.onExit(id, () => resolve()))
    await expect(driver.write(id, new TextEncoder().encode('late\n'))).resolves.toBeUndefined()
    await driver.close(id)
    expect(troubles).toEqual([])
  })

  // Only Linux says a terminal nothing holds is gone while its program runs:
  // macOS keeps the master until the program ends.
  it.runIf(process.platform === 'linux')(
    'goes nowhere once node-pty let go of a master its program no longer holds',
    async () => {
      const masters = () => mastersHeld() ?? Number.NaN
      const before = masters()
      const id = 'typing/let-go' as LaneId
      // Nothing in the lane holds its terminal, and its program runs on.
      await driver.open({ id, ...sh('exec sleep 30 </dev/null >/dev/null 2>&1') })
      await until(async () => masters() <= before)
      // Most likely under the number the lane's master had.
      const path = join(dir, 'next')
      const next = openSync(path, 'w+')
      await driver.write(id, new TextEncoder().encode('stray\n'))
      const echo = 'typing/let-go/echo' as LaneId
      await driver.open({ id: echo, ...sh('read line; echo "got $line"') })
      let out = ''
      driver.onOutput(echo, (bytes) => (out += bytes.toString()), { replay: true })
      await driver.write(echo, new TextEncoder().encode('it\n'))
      await until(async () => out.includes('got it'))
      closeSync(next)
      expect(readFileSync(path, 'utf8')).toBe('')
      expect(troubles).toEqual([])
    },
  )
})
