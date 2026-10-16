import { EVALUATION_EVENTS, pricesFrom, spendFrom, type TadeEvent } from '@tade/core'
import { type EvaluationsOut, evaluationsFor, type Reach } from '@tade/web'
import { type EvalsView, evalsView } from '../evaluations.ts'
import type { Frame } from '../frame.ts'
import { evaluationsPanel } from '../panels/evaluations/state.ts'
import type { SpendWindow } from '../spend.ts'
import type { Actions, Subject, Wiring } from './context.ts'
import { heldFindings } from './findings.ts'
import { Kept } from './kept.ts'
import { racesHeld, usdByTask } from './races.ts'

// The Evaluations panel, and the scorecards the away view reads too.
//
// A view over folds and nothing remembered but the folds themselves. The
// scorecards need the **whole** journal of the events they read — `Live.events`
// is a window of the newest five hundred lines, and a scorecard over that is a
// scorecard of this morning — so the lines are read once with the journal's
// own reader and held, and asked again on the beat no oftener than
// `JOURNAL_MS`, and only while something is looking: the panel open, or a
// device asking for the away view's collections. Nothing reads it for nobody.
//
// Merges are what status's last look said (a review's state is the forge's to
// keep, so it is asked rather than journalled); what each task cost is the
// window's own usage fold; what the judges raised is `heldFindings`, the same
// answer the landing desk draws.

/** How often the journal's lines are read again while somebody is looking. */
export const JOURNAL_MS = 30_000

interface Held {
  lines: readonly TadeEvent[] | null
  at: number
  asking: boolean
  /**
   * The folds, one per range and set of projects — the panel's, and each
   * device's own — each kept until something it was made of moved.
   */
  folds: Map<string, Kept<EvalsView>>
  spent: Kept<ReturnType<typeof spendFrom>['byTask']>
}

const held = new WeakMap<object, Held>()

/**
 * The scorecards over one range, or null until the journal has been read: a
 * page of noughts before then would be a page of facts nobody has. Over the
 * projects named, where a device reads only some; every project where null.
 */
export function evaluationsNow(
  wire: Wiring,
  window: SpendWindow,
  projects: ReadonlySet<string> | null = null,
): EvalsView | null {
  const live = wire.live
  if (!live) return null
  const client = wire.opts.client
  let one = held.get(client)
  if (!one) {
    one = {
      lines: null,
      at: Number.NEGATIVE_INFINITY,
      asking: false,
      folds: new Map(),
      spent: new Kept(),
    }
    held.set(client, one)
  }
  const kept = one
  if (!kept.asking && wire.now() - kept.at >= JOURNAL_MS) {
    kept.asking = true
    kept.at = wire.now()
    void client
      .events({ types: [...EVALUATION_EVENTS] })
      .then((lines) => {
        kept.lines = lines
        wire.draw()
      })
      // A journal that could not be read keeps what was read before, and says so.
      .catch((err: unknown) => {
        wire.note(err)
        wire.draw()
      })
      .finally(() => {
        kept.asking = false
      })
  }
  const lines = kept.lines
  if (lines === null) return null
  const findings = heldFindings(wire)
  const spent = kept.spent.of([live.spending.size], () => {
    return spendFrom(live.spending.events, {
      since: 0,
      prices: pricesFrom(wire.opts.config.prices),
    }).byTask
  })
  const merged = live.tasks.filter((task) => task.state === 'merged').map((task) => task.task)
  const which = `${window}|${projects === null ? '*' : [...projects].sort().join(',')}`
  const fold = kept.folds.get(which) ?? new Kept<EvalsView>()
  kept.folds.set(which, fold)
  return fold.of([lines, findings, spent, merged.join('\n')], () =>
    evalsView(lines, {
      window,
      now: wire.now(),
      openedAt: wire.openedAt,
      spent,
      findings,
      merged: new Set(merged),
      projects,
    }),
  )
}

/**
 * The away view's answer for one device: folded over the projects it reads,
 * every range there is, and what its grants withhold taken out (`evaluationsFor`).
 */
export function evaluationsAnswer(wire: Wiring, reach: Reach): EvaluationsOut {
  return evaluationsFor(
    reach,
    (projects) => evaluationsNow(wire, 'all', projects)?.evaluations ?? null,
    // The races, over the projects this device reads and never filtered after:
    // a race is one project's, so leaving the others out is the whole fold.
    (projects) =>
      racesHeld(wire, usdByTask(wire)).filter((one) => !projects || projects.has(one.project)),
  )
}

export class Evaluations implements Subject {
  private readonly wire: Wiring

  constructor(wire: Wiring) {
    this.wire = wire
  }

  /** The page, only while it is open: nothing is read or folded for a closed one. */
  facts(): Partial<Frame> {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'evaluations') return {}
    return { evaluations: evaluationsNow(this.wire, panel.window) }
  }

  actions(): Actions {
    const open = () => {
      this.wire.put({ ...this.wire.state, panel: evaluationsPanel() })
      this.wire.draw()
    }
    return { evaluations: open, '/evals': open }
  }
}
