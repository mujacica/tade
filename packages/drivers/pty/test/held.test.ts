import { closeSync, openSync } from 'node:fs'
import type { LaneId } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { LEAK_SAID_AT, leakIn } from '../src/held.ts'
import { mastersHeld, PtyDriver } from '../src/index.ts'

// What every way a lane ends gives back of the machine's pseudo-terminals,
// counted in this process, and what is said when the count runs ahead of the
// lanes. A window that kept one for every lane it ever spawned held 334 of
// macOS's 511 after a week (`spare.ts`), and nothing said so until every
// agent's test run on the machine failed with `posix_spawnp failed.`

const masters = () => mastersHeld() ?? Number.NaN

async function until(check: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const sh = (script: string) => ({ cwd: process.cwd(), command: '/bin/sh', args: ['-c', script] })

describe('the pseudo-terminals the driver holds', () => {
  let driver: PtyDriver
  let troubles: Error[]
  /** Masters opened by hand, standing in for a leak. */
  let leaked: number[]
  /** Programs that outlive their lane, ended here rather than left on the machine. */
  let strays: number[]

  const opened = () => {
    troubles = []
    leaked = []
    strays = []
    driver = new PtyDriver({ trouble: (problem) => troubles.push(problem) })
    return driver
  }

  afterEach(async () => {
    await driver.shutdown()
    for (const fd of leaked) closeSync(fd)
    for (const pid of strays) {
      try {
        process.kill(-pid, 'SIGKILL')
      } catch {
        // gone already
      }
    }
  })

  it('gives a closed lane’s back before the close returns, though its program ignores the hangup', async () => {
    opened()
    const before = masters()
    const id = 'held/deaf' as LaneId
    // Said ready only once the trap is set, so the close is known to land on it.
    const lane = await driver.open({ id, ...sh(`trap '' HUP; echo ready; exec sleep 30`) })
    strays.push(lane.pid!)
    let out = ''
    driver.onOutput(id, (bytes) => (out += bytes.toString()), { replay: true })
    await until(() => out.includes('ready'), 'the trap to be set')
    expect(masters()).toBe(before + 1)
    await driver.close(id)
    expect(masters()).toBe(before)
  })

  it('gives an ended lane’s back, and holds one for the lane opened again in its place', async () => {
    opened()
    const before = masters()
    const id = 'held/again' as LaneId
    await driver.open({ id, ...sh('exit 0') })
    await new Promise<void>((resolve) => driver.onExit(id, () => resolve()))
    expect(masters()).toBe(before)
    await driver.open({ id, ...sh('sleep 30') })
    expect(masters()).toBe(before + 1)
    await driver.close(id)
    expect(masters()).toBe(before)
  })

  it('gives every lane’s back when it shuts down', async () => {
    opened()
    const before = masters()
    for (let i = 0; i < 3; i++) await driver.open({ id: `held/${i}` as LaneId, ...sh('sleep 30') })
    expect(masters()).toBe(before + 3)
    await driver.shutdown()
    expect(masters()).toBe(before)
  })

  it('says nothing over lanes that come and go', async () => {
    opened()
    for (let i = 0; i < 8; i++) {
      const id = `held/quiet/${i}` as LaneId
      await driver.open({ id, ...sh(i % 2 ? 'exit 0' : 'sleep 30') })
      if (i % 2 === 0) await driver.close(id)
    }
    expect(troubles).toEqual([])
  })

  it('says so once when this process holds more than its lanes do, and again after it healed', async () => {
    opened()
    for (let i = 0; i < LEAK_SAID_AT; i++) leaked.push(openSync('/dev/ptmx', 'r+'))

    await driver.open({ id: 'held/first' as LaneId, ...sh('sleep 30') })
    expect(troubles).toHaveLength(1)
    expect(troubles[0]?.message).toContain(`${LEAK_SAID_AT} are held by nothing it runs`)
    expect(troubles[0]?.message).toContain('posix_spawnp failed.')

    // Still leaking, and already said: not said again for every lane after it.
    await driver.open({ id: 'held/second' as LaneId, ...sh('sleep 30') })
    expect(troubles).toHaveLength(1)

    for (const fd of leaked.splice(0)) closeSync(fd)
    await driver.open({ id: 'held/third' as LaneId, ...sh('sleep 30') })
    expect(troubles).toHaveLength(1)

    for (let i = 0; i < LEAK_SAID_AT; i++) leaked.push(openSync('/dev/ptmx', 'r+'))
    await driver.open({ id: 'held/fourth' as LaneId, ...sh('sleep 30') })
    expect(troubles).toHaveLength(2)
  })
})

describe('what is said about a count', () => {
  it('is nothing while the lanes account for every one, or nearly', () => {
    expect(leakIn(4, 4)).toBeNull()
    expect(leakIn(4 + LEAK_SAID_AT - 1, 4)).toBeNull()
  })

  it('is nothing where the count could not be taken', () => {
    expect(leakIn(null, 0)).toBeNull()
  })

  it('names how many are held and by how many lanes', () => {
    expect(leakIn(334, 12)).toContain('holds 334 pseudo-terminals and is running 12 lanes, so 322')
  })
})
