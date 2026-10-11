import { describe, expect, it } from 'vitest'
import { Emulators } from '../src/emulator.ts'
import type { Order, Report } from '../src/protocol.ts'

// The emulators on their own, driven in place rather than on their thread: the
// orders a driver gives, in the order it gives them, and what comes back.
// Exactly the code the thread runs (`emulator-thread.ts` is three lines of
// wiring), so what a frame promises is held here without a process, a pty or
// a thread's timing in the way.

const ESC = String.fromCharCode(27)

type Pushed = Extract<Report, { is: 'frame' }>

/** A set of emulators, and a way to wait for what they say next. */
function emulators() {
  const reports: Report[] = []
  const waiting: Array<{ wanted: (report: Report) => boolean; done: (report: Report) => void }> = []
  const emulators = new Emulators((report) => {
    reports.push(report)
    for (const one of [...waiting]) {
      if (!one.wanted(report)) continue
      waiting.splice(waiting.indexOf(one), 1)
      one.done(report)
    }
  })
  const next = <T extends Report>(wanted: (report: Report) => report is T, ms = 2_000) =>
    new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('nothing was said')), ms)
      waiting.push({
        wanted,
        done: (report) => {
          clearTimeout(timer)
          resolve(report as T)
        },
      })
    })
  let seq = 0
  let asks = 0
  const frames = (key: number) =>
    reports.filter((r): r is Pushed => r.is === 'frame' && r.key === key)
  return {
    take: (order: Order) => emulators.take(order),
    reports,
    frames,
    open(key: number, cols = 80, rows = 24, scrollback = 100) {
      emulators.take({ do: 'open', key, cols, rows, scrollback, seq: 0, seed: '' })
    },
    print(key: number, data: string, at = Date.now()) {
      seq++
      emulators.take({ do: 'data', key, seq, at, data })
      return seq
    },
    resize(key: number, cols: number, rows: number) {
      seq++
      emulators.take({ do: 'resize', key, seq, cols, rows })
      return seq
    },
    /** The next frame of `key` that `ok` is true of. */
    frame(key: number, ok: (frame: Pushed) => boolean = () => true, ms?: number) {
      return next((r): r is Pushed => r.is === 'frame' && r.key === key && ok(r), ms)
    },
    watch(key: number, lines: number, styled = false) {
      emulators.take({ do: 'watch', key, lines, styled })
    },
    /**
     * The numbers beside a screen, asked for. Also a barrier: orders are taken
     * in turn, so by the time this answers, everything before it has been.
     */
    look(key: number) {
      const ask = ++asks
      const answer = next(
        (r): r is Extract<Report, { is: 'view' }> => r.is === 'view' && r.ask === ask,
      )
      emulators.take({ do: 'look', key, ask })
      return answer
    },
    release(key: number) {
      emulators.take({ do: 'release', key })
    },
  }
}

describe('the emulators', () => {
  it('build no frame of a lane nobody is looking at', async () => {
    const at = emulators()
    at.open(1)
    at.print(1, 'hello\r\n')
    const view = await at.look(1)
    // Parsed — the numbers know there is a line — and never drawn.
    expect(view.view?.lines).toBe(1)
    expect(at.frames(1)).toEqual([])
  })

  it('push a frame of a lane somebody is looking at, saying how much of it is in it', async () => {
    const at = emulators()
    at.open(1)
    const printed = at.print(1, 'hello\r\n')
    const coming = at.frame(1)
    at.watch(1, 5)
    const frame = await coming
    expect(frame).toMatchObject({ seq: printed, lines: 5, styled: false, whole: true })
    expect(frame.rows).toBe('hello')
    expect(frame.alternate).toBe(false)
    expect(frame.view).toEqual({
      lines: 1,
      cursor: { back: -1, column: 0 },
      scrolling: 'window',
      pointing: 'nobody',
    })
  })

  it('keep pushing while more arrives, never going backwards, and end on all of it', async () => {
    const at = emulators()
    at.open(1)
    at.watch(1, 50)
    let last = 0
    for (let i = 0; i < 40; i++) last = at.print(1, `line ${i}\r\n`)
    const final = await at.frame(1, (f) => f.seq === last)
    expect(final.rows.split('\n').at(-1)).toBe('line 39')
    const seqs = at.frames(1).map((f) => f.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
    // Every frame holds exactly the lines its number says were printed.
    for (const frame of at.frames(1)) {
      const lines = frame.rows.split('\n').filter((row) => row !== '')
      expect(lines.length).toBe(frame.seq)
    }
  })

  // A frame says how much of what was printed is on it, and a driver takes
  // that at its word: a frame claiming output it does not show is a capture
  // that misses a keystroke's echo and says it is current. Only reachable when
  // a parse is still running as the wait for it runs out — so the middle chunk
  // is several times what this machine parses in that time.
  it('never claim output still being parsed', async () => {
    const at = emulators()
    at.open(1, 80, 24, 100)
    at.print(1, 'start\r\n')
    let flood = ''
    for (let i = 0; flood.length < 12_000_000; i++) flood += `flood ${i}\r\n`
    const last = flood.slice(flood.lastIndexOf('flood', flood.length - 3), -2)
    const flooded = at.print(1, flood)
    const ended = at.print(1, 'end\r\n')
    const frames: Pushed[] = []
    for (;;) {
      // Asked again before every wait, as a driver asks whenever what it has
      // is not current: one parse of this much can outlast a watch, and a
      // coverage run makes it take more than a second.
      const coming = at.frame(1, () => true, 20_000)
      at.watch(1, 3)
      const frame = await coming
      frames.push(frame)
      if (frame.seq === ended) break
    }
    for (const frame of frames) {
      const rows = frame.rows.split('\n')
      if (frame.seq >= ended) expect(rows.at(-1)).toBe('end')
      else if (frame.seq >= flooded) expect(rows.at(-1)).toBe(last)
    }
  }, 30_000)

  it('pace a lane that keeps printing', async () => {
    const at = emulators()
    at.open(1)
    at.watch(1, 5)
    await at.frame(1)
    // Printing flat out: frames come no closer together than the pace. A
    // floor, never a ceiling — how soon one comes is about the machine.
    const pushed: number[] = []
    for (let i = 0; i < 6; i++) {
      at.print(1, `more ${i}\r\n`)
      await at.frame(1)
      pushed.push(Date.now())
    }
    const gaps = pushed.slice(1).map((t, i) => t - pushed[i]!)
    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(15)
  })

  it('do not send a frame they have already sent', async () => {
    const at = emulators()
    at.open(1)
    at.print(1, 'once\r\n')
    at.watch(1, 5)
    await at.frame(1)
    // Asked again, as a driver renewing what it watches does: only kept.
    at.watch(1, 5)
    await at.look(1)
    expect(at.frames(1)).toHaveLength(1)
    // A different question is a different frame.
    const styled = at.frame(1)
    at.watch(1, 5, true)
    expect((await styled).styled).toBe(true)
  })

  it('wait out a synchronized update rather than push half of it', async () => {
    const at = emulators()
    at.open(1)
    at.print(1, `${ESC}[2J${ESC}[Hold frame`)
    at.watch(1, 5)
    await at.frame(1, (f) => f.rows.includes('old frame'))
    // Past the pace between two frames, so nothing but the update itself can
    // be what holds the half of it back.
    await new Promise((resolve) => setTimeout(resolve, 30))
    at.print(1, `${ESC}[?2026h${ESC}[2J${ESC}[Hnew `)
    await new Promise((resolve) => setTimeout(resolve, 10))
    const ended = at.print(1, `frame${ESC}[?2026l`)
    const after = await at.frame(1, (f) => f.seq === ended)
    expect(after).toMatchObject({ whole: true })
    expect(after.rows.trim()).toBe('new frame')
    // Nothing between the two was ever pushed: no frame shows the new one half
    // drawn, and the only frames are the old one and the new one.
    expect(at.frames(1).map((f) => f.rows.trim())).toEqual(['old frame', 'new frame'])
  })

  it('push a frame that never settled as one, and keep trying for a whole one', async () => {
    const at = emulators()
    at.open(1)
    at.watch(1, 5)
    await at.frame(1)
    // An update begun and never ended: the wait for it runs out, and what is
    // there is pushed marked not whole — then pushed again, still trying,
    // because a screen torn by a program that has since stopped is about to be
    // whole and nobody should be left drawing the torn one.
    at.print(1, `${ESC}[?2026hhalf`)
    const torn = await at.frame(1, (f) => !f.whole)
    expect(torn.rows).toContain('half')
    await at.frame(1, (f) => !f.whole && f !== torn)
    at.print(1, `${ESC}[?2026l`)
    expect((await at.frame(1, (f) => f.whole)).rows).toContain('half')
  })

  it('call a frame on the alternate screen whole only once the writing stops', async () => {
    const at = emulators()
    at.open(1)
    at.watch(1, 24)
    await at.frame(1)
    const wrote = Date.now()
    at.print(1, `${ESC}[?1049h${ESC}[?1000h${ESC}[2J${ESC}[Hdrawn`, wrote)
    const frame = await at.frame(1, (f) => f.rows.includes('drawn'))
    expect(frame.whole).toBe(true)
    expect(Date.now() - wrote).toBeGreaterThanOrEqual(5)
    // The whole rectangle the program drew, the blank rows under it included.
    expect(frame.alternate).toBe(true)
    expect(frame.rows.split('\n')).toHaveLength(24)
    expect(frame.view).toMatchObject({ lines: 24, scrolling: 'lane', pointing: 'press' })
  })

  it('give up on the quiet for a lane that never stops, and say so', async () => {
    const at = emulators()
    at.open(1)
    at.print(1, `${ESC}[?1049h`)
    at.watch(1, 5)
    await at.frame(1)
    // Printing every millisecond: never the five of quiet a frame is waited for.
    const busy = setInterval(() => at.print(1, `${ESC}[Hstreaming ${Date.now()}`), 1)
    try {
      expect((await at.frame(1, (f) => !f.whole)).alternate).toBe(true)
    } finally {
      clearInterval(busy)
    }
  })

  it('apply a resize in order with what was printed around it', async () => {
    const at = emulators()
    at.open(1, 80, 24)
    at.print(1, `${'x'.repeat(100)}\r\n`)
    const resized = at.resize(1, 120, 40)
    at.watch(1, 50)
    const frame = await at.frame(1, (f) => f.seq === resized)
    // Wrapped at eighty and kept as two rows, now that the lane is wider.
    expect(frame.rows.split('\n').filter((row) => row !== '').length).toBeGreaterThanOrEqual(1)
    const after = at.print(1, `${'y'.repeat(100)}\r\n`)
    const wider = await at.frame(1, (f) => f.seq === after)
    expect(wider.rows.split('\n').at(-1)).toBe('y'.repeat(100))
    expect((await at.look(1)).seq).toBe(after)
  })

  it('keep the scrollback they were opened with, and no more', async () => {
    const at = emulators()
    at.open(1, 80, 24, 100)
    let text = ''
    for (let i = 0; i < 300; i++) text += `n${i}\r\n`
    at.print(1, text)
    at.watch(1, 1_000)
    const frame = await at.frame(1)
    // Screen and scrollback together, which is the most a capture can return,
    // and exactly as many rows as the numbers beside it say there are.
    expect(frame.view.lines).toBeLessThanOrEqual(124)
    expect(frame.rows.split('\n')).toHaveLength(frame.view.lines)
    expect(frame.rows.split('\n').at(-1)).toBe('n299')
  })

  it('keep the paint, and only where it is', async () => {
    const at = emulators()
    at.open(1)
    at.print(
      1,
      `${ESC}[1;3;4;7;38;5;196mpal${ESC}[0m   ${ESC}[2;38;2;1;2;3;48;2;4;5;6mrgb${ESC}[0m ${ESC}[48;5;238mbg${ESC}[0m\r\n`,
    )
    at.watch(1, 5, true)
    const frame = await at.frame(1)
    const row = frame.rows.split('\n')[0] ?? ''
    expect(row).toContain(`${ESC}[0;1;3;4;7;38;5;196mpal`)
    expect(row).toContain(`${ESC}[0;2;38;2;1;2;3;48;2;4;5;6mrgb`)
    // The gap after a painted run is closed before it, never painted with it.
    expect(row).toContain(`pal${ESC}[0m   ${ESC}[0;2;`)
    expect(row.endsWith(`bg${ESC}[0m`)).toBe(true)
  })

  it('forget a lane released, and answer nothing about it', async () => {
    const at = emulators()
    at.open(1)
    at.watch(1, 5)
    await at.frame(1)
    at.release(1)
    at.print(1, 'after\r\n')
    at.resize(1, 100, 30)
    at.watch(1, 5)
    expect((await at.look(1)).view).toBeNull()
    expect(at.frames(1)).toHaveLength(1)
    // A key the driver sends again after starting these afresh is the same
    // lane: the screen already here is kept rather than replaced.
    at.open(2)
    at.print(2, 'kept\r\n')
    at.take({ do: 'open', key: 2, cols: 80, rows: 24, scrollback: 100, seq: 0, seed: 'lost' })
    expect((await at.look(2)).view?.lines).toBe(1)
  })

  it('open a lane from what it already printed, as when started again after dying', async () => {
    const at = emulators()
    at.take({
      do: 'open',
      key: 7,
      cols: 80,
      rows: 24,
      scrollback: 100,
      seq: 12,
      seed: 'one\r\ntwo\r\n',
    })
    at.watch(7, 5)
    const frame = await at.frame(7)
    expect(frame.seq).toBe(12)
    expect(frame.rows).toBe('one\ntwo')
  })

  it('say what they hold', async () => {
    const at = emulators()
    at.take({ do: 'held', ask: 1 })
    const held = at.reports.find((r) => r.is === 'held')
    expect(held).toMatchObject({ is: 'held', ask: 1 })
    expect((held as Extract<Report, { is: 'held' }>).bytes).toBeGreaterThan(0)
  })
})
