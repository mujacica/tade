import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { visibleWidth } from '@earendil-works/pi-tui'
import { describe, expect, it } from 'vitest'
import { draw } from '../src/view.ts'
import { benchFrames, benchSteady, REGIONS, SIZES } from './bench.ts'
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

/**
 * Rounds here: two, because the property is that every round is counted — one
 * would hold just as well with the rounds loop ignored. How many samples make
 * a p99 is the bench script's question (`pnpm bench`), not this file's.
 */
const ROUNDS = 2

/**
 * Frames of each screen in the steady run here: the first drawn whole, and two
 * after it that may keep what did not move. Enough for every region to be kept
 * somewhere and for drawn plus kept to add up; `STEADY_FRAMES` is the bench's
 * own run, a figure about the machine, and this file is about the instrument.
 */
const FEW = 3

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

  it('has a figure for a run of frames both ways, and kept something in it', () => {
    // The steady run is the one figure about keeping, so the way it lies is a
    // run where nothing was kept: two equal numbers that look like keeping
    // bought nothing, when it was never asked. The smallest size, once: what
    // is held here is the instrument, not the machine.
    const size = SIZES[0]
    const { timings, tally } = benchSteady(size, 1, SCENARIOS, FEW)
    const spans = timings.spans()
    const frames = SCENARIOS.length * FEW
    expect(spans['steady:drawn']?.count).toBe(frames)
    expect(spans['steady:kept']?.count).toBe(frames)
    for (const region of REGIONS)
      expect(tally[region].kept, `${region} was never kept`).toBeGreaterThan(0)
    // And every frame of it was a frame of one region or the other, never neither.
    for (const region of REGIONS)
      expect(tally[region].drawn + tally[region].kept, region).toBe(frames)
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
