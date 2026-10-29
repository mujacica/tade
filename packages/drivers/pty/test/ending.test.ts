import type { LaneId } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { PtyDriver } from '../src/index.ts'

// What a lane prints as it ends. On Linux the master says it was hung up while
// the program's last bytes are still on their way to it, and libuv takes a
// hangup after a short read for the end without reading again, so a program
// that prints and ends at once lost the end of what it printed. Printing more
// than the pseudo-terminal holds makes that the usual case: in a node-pty loop
// on Ubuntu 22.04, 367 of 400 such programs lost their last line before, and
// none after.

const LANES = 10

describe('what a lane prints as it ends', () => {
  let driver: PtyDriver
  beforeEach(() => {
    driver = new PtyDriver()
  })
  afterEach(async () => {
    await driver.shutdown()
  })

  it('is all read, however quickly it ends', async () => {
    const printed = async (i: number): Promise<string> => {
      const id = `ending/${i}` as LaneId
      await driver.open({
        id,
        cwd: process.cwd(),
        command: '/bin/sh',
        args: ['-c', `read line; head -c 16384 /dev/zero | tr '\\0' x; echo "got $line"`],
      })
      let out = ''
      driver.onOutput(id, (bytes) => (out += bytes.toString()), { replay: true })
      const ended = new Promise<void>((resolve) => driver.onExit(id, () => resolve()))
      await driver.write(id, new TextEncoder().encode('it\n'))
      await ended
      return out
    }
    const outs = await Promise.all(Array.from({ length: LANES }, (_, i) => printed(i)))
    const lost = outs.flatMap((out, i) => (out.includes('got it') ? [] : [i]))
    expect(lost).toEqual([])
  })
})
