import { describe, expect, it } from 'vitest'
import type { Hit } from '../src/hits.ts'
import { scrollBy } from '../src/model.ts'
import {
  cutFrom,
  endOf,
  NOTCH,
  RUN_MS,
  reachOf,
  scrollable,
  Wheel,
  wheelRows,
} from '../src/scroll.ts'
import { draw } from '../src/view.ts'
import { SCENARIOS } from './screens/scenarios.ts'

// What the wheel means. One rule for every region, because three of them used
// to have three, and the ends of each disagreed.

describe('how far a notch goes', () => {
  it('moves a few rows when it arrives on its own', () => {
    expect(wheelRows(1, 4_000)).toBe(NOTCH)
    expect(wheelRows(-1, RUN_MS)).toBe(-NOTCH)
  })

  it('moves the lines the terminal counted when they arrive in a run', () => {
    // A finger on a trackpad reports a notch a line, a hundred times a second,
    // and the terminal has already turned the pixels into lines with the
    // settings of the machine it is on. Doing that sum again on top is the
    // jump people feel.
    expect(wheelRows(1, 0)).toBe(1)
    expect(wheelRows(1, RUN_MS - 1)).toBe(1)
    expect(wheelRows(-1, 8)).toBe(-1)
  })

  it('keeps what the terminal said about how big a notch was', () => {
    // Alt is a page on a terminal that offers one, and a terminal set to
    // scroll five lines a notch means five.
    expect(wheelRows(5, 0)).toBe(5)
    expect(wheelRows(5, 4_000)).toBe(5 * NOTCH)
  })

  it('never turns a notch into nothing', () => {
    for (const since of [0, 50, 5_000]) expect(Math.abs(wheelRows(1, since))).toBeGreaterThan(0)
  })
})

describe('a wheel', () => {
  it('counts the first notch as one on its own, and the rest as a run', () => {
    const wheel = new Wheel()
    expect(wheel.rows('pane', 1, 1_000)).toBe(NOTCH)
    expect(wheel.rows('pane', 1, 1_010)).toBe(1)
    expect(wheel.rows('pane', 1, 1_020)).toBe(1)
    // A hand that stopped and started again is a new movement.
    expect(wheel.rows('pane', 1, 1_020 + RUN_MS)).toBe(NOTCH)
  })

  it('starts again when the pointer moves to another region', () => {
    // Crossing from an agent's screen to the conversation is a new movement of
    // the hand, not the continuation of the last one.
    const wheel = new Wheel()
    expect(wheel.rows('pane', 1, 100)).toBe(NOTCH)
    expect(wheel.rows('transcript', 1, 105)).toBe(NOTCH)
    expect(wheel.rows('transcript', 1, 110)).toBe(1)
  })
})

describe('how far a region reaches', () => {
  const bar = (area: 'pane' | 'sidebar', total: number, shown: number, across?: true): Hit => ({
    row: 0,
    from: 9,
    to: 9,
    target: { kind: 'scrollbar', area, total, shown, ...(across ? { across } : {}) },
  })

  it('is read off the bar the last frame drew, not laid out again', () => {
    const hits = [bar('sidebar', 90, 20), bar('pane', 400, 30)]
    expect(reachOf(hits, 'pane')).toEqual({ total: 400, shown: 30 })
    expect(endOf(reachOf(hits, 'pane'))).toBe(370)
    expect(reachOf(hits, 'sidebar')).toEqual({ total: 90, shown: 20 })
  })

  it('tells the bar down the side from the one lying along the bottom', () => {
    const hits = [bar('sidebar', 90, 20), bar('sidebar', 60, 20, true)]
    expect(reachOf(hits, 'sidebar')).toEqual({ total: 90, shown: 20 })
    expect(reachOf(hits, 'sidebar', true)).toEqual({ total: 60, shown: 20 })
  })

  it('says nowhere for a region with no bar, rather than guessing', () => {
    // A bar along the bottom is drawn only where there is somewhere to go, so
    // its absence is the answer: the wheel is handed back and scrolls down
    // instead of being swallowed.
    expect(reachOf([bar('sidebar', 90, 20)], 'sidebar', true)).toEqual({ total: 0, shown: 0 })
    expect(scrollable(reachOf([], 'terminal'))).toBe(false)
    expect(scrollable({ total: 20, shown: 20 })).toBe(false)
    expect(scrollable({ total: 21, shown: 20 })).toBe(true)
  })
})

describe('cutting a screen out of the lines already held', () => {
  // A lane of 100 lines, 60 of them read back: lines 40 to 99.
  const held = {
    lane: 'app/agent',
    lines: Array.from({ length: 60 }, (_, i) => `line ${i + 40}`),
    at: 100,
    asked: 60,
  }

  it('gives the newest rows when nothing is scrolled back', () => {
    expect(cutFrom(held, 4, 0, 100)).toBe(['line 96', 'line 97', 'line 98', 'line 99'].join('\n'))
  })

  it('gives the rows scrolled back to, without asking the driver', () => {
    expect(cutFrom(held, 3, 10, 100)).toBe(['line 87', 'line 88', 'line 89'].join('\n'))
    expect(cutFrom(held, 2, 55, 100)).toBe(['line 43', 'line 44'].join('\n'))
  })

  it('says nothing when the wheel has gone above the oldest line held', () => {
    // 60 lines held, so 57 back is the furthest a screen of three reaches.
    expect(cutFrom(held, 3, 57, 100)).not.toBeNull()
    expect(cutFrom(held, 3, 58, 100)).toBeNull()
  })

  it('reaches to the top of the scrollback when that is all there is', () => {
    // Fewer lines came back than were asked for: there is nothing above them,
    // so scrolling past them stops rather than sending for more.
    const top = { ...held, asked: 500 }
    expect(cutFrom(top, 3, 80, 100)).toBe(['line 40', 'line 41', 'line 42'].join('\n'))
  })

  it('follows the bottom as the agent prints, which is what `back` counts from', () => {
    // Three lines arrived since the read. The same distance back from the
    // newest line is three lines further down the ones held — the view slides
    // with the output, as it did when every frame read the lane again.
    expect(cutFrom(held, 2, 10, 103)).toBe(['line 91', 'line 92'].join('\n'))
    // And once it wants a line that arrived after the read, it has to ask.
    expect(cutFrom(held, 2, 0, 103)).toBeNull()
  })
})

// A notch is answered between two frames, so what one costs is held to a
// number the same way a frame is. The thing this replaced laid the region out
// again to find out how far it could go — two milliseconds a notch on a
// conversation of any length, and a flick is twenty of them.
describe('what a notch costs', () => {
  it('answers one in the same time however big the screen behind it is', () => {
    for (const scenario of SCENARIOS) {
      const hits = draw(scenario.state, scenario.frame).hits
      const areas = [
        ...new Set(hits.flatMap((hit) => (hit.target.kind === 'scroll' ? [hit.target.area] : []))),
      ]
      if (areas.length === 0) continue
      const notch = () => {
        for (const area of areas) scrollBy(scenario.state, area, -NOTCH, reachOf(hits, area))
      }
      notch()
      const rounds = 200
      const started = performance.now()
      for (let round = 0; round < rounds; round++) notch()
      const each = (performance.now() - started) / (rounds * areas.length)
      expect(each, `${scenario.name}: ${areas.join(', ')}`).toBeLessThan(0.5)
    }
  })
})
