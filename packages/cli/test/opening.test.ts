import { EventEmitter } from 'node:events'
import { COLOUR, MARK, PLAIN } from '@tade/app/skin'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  handOverOpening,
  OPENING,
  type OpeningProcess,
  type OpeningTerminal,
  opensWindow,
  sayOpening,
  TICK_MS,
  unsayOpening,
} from '../src/opening.ts'
import {
  markBytes,
  markRows,
  paletteOf,
  placed,
  REST_MS,
  restingMark,
  splashBytes,
  TURN_MS,
  turnedAt,
  turningRoom,
  WORD,
} from '../src/splash.ts'

// What `tade` shows while the window opens: the mark, turning, over the name.
// The drawing is one with the window's own corner and the away view's
// favicon, and the showing of it may never outlast the moment the window
// takes the screen, nor leave a terminal on a screen nobody can get off.

/** Where an escape begins, spelt out: a control character in a regex literal is a lint error. */
const ESC = String.fromCharCode(27)

/** Half blocks lit, counted in pixels: the mark's area, whatever its pose. */
const area = (rows: readonly string[]): number =>
  rows.join('').replace(/ /g, '').length + (rows.join('').match(/█/g)?.length ?? 0)

describe('the mark, drawn in cells', () => {
  it('is the window’s own corner at its smallest', () => {
    expect(restingMark(1)).toEqual([MARK])
  })

  it('rests in whole cells, the favicon’s two squares on a diagonal', () => {
    for (const side of [2, 4, 6]) {
      const rest = restingMark(side)
      const full = '█'.repeat(side)
      const air = ' '.repeat(side)
      expect(rest).toEqual([
        ...Array(side / 2).fill(air + full),
        ...Array(side / 2).fill(full + air),
      ])
      // And it is that, in the middle of the room it turns in.
      const box = turningRoom(side)
      const margin = ' '.repeat((box - 2 * side) / 2)
      const turning = markRows(side, 0)
      expect(turning.length).toBe(box / 2)
      expect(turning.filter((row) => row.trim() !== '')).toEqual(
        rest.map((row) => margin + row + margin),
      )
    }
  })

  it('is itself again after half a turn, and its mirror a quarter of the way', () => {
    const rest = markRows(6, 0)
    expect(markRows(6, 1)).toEqual(rest)
    expect(markRows(6, 0.5)).toEqual(rest.map((row) => [...row].reverse().join('')))
  })

  it('never turns out of its room: every pose has the whole of both squares', () => {
    for (const side of [2, 4, 6]) {
      const whole = 2 * side * side
      for (let turned = 0; turned <= 1; turned += 1 / 32) {
        const rows = markRows(side, turned)
        const box = turningRoom(side)
        expect(rows.length).toBe(box / 2)
        for (const row of rows) expect(row.length).toBe(box)
        // A square at an angle is a staircase, so a few pixels either way (six
        // at most, at side 6); a room the size of the mark at rest would cut
        // a dozen off the corners as they went past.
        expect(Math.abs(area(rows) - whole)).toBeLessThanOrEqual(Math.max(2, whole / 10))
      }
    }
  })

  it('rests, then turns half a turn, slow at both ends, and rests again', () => {
    expect(turnedAt(0)).toBe(0)
    expect(turnedAt(REST_MS - 1)).toBe(0)
    let last = 0
    for (let ms = REST_MS; ms < REST_MS + TURN_MS; ms += TICK_MS) {
      const now = turnedAt(ms)
      expect(now).toBeGreaterThanOrEqual(last)
      expect(now).toBeLessThan(1)
      last = now
    }
    expect(last).toBeGreaterThan(0.9)
    expect(turnedAt(REST_MS + TURN_MS)).toBe(0)
    expect(turnedAt(REST_MS + TURN_MS / 2)).toBeCloseTo(0.5)
    // Eased: the first and last steps are smaller than the one in the middle.
    const step = (ms: number) => turnedAt(ms + TICK_MS) - turnedAt(ms)
    expect(step(REST_MS)).toBeLessThan(step(REST_MS + TURN_MS / 2 - TICK_MS / 2))
  })
})

describe('where it goes', () => {
  it('is the largest that fits, centred, a cell clear of every edge', () => {
    expect(placed({ columns: 80, rows: 24 })?.side).toBe(6)
    expect(placed({ columns: 20, rows: 10 })?.side).toBe(4)
    expect(placed({ columns: 14, rows: 7 })?.side).toBe(2)
    for (let columns = 0; columns <= 120; columns += 3) {
      for (let rows = 0; rows <= 40; rows++) {
        const at = placed({ columns, rows })
        if (at === null) continue
        const box = turningRoom(at.side)
        expect(at.top).toBeGreaterThanOrEqual(1)
        expect(at.left).toBeGreaterThanOrEqual(1)
        expect(at.left + box).toBeLessThanOrEqual(columns - 1)
        expect(at.wordLeft).toBeGreaterThanOrEqual(1)
        expect(at.wordLeft + WORD.length).toBeLessThanOrEqual(columns - 1)
        // The word is under the room the mark turns in, never in it.
        expect(at.wordRow).toBe(at.top + box / 2)
        expect(at.wordRow).toBeLessThanOrEqual(rows - 2)
      }
    }
  })

  it('is nowhere in a terminal with no size, or one too small for the smallest', () => {
    expect(placed({ columns: 0, rows: 0 })).toBeNull()
    expect(placed({ columns: 12, rows: 24 })).toBeNull()
    expect(placed({ columns: 80, rows: 6 })).toBeNull()
  })
})

describe('the colours it is painted in', () => {
  const at = placed({ columns: 80, rows: 24 })
  if (at === null) throw new Error('80 × 24 has room for the mark')

  it('is what the terminal can paint, and nothing where colour is turned off', () => {
    expect(paletteOf({}, 24)).toBe('256')
    expect(paletteOf({}, 8)).toBe('256')
    expect(paletteOf({}, 4)).toBe('16')
    expect(paletteOf({}, 1)).toBe('none')
    expect(paletteOf({}, undefined)).toBe('256')
    expect(paletteOf({ NO_COLOR: '1' }, 24)).toBe('none')
    expect(paletteOf({ NO_COLOR: '' }, 8)).toBe('256')
  })

  it('writes the name the way the window’s corner does, byte for byte', () => {
    expect(splashBytes(at, markRows(6), '256')).toContain(COLOUR.mark('TADE'))
    expect(splashBytes(at, markRows(6), 'none')).toContain(PLAIN.mark('TADE'))
  })

  it('paints the mark in the window’s amber, or the nearest of sixteen, or not at all', () => {
    expect(splashBytes(at, markRows(6), '256')).toContain('\x1b[38;5;214m')
    expect(COLOUR.brand(MARK)).toContain('\x1b[38;5;214m')
    const sixteen = splashBytes(at, markRows(6), '16')
    expect(sixteen).toContain('\x1b[33m')
    expect(sixteen).not.toContain('\x1b[38;5;')
    expect(sixteen).not.toContain('\x1b[48;5;')
    // Without colour, the only escapes are where things go and the clearing.
    const plain = splashBytes(at, markRows(6), 'none')
    const placing = new RegExp(`${ESC}\\[\\d+;\\d+H|${ESC}\\[2J`, 'g')
    expect(plain.replace(placing, '')).not.toContain(ESC)
  })
})

/** A terminal that keeps what was written to it. */
function terminal(over: Partial<OpeningTerminal> = {}) {
  const events = new EventEmitter()
  const room = { columns: 80, rows: 24 }
  const out = {
    isTTY: true,
    get columns() {
      return room.columns
    },
    get rows() {
      return room.rows
    },
    written: '',
    write(text: string) {
      out.written += text
      return true
    },
    getColorDepth: () => 8,
    on: (event: 'resize', listener: () => void) => events.on(event, listener),
    off: (event: 'resize', listener: () => void) => events.off(event, listener),
    resize(columns: number, rows: number) {
      room.columns = columns
      room.rows = rows
      events.emit('resize')
    },
    listening: () => events.listenerCount('resize'),
    ...over,
  }
  return out
}

/** A process that says how it was told to end, rather than ending. */
function process_(env: NodeJS.ProcessEnv = { TERM: 'xterm-256color' }) {
  const events = new EventEmitter()
  const proc = {
    env,
    pid: 4242,
    killed: [] as string[],
    on: (event: string, listener: (signal: NodeJS.Signals) => void) => events.on(event, listener),
    off: (event: string, listener: (signal: NodeJS.Signals) => void) => events.off(event, listener),
    kill: (_pid: number, signal: NodeJS.Signals) => proc.killed.push(signal),
    emit: (event: string, ...args: unknown[]) => events.emit(event, ...args),
    listening: () => events.eventNames().reduce((n, name) => n + events.listenerCount(name), 0),
  }
  return proc
}

const as = (out: ReturnType<typeof terminal>) => out as OpeningTerminal
const asProcess = (proc: ReturnType<typeof process_>) => proc as OpeningProcess

const ENTER = '\x1b[?1049h\x1b[?25l'
const LEAVE = '\x1b[?1049l\x1b[?25h'

describe('saying the window is opening', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    unsayOpening()
    vi.useRealTimers()
  })

  it('is said for the window, and for nothing that answers instead', () => {
    expect(opensWindow([])).toBe(true)
    expect(opensWindow(['app'])).toBe(true)
    expect(opensWindow(['--safe'])).toBe(true)
    expect(opensWindow(['app', '--config', '/x.yaml'])).toBe(true)
    expect(opensWindow(['status'])).toBe(false)
    expect(opensWindow(['--version'])).toBe(false)
    expect(opensWindow(['app', '--help'])).toBe(false)
    expect(opensWindow(['help'])).toBe(false)
  })

  it('is nothing down a pipe', () => {
    const pipe = terminal({ isTTY: false })
    sayOpening(as(pipe), asProcess(process_()))
    unsayOpening()
    expect(pipe.written).toBe('')
  })

  it('is a line on a dumb terminal, or one with no room, said once and taken back once', () => {
    for (const [out, proc] of [
      [terminal(), process_({ TERM: 'dumb' })],
      [terminal(), process_({})],
      [terminal({ columns: 0, rows: 0 }), process_()],
      [terminal({ columns: 40, rows: 5 }), process_()],
    ] as const) {
      sayOpening(as(out), asProcess(proc))
      sayOpening(as(out), asProcess(proc))
      expect(out.written).toBe(OPENING)
      // The window taking the screen leaves a line where it is, on the screen it came from.
      handOverOpening()
      unsayOpening()
      unsayOpening()
      expect(out.written).toBe(`${OPENING}\r\x1b[2K`)
      expect(proc.listening()).toBe(0)
    }
  })

  it('puts the mark up on a screen of its own, in the colours the terminal has', () => {
    const out = terminal({ getColorDepth: () => 4 })
    sayOpening(as(out), asProcess(process_()))
    expect(out.written.startsWith(ENTER)).toBe(true)
    expect(out.written).toContain('\x1b[33m')
    expect(out.written).not.toContain('\x1b[38;5;')
    expect(out.written).toContain('T A D E')
  })

  it('turns on a timer that never holds the process open, and draws only when it moved', () => {
    const intervals = vi.spyOn(globalThis, 'setInterval')
    const out = terminal()
    sayOpening(as(out), asProcess(process_()))
    const timer = intervals.mock.results[0]?.value as NodeJS.Timeout
    expect(timer.hasRef()).toBe(false)
    const first = out.written.length
    // At rest, a tick has nothing new to draw, and writes nothing.
    vi.advanceTimersByTime(REST_MS - TICK_MS)
    expect(out.written.length).toBe(first)
    // Half way through the turn, what was last drawn is the mark a quarter of
    // the way round: its mirror.
    vi.advanceTimersByTime(TICK_MS + TURN_MS / 2)
    expect(out.written.length).toBeGreaterThan(first)
    const at = placed({ columns: 80, rows: 24 })
    if (at === null) throw new Error('80 × 24 has room for the mark')
    expect(out.written.endsWith(markBytes(at, markRows(6, 0.5), '256'))).toBe(true)
    intervals.mockRestore()
  })

  it('stops where the window takes the screen, and leaves it for the window', () => {
    const out = terminal()
    const proc = process_()
    sayOpening(as(out), asProcess(proc))
    vi.advanceTimersByTime(REST_MS + TURN_MS / 3)
    handOverOpening()
    const handed = out.written
    vi.advanceTimersByTime(10 * (REST_MS + TURN_MS))
    out.resize(100, 30)
    // Nothing after it: not a frame, not the way back, not on the way out —
    // the window clears the screen as it takes it, and leaves it itself.
    unsayOpening()
    proc.emit('exit', 0)
    expect(out.written).toBe(handed)
    expect(handed).not.toContain('\x1b[?1049l')
    expect(out.listening()).toBe(0)
    expect(proc.listening()).toBe(0)
  })

  it('goes back to the terminal it came from when something else is said instead, once', () => {
    const out = terminal()
    const proc = process_()
    sayOpening(as(out), asProcess(proc))
    unsayOpening()
    unsayOpening()
    expect(out.written.endsWith(LEAVE)).toBe(true)
    expect(out.written.split(LEAVE).length).toBe(2)
    const left = out.written
    vi.advanceTimersByTime(REST_MS + TURN_MS)
    expect(out.written).toBe(left)
    expect(out.listening()).toBe(0)
    expect(proc.listening()).toBe(0)
  })

  it('is taken down before a crash is printed, or the process exits', () => {
    for (const event of ['uncaughtExceptionMonitor', 'exit']) {
      const out = terminal()
      const proc = process_()
      sayOpening(as(out), asProcess(proc))
      proc.emit(event, new Error('boom'))
      expect(out.written.endsWith(LEAVE)).toBe(true)
      expect(proc.listening()).toBe(0)
    }
  })

  it('takes itself down on ctrl+c, and then lets the signal end Tade', () => {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      const out = terminal()
      const proc = process_()
      sayOpening(as(out), asProcess(proc))
      proc.emit(signal, signal)
      expect(out.written.endsWith(LEAVE)).toBe(true)
      // Its own listener gone first, so what the signal does now is Node's own.
      expect(proc.listening()).toBe(0)
      expect(proc.killed).toEqual([signal])
    }
  })

  it('is drawn again at a new size, and is the line where it no longer fits', () => {
    const out = terminal()
    sayOpening(as(out), asProcess(process_()))
    out.resize(30, 14)
    const at = placed({ columns: 30, rows: 14 })
    if (at === null) throw new Error('30 × 14 has room for the mark')
    expect(out.written.endsWith(splashBytes(at, markRows(at.side), '256'))).toBe(true)
    out.resize(10, 4)
    expect(out.written.endsWith(`\x1b[2J\x1b[H${OPENING}`)).toBe(true)
    const small = out.written
    vi.advanceTimersByTime(REST_MS + TURN_MS)
    expect(out.written).toBe(small)
    // And the mark again, from nothing, once there is room for it.
    out.resize(80, 24)
    expect(out.written.slice(small.length).startsWith('\x1b[2J')).toBe(true)
    expect(out.written).toContain('T A D E')
  })
})
