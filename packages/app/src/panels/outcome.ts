import type { Panel } from '../panels.ts'

// What a press does to a panel, and the two answers every panel gives.
//
// Here rather than in `panels.ts` so that a panel's own `state.ts` can reach
// them without the dispatch reaching back: `panels.ts` imports each panel, each
// panel imports this, and the arrows only ever point down.

/** What a keystroke or click did: the panel as it now is, and whether to run it. */
export interface PanelOutcome {
  panel: Panel | null
  submit: boolean
  /** For a menu: which item was chosen. */
  choice?: string
}

export const stay = (panel: Panel): PanelOutcome => ({ panel, submit: false })
export const close: PanelOutcome = { panel: null, submit: false }

/** A control character: never something a person meant to type. */
export function control(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 32 || code === 127
}

export function typed(data: string, key: string | undefined): string {
  const text = key === 'space' ? ' ' : data.startsWith('\x1b') ? '' : data
  return text && ![...text].some(control) ? text : ''
}
