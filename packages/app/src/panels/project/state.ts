import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// Opening a project: where you are, where you have been, and what a key or a
// click does to a folder browser. The drawing is beside this in `view.ts`.

/**
 * Opening a project: a folder browser that starts in your home folder, with
 * the projects you opened lately beside it, and git for a folder without it.
 */
export interface OpenProjectPanel {
  kind: 'open-project'
  /** The folder being looked in, as an absolute path. */
  dir: string
  /** Folders looked in before this one, and after it once you have gone back. */
  back: string[]
  forward: string[]
  /** Narrows what is listed; starting with `~`, `/` or `.` it goes to that path instead. */
  query: string
  /**
   * Which row is chosen — this folder, the folders in it, then the recent
   * projects — or -1 before anything is. Nothing is chosen on arriving in a
   * folder, so looking around never offers to open the place you walked through.
   */
  index: number
  field: 'query' | 'init' | 'name'
  /** The name you typed, or null to use the folder's. */
  name: string | null
  /** Make a folder without git into a repository. */
  init: boolean
  busy: boolean
  error: string | null
}

/** A row in the Open project list, as the app found it. */
export interface OpenRow {
  /** A project opened before, the folder being looked in, or a folder inside it. */
  kind: 'recent' | 'here' | 'folder'
  name: string
  path: string
  git: boolean
}

export function openProjectPanel(dir: string, query = ''): OpenProjectPanel {
  return {
    kind: 'open-project',
    dir,
    back: [],
    forward: [],
    query,
    index: -1,
    field: 'query',
    name: null,
    init: true,
    busy: false,
    error: null,
  }
}

/** Look in another folder, remembering this one for back. */
function goTo(panel: OpenProjectPanel, dir: string): OpenProjectPanel {
  if (dir === panel.dir && panel.query === '') return panel
  return {
    ...panel,
    back: [...panel.back, panel.dir],
    forward: [],
    dir,
    query: '',
    index: -1,
    name: null,
    error: null,
    field: 'query',
  }
}

/** The folder above, or the folder itself at the top of the disk. */
function parentOf(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '')
  const at = trimmed.lastIndexOf('/')
  return at <= 0 ? '/' : trimmed.slice(0, at)
}

/** Back, forward and up: what a folder browser's own buttons do. */
function navigate(panel: OpenProjectPanel, where: string): OpenProjectPanel {
  if (where === 'back') {
    const previous = panel.back.at(-1)
    if (previous === undefined) return panel
    return {
      ...panel,
      back: panel.back.slice(0, -1),
      forward: [panel.dir, ...panel.forward],
      dir: previous,
      query: '',
      index: -1,
      name: null,
      error: null,
    }
  }
  if (where === 'forward') {
    const next = panel.forward[0]
    if (next === undefined) return panel
    return {
      ...panel,
      back: [...panel.back, panel.dir],
      forward: panel.forward.slice(1),
      dir: next,
      query: '',
      index: -1,
      name: null,
      error: null,
    }
  }
  if (where === 'up') return goTo(panel, parentOf(panel.dir))
  return panel
}

export function openKey(
  panel: OpenProjectPanel,
  key: string | undefined,
  data: string,
  rows: readonly OpenRow[],
): PanelOutcome {
  if (panel.busy) return key === 'escape' ? close : stay(panel)
  if (key === 'escape') return close
  const chosen = rows[panel.index]
  if (key === 'enter')
    return chosen
      ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: 'open' }
      : stay(panel)
  if (key === 'tab' || key === 'shift+tab') {
    const order: OpenProjectPanel['field'][] =
      chosen && !chosen.git ? ['query', 'init', 'name'] : ['query', 'name']
    const at = Math.max(0, order.indexOf(panel.field))
    const next = order[(at + (key === 'tab' ? 1 : -1) + order.length) % order.length] ?? 'query'
    return stay({ ...panel, field: next })
  }
  if (panel.field === 'init') {
    return key === 'space' ? stay({ ...panel, init: !panel.init }) : stay(panel)
  }
  if (panel.field === 'name') {
    const name = panel.name ?? (chosen ? nameFrom(chosen.path) : '')
    if (key === 'backspace') return stay({ ...panel, name: [...name].slice(0, -1).join('') })
    const text = typed(data, key)
    return text ? stay({ ...panel, name: name + text.toLowerCase() }) : stay(panel)
  }
  if (key === 'down' || key === 'up') {
    if (rows.length === 0) return stay(panel)
    const from = panel.index < 0 ? (key === 'down' ? -1 : 0) : panel.index
    const index = (from + (key === 'down' ? 1 : -1) + rows.length) % rows.length
    return stay({ ...panel, index, name: null })
  }
  // → goes into the chosen folder, ← to the one above: the arrows a list of
  // folders has everywhere else.
  if (key === 'right' && (chosen?.kind === 'folder' || chosen?.kind === 'recent')) {
    return stay(goTo(panel, chosen.path))
  }
  if (key === 'left' && panel.query === '') return stay(navigate(panel, 'up'))
  if (key === 'backspace' && panel.query === '') return stay(navigate(panel, 'up'))
  if (key === 'backspace')
    return stay({ ...panel, query: [...panel.query].slice(0, -1).join(''), index: -1, name: null })
  const text = typed(data, key)
  return text
    ? stay({ ...panel, query: panel.query + text, index: -1, name: null, error: null })
    : stay(panel)
}

export function openClick(
  panel: OpenProjectPanel,
  control: string,
  rows: readonly OpenRow[],
): PanelOutcome {
  if (panel.busy) return stay(panel)
  const [verb, ...rest] = control.split(':')
  const arg = rest.join(':')
  switch (verb) {
    case 'cancel':
      return close
    case 'open':
      return rows[panel.index]
        ? { panel: { ...panel, busy: true, error: null }, submit: true, choice: 'open' }
        : stay(panel)
    case 'back':
    case 'forward':
    case 'up':
      return stay(navigate(panel, verb))
    case 'go':
      return stay(goTo(panel, arg))
    case 'row': {
      const index = Number(arg)
      const row = rows[index]
      // A second click on a folder goes into it, as it would anywhere else.
      if (row?.kind === 'folder' && index === panel.index) return stay(goTo(panel, row.path))
      return stay({ ...panel, index: Math.max(-1, index), field: 'query', name: null })
    }
    case 'into': {
      const row = rows[Number(arg)]
      return row ? stay(goTo(panel, row.path)) : stay(panel)
    }
    case 'init':
      return stay({ ...panel, init: !panel.init, field: 'init' })
    case 'name':
      return stay({ ...panel, field: 'name' })
    case 'query':
      return stay({ ...panel, field: 'query' })
    default:
      return stay(panel)
  }
}

/** A project name from a folder path: what `projects.<name>` accepts. */
export function nameFrom(path: string): string {
  const base = path.replace(/\/+$/, '').split('/').at(-1) ?? ''
  return (
    base
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'project'
  )
}

/** A row of the Open project list, with what the window found out about it. */
export interface OpenRowView {
  row: OpenRow
  branch: string | null
  tasks: number
  /** When it was last opened, said the way people say it. */
  when: string | null
}
