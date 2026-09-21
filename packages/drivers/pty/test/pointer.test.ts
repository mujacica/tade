import type { LaneId } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyDriver } from '../src/index.ts'

// Which encoding a program asked for, read off its output on the way past.
//
// The conformance suite covers the ordinary case for every driver. This is
// the one that only a real terminal emulator can be put in: the sequence
// arriving in two pieces, because a read ended in the middle of it. Getting
// that wrong is not a scroll that goes nowhere — it is a report in an
// encoding the program cannot read, which is characters typed into it.

const ESC = String.fromCharCode(27)

/** A lane that asks for the mouse in two writes, and says what it is sent. */
function child(driver: PtyDriver, id: string, source: string) {
  return driver.open({
    id: id as LaneId,
    cwd: process.cwd(),
    command: process.execPath,
    args: ['-e', source],
    cols: 80,
    rows: 24,
  })
}

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error('timed out')
}

describe('how a lane asked to be told about the pointer', () => {
  let driver: PtyDriver | null = null
  afterEach(async () => {
    await driver?.shutdown()
    driver = null
  })

  it('is read even when the sequence arrives cut in two', async () => {
    driver = new PtyDriver({ scrollback: 500 })
    // The alternate screen and the mouse, then — after a pause long enough to
    // be its own read — the half of `?1006h` that says SGR.
    const source = [
      `process.stdout.write('\\x1b[?1049h\\x1b[?1000h\\x1b[?100')`,
      `process.stdin.setRawMode(true)`,
      `process.stdin.on('data', (d) => process.stdout.write('saw ' + JSON.stringify(String(d)).slice(1, -1) + '\\r\\n'))`,
      `setTimeout(() => process.stdout.write('6h\\x1b[2J\\x1b[Hready\\r\\n'), 120)`,
      `setInterval(() => {}, 1000)`,
    ].join('\n')
    const lane = await child(driver, 'pointer/split', source)
    await until(async () => (await driver!.capture(lane.id, { lines: 24 })).includes('ready'))

    // It took the screen and asked for the mouse, so the wheel is its own.
    expect((await driver.screen(lane.id)).scrolling).toBe('lane')

    await driver.wheel(lane.id, { rows: -1, column: 4, row: 2 })
    await until(async () => (await driver!.capture(lane.id, { lines: 24 })).includes('saw '))
    const said = await driver.capture(lane.id, { lines: 24 })
    // The modern encoding, because that is what it asked for — across the
    // cut. The old one would have arrived as `ESC [ M` and three bytes.
    expect(said).toContain('u001b[<64;5;3M')
    expect(said).not.toContain(`${ESC}[M`)
  })
})
