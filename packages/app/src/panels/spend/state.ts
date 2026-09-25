import { SPEND_BY, SPEND_WINDOWS, type SpendBy, type SpendWindow } from '../../spend.ts'
import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay } from '../outcome.ts'

// The Spend panel's own state: which window and which grouping its tabs are
// on. What the money was is `spend.ts`; the drawing is beside this in
// `view.ts`.

/** Where the money went, regrouped and re-windowed by its tabs. */
export interface SpendPanel {
  kind: 'spend'
  window: SpendWindow
  by: SpendBy
  /** Lines of the table scrolled past: the panel's place in the one scroll area. */
  scroll: number
  busy: false
}

export function spendPanel(): SpendPanel {
  return { kind: 'spend', window: 'today', by: 'agent', scroll: 0, busy: false }
}

/**
 * ← → move through the time windows, tab through the groupings, and the
 * arrows read down the table — which is the wheel's own move, said with a key.
 * A window or a grouping changed is a different table, so it starts at the top.
 */
export function spendKey(panel: SpendPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  if (key === 'left' || key === 'right') {
    return stay({
      ...panel,
      window: cycle(SPEND_WINDOWS, panel.window, key === 'left' ? -1 : 1),
      scroll: 0,
    })
  }
  if (key === 'tab' || key === 'shift+tab') {
    return stay({ ...panel, by: cycle(SPEND_BY, panel.by, key === 'tab' ? 1 : -1), scroll: 0 })
  }
  const by = pageBy(key)
  if (by !== null) return stay({ ...panel, scroll: Math.max(0, panel.scroll + by) })
  return stay(panel)
}

export function spendClick(panel: SpendPanel, control: string): PanelOutcome {
  if (control === 'close') return close
  const [kind, id] = control.split(':')
  if (kind === 'window' && SPEND_WINDOWS.some((w) => w.id === id)) {
    return stay({ ...panel, window: id as SpendWindow, scroll: 0 })
  }
  if (kind === 'by' && SPEND_BY.some((b) => b.id === id))
    return stay({ ...panel, by: id as SpendBy, scroll: 0 })
  return stay(panel)
}

function cycle<T extends string>(options: readonly { id: T }[], current: T, delta: number): T {
  const at = options.findIndex((option) => option.id === current)
  return options[(at + delta + options.length) % options.length]?.id ?? current
}
