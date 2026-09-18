import type { LaneId } from '@tade/core'
import { afterEach, describe, expect, it } from 'vitest'
import { PtyDriver } from '../src/index.ts'

// Reading a lane's screen the way the window does it, many times a second:
// fast however long the lane has been running, and never a frame half drawn.

const ESC = String.fromCharCode(27)

/** A lane running a few lines of JavaScript. */
function script(driver: PtyDriver, id: string, source: string) {
  return driver.open({
    id: id as LaneId,
    cwd: process.cwd(),
    command: process.execPath,
    args: ['-e', `${source}\nsetInterval(() => {}, 1000)`],
    cols: 120,
    rows: 40,
  })
}

async function until(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('reading a lane', () => {
  let driver: PtyDriver
  afterEach(async () => {
    await driver.shutdown()
  })

  it('costs what is shown, not the whole scrollback behind it', async () => {
    driver = new PtyDriver()
    await script(
      driver,
      'read/long',
      `for (let i = 0; i < 10000; i++) process.stdout.write('\\x1b[1;31mline ' + i + '\\x1b[0m\\r\\n')`,
    )
    const lane = 'read/long' as LaneId
    await until(async () => (await driver.capture(lane, { lines: 40 })).includes('line 9999'))
    const started = performance.now()
    let screen = ''
    for (let i = 0; i < 20; i++) screen = await driver.capture(lane, { lines: 40, styled: true })
    const each = (performance.now() - started) / 20
    expect(screen.split('\n')).toHaveLength(40)
    expect(screen).toContain('line 9999')
    // Painting all ten thousand lines to keep forty took a good part of a second.
    expect(each).toBeLessThan(15)
  }, 30_000)

  it('never shows a frame half drawn', async () => {
    driver = new PtyDriver()
    // An old frame, then a new one drawn inside a synchronized update that
    // arrives in two halves, the way a redraw arrives when a pty splits it.
    await script(
      driver,
      'read/frames',
      [
        `process.stdout.write('${ESC}[2J${ESC}[Hold frame')`,
        'setTimeout(() => {',
        `  process.stdout.write('${ESC}[?2026h${ESC}[2J${ESC}[Hnew ')`,
        `  setTimeout(() => process.stdout.write('frame${ESC}[?2026l'), 25)`,
        '}, 300)',
      ].join('\n'),
    )
    const lane = 'read/frames' as LaneId
    await until(async () => (await driver.capture(lane, { lines: 5 })).includes('old frame'))
    const seen = new Set<string>()
    const deadline = Date.now() + 700
    while (Date.now() < deadline) seen.add((await driver.capture(lane, { lines: 5 })).trim())
    expect(seen).toContain('new frame')
    expect([...seen].every((screen) => screen === 'old frame' || screen === 'new frame')).toBe(true)
  }, 30_000)
})
