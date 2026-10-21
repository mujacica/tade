import type { Workspace } from '@tade/core'
import { type RunIn, rollup } from '@tade/web'
import { runsIn } from '../away-factory.ts'
import type { Frame } from '../frame.ts'
import { showPlans } from '../model.ts'
import type { PlanRow } from '../plans.ts'
import type { Actions, Subject, Wiring } from './context.ts'
import { type RunFrom, runTasks, startsOf } from './web-beat.ts'

// The Plans screen's facts: every plan, folded out of what the window already
// holds — and the actions that put the screen in front of you.
//
// **The same folds the away view's Plans page reads**, and nothing new kept:
// `runsIn` over `runTasks` (which tasks name an effort, their `start.after`,
// the journal's `finished` and `run_started`, the last look at the checks and
// the day's spend), with the provenance the inbox already folded (`RunFrom`),
// then the rollups `runRow` makes. So the window and a phone are one answer to
// "which plan wants me".
//
// **Asked only while somebody looks**: the screen being open, or search. The
// fold reads the whole journal's `run_started` lines, so it is kept against the
// look it was made from (`Live.revision` and the world) and made again only
// when either moved — never per frame, and the array handed to the frame is
// the same one until then, which is what lets the last frame keep a region.

export interface PlansDeps {
  /** Which request each effort came from, and what it was stamped from: the inbox's fold. */
  from(): ReadonlyMap<string, RunFrom>
}

export class Plans implements Subject {
  private readonly wire: Wiring
  private readonly deps: PlansDeps
  private kept: {
    revision: number
    world: Workspace
    from: ReadonlyMap<string, RunFrom>
    rows: readonly PlanRow[]
  } | null = null

  constructor(wire: Wiring, deps: PlansDeps) {
    this.wire = wire
    this.deps = deps
  }

  facts(): Partial<Frame> {
    if (this.wire.state.plans === null) return {}
    return { plans: this.rows() }
  }

  /** Every plan as of the last look, or null before there has been one. */
  rows(): readonly PlanRow[] | null {
    const live = this.wire.live
    const world = live?.world ?? null
    if (!live || world === null) return null
    const from = this.deps.from()
    const kept = this.kept
    if (
      kept !== null &&
      kept.revision === live.revision &&
      kept.world === world &&
      kept.from === from
    ) {
      return kept.rows
    }
    const facts = live.queueFacts()
    const runs = runsIn(
      runTasks(world, {
        finished: new Set(facts.finished.keys()),
        starts: startsOf(facts.events),
        checks: live,
        spend: live.spendToday() ?? { byTask: {} },
      }),
      from,
    )
    const rows = planRowsOf(runs)
    this.kept = { revision: live.revision, world, from, rows }
    return rows
  }

  actions(): Actions {
    return {
      // Every plan; `/plans <name>` opens that one, as the search row does.
      plans: (name) => this.show(name.trim() === '' ? null : name.trim()),
      '/plans': (name) => this.show(name.trim() === '' ? null : name.trim()),
      'plan:': (name) => this.show(name),
    }
  }

  private show(effort: string | null): void {
    this.wire.put(showPlans(this.wire.state, effort))
    this.wire.draw()
  }
}

/**
 * The plans as the screen reads them: each run with the rollups `runRow` makes
 * for a device that may read everything — how many steps finished, the checks
 * with `unknown` beating `pass` — and its cost, null where no step has a
 * figure yet rather than a nought nobody recorded.
 */
export function planRowsOf(runs: readonly RunIn[]): PlanRow[] {
  return runs.map((run): PlanRow => {
    const usd = run.steps.reduce<number | null>(
      (total, step) => (step.usd === null ? total : (total ?? 0) + step.usd),
      null,
    )
    return {
      run: run.run,
      projects: run.projects,
      steps: run.steps,
      finished: run.steps.filter((step) => step.finished).length,
      total: run.steps.length,
      from: run.from,
      stamp: run.stamp,
      retries: run.retries,
      // **`unknown` beats `pass`**: a check nobody ran is not one that passed.
      checks: rollup(run.steps),
      usd,
    }
  })
}
