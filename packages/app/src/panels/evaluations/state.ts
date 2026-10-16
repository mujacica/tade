import { EVAL_TABS, type EvalTab } from '../../evaluations.ts'
import { SPEND_WINDOWS, type SpendWindow } from '../../spend.ts'
import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// The Evaluations panel's own state: which tab and which range it is on. What
// the work came to is core's (`evaluationsFrom`); the drawing is beside this in
// `view.ts`. The keys are the Spend page's, because a page with tabs and a
// range is the same thing twice and nobody should learn it in two places: tab
// through the tabs, ← → through the ranges, the arrows down the table.

export interface EvaluationsPanel {
  kind: 'evaluations'
  tab: EvalTab
  window: SpendWindow
  /** Lines of the table scrolled past. */
  scroll: number
  busy: false
}

/**
 * All time by default, unlike Spend's today: a scorecard is counts, and a day
 * of them is too few to say anything — which is the rule the page draws by.
 */
export function evaluationsPanel(tab: EvalTab = 'harness'): EvaluationsPanel {
  return { kind: 'evaluations', tab, window: 'all', scroll: 0, busy: false }
}

export function evaluationsKey(panel: EvaluationsPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  if (key === 'left' || key === 'right') {
    const window = cycle(SPEND_WINDOWS, panel.window, key === 'left' ? -1 : 1)
    return stay({ ...panel, window, scroll: 0 })
  }
  if (key === 'tab' || key === 'shift+tab') {
    const tab = cycle(EVAL_TABS, panel.tab, key === 'tab' ? 1 : -1)
    return stay({ ...panel, tab, scroll: 0 })
  }
  const by = pageBy(key)
  if (by !== null) return stay({ ...panel, scroll: Math.max(0, panel.scroll + by) })
  return stay(panel)
}

export function evaluationsClick(panel: EvaluationsPanel, control: string): PanelOutcome {
  if (control === 'close') return close
  const [kind, id] = control.split(':')
  if (kind === 'window' && SPEND_WINDOWS.some((one) => one.id === id)) {
    return stay({ ...panel, window: id as SpendWindow, scroll: 0 })
  }
  if (kind === 'tab' && EVAL_TABS.some((one) => one.id === id)) {
    return stay({ ...panel, tab: id as EvalTab, scroll: 0 })
  }
  return stay(panel)
}

function cycle<T extends string>(options: readonly { id: T }[], current: T, delta: number): T {
  const at = options.findIndex((option) => option.id === current)
  return options[(at + delta + options.length) % options.length]?.id ?? current
}
