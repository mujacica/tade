import { closeSync, fstatSync, openSync } from 'node:fs'
import type { LaneId } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { mastersHeld, PtyDriver } from '../src/index.ts'
import { spawnClosingSpare } from '../src/spare.ts'

// What a lane gives back of the machine's pseudo-terminals once it has ended.
//
// node-pty 1.1.0 kept one open in this process for every lane it ever spawned
// on macOS (`spare.ts` says how), and the machine has 511 for everything. A
// window open for a week held 334, and every agent's test run then failed with
// `posix_spawnp failed.`

/** The pseudo-terminal masters this process holds now. */
const masters = () => mastersHeld() ?? Number.NaN

async function until(check: () => boolean, what: () => string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out: ${what()}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

// Run on every machine: node-pty leaves a spare only on macOS, and a lane that
// gives every one back is what every machine is owed.
describe('the pseudo-terminals a lane holds', () => {
  let driver: PtyDriver
  afterEach(async () => {
    await driver.shutdown()
  })

  it('gives every one back once the lane has ended', async () => {
    driver = new PtyDriver()
    const before = masters()
    for (let i = 0; i < 5; i++) {
      const id = `spare/${i}` as LaneId
      await driver.open({ id, cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'exit 0'] })
      await new Promise<void>((resolve) => driver.onExit(id, () => resolve()))
    }
    // node-pty lets the master go once it has read the end of the lane, a
    // moment after the exit: what is counted is waited for, never slept on.
    await until(
      () => masters() <= before,
      () => `${masters() - before} more pseudo-terminals held than before five lanes ran`,
    )
  })

  it('gives every one back from a lane that was closed while it ran', async () => {
    driver = new PtyDriver()
    const before = masters()
    for (let i = 0; i < 3; i++) {
      const id = `spare/closed/${i}` as LaneId
      await driver.open({ id, cwd: process.cwd(), command: '/bin/sh', args: ['-c', 'sleep 30'] })
      await driver.close(id)
    }
    await until(
      () => masters() <= before,
      () => `${masters() - before} more pseudo-terminals held than before three lanes were closed`,
    )
  })
})

// Run on every machine, as though node-pty left a spare there too: which
// descriptors are masters is the machine's (`isMaster`), and what is done with
// them is not.
describe('what is closed as the spare', () => {
  // Spawns that open what node-pty 1.1.0's does on macOS, without node-pty.
  const ptmx = () => openSync('/dev/ptmx', 'r+')
  const isOpen = (fd: number) => {
    try {
      fstatSync(fd)
      return true
    } catch {
      return false
    }
  }
  const kept: number[] = []
  /** What looking for the spare told `trouble`: nothing, where every look could be made. */
  const said: Error[] = []
  const say = (problem: Error) => {
    said.push(problem)
  }
  afterEach(() => {
    for (const fd of kept.splice(0)) if (isOpen(fd)) closeSync(fd)
    expect(said.splice(0)).toEqual([])
  })

  it('is a pseudo-terminal the spawn opened beside the lane’s own', () => {
    let spare = -1
    const own = spawnClosingSpare(
      () => {
        spare = ptmx()
        return ptmx()
      },
      (fd) => fd,
      say,
      { leaves: true },
    )
    kept.push(own)
    expect(isOpen(spare)).toBe(false)
    expect(isOpen(own)).toBe(true)
  })

  it('is never one that was open before the spawn, nor anything but a pseudo-terminal', () => {
    const earlier = ptmx()
    let file = -1
    kept.push(earlier)
    const own = spawnClosingSpare(
      () => {
        file = openSync('/dev/null', 'r')
        return ptmx()
      },
      (fd) => fd,
      say,
      { leaves: true },
    )
    kept.push(own, file)
    expect([earlier, own, file].map(isOpen)).toEqual([true, true, true])
  })

  it('is every one the spawn opened when it threw, and the throw still reaches the caller', () => {
    let spare = -1
    expect(() =>
      spawnClosingSpare(
        () => {
          spare = ptmx()
          throw new Error('posix_spawnp failed.')
        },
        () => 0,
        say,
        { leaves: true },
      ),
    ).toThrow('posix_spawnp failed.')
    expect(isOpen(spare)).toBe(false)
  })

  it('is nothing where the lane’s own cannot be told from it', () => {
    let spare = -1
    const own = spawnClosingSpare(
      () => {
        spare = ptmx()
        return ptmx()
      },
      () => undefined,
      say,
      { leaves: true },
    )
    kept.push(spare, own)
    expect([spare, own].map(isOpen)).toEqual([true, true])
  })

  it('is not looked for away from macOS, where node-pty opens none', () => {
    let spare = -1
    const own = spawnClosingSpare(
      () => {
        spare = ptmx()
        return ptmx()
      },
      (fd) => fd,
      say,
      { leaves: false },
    )
    kept.push(spare, own)
    expect(isOpen(spare)).toBe(true)
  })

  it('is not looked for where a look fails, and the lane is opened all the same', () => {
    let spare = -1
    const own = spawnClosingSpare(
      () => {
        spare = ptmx()
        return ptmx()
      },
      (fd) => fd,
      say,
      {
        leaves: true,
        look: () => {
          throw new Error('EMFILE: too many open files')
        },
      },
    )
    kept.push(spare, own)
    expect([spare, own].map(isOpen)).toEqual([true, true])
    expect(said.splice(0).map((problem) => problem.message)).toEqual([
      'The pseudo-terminal node-pty leaves open beside a lane could not be looked for, so it may still be open: EMFILE: too many open files',
    ])
  })

  it('is nothing where the machine cannot be asked, and nothing is said', () => {
    let spare = -1
    const own = spawnClosingSpare(
      () => {
        spare = ptmx()
        return ptmx()
      },
      (fd) => fd,
      say,
      { leaves: true, look: () => null },
    )
    kept.push(spare, own)
    expect([spare, own].map(isOpen)).toEqual([true, true])
  })

  it('still throws what the spawn threw when the look after it fails', () => {
    let looks = 0
    expect(() =>
      spawnClosingSpare(
        () => {
          throw new Error('posix_spawnp failed.')
        },
        () => 0,
        say,
        {
          leaves: true,
          look: () => {
            if (++looks > 1) throw new Error('EMFILE: too many open files')
            return new Set()
          },
        },
      ),
    ).toThrow('posix_spawnp failed.')
    expect(said.splice(0)).toHaveLength(1)
  })
})
