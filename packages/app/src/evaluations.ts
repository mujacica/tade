import {
  EVAL_BY,
  type EvalBy,
  type EvalFinding,
  type Evaluations,
  evaluationsFrom,
  type Spend,
  type TadeEvent,
} from '@tade/core'
import { type SpendWindow, sinceOf } from './spend.ts'

// What the Evaluations panel shows, as data: the scorecards and the judge's
// own calibration, over the range the panel is on.
//
// One surface for everything that is measured about how work goes, which is
// what the person asked for: the harnesses, the models, the personas and the
// templates the work ran on, and the judge that read it. The fold is core's
// (`evaluationsFrom`); this decides what a tab is and what "7 days" means,
// which is the Spend page's answer (`sinceOf`) so the two pages agree.
//
// **Room for what comes next is a tab, not a page.** Replaying landed work on a
// candidate model (the replay-evals task) lands its results here as one more
// entry in `EVAL_TABS`, beside the judge, so a person comparing models reads
// the scorecards and the replays in one place. A tab for it is added when it
// has something to draw — never before, because a tab that says *not built* is
// advertising.

/** A tab of the page: one way of grouping the scorecards, or the judge itself. */
export type EvalTab = EvalBy | 'judge'

export const EVAL_TABS: readonly { id: EvalTab; label: string }[] = [
  ...EVAL_BY,
  { id: 'judge', label: 'Judge' },
]

/** The page as folded: the scorecards over one range. */
export interface EvalsView {
  evaluations: Evaluations
  window: SpendWindow
}

/** Everything the page is folded from beside the journal, each asked again rather than kept. */
export interface EvalsAsked {
  window: SpendWindow
  now: number
  /** The window's own moment, which "This window" means everywhere. */
  openedAt: number
  /** Each task's spend over every run. */
  spent: Readonly<Record<string, Spend>>
  /** What the judges last said, or null where none reads anything here. */
  findings: readonly EvalFinding[] | null
  /** What status's last look said was merged. */
  merged: ReadonlySet<string>
  /** Only work in these projects, for a device that reads only some; every project where null. */
  projects?: ReadonlySet<string> | null
}

export function evalsView(journal: readonly TadeEvent[], asked: EvalsAsked): EvalsView {
  return {
    window: asked.window,
    evaluations: evaluationsFrom(journal, {
      since: sinceOf(asked.window, asked.now, asked.openedAt),
      spent: asked.spent,
      findings: asked.findings,
      merged: asked.merged,
      projects: asked.projects ?? null,
    }),
  }
}
