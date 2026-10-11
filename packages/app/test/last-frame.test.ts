import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { type AppState, SPIN_MS, spinner } from '../src/model.ts'
import type { Drawn } from '../src/ui.ts'
import { DEPTH, drawnFor, LastFrame, REGIONS, same } from '../src/view/last-frame.ts'
import { draw } from '../src/view.ts'
import { SCENARIOS, type Scenario } from './screens/scenarios.ts'

// Keeping a region from one frame to the next.
//
// The whole of the risk is one sentence: a region handed back that drawing it
// again would not have drawn. So the first thing held here is that over every
// screen there is, through a run of frames that each move something — the
// clock, the pane, the pointer, the size — a window that keeps draws exactly
// what a window that keeps nothing draws, rows, hits and what scrolls alike.
// The second is the other half, without which the first is free: that keeping
// happens at all, where the frame says it should.

/** What a drawing is, all of it: a kept region that differs in any of these is wrong. */
function whole(drawn: Drawn): unknown {
  return { rows: drawn.rows, hits: drawn.hits, regions: drawn.regions ?? {} }
}

/** A pane that has printed one more line. */
function printed(frame: Frame, n: number): Frame {
  return { ...frame, screen: `${frame.screen}\nprinting ${n}` }
}

/**
 * The frames a window draws one after another, each moving one thing: the
 * moment inside one turn of the spinner and then past it, the pane printing,
 * the pointer moving onto something and off it, and the window being resized.
 */
function run(scenario: Scenario): { state: AppState; frame: Frame }[] {
  const { state, frame } = scenario
  const now = frame.now ?? 0
  const pointed: AppState = { ...state, hover: { kind: 'action', name: 'toggle-done' } }
  return [
    { state, frame },
    { state, frame: { ...frame, now: now + 33 } },
    { state, frame: { ...frame, now: now + SPIN_MS } },
    { state, frame: printed({ ...frame, now: now + SPIN_MS }, 1) },
    { state, frame: printed({ ...frame, now: now + SPIN_MS + 33 }, 2) },
    { state: pointed, frame: printed({ ...frame, now: now + SPIN_MS + 33 }, 2) },
    { state, frame: printed({ ...frame, now: now + SPIN_MS + 33 }, 2) },
    { state, frame: printed({ ...frame, now: now + SPIN_MS + 33, width: frame.width + 7 }, 2) },
    { state, frame: printed({ ...frame, now: now + 2 * SPIN_MS }, 2) },
  ]
}

describe('a region kept from the last frame', () => {
  it('is exactly the region drawing it again gives, over every screen and every kind of change', () => {
    for (const scenario of SCENARIOS) {
      // Checked as well: a kept region that differs throws inside `draw`, and
      // the comparison below is the same question asked from outside.
      const last = new LastFrame({ checked: true })
      for (const [at, { state, frame }] of run(scenario).entries()) {
        expect(whole(draw(state, frame, last)), `${scenario.name}, frame ${at}`).toEqual(
          whole(draw(state, frame)),
        )
      }
    }
  })

  it('is kept wherever the only thing that moved is the pane', () => {
    // A lane printing in front of you: the picture that was a frame every
    // thirty-three milliseconds with every region drawn again from nothing.
    let checked = 0
    for (const scenario of SCENARIOS) {
      if (scenario.state.panel) continue
      const last = new LastFrame()
      draw(scenario.state, scenario.frame, last)
      draw(scenario.state, printed(scenario.frame, 1), last)
      const counts = last.counts()
      for (const region of ['top', 'sidebar', 'strip', 'foot'] as const)
        expect(counts[region], `${scenario.name}: ${region}`).toEqual({ drawn: 1, kept: 1 })
      checked++
    }
    // The floor under the loop: it was about something.
    expect(checked).toBeGreaterThan(30)
  })

  it('draws the pane again when it printed, and keeps it when it did not', () => {
    const scenario = SCENARIOS.find(
      (one) =>
        !one.state.panel &&
        one.state.focused !== null &&
        draw(one.state, printed(one.frame, 1)).rows.join('\n') !==
          draw(one.state, one.frame).rows.join('\n'),
    )
    if (!scenario) throw new Error('no screen draws the pane it is handed')
    const last = new LastFrame()
    draw(scenario.state, scenario.frame, last)
    draw(scenario.state, printed(scenario.frame, 1), last)
    draw(scenario.state, printed(scenario.frame, 1), last)
    expect(last.counts().main).toEqual({ drawn: 2, kept: 1 })
  })

  it('is drawn again when the spinner turns, and not inside one turn of it', () => {
    const scenario = SCENARIOS.find((one) => !one.state.panel)
    if (!scenario) throw new Error('every screen has a panel')
    const now = scenario.frame.now ?? 0
    const last = new LastFrame()
    draw(scenario.state, scenario.frame, last)
    draw(scenario.state, { ...scenario.frame, now: now + SPIN_MS - 1 }, last)
    for (const region of REGIONS) expect(last.counts()[region]?.drawn, region).toBe(1)
    draw(scenario.state, { ...scenario.frame, now: now + SPIN_MS }, last)
    // The top reads the clock on every screen — its spinner and its toast — so
    // a new turn is a new top; which of the others read it depends on what is
    // on the screen, and the first test holds every one of them to the truth.
    expect(last.counts().top?.drawn).toBe(2)
  })

  it('throws, while checked, where something it read was changed in place rather than replaced', () => {
    const scenario = SCENARIOS.find((one) => !one.state.panel && one.state.panes.length > 1)
    if (!scenario) throw new Error('no screen has two agents on it')
    const panes = [...scenario.state.panes]
    const state: AppState = { ...scenario.state, panes }
    const last = new LastFrame({ checked: true })
    draw(state, scenario.frame, last)
    // The same array with an agent fewer in it: a subject keeping its list and
    // writing into it, which is the one thing the keeping cannot see.
    panes.pop()
    expect(() => draw(state, scenario.frame, last)).toThrow(/kept from the last frame/)
  })
})

describe('whether two values would draw the same', () => {
  it('is the same thing, or plain data with the same members', () => {
    expect(same(1, 1)).toBe(true)
    expect(same(Number.NaN, Number.NaN)).toBe(true)
    expect(same('a', 'b')).toBe(false)
    expect(same({ held: true, problem: null }, { held: true, problem: null })).toBe(true)
    expect(same({ held: true }, { held: false })).toBe(false)
    expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(false)
    expect(same({ a: 1, b: undefined }, { a: 1, c: undefined })).toBe(false)
    expect(same([1, [2, 3]], [1, [2, 3]])).toBe(true)
    expect(same([1, 2], [1, 2, 3])).toBe(false)
    expect(same([1], { 0: 1 })).toBe(false)
    expect(same(null, {})).toBe(false)
  })

  it('compares anything with behaviour only by what it is', () => {
    // Two maps have no members `Object.keys` can see, so compared as data any
    // two would be the same — which is exactly the map written into in place.
    expect(same(new Map([[1, 'a']]), new Map([[1, 'b']]))).toBe(false)
    const map = new Map([[1, 'a']])
    expect(same(map, map)).toBe(true)
    expect(
      same(
        () => 1,
        () => 1,
      ),
    ).toBe(false)
    expect(same(new Date(5), new Date(5))).toBe(false)
  })

  it('stops comparing members at the depth it was given', () => {
    const nested = (depth: number): unknown =>
      depth === 0 ? { leaf: 1 } : { in: nested(depth - 1) }
    expect(same(nested(DEPTH - 2), nested(DEPTH - 2))).toBe(true)
    expect(same(nested(DEPTH), nested(DEPTH))).toBe(false)
  })
})

describe('the moment a frame is drawn for', () => {
  it('is now, to the turn of the spinner, and shows the spinner it would have', () => {
    for (const now of [0, 1, 99, 100, 1_234_567, Date.parse('2026-09-13T14:00:04.987Z')]) {
      const at = drawnFor(now)
      expect(at).toBeLessThanOrEqual(now)
      expect(now - at).toBeLessThan(SPIN_MS)
      expect(at % SPIN_MS).toBe(0)
      expect(drawnFor(at)).toBe(at)
      expect(spinner(at)).toBe(spinner(now))
    }
  })
})
