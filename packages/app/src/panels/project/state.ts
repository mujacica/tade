import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// Opening a project: where you are, where you have been, and what a key or a
// click does to one list of places to work. The drawing is beside this in
// `view.ts`.

/**
 * Opening a project: one list — the projects you opened lately, the folder
 * you are looking in and the folders in it — a field to narrow it or to type
 * a path, and git for a folder that has none.
 *
 * One list and one index, because two columns with one index between them is
 * what made the down key leave the column it was in. One `scroll` too: it is
 * the window's own scroll area (`panel`), so the wheel, a drag on the bar and
 * the arrow keys all land through the same move.
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
   * Which row is chosen, or -1 before any is. Nothing is chosen on arriving in
   * a folder, so looking around never offers to open the place you walked
   * through — and never creates one either.
   */
  index: number
  /** Lines above the first one drawn: the panel's place in the one scroll area. */
  scroll: number
  /**
   * Whether the list follows the row the keyboard is on. It does while you
   * walk it, and stops the moment you scroll it yourself: a list that jumps
   * back to the chosen row every time you read past it is one nobody can read.
   */
  following: boolean
  field: 'query' | 'init' | 'name'
  /** The name you typed, or null to use the folder's. */
  name: string | null
  /** Make a folder without git into a repository. */
  init: boolean
  busy: boolean
  error: string | null
}

/**
 * A row in the Open project list, as the app found it.
 *
 * `new` is a path that was typed and is not there: the offer to make it. It
 * is a row like any other so that choosing it, naming it and opening it are
 * the acts they already were — a folder you make and a folder you found reach
 * the same git and the same `projects.<name>`.
 */
export interface OpenRow {
  kind: 'recent' | 'here' | 'folder' | 'new'
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
    scroll: 0,
    following: true,
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
    scroll: 0,
    following: true,
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
      scroll: 0,
      following: true,
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
      scroll: 0,
      following: true,
      name: null,
      error: null,
    }
  }
  if (where === 'up') return goTo(panel, parentOf(panel.dir))
  return panel
}

/** The longest run of letters two names start with. */
function shared(a: string, b: string): string {
  const to = Math.min(a.length, b.length)
  let n = 0
  while (n < to && a[n]?.toLowerCase() === b[n]?.toLowerCase()) n++
  return a.slice(0, n)
}

/**
 * The query tab would leave behind, or null where there is nothing to add.
 *
 * Completion is only ever about a typed path — a name being matched against
 * the list is not a prefix of anything — so it is the last segment that is
 * completed, and it is replaced rather than appended to: `~/src/Pay` against
 * `payments/` means `~/src/payments`, in the disk's own spelling, not a path
 * with a capital in the middle that nothing will open.
 *
 * Pure, and derived from the rows the app already found: the panel keeps no
 * list of its own to fall out of date.
 */
export function completedQuery(panel: OpenProjectPanel, rows: readonly OpenRow[]): string | null {
  const at = panel.query.lastIndexOf('/')
  if (at < 0) return null
  const tail = panel.query.slice(at + 1).toLowerCase()
  // Narrowed here as well as by whoever listed the folders: a rule that only
  // holds while its caller filtered first is a rule that breaks the day
  // somebody hands it the whole list.
  const names = rows
    .filter((row) => row.kind === 'folder' && row.name.toLowerCase().startsWith(tail))
    .map((row) => row.name)
  const first = names[0]
  if (first === undefined) return null
  const whole = names.reduce(shared, first)
  if (whole.length <= tail.length) return null
  return `${panel.query.slice(0, at + 1)}${whole}`
}

/** Where the arrows put the choice: one row, and never off either end. */
function moved(key: string, index: number, count: number): number {
  if (count === 0) return -1
  if (key === 'home') return 0
  if (key === 'end') return count - 1
  // Wrapping is what made a flick teleport: the wheel used to press this key,
  // and the row after the last was the first one again.
  if (key === 'down') return index < 0 ? 0 : Math.min(count - 1, index + 1)
  return index < 0 ? count - 1 : Math.max(0, index - 1)
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
    // Tab completes the path being typed, as it does in every shell, and
    // moves between the fields once there is nothing left to complete.
    const completed = panel.field === 'query' && key === 'tab' ? completedQuery(panel, rows) : null
    if (completed !== null) return stay({ ...panel, query: completed, index: -1, name: null })
    const order: OpenProjectPanel['field'][] =
      chosen && !chosen.git && chosen.kind !== 'new' ? ['query', 'init', 'name'] : ['query', 'name']
    const at = Math.max(0, order.indexOf(panel.field))
    const next = order[(at + (key === 'tab' ? 1 : -1) + order.length) % order.length] ?? 'query'
    return stay({ ...panel, field: next })
  }
  // The arrows mean the list wherever the keyboard is. A field that swallowed
  // every key but its own is a field you cannot look around from: the tick box
  // used to take the down key and do nothing with it.
  if (key === 'down' || key === 'up' || key === 'home' || key === 'end') {
    if (rows.length === 0) return stay(panel)
    return stay({
      ...panel,
      index: moved(key, panel.index, rows.length),
      name: null,
      following: true,
    })
  }
  // → goes into the chosen folder, ← to the one above: the arrows a list of
  // folders has everywhere else. Only while the query has the keyboard — with
  // a name half typed they are the caret's.
  if (panel.field === 'query') {
    if (key === 'right' && (chosen?.kind === 'folder' || chosen?.kind === 'recent'))
      return stay(goTo(panel, chosen.path))
    if (key === 'left' && panel.query === '') return stay(navigate(panel, 'up'))
  }
  if (panel.field === 'init') {
    return key === 'space' ? stay({ ...panel, init: !panel.init }) : stay(panel)
  }
  if (panel.field === 'name') {
    const name = panel.name ?? (chosen ? nameFrom(chosen.path) : '')
    if (key === 'ctrl+u') return stay({ ...panel, name: '' })
    if (key === 'backspace') return stay({ ...panel, name: [...name].slice(0, -1).join('') })
    const text = typed(data, key)
    return text ? stay({ ...panel, name: name + text.toLowerCase() }) : stay(panel)
  }
  if (key === 'ctrl+u')
    return stay({
      ...panel,
      query: '',
      index: -1,
      scroll: 0,
      following: true,
      name: null,
      error: null,
    })
  if (key === 'backspace' && panel.query === '') return stay(navigate(panel, 'up'))
  if (key === 'backspace')
    return stay({
      ...panel,
      query: [...panel.query].slice(0, -1).join(''),
      index: -1,
      scroll: 0,
      following: true,
      name: null,
    })
  const text = typed(data, key)
  return text
    ? stay({
        ...panel,
        query: panel.query + text,
        index: -1,
        scroll: 0,
        following: true,
        name: null,
        error: null,
      })
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
      // A folder that is not there yet has nothing to go into.
      if (row?.kind === 'folder' && index === panel.index) return stay(goTo(panel, row.path))
      return stay({ ...panel, index: Math.max(-1, index), field: 'query', name: null })
    }
    case 'into': {
      const row = rows[Number(arg)]
      return row?.kind === 'folder' || row?.kind === 'recent'
        ? stay(goTo(panel, row.path))
        : stay(panel)
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
