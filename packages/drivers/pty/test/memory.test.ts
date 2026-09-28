import { setFlagsFromString } from 'node:v8'
import { runInNewContext } from 'node:vm'
import type { LaneId } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyDriver } from '../src/index.ts'

// What a lane costs to hold, and what it gives back when it closes.
//
// A screen buffer is the largest thing Tade keeps: ten thousand lines at the
// width of a window is thirty megabytes of typed arrays, per lane. A window
// holds every lane it has opened, so a session that opens and closes terminals
// and restarts agents all day used to grow without any bound at all — the
// emulator was disposed on close and the memory was not, because the buffer
// stays reachable from the terminal object that was disposed.
//
// Measured rather than asserted about the code, because what went wrong was
// invisible in the code: `dispose()` is called, and it reads as enough.

/** Collect, so what is only *reachable* is not counted as what is *held*. */
function collect(): void {
  setFlagsFromString('--expose_gc')
  const gc = runInNewContext('gc') as () => void
  gc()
  gc()
}

/** The typed arrays alive now, in megabytes: where a screen buffer lives. */
function heldMb(): number {
  collect()
  return process.memoryUsage().arrayBuffers / 1e6
}

async function until(check: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('what a lane holds', () => {
  let driver: PtyDriver
  afterEach(async () => {
    await driver.shutdown()
  })

  it('gives the screen back when the lane closes', async () => {
    driver = new PtyDriver()
    const lane = 'mem/full' as LaneId
    // Filled to the scrollback the driver keeps, at the width of a real
    // window: the point is the size of the thing, so a smaller one would
    // prove nothing about the thing that was reported.
    await driver.open({
      id: lane,
      cwd: process.cwd(),
      command: process.execPath,
      args: [
        '-e',
        [
          `const line = 'x'.repeat(190)`,
          `let out = ''`,
          `for (let i = 0; i < 10000; i++) out += i + ' ' + line + '\\r\\n'`,
          `process.stdout.write(out)`,
          // Still printing when the lane is closed, which is what a lane
          // being closed is usually doing, and what leaves the emulator
          // something unparsed to be holding.
          `setInterval(() => process.stdout.write(out.slice(0, 20000)), 10)`,
        ].join('\n'),
      ],
      cols: 200,
      rows: 50,
    })
    await until(async () => (await driver.screen(lane)).lines > 9_000)

    const full = heldMb()
    // A full buffer at this size is tens of megabytes. If it is not, the lane
    // never filled and the rest of this test would pass while proving nothing.
    expect(full).toBeGreaterThan(10)

    // Closed on a chunk the emulator has been handed and has not parsed: the
    // driver writes to it before it tells anybody, so inside a listener there
    // is always one queued, on any machine. That is the case that broke —
    // `dispose()` leaves the backlog, and the backlog holds the screen — and
    // waiting for the lane to go quiet instead would only reach it on a runner
    // slow enough to still be behind, which is how this arrived as a flake.
    await new Promise<void>((resolve) => {
      const stop = driver.onOutput(lane, () => {
        stop()
        resolve()
      })
    })
    await driver.close(lane)
    const after = heldMb()

    // Nothing can ever read a closed lane's screen again — `capture` and
    // `screen` both refuse one — so every byte of it should be back.
    expect(after).toBeLessThan(full / 2)
  }, 30_000)

  it('still says a closed lane is closed, rather than missing', async () => {
    driver = new PtyDriver()
    const lane = 'mem/closed' as LaneId
    await driver.open({
      id: lane,
      cwd: process.cwd(),
      command: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cols: 80,
      rows: 24,
    })
    await driver.close(lane)
    // Letting the screen go may never turn a lane that closed into one that
    // was never there: the id stays taken until something opens it again.
    await expect(driver.capture(lane, { lines: 5 })).rejects.toMatchObject({
      code: 'LANE_CLOSED',
    })
    expect(await driver.get(lane)).toBeNull()
    expect(await driver.list()).toEqual([])
  }, 30_000)
})
