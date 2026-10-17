import { resolveLayout } from '../src/layout.ts'
import { conversing } from '../src/model.ts'
import { LOOK_FLOOR_MS } from '../src/pace.ts'
import { PLAIN } from '../src/skin.ts'
import { Timings } from '../src/timing.ts'
import type { Drawn } from '../src/ui.ts'
import { renderFoot } from '../src/view/foot.ts'
import { LastFrame, REGIONS, type RegionName, type Tally } from '../src/view/last-frame.ts'
import { renderMain } from '../src/view/main.ts'
import { renderSidebar } from '../src/view/sidebar.ts'
import { renderStrip } from '../src/view/strip.ts'
import { renderTop } from '../src/view/top.ts'
import { draw } from '../src/view.ts'
import { SCENARIOS, type Scenario } from './screens/scenarios.ts'

// What a frame costs to compose, over the screens that already exist.
//
// The cheapest honest instrument in the repository: `draw(state, frame)` is
// pure, and `screens/scenarios.ts` is 141 real `(state, frame)` pairs that the
// goldens already hold to the window Tade actually has. So the cost of a frame
// can be measured with no terminal, no agent, no git and no clock beyond the
// one measuring — which makes it a number about this code rather than about
// the machine's mood, and lets it be run while the suite is not.
//
// Two things it answers that one total cannot:
//
// **Per region.** `draw` composes five of them and nothing is cached between
// frames, so "a frame costs 0.9ms" is not actionable and "the sidebar is 0.4ms
// of it" is. The five are drawn again here with the arguments `draw` gives
// them, which does mean a round draws each region twice. That is what a bench
// is for, and `frame-cost.probe.test.ts` holds the one thing the duplication
// could get wrong: that the five named here are all five the drawing has.
//
// **Per screen.** A panel over a full window is a different frame from a
// sidebar with two agents in it, and the dear ones are where to look first.
//
// The five do not add up to the frame, and are not meant to. `draw` also lays
// the two body regions into shared rows with `fit` twice a row, floats a toast
// and draws a panel — so on a screen with a panel open most of the frame is in
// `drawPanel`, which takes forty-five fields of its own and is read here as the
// difference between `draw` and the regions rather than reproduced.
//
// What is *not* here is per subject. A subject is a live wiring over a
// workbench, a journal and twenty-two collaborators — a scenario has none, by
// design — so `frameOf`'s fold is measured where it really happens, by the
// probe in `wire/frame.ts`, and read off a running window by
// `scripts/bench.ts`. This file is the half that needs nothing.
//
// Three sizes rather than one, because every cost here is a function of the
// width: 260×60 is eight times the cells of 80×24, and which of the five
// regions grows with the window is most of the point.

/** The windows every case is measured at: a laptop pane, a full screen, a wide one. */
export const SIZES = [
  { name: '80x24', width: 80, height: 24 },
  { name: '160x45', width: 160, height: 45 },
  { name: '260x60', width: 260, height: 60 },
] as const

export type Size = (typeof SIZES)[number]

/** A size by its name, for a `--size` on the command line. */
export function sizeNamed(name: string): Size | null {
  return SIZES.find((size) => size.name === name) ?? null
}

/**
 * The five regions `draw` composes, in the order it composes them — the list
 * the drawing keeps them by, so the bench and the keeping are about the same
 * five. Checked against `view.ts` itself: a sixth region added to the drawing
 * and not to this list is a region nobody is measuring, which is the one way a
 * bench stops being true without anything failing.
 */
export { REGIONS }

export type Region = RegionName

/**
 * What a round composed, rows and clickable boxes.
 *
 * A floor under the measurement rather than an accounting of a frame: the
 * regions are drawn as well as the whole window, so the same rows are in here
 * twice. What it is for is the failure a timing bench cannot otherwise notice
 * — that it timed a function which quietly drew nothing at all.
 */
export interface Drew {
  rows: number
  hits: number
}

/** How long one piece took to compose, counting what it composed. */
function drewIn(work: () => Drawn, into: Drew): number {
  const at = performance.now()
  const drawn = work()
  const ms = performance.now() - at
  into.rows += drawn.rows.length
  into.hits += drawn.hits.length
  return ms
}

/**
 * Draw every screen `rounds` times at `size`, timing the whole frame, each of
 * the five regions, and each screen.
 *
 * Every whole-frame measurement is filed twice — once under `draw` and once
 * under the screen it was — so one pass answers both tables. They are the same
 * samples: `Timings.sample` is the door that takes a measurement already made,
 * rather than reading the clock a second time for the second name.
 */
export function benchFrames(
  size: Size,
  rounds: number,
  scenarios: readonly Scenario[] = SCENARIOS,
): { timings: Timings; drew: Drew } {
  const timings = new Timings(true)
  const drew: Drew = { rows: 0, hits: 0 }
  for (let round = 0; round < rounds; round++) {
    for (const scenario of scenarios) {
      const state = scenario.state
      // The scenario's own state and facts, at the size being measured: the
      // goldens pin each screen at the width it was written for, and what a
      // frame costs at 80 columns says nothing about the same frame at 260.
      const frame = { ...scenario.frame, width: size.width, height: size.height }
      const skin = frame.skin ?? PLAIN
      const pointer = { hover: state.hover, pressed: state.pressed }
      const { sidebarWidth, stripHeight, mainWidth, bodyHeight } = resolveLayout(
        { ...frame.layout, ...state.sizes, bottom: state.bottomMode, grow: conversing(state) },
        frame,
      )
      // The clamped width `draw` composes across, not the one asked for.
      const width = sidebarWidth + mainWidth + 1
      const each: Record<Region, number> = {
        top: drewIn(() => renderTop(state, frame, width, skin, pointer), drew),
        sidebar: drewIn(
          () => renderSidebar(state, frame, sidebarWidth, bodyHeight, skin, pointer),
          drew,
        ),
        main: drewIn(() => renderMain(state, frame, mainWidth, bodyHeight, skin, pointer), drew),
        strip: drewIn(() => renderStrip(state, frame, width, stripHeight, skin, pointer), drew),
        foot: drewIn(() => renderFoot(state, frame, width, skin, pointer), drew),
      }
      const whole = drewIn(() => draw(state, frame), drew)
      timings.sample('draw', whole)
      timings.sample(`screen:${scenario.name}`, whole)
      for (const region of REGIONS) timings.sample(`region:${region}`, each[region])
    }
  }
  return { timings, drew }
}

/**
 * How many frames in a row each screen is drawn for, in the steady bench: a
 * second of a lane printing at the look's floor.
 */
export const STEADY_FRAMES = 30

/**
 * What a frame costs when it is one of a run — the case the window is in
 * nearly all the time it is drawing at all.
 *
 * Every frame above is a different screen from the one before, which is the
 * right question for "what does this screen cost" and the wrong one for "what
 * does the window spend": it draws the same screen again and again with one
 * thing moving. A lane printing in front of you is the commonest and the
 * dearest of those — a frame every `LOOK_FLOOR_MS` — so that is the run: each
 * screen drawn `STEADY_FRAMES` times with its pane one line further on and its
 * clock one look later, once drawing every region from nothing and once with
 * the regions of the last frame kept (`view/last-frame.ts`).
 *
 * Filed under `steady:drawn` and `steady:kept`, the same frames both ways, and
 * the tallies of what was drawn and what kept beside them — a figure for
 * keeping with nothing kept would be a figure about nothing. A run is thirty
 * frames of every screen, so a round is already four thousand frames a way:
 * it wants far fewer rounds than the per-screen table does.
 */
export function benchSteady(
  size: Size,
  rounds: number,
  scenarios: readonly Scenario[] = SCENARIOS,
  frames: number = STEADY_FRAMES,
): { timings: Timings; tally: Record<Region, Tally> } {
  const timings = new Timings(true)
  const tally = Object.fromEntries(
    REGIONS.map((region) => [region, { drawn: 0, kept: 0 }]),
  ) as Record<Region, Tally>
  for (let round = 0; round < rounds; round++) {
    for (const scenario of scenarios) {
      const last = new LastFrame()
      const base = { ...scenario.frame, width: size.width, height: size.height }
      for (let at = 0; at < frames; at++) {
        const frame = {
          ...base,
          now: (base.now ?? 0) + at * LOOK_FLOOR_MS,
          screen: `${base.screen}\nprinting ${at}`,
        }
        let start = performance.now()
        draw(scenario.state, frame)
        const drawn = performance.now() - start
        start = performance.now()
        draw(scenario.state, frame, last)
        const kept = performance.now() - start
        timings.sample('steady:drawn', drawn)
        timings.sample('steady:kept', kept)
        // A panel is drawn afresh in every frame either way — it is not one
        // of the five — so the screens without one are where keeping is the
        // whole of the difference, and are filed again on their own.
        if (scenario.state.panel) continue
        timings.sample('steady:drawn, no panel', drawn)
        timings.sample('steady:kept, no panel', kept)
      }
      for (const [region, counted] of Object.entries(last.counts())) {
        const into = tally[region as Region]
        into.drawn += counted.drawn
        into.kept += counted.kept
      }
    }
  }
  return { timings, tally }
}
