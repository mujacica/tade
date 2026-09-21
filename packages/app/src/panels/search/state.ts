import { completed, SCOPES, type SearchEntry } from '../../search.ts'
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// Search: what `ctrl+k` opens, and what a key or a click does to it.
//
// The ranking itself is `search.ts` — this is only the box you type in and
// which row the keyboard is on.

/** Search: agents, files in every worktree, lines inside them, actions and settings. */
export interface SearchPanel {
  kind: 'search'
  query: string
  /** Which result the keyboard is on. */
  index: number
  busy: false
}

export function searchPanel(query = ''): SearchPanel {
  return { kind: 'search', query, index: 0, busy: false }
}

export function searchClick(
  panel: SearchPanel,
  control: string,
  entries: readonly SearchEntry[],
): PanelOutcome {
  const [verb, arg] = control.split(':')
  if (verb === 'entry') {
    const entry = entries[Number(arg)]
    return entry ? { panel, submit: true, choice: entry.id } : stay(panel)
  }
  if (verb === 'scope') {
    // A scope chip replaces the one typed, keeping the words.
    const bare = SCOPES.some((one) => panel.query.startsWith(one.prefix))
      ? panel.query.slice(1)
      : panel.query
    const prefix = SCOPES.find((one) => one.prefix === control.slice('scope:'.length))?.prefix ?? ''
    return stay({ ...panel, query: `${prefix}${bare}`, index: 0 })
  }
  return stay(panel)
}

export function searchKey(
  panel: SearchPanel,
  key: string | undefined,
  data: string,
  entries: readonly SearchEntry[],
): PanelOutcome {
  if (key === 'escape') return close
  if (key === 'down' || key === 'up') {
    const count = Math.max(1, entries.length)
    const index = (panel.index + (key === 'down' ? 1 : -1) + count) % count
    return stay({ ...panel, index })
  }
  // Tab completes, as it does in a shell: the chosen result's name into the box.
  if (key === 'tab') {
    const query = completed(panel.query, entries[panel.index])
    return stay({ ...panel, query, index: 0 })
  }
  if (key === 'enter') {
    const entry = entries[panel.index]
    return entry ? { panel, submit: true, choice: entry.id } : stay(panel)
  }
  if (key === 'backspace')
    return stay({ ...panel, query: [...panel.query].slice(0, -1).join(''), index: 0 })
  if (key === 'ctrl+u') return stay({ ...panel, query: '', index: 0 })
  const text = typed(data, key)
  return text ? stay({ ...panel, query: panel.query + text, index: 0 }) : stay(panel)
}
