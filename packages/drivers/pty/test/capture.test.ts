import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { LaneId } from '@tade/core'
import { ECHO_CHILD } from '@tade/drivers-core/conformance'
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

/** Emulators that never make a frame of a lane smaller than one it was already asked for. */
const SPARING = new URL('./fixtures/sparing-emulators.ts', import.meta.url)

/** `count` turns of the event loop, with whatever I/O arrived in them. */
async function turns(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => setImmediate(resolve))
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

  // The keystroke's echo: output this thread has seen is on the next screen it
  // reads, and in the numbers beside it, every time. The emulators are on a
  // thread of their own and push frames when they please; a capture answered
  // from one older than what the lane already printed would be a pane a
  // keystroke behind, which is the one thing a terminal may never be.
  it('shows everything the lane printed before it was asked', async () => {
    driver = new PtyDriver()
    const lane = 'read/echo' as LaneId
    await driver.open({
      id: lane,
      cwd: process.cwd(),
      command: process.execPath,
      args: [ECHO_CHILD],
      cols: 80,
      rows: 24,
    })
    await until(async () => (await driver.capture(lane, { lines: 50 })).includes('ready'))
    let depth = (await driver.screen(lane)).lines
    for (let i = 0; i < 20; i++) {
      const heard = new Promise<void>((resolve) => {
        const stop = driver.onOutput(lane, (chunk) => {
          if (!Buffer.from(chunk).toString().includes(`got:k${i}`)) return
          stop()
          resolve()
        })
      })
      await driver.write(lane, new TextEncoder().encode(`k${i}\n`))
      await heard
      // The numbers first, as the window reads them, so the capture after
      // cannot be what brought them up to date.
      const view = await driver.screen(lane)
      expect(view.lines).toBe(depth + 1)
      depth = view.lines
      expect(await driver.capture(lane, { lines: 50, styled: true })).toContain(`got:k${i}`)
    }
  }, 30_000)

  // A window scrolled up the first screenful of a lane asks for more lines than
  // one at its newest line, and each notch asked for a different number of
  // them. Matched only on the exact count, every one was a frame the emulators
  // had to make and the capture had to wait for, though the newest rows of the
  // one they had already sent are exactly the rows asked for.
  it('answers from a frame of more lines than it was asked for, without waiting for one', async () => {
    driver = new PtyDriver({ emulators: SPARING })
    await script(
      driver,
      'read/fewer',
      `for (let i = 0; i < 300; i++) process.stdout.write('\\x1b[1;31mline ' + i + '\\x1b[0m\\r\\n')`,
    )
    const lane = 'read/fewer' as LaneId
    const deep = { lines: 400, styled: true }
    await until(async () => (await driver.capture(lane, deep)).includes('line 299'))
    const all = await driver.capture(lane, deep)

    // Counted in turns of the loop rather than in milliseconds: answered from
    // what is there is one turn, and these emulators never make the smaller
    // frame a capture that waited for one would wait out its bound for.
    const near = driver.capture(lane, { lines: 40, styled: true })
    const first = await Promise.race([near.then(() => 'answered'), turns(5).then(() => 'waiting')])
    expect(first).toBe('answered')
    expect(await near).toBe(all.split('\n').slice(-40).join('\n'))
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
//
// The gaps inside a frame are timers, and a timer on a starved runner fires
// late: a 1ms gap became 5 or more, which is a pause the driver is *meant* to
// read as the frame having ended (`QUIET_MS`). So the repainter measures its
// own gaps and writes down, to `stretched`, every frame it drew with one of 3ms
// or more — under the boundary, for the time a write takes to reach the driver.
const repainter = (stretched: string) =>
  [
    "const { appendFileSync } = require('node:fs')",
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
    '  const f = ++n',
    '  let last = performance.now()',
    '  let widest = 0',
    '  const write = (from, to) => {',
    '    const now = performance.now()',
    '    widest = Math.max(widest, now - last)',
    '    last = now',
    '    process.stdout.write(piece(from, to, f))',
    `    if (to === ROWS && widest >= 3) appendFileSync(${JSON.stringify(stretched)}, f + '\\n')`,
    '  }',
    '  write(0, 10)',
    '  setTimeout(() => write(10, 20), 1)',
    '  setTimeout(() => write(20, 30), 2)',
    '  setTimeout(() => write(30, 40), 3)',
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
    const stretched = join(mkdtempSync(join(tmpdir(), 'tade-tear-')), 'stretched')
    writeFileSync(stretched, '')
    await script(driver, 'tear/repaint', repainter(stretched))
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
    // Read once the newest frame in a capture has had time to finish, since
    // a frame is written down only after its last piece.
    await new Promise((resolve) => setTimeout(resolve, 50))
    const late = new Set(readFileSync(stretched, 'utf8').split('\n').filter(Boolean).map(Number))
    // A frame the runner stretched past the boundary was, as far as anything
    // could tell, two frames, and a capture between them is the driver keeping
    // its word; it is the tears inside the contract that count. macOS CI tore
    // three such in sixty on 2026-10-14, a commit that touched no driver code.
    const excused = torn.filter((frames) => frames.some((frame) => late.has(frame)))
    const counted = torn.length - excused.length
    // Before the write itself was taken as the frame boundary this was one
    // capture in six, and one in five with four lanes repainting under load.
    // So one is allowed and two are not: ten of sixty still fails by a mile,
    // and a single interleaving on a runner sharing two cores with 279 forked
    // workers stops being a regression that names the wrong cause.
    expect(
      counted,
      `${counted} of 60 captures were two frames mixed, drawn without a gap the driver may end a frame on`,
    ).toBeLessThanOrEqual(1)
    // And the excuse is not a way for everything to pass: a runner that late
    // left nothing to judge, which is said rather than counted as green.
    expect(
      excused.length,
      `${excused.length} of 60 torn captures were frames the runner stretched`,
    ).toBeLessThan(20)
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

  // The numbers beside a screen — how far back it goes, where typing lands,
  // whose the scrolling is — are read without waiting for a whole frame.
  //
  // A capture waits, because two frames mixed is a picture nobody drew. None
  // of these is a picture: a frame half drawn rewrote the rows it already had,
  // so the depth is where it was, and on the alternate screen the depth is the
  // height of the screen whatever is being painted on it. So the wait bought
  // nothing here — and cost the whole of its bound on the one lane shape that
  // can never satisfy it, twice in every look, because the window asks for
  // these numbers and then captures the screen beside them.
  //
  // What that came to, measured through the window on a lane of this shape: a
  // graphical CLI redrawn 20 times a second against a floor of 30.
  it('reads the numbers beside a screen without waiting for a whole frame', async () => {
    driver = new PtyDriver()
    // The same never-quiet shape as above: no gap between two repaints for the
    // wait to find, so it ran to its bound every time.
    await script(
      driver,
      'read/flatout',
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
    const lane = 'read/flatout' as LaneId
    await until(async () => (await driver.screen(lane)).scrolling === 'lane')

    const deep = new Set<number>()
    const started = performance.now()
    for (let i = 0; i < 20; i++) deep.add((await driver.screen(lane)).lines)
    const each = (performance.now() - started) / 20

    // However the shutter fell, the screen was forty rows deep: that is what a
    // half-drawn frame cannot move, and the whole reason none of this waits.
    expect([...deep]).toEqual([40])
    // A ceiling rather than a rate — a loaded machine takes longer to say the
    // same thing — but nowhere near the 20ms of quiet this used to sit out.
    expect(each, `${each.toFixed(1)}ms a read`).toBeLessThan(10)
  }, 30_000)
})

describe('what reading a screen allocates', () => {
  // A capture reads every cell on the screen, and xterm hands a cell back as
  // an object. Asked for one without being given somewhere to put it, it makes
  // a fresh object every time — which its own typings say not to do:
  //
  // > Creates an empty cell object suitable as a cell reference in
  // > `line.getCell(x, cell)`. Use this to avoid costly recreation of cell
  // > objects when dealing with tons of cells.
  //
  // A 200-column lane keeping fifty rows is ten thousand of them a capture, at
  // several captures a second per lane, every one thrown away immediately.
  // Measured over one such screen with the two read interleaved, so the
  // machine's drift fell on both: 1.21ms a capture became 0.87ms, and the 95th
  // came down with it in every round — the tail is the collector, which is the
  // whole of what this buys, and is also why no number of it is quoted here.
  //
  // Held here rather than by timing it, because what a capture costs is a
  // number about the machine and this is a number about the code.
  it('reads every cell through one cell object', () => {
    const source = readFileSync(new URL('../src/emulator.ts', import.meta.url), 'utf8')
    const lone = [...source.matchAll(/getCell\(([^,)]*)\)/g)].map((found) => found[0])
    expect(lone).toEqual([])
    expect(source).toContain('getNullCell()')
  })
})

describe('where the emulators run', () => {
  // Every byte every agent prints is parsed by an emulator, in twelve
  // millisecond slices per lane, and every lane's screen is thirty megabytes of
  // buffer. None of it may be on the thread that draws the window and answers
  // your keys, and the way that stays true is that nothing the driver loads
  // there can load an emulator: `emulator.ts` is loaded only by the thread
  // that runs it (`emulator-thread.ts`), and what both sides share is types
  // and numbers (`protocol.ts`).
  //
  // Held by what is imported rather than by timing a frame, because a frame's
  // cost is a number about the machine and this is a fact about the code.
  it('never loads one on the thread that drives the lanes', () => {
    const source = (file: string) =>
      readFileSync(new URL(`../src/${file}`, import.meta.url), 'utf8')
    // An import that is not only of types, across however many lines it takes:
    // `[^']` cannot run past the specifier of the statement it started in.
    const loads = (file: string, what: string) =>
      new RegExp(`^import (?!type )[^']*from '${what.replaceAll('.', '\\.')}'`, 'm').test(
        source(file),
      )
    for (const file of ['index.ts', 'thread.ts', 'protocol.ts']) {
      // Named at all, an emulator is loaded: `emulator.ts` loads its own
      // through `createRequire`, which no import statement would show.
      expect(source(file), file).not.toContain("'@xterm/headless'")
      expect(loads(file, './emulator.ts'), file).toBe(false)
    }
    expect(loads('emulator-thread.ts', './emulator.ts')).toBe(true)
    expect(source('emulator.ts')).toContain("'@xterm/headless'")
  })
})
