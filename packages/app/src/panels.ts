import { slugify } from '@wilco/voice-core'
import { SPEND_BY, SPEND_WINDOWS, type SpendBy, type SpendWindow } from './spend.ts'

// Panels: the questions the window asks, floating over it.
//
// A click does the thing. When the thing needs more than a click — what a task
// is for, which folder to open — it gets a panel with the fields in it, filled
// with the likely answers, and Enter runs it. Nothing types a half-written
// command into a line for you to finish, and nothing takes the screen away:
// the window keeps running underneath.
//
// Pure, like the rest of the model. What a key or a click does to a panel is
// decided here; carrying it out is the app's job.

export type NewTaskField = 'project' | 'intent' | 'start' | 'cancel' | 'go'

const NEW_TASK_FIELDS: readonly NewTaskField[] = ['project', 'intent', 'start', 'cancel', 'go']

export interface NewTaskPanel {
  kind: 'new-task'
  /** Every project a task could go in, in the order the tabs show them. */
  projects: string[]
  project: string | null
  /** What needs doing, exactly as typed. It becomes the task's intent. */
  intent: string
  /** Start an agent on it straight away. */
  start: boolean
  /** Which control has the keyboard. */
  field: NewTaskField
  /** Why the last attempt did not happen, in words you can act on. */
  error: string | null
  /** Being carried out: a second Enter must not make a second task. */
  busy: boolean
}

/** Where the money went, regrouped and re-windowed by its tabs. */
export interface SpendPanel {
  kind: 'spend'
  window: SpendWindow
  by: SpendBy
  busy: false
}

export type Panel = NewTaskPanel | SpendPanel

export function spendPanel(): SpendPanel {
  return { kind: 'spend', window: 'today', by: 'agent', busy: false }
}

/** What a keystroke or click did: the panel as it now is, and whether to run it. */
export interface PanelOutcome {
  panel: Panel | null
  submit: boolean
}

/** The New task panel, on the project you are in. */
export function newTaskPanel(projects: readonly string[], current: string | null): NewTaskPanel {
  const project = current && projects.includes(current) ? current : (projects[0] ?? null)
  return {
    kind: 'new-task',
    projects: [...projects],
    project,
    intent: '',
    start: true,
    // Straight to the words: the project is already the likely one.
    field: 'intent',
    error: project ? null : 'No projects yet. Open one first, with the + beside the tabs.',
    busy: false,
  }
}

/** The branch a task would get, shown before it exists. */
export function branchPreview(intent: string): string {
  return `wilco/${slugify(intent)}`
}

const stay = (panel: Panel): PanelOutcome => ({ panel, submit: false })
const close: PanelOutcome = { panel: null, submit: false }

/**
 * A keystroke, while a panel has the keyboard.
 *
 * `key` is the key's name where it has one (`escape`, `enter`, `left`), and
 * `data` is what was typed, so a paste arrives as the text it is.
 */
export function panelKey(panel: Panel, key: string | undefined, data: string): PanelOutcome {
  if (panel.kind === 'spend') return spendKey(panel, key)
  if (panel.busy) return key === 'escape' ? close : stay(panel)
  if (key === 'escape') return close
  if (key === 'tab' || key === 'down') return stay(moveField(panel, 1))
  if (key === 'shift+tab' || key === 'up') return stay(moveField(panel, -1))

  if (key === 'enter') {
    if (panel.field === 'cancel') return close
    if (panel.field === 'start') return stay({ ...panel, start: !panel.start })
    return tryRun(panel)
  }

  switch (panel.field) {
    case 'project':
      if (key === 'left') return stay(cycleProject(panel, -1))
      if (key === 'right') return stay(cycleProject(panel, 1))
      return stay(panel)
    case 'start':
      if (key === 'space') return stay({ ...panel, start: !panel.start })
      return stay(panel)
    case 'intent':
      return stay(editIntent(panel, key, data))
    default:
      return stay(panel)
  }
}

/** A click on one of the panel's own controls. */
export function panelClick(panel: Panel, control: string): PanelOutcome {
  if (panel.kind === 'spend') return spendClick(panel, control)
  if (panel.busy) return stay(panel)
  if (control === 'cancel') return close
  if (control === 'go') return tryRun(panel)
  if (control === 'start') return stay({ ...panel, start: !panel.start, field: 'start' })
  if (control === 'intent') return stay({ ...panel, field: 'intent' })
  if (control.startsWith('project:')) {
    const project = control.slice('project:'.length)
    if (panel.projects.includes(project)) {
      return stay({ ...panel, project, field: 'project', error: null })
    }
  }
  return stay(panel)
}

/** The panel is being carried out, or has failed and says why. */
export function panelBusy(panel: NewTaskPanel): NewTaskPanel {
  return { ...panel, busy: true, error: null }
}

export function panelFailed(panel: NewTaskPanel, error: string): NewTaskPanel {
  return { ...panel, busy: false, error }
}

/** ← → move through the time windows, tab through the groupings. */
function spendKey(panel: SpendPanel, key: string | undefined): PanelOutcome {
  if (key === 'escape' || key === 'enter') return close
  if (key === 'left' || key === 'right') {
    return stay({ ...panel, window: cycle(SPEND_WINDOWS, panel.window, key === 'left' ? -1 : 1) })
  }
  if (key === 'tab' || key === 'shift+tab') {
    return stay({ ...panel, by: cycle(SPEND_BY, panel.by, key === 'tab' ? 1 : -1) })
  }
  return stay(panel)
}

function spendClick(panel: SpendPanel, control: string): PanelOutcome {
  if (control === 'close') return close
  const [kind, id] = control.split(':')
  if (kind === 'window' && SPEND_WINDOWS.some((w) => w.id === id)) {
    return stay({ ...panel, window: id as SpendWindow })
  }
  if (kind === 'by' && SPEND_BY.some((b) => b.id === id))
    return stay({ ...panel, by: id as SpendBy })
  return stay(panel)
}

function cycle<T extends string>(options: readonly { id: T }[], current: T, delta: number): T {
  const at = options.findIndex((option) => option.id === current)
  return options[(at + delta + options.length) % options.length]?.id ?? current
}

function tryRun(panel: NewTaskPanel): PanelOutcome {
  if (!panel.project) {
    return stay({ ...panel, error: 'No projects yet. Open one first, with the + beside the tabs.' })
  }
  if (panel.intent.trim() === '') {
    return stay({ ...panel, field: 'intent', error: 'Say what needs doing first.' })
  }
  return { panel: panelBusy(panel), submit: true }
}

function moveField(panel: NewTaskPanel, delta: number): NewTaskPanel {
  const at = NEW_TASK_FIELDS.indexOf(panel.field)
  const next = (at + delta + NEW_TASK_FIELDS.length) % NEW_TASK_FIELDS.length
  return { ...panel, field: NEW_TASK_FIELDS[next] ?? 'intent' }
}

function cycleProject(panel: NewTaskPanel, delta: number): NewTaskPanel {
  if (panel.projects.length === 0) return panel
  const at = panel.project ? panel.projects.indexOf(panel.project) : -1
  const next = (at + delta + panel.projects.length) % panel.projects.length
  return { ...panel, project: panel.projects[next] ?? panel.project, error: null }
}

/** Backspace, clear, or type. A paste arrives whole and is kept whole. */
function editIntent(panel: NewTaskPanel, key: string | undefined, data: string): NewTaskPanel {
  if (key === 'backspace') return { ...panel, intent: [...panel.intent].slice(0, -1).join('') }
  if (key === 'ctrl+u') return { ...panel, intent: '' }
  if (key === 'space') return { ...panel, intent: `${panel.intent} `, error: null }
  // Control sequences are keys, not words: an arrow must not type `[D`.
  const text = data.startsWith('\x1b')
    ? ''
    : [...data].map((char) => (control(char) ? ' ' : char)).join('')
  if (text === '') return panel
  return { ...panel, intent: panel.intent + text, error: null }
}

/** A control character: never something a person meant to type into a sentence. */
function control(char: string): boolean {
  const code = char.charCodeAt(0)
  return code < 32 || code === 127
}
