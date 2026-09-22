import { describe, expect, it } from 'vitest'
import { toCells } from '../scripts/terminal.ts'
import type { Hit } from '../src/hits.ts'
import { resolveLayout } from '../src/layout.ts'
import { type AppState, scrollBy } from '../src/model.ts'
import {
  cutFrom,
  DRAG_MS,
  endOf,
  NOTCH,
  RUN_MS,
  reachOf,
  scrollable,
  Wheel,
  wheelRows,
} from '../src/scroll.ts'
import { rowsRead } from '../src/view/lane.ts'
import { draw } from '../src/view.ts'
import { SCENARIOS } from './screens/scenarios.ts'

// What the wheel means. One rule for every region, because three of them used
// to have three, and the ends of each disagreed.

describe('how far a notch goes', () => {
  it('moves a few rows when it arrives on its own', () => {
    expect(wheelRows(1, 4_000)).toBe(NOTCH)
    expect(wheelRows(-1, RUN_MS)).toBe(-NOTCH)
  })

  it('moves a row when the notches arrive as fast as a finger does', () => {
    // A finger on a trackpad reports a notch a line, a hundred times a second,
    // and giving each of those a detent's worth is how a flick crossed the
    // screen three times over.
    expect(wheelRows(1, 0)).toBe(1)
    expect(wheelRows(1, DRAG_MS)).toBe(1)
    expect(wheelRows(-1, 8)).toBe(-1)
  })

  it('ramps between the two rather than stepping, because a hand is neither', () => {
    // The step was the jank. It put the line at `RUN_MS` — a fifth of a second
    // — so an ordinary mouse wheel, whose detents arrive fifty to a hundred
    // milliseconds apart, was read as a finger and moved one row a detent,
    // while the same wheel turned slowly moved three. Either side of the line,
    // one report's jitter changed the step threefold.
    const at = (since: number) => wheelRows(1, since)
    expect(at(RUN_MS - 1)).toBeGreaterThan(at(DRAG_MS + 1))
    expect(at(RUN_MS - 1)).toBeCloseTo(NOTCH, 1)
    // Never backwards: later is always at least as far as sooner.
    let last = 0
    for (let since = 0; since <= RUN_MS + 40; since += 4) {
      expect(at(since)).toBeGreaterThanOrEqual(last)
      last = at(since)
    }
    // And a wheel's own pace lands between the two, rather than at one end.
    expect(at(60)).toBeGreaterThan(1.5)
    expect(at(60)).toBeLessThan(NOTCH)
  })

  it('keeps what the terminal said about how big a notch was', () => {
    // Alt is a page on a terminal that offers one, and a terminal set to
    // scroll five lines a notch means five.
    expect(wheelRows(5, 0)).toBe(5)
    expect(wheelRows(5, 4_000)).toBe(5 * NOTCH)
  })

  it('never turns a notch into nothing', () => {
    const wheel = new Wheel()
    for (const since of [0, 50, 5_000]) expect(Math.abs(wheelRows(1, since))).toBeGreaterThan(0)
    // Nor after rounding: whatever the arithmetic comes to, a notch that
    // arrived moves at least the row it asked for, either way.
    for (let i = 0; i < 40; i++) expect(wheel.rows('sidebar', 1, i * 7)).toBeGreaterThan(0)
    for (let i = 0; i < 40; i++) expect(wheel.rows('sidebar', -1, 500 + i * 7)).toBeLessThan(0)
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

  it('carries what a notch could not spend, so a run of them is even', () => {
    // A wheel turned evenly at its own pace: every notch the same distance
    // apart, so every one of them has to be worth the same. Deciding each on
    // its own would give all 1s or all 2s; carried, they alternate and add up
    // to exactly what the hand asked for.
    const wheel = new Wheel()
    const each: number[] = []
    for (let i = 1; i <= 12; i++) each.push(wheel.rows('sidebar', 1, 1_000 + i * 60))
    const want = wheelRows(1, 60) * 11 + NOTCH
    expect(each.reduce((all, one) => all + one, 0)).toBeCloseTo(want, 0)
    // None of them is a jump: a run of one step size, give or take the cell
    // the grid rounds to.
    for (const one of each.slice(1)) expect(Math.abs(one - 2)).toBeLessThanOrEqual(1)
  })

  it('drops what it was carrying when the hand turns back the other way', () => {
    // Momentum has a direction: rows owed downward are not rows owed upward,
    // and a turn back that spent them would overshoot by however far the last
    // run happened to stop short.
    const turnedBack = new Wheel()
    for (let i = 1; i <= 3; i++) turnedBack.rows('sidebar', 1, 1_000 + i * 50)
    const straight = new Wheel()
    straight.rows('sidebar', -1, 1_000)
    const back: number[] = []
    const same: number[] = []
    for (let i = 1; i <= 6; i++) {
      back.push(turnedBack.rows('sidebar', -1, 1_150 + i * 50))
      same.push(straight.rows('sidebar', -1, 1_000 + i * 50))
    }
    expect(back).toEqual(same)
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

// How far a region goes is read off its bar, so the bar has to be measured
// against the rows the region actually drew. A pane is the one place those two
// differ: an approval card sits at the bottom of the agent's own screen and
// takes five rows off it, and the bar was being drawn from the pane's height
// — so a screen with more lines in it than fit said everything was in view and
// the wheel over it did nothing at all. It is only wrong while the agent is
// waiting on you, which is what made it look intermittent.
describe('a pane with an approval card over it', () => {
  const carded = SCENARIOS.find((one) => one.name === 'watching-an-agent')
  if (!carded) throw new Error('the scenario is gone')
  /** The same window with the card taken away, which is the only difference. */
  const uncarded = {
    ...carded.state,
    panes: carded.state.panes.map((pane) =>
      pane.task === carded.state.focused ? { ...pane, approval: null } : pane,
    ),
  }
  const at = (state: AppState, lines: number) => {
    const frame = { ...carded.frame, paneScreen: { lines, cursor: { back: 0, column: 0 } } }
    const hits = draw(state, frame).hits
    const rows = hits.filter(
      (hit) => hit.target.kind === 'scroll' && hit.target.area === 'pane',
    ).length
    return { reach: reachOf(hits, 'pane'), rows }
  }

  it('says how much of the screen the card leaves in view, not how tall the pane is', () => {
    const withCard = at(carded.state, 1_000)
    const without = at(uncarded, 1_000)
    // The bar counts exactly the rows the screen was drawn in — which is what
    // the wheel lands on, and is five fewer than the pane has to give.
    expect(withCard.reach.shown).toBe(withCard.rows)
    expect(without.reach.shown).toBe(without.rows)
    expect(withCard.reach.shown).toBe(rowsRead(without.reach.shown, true))
    expect(withCard.reach.shown).toBeLessThan(without.reach.shown)
  })

  it('counts the row that says how far back it is as a row of the pane', () => {
    // Scrolled away from its newest line, the last row of the screen says so
    // and takes you back there. It is a row of the pane and not a line of the
    // lane, so one fewer line is in view — and left out of the count, the bar
    // said the end was a row further than the look would allow, so the top of
    // a scrollback answered every notch by springing back a row.
    const atNewest = at(carded.state, 1_000)
    const scrolled = at({ ...carded.state, paneScroll: 5 }, 1_000)
    expect(scrolled.reach.shown).toBe(atNewest.reach.shown - 1)
    expect(endOf(scrolled.reach)).toBe(1_000 - scrolled.reach.shown)
  })

  it('scrolls when there is more of the screen than the card leaves room for', () => {
    const shown = at(carded.state, 1_000).reach.shown
    // Exactly what fits: nothing to scroll, and the wheel is honest about it.
    expect(scrollable(at(carded.state, shown).reach)).toBe(false)
    // One line more than fits, and every line up to a whole pane's worth —
    // which is the band the card's own height used to swallow, so a screen
    // with plenty to read said there was nothing and the wheel did nothing.
    for (const lines of [shown + 1, shown + 3, shown + 5, shown + 20]) {
      expect(scrollable(at(carded.state, lines).reach), `${lines} lines`).toBe(true)
      expect(endOf(at(carded.state, lines).reach)).toBe(lines - shown)
    }
  })
})

// The side and the agent's screen share a row — the window is regions beside
// each other, not one flow of text — and the renderer diffs whole rows. So a
// notch over the side rewrites every row of the body, the agent's half
// included, which is the erase and repaint that reads as the harness rows
// blinking. Nothing can be done about the rewrite from here; what can be held
// is that it is only ever a rewrite of the same cells, never a change to them.
describe('scrolling the side', () => {
  it('never changes a single cell of what is drawn beside it', () => {
    for (const scenario of SCENARIOS) {
      const before = draw(scenario.state, scenario.frame)
      const reach = reachOf(before.hits, 'sidebar')
      const moved = scrollBy(scenario.state, 'sidebar', NOTCH, reach)
      if (moved === scenario.state) continue
      const after = draw(moved, scenario.frame)
      const { sidebarWidth, mainWidth } = resolveLayout(
        {
          ...scenario.frame.layout,
          ...scenario.state.sizes,
          bottom: scenario.state.bottomMode,
        },
        scenario.frame,
      )
      // In cells, not in bytes: a slice of a row carries in whatever paint
      // was live at the column it starts on, which is the side's, and that
      // says nothing about what the cell after it ends up looking like.
      const beside = (rows: readonly string[], row: number) =>
        toCells(rows[row] ?? '')
          .slice(sidebarWidth + 1, sidebarWidth + 1 + mainWidth)
          .map((cell) => `${cell.ch}|${cell.fg}|${cell.bg}|${cell.bold}`)
          .join(' ')
      for (let row = 0; row < before.rows.length; row++) {
        expect(beside(after.rows, row), `${scenario.name}, row ${row}`).toBe(
          beside(before.rows, row),
        )
      }
    }
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

// The project picker was the last region in the window scrolling its own way,
// and its own way was nothing at all: it kept no offset, drew no bar, and the
// wheel over it fell through to the branch that presses the down key — so a
// notch moved what was *chosen*, wrapping from the last row back to the first.
describe('the project picker', () => {
  const listed = SCENARIOS.find((one) => one.name === 'open-project-a-long-list')
  if (!listed) throw new Error('the scenario is gone')
  const hits = draw(listed.state, listed.frame).hits
  const reach = reachOf(hits, 'panel')

  it('says how far it goes on the bar beside it, like every other region', () => {
    expect(scrollable(reach)).toBe(true)
    // What the bar says is in view is exactly the rows the list drew — one
    // cell of bar beside each of them — and never the room the panel took.
    const cells = hits.filter(
      (hit) => hit.target.kind === 'scrollbar' && hit.target.area === 'panel',
    ).length
    expect(reach.shown).toBe(cells)
    expect(reach.total).toBeGreaterThan(reach.shown)
  })

  it('answers a notch by moving what is in view, never what is chosen', () => {
    const top = { ...listed.state, panel: { ...listed.state.panel, scroll: 0 } } as AppState
    const moved = scrollBy(top, 'panel', NOTCH, reach)
    expect(moved.panel).toMatchObject({ kind: 'open-project', index: 14, scroll: NOTCH })
  })

  it('stops at both ends rather than counting on past them', () => {
    const end = scrollBy(listed.state, 'panel', 999, reach)
    expect(end.panel && 'scroll' in end.panel ? end.panel.scroll : null).toBe(endOf(reach))
    const top = scrollBy(end, 'panel', -999, reach)
    expect(top.panel && 'scroll' in top.panel ? top.panel.scroll : null).toBe(0)
  })
})
