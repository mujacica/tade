import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { draw } from '../src/view.ts'
import { benchFrames, REGIONS, SIZES } from './bench.ts'
import { SCENARIOS } from './screens/scenarios.ts'

// The frame-cost bench, held to the three things that would make it lie.
//
// What the bench is for is a number somebody argues with — "the sidebar is
// 0.4ms of a 0.9ms frame at 160×45, so memoise that one first". A number like
// that is worth nothing if the instrument quietly stopped covering what it
// claims to, and that is the only failure a bench has: it goes on printing a
// table, and the table is about less than it says.
//
// So: it measures every region the drawing really has, it produces a figure
// for every region and every screen at every size, and the thing it drew at
// each of those sizes is a whole screen rather than a crash or a ragged one.
//
// What is *not* here is an opinion about how fast the machine is. The ceiling
// over drawing lives in `screens.test.ts` and carries the argument for why it
// is loose (0.85ms a screen on a quiet laptop, 7.1ms on a macOS runner — a
// factor of eight that has nothing to do with this code). Two budgets for one
// property would be two numbers to argue with, and the second one would be
// the one nobody maintained. This file is about the instrument.

/** Rounds here: enough samples per region to have a p99 at all, few enough to be free. */
const ROUNDS = 3

describe('the frame-cost bench', () => {
  it('measures every region the drawing composes', () => {
    // The ratchet. The bench draws the five regions itself, with the arguments
    // `draw` gives them, so a sixth region added to `view.ts` would be timed
    // by nothing and nothing would say so — the table would simply be about
    // less of the frame than it claims, which is the one way a bench rots
    // silently. Read off `view.ts`'s own imports rather than its calls: what
    // it pulls out of `view/` is the list of pieces it is made of.
    const source = readFileSync(fileURLToPath(new URL('../src/view.ts', import.meta.url)), 'utf8')
    const imported = [...source.matchAll(/import \{([^}]*)\} from '\.\/view\//g)]
      .flatMap((found) => [...(found[1] ?? '').matchAll(/\brender\w+/g)].map((name) => name[0]))
      .sort()
    const named = REGIONS.map(
      (region) => `render${region[0]?.toUpperCase()}${region.slice(1)}`,
    ).sort()
    expect(
      imported,
      `view.ts composes these regions; test/bench.ts times ${named.join(', ')}. ` +
        'The toast and the panel are not regions and are deliberately not in the list — ' +
        "`test/bench.ts` says so, and a screen with a panel on it has a `draw` far dearer than its regions' sum.",
    ).toEqual(named)
  })

  it('has a figure for every region and every screen, at every size', () => {
    for (const size of SIZES) {
      const { timings, drew } = benchFrames(size, ROUNDS)
      // The floor: it really drew. A bench whose work was optimised away, or
      // whose scenarios list came back empty, reports beautiful quantiles over
      // nothing — so what was composed is counted and has to be there.
      expect(drew.rows, `${size.name} drew no rows`).toBeGreaterThan(SCENARIOS.length * size.height)
      expect(drew.hits, `${size.name} drew nothing clickable`).toBeGreaterThan(0)

      const spans = timings.spans()
      for (const region of REGIONS) {
        const span = spans[`region:${region}`]
        expect(span, `no figure for ${region} at ${size.name}`).toBeDefined()
        expect(span?.count).toBe(SCENARIOS.length * ROUNDS)
      }
      expect(spans.draw?.count).toBe(SCENARIOS.length * ROUNDS)
      for (const scenario of SCENARIOS)
        expect(spans[`screen:${scenario.name}`]?.count, scenario.name).toBe(ROUNDS)
    }
  })

  it('draws a whole screen at every size, not only the one its golden was written for', () => {
    // The goldens pin each screen at the width it was written for, and this is
    // the only thing that asks whether the same state composes at another one.
    // It is the bench's own precondition — a frame that came back ragged at
    // 260×60 would be timed as cheerfully as a whole one — and it is also the
    // first thing a change to the drawing breaks.
    for (const size of SIZES) {
      for (const scenario of SCENARIOS) {
        const drawn = draw(scenario.state, {
          ...scenario.frame,
          width: size.width,
          height: size.height,
        })
        expect(drawn.rows.length, `${scenario.name} at ${size.name}`).toBe(size.height)
        const widths = new Set(drawn.rows.map((row) => visibleWidth(row)))
        expect([...widths], `${scenario.name} at ${size.name}`).toEqual([size.width])
      }
    }
  })
})
