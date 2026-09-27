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

// A program that repaints the whole screen in place and never says where its
// frames begin — which is most of them, Claude Code included (checked at
// 2.1.267: it emits no DEC 2026 at all, at boot or while scrolling).
//
// The shape is measured off that program answering a wheel at 120x40: it
// rewrites every row, the repaint reaches the pty as three to six writes
// spread over two to seven milliseconds, and then some twenty milliseconds of
// quiet before the next one. Photographed in between, the screen is the top of
// the new frame over the bottom of the old — rows from two different moments
// on one screen, which is what tearing is and what it looks like.
//
// Every row carries the frame number, so a capture whose rows disagree is
// provably torn and nothing has to be inferred from how it looked.
const REPAINTER = [
  'const ROWS = 40',
  'const piece = (from, to, f) => {',
  "  let out = ''",
  `  for (let r = from; r < to; r++) out += '${ESC}[' + (r + 1) + ';1H${ESC}[2Kframe ' + f + ' row ' + r`,
  '  return out',
  '}',
  // The alternate screen and the mouse: `scrolling` is then `lane`, which is
  // the situation this is about, and the one where rows are rewritten in place.
  `process.stdout.write('${ESC}[?1049h${ESC}[?1000h${ESC}[?1006h')`,
  'let n = 0',
  'setInterval(() => {',
  '  n++',
  '  process.stdout.write(piece(0, 10, n))',
  '  setTimeout(() => process.stdout.write(piece(10, 20, n)), 1)',
  '  setTimeout(() => process.stdout.write(piece(20, 30, n)), 2)',
  '  setTimeout(() => process.stdout.write(piece(30, 40, n)), 3)',
  '}, 27)',
].join('\n')

/** Which frames a capture is made of. More than one is a torn screen. */
function framesIn(screen: string): number[] {
  const frames = new Set<number>()
  for (const row of screen.split('\n')) {
    const found = /frame (\d+) row/.exec(row)
    if (found?.[1]) frames.add(Number(found[1]))
  }
  return [...frames]
}

describe('a program that repaints in place and says nothing', () => {
  let driver: PtyDriver
  afterEach(async () => {
    await driver.shutdown()
  })

  it('is never photographed between two of its frames', async () => {
    driver = new PtyDriver()
    await script(driver, 'tear/repaint', REPAINTER)
    const lane = 'tear/repaint' as LaneId
    await until(async () => framesIn(await driver.capture(lane, { lines: 40 })).length > 0)

    // Counted in captures rather than over a stretch of the clock: how many a
    // busy runner fits in a second is a fact about the runner, and none of
    // them may be torn however few there are. Styled, as the window asks.
    const torn: number[][] = []
    const seen: number[] = []
    while (seen.length < 60) {
      const frames = framesIn(await driver.capture(lane, { lines: 40, styled: true }))
      const first = frames[0]
      if (first === undefined) continue
      if (frames.length > 1) torn.push(frames)
      seen.push(first)
      await new Promise((resolve) => setTimeout(resolve, 8))
    }
    // Before the write itself was taken as the frame boundary this was one
    // capture in six, and one in five with four lanes repainting under load.
    expect(torn, `${torn.length} of 60 captures were two frames mixed`).toEqual([])
    // And it is not a photograph: a screen held back rather than drawn torn is
    // held back for one capture and no more.
    expect(Math.max(...seen)).toBeGreaterThan(Math.min(...seen))
  }, 30_000)

  it('never freezes on a lane that will not go quiet', async () => {
    driver = new PtyDriver()
    // Repaints as fast as the pty will take it, so there is no gap between two
    // frames to wait for and no frame that can be called whole. Waiting on one
    // for ever, or giving back the last whole one for ever, is a pane that has
    // stopped — which is worse than a torn one, and is the whole argument of
    // `packages/app/test/wire/frame.probe.test.ts`.
    await script(
      driver,
      'tear/flatout',
      [
        `process.stdout.write('${ESC}[?1049h${ESC}[?1000h')`,
        'let n = 0',
        'setInterval(() => {',
        '  n++',
        `  let out = '${ESC}[H'`,
        `  for (let r = 0; r < 40; r++) out += '${ESC}[' + (r + 1) + ';1H${ESC}[2Kframe ' + n + ' row ' + r`,
        '  process.stdout.write(out)',
        '}, 0)',
      ].join('\n'),
    )
    const lane = 'tear/flatout' as LaneId
    await until(async () => framesIn(await driver.capture(lane, { lines: 40 })).length > 0)
    const was = framesIn(await driver.capture(lane, { lines: 40 }))[0]
    await until(async () => framesIn(await driver.capture(lane, { lines: 40 }))[0] !== was, 5_000)
  }, 30_000)
})
