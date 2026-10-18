import type { Queued, Wait } from '@tade/core'
import type { TaskSnapshot } from '../../model.ts'
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// What a piece of queued work waits on, chosen from a list: every task it could
// wait on, the ones it waits on now ticked, and typing to narrow it. It was a
// line of names to type, which said nothing about which of them were real and
// offered nothing to choose from. What is in the list is the queue subject's
// to find (`wire/queue.ts`); the drawing is beside this in `view.ts`.
//
// Saving is the same change the orchestrator's tool makes — `after`, replacing
// the list — so the rules are the queue's: nothing waits on itself, and no loop.

/** Choosing what one piece of queued work waits on. */
export interface WaitsPanel {
  kind: 'waits'
  /** The queued task whose waits these are, as its qualified id. */
  task: string
  query: string
  /** The row the keyboard is on, among those the query leaves. */
  index: number
  /** Lines of the list scrolled past: the panel's place in the one scroll area. */
  scroll: number
  /** Whether the list follows the row the keyboard is on; scrolling it yourself stops that. */
  following: boolean
  /**
   * What it will wait on once saved, each with why, by qualified id — begun
   * from what its task file says now, so saving untouched changes nothing. A
   * wait for an approval keeps that it is one.
   */
  picked: readonly Wait[]
  /** Whether the keys are writing the reason of the row the keyboard is on, rather than the query. */
  editing: boolean
  busy: boolean
  error: string | null
}

/** Where a task it could wait on stands, in the word the row says it with. */
export type WaitStanding =
  | 'working'
  | 'needs you'
  | 'stopped'
  | 'queued'
  | 'parked'
  | 'finished'
  | 'failed'
  | 'removed'

/** One task the panel offers, as the window has it. */
export interface WaitRow {
  /** Its qualified id: what a wait names. */
  task: string
  project: string
  /** Its name in its project. */
  name: string
  standing: WaitStanding
  /** Waited on now, as its task file says; or the agents at work; or the rest of the queue. */
  group: 'now' | 'working' | 'queued'
  /** What it is, on one line: its title, or what it was asked for. */
  about: string
}

/** What the panel draws: the task whose waits they are, and what it could wait on. */
export interface WaitsView {
  task: string
  rows: readonly WaitRow[]
}

/** A wait on this is a wait nothing can ever answer: the task is not there to finish. */
export function gone(row: WaitRow): boolean {
  return row.standing === 'removed'
}

/** Where a task stands, in the word a row says it with; absent from status is removed. */
function standingOf(
  task: string,
  tasks: ReadonlyMap<string, TaskSnapshot>,
  finished: ReadonlySet<string>,
): WaitStanding {
  if (finished.has(task)) return 'finished'
  const seen = tasks.get(task)
  if (!seen) return 'removed'
  switch (seen.state) {
    case 'working':
      return seen.waiting ? 'needs you' : 'working'
    case 'blocked':
      return 'needs you'
    case 'review':
      return 'stopped'
    case 'merged':
      return 'finished'
    default:
      return seen.state
  }
}

/**
 * What one piece of queued work could wait on, in the order the panel lists
 * it: what it waits on now, as its task file says and wherever that is —
 * removed and finished work included, since that is what there is to drop —
 * then the agents at work, then the rest of the queue, its own project's
 * first in each. Never itself, and never work that has finished or failed,
 * which a new wait could only ever be answered by already or never.
 */
export function waitRowsOf(req: {
  task: string
  after: readonly Wait[]
  tasks: readonly TaskSnapshot[]
  queued: readonly Queued[]
  finished: ReadonlySet<string>
}): WaitRow[] {
  const here = req.task.split('/')[0] ?? ''
  const tasks = new Map(req.tasks.map((one) => [one.task, one]))
  const row = (task: string, group: WaitRow['group']): WaitRow => {
    const seen = tasks.get(task)
    const said = seen?.title ?? seen?.intent ?? ''
    return {
      task,
      project: task.split('/')[0] ?? '',
      name: task.split('/').slice(1).join('/') || task,
      standing: standingOf(task, tasks, req.finished),
      group,
      about: said.split('\n')[0]?.trim() ?? '',
    }
  }
  const taken = new Set([req.task, ...req.after.map((one) => one.task)])
  const ours = (a: WaitRow, b: WaitRow) =>
    Number(b.project === here) - Number(a.project === here) || a.task.localeCompare(b.task)
  const working = req.tasks
    .filter((one) => !taken.has(one.task) && !req.finished.has(one.task))
    .filter((one) => one.state === 'working' || one.state === 'blocked' || one.state === 'review')
    .map((one) => row(one.task, 'working'))
    .sort(ours)
  // The queue's own list, oldest first, and anything status calls queued that
  // the last look at the queue had not reached yet.
  const waiting = [
    ...req.queued.map((one) => one.task),
    ...req.tasks
      .filter((one) => one.state === 'queued' || one.state === 'parked')
      .map((one) => one.task),
  ]
  const queued = [...new Set(waiting)]
    .filter((task) => !taken.has(task) && !req.finished.has(task))
    .map((task) => {
      const made = row(task, 'queued')
      return req.queued.some((one) => one.task === task && one.parked)
        ? { ...made, standing: 'parked' as const }
        : made.standing === 'removed'
          ? { ...made, standing: 'queued' as const }
          : made
    })
    .sort((a, b) => Number(b.project === here) - Number(a.project === here))
  return [...req.after.map((one) => row(one.task, 'now')), ...working, ...queued]
}

/** Rows a page key moves by. */
const PAGE = 5

export function waitsPanel(task: string, picked: readonly Wait[]): WaitsPanel {
  return {
    kind: 'waits',
    task,
    query: '',
    index: 0,
    scroll: 0,
    following: true,
    picked,
    editing: false,
    busy: false,
    error: null,
  }
}

/** The rows that fit what is typed: every word somewhere in its name, project or what it is. */
export function waitChoices(rows: readonly WaitRow[], query: string): WaitRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  return rows.filter((row) => {
    const text = `${row.task} ${row.about} ${row.standing}`.toLowerCase()
    return words.every((word) => text.includes(word))
  })
}

/** The wait on this row, where it is picked. */
export function pickedOf(panel: WaitsPanel, task: string): Wait | undefined {
  return panel.picked.find((one) => one.task === task)
}

/** Picked, or not: a row ticked goes on the end, and one unticked takes its reason with it. */
function toggled(panel: WaitsPanel, row: WaitRow): WaitsPanel {
  const had = pickedOf(panel, row.task)
  return {
    ...panel,
    picked: had
      ? panel.picked.filter((one) => one.task !== row.task)
      : [...panel.picked, { task: row.task, why: '' }],
    editing: false,
    error: null,
  }
}

/** The reason of one picked wait, rewritten. */
function rewhy(panel: WaitsPanel, task: string, why: (was: string) => string): WaitsPanel {
  return {
    ...panel,
    picked: panel.picked.map((one) => (one.task === task ? { ...one, why: why(one.why) } : one)),
  }
}

const saved = (panel: WaitsPanel): PanelOutcome => ({
  panel: { ...panel, editing: false, busy: true, error: null },
  submit: true,
})

export function waitsKey(
  panel: WaitsPanel,
  key: string | undefined,
  data: string,
  rows: readonly WaitRow[],
): PanelOutcome {
  if (key === 'escape') return panel.editing ? stay({ ...panel, editing: false }) : close
  // One save at a time: a second enter while the first is being written would write twice.
  if (panel.busy) return stay(panel)
  const choices = waitChoices(rows, panel.query)
  const row = choices[panel.index]
  if (panel.editing && row && pickedOf(panel, row.task)) {
    if (key === 'enter' || key === 'tab') return stay({ ...panel, editing: false })
    if (key === 'backspace') return stay(rewhy(panel, row.task, (was) => was.slice(0, -1)))
    const text = typed(data, key)
    if (text) return stay(rewhy(panel, row.task, (was) => was + text))
    if (key !== 'up' && key !== 'down' && key !== 'pageUp' && key !== 'pageDown') return stay(panel)
  }
  const last = Math.max(0, choices.length - 1)
  const at = (index: number) =>
    stay({ ...panel, index, following: true, editing: false, error: null })
  if (key === 'up') return at(Math.max(0, panel.index - 1))
  if (key === 'down') return at(Math.min(last, panel.index + 1))
  if (key === 'pageUp') return at(Math.max(0, panel.index - PAGE))
  if (key === 'pageDown') return at(Math.min(last, panel.index + PAGE))
  if (key === 'enter') return saved(panel)
  // Space ticks, as in any list of boxes: no task's name has a space in it,
  // so the query never needs one.
  if (key === 'space') return row ? stay(toggled(panel, row)) : stay(panel)
  // Tab is the reason: a row not yet picked is picked to be given one.
  if (key === 'tab') {
    if (!row) return stay(panel)
    const on = pickedOf(panel, row.task) ? panel : toggled(panel, row)
    return stay({ ...on, editing: true, following: true })
  }
  if (key === 'backspace')
    return stay({ ...panel, query: panel.query.slice(0, -1), index: 0, following: true })
  const text = typed(data, key)
  if (text)
    return stay({ ...panel, query: panel.query + text, index: 0, following: true, error: null })
  return stay(panel)
}

export function waitsClick(
  panel: WaitsPanel,
  control: string,
  rows: readonly WaitRow[],
): PanelOutcome {
  if (control === 'cancel') return close
  if (panel.busy) return stay(panel)
  if (control === 'save') return saved(panel)
  if (control === 'drop-gone') {
    const away = new Set(rows.filter(gone).map((row) => row.task))
    return stay({
      ...panel,
      picked: panel.picked.filter((one) => !away.has(one.task)),
      editing: false,
      error: null,
    })
  }
  const choices = waitChoices(rows, panel.query)
  if (control.startsWith('row:')) {
    const index = Number(control.slice('row:'.length))
    const row = choices[index]
    return row ? stay({ ...toggled(panel, row), index }) : stay(panel)
  }
  if (control.startsWith('why:')) {
    const index = Number(control.slice('why:'.length))
    const row = choices[index]
    return row && pickedOf(panel, row.task)
      ? stay({ ...panel, index, editing: true, error: null })
      : stay(panel)
  }
  return stay(panel)
}
