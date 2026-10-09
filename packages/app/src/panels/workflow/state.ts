import type { WorkflowField } from '@tade/core'
import { pageBy } from '../frame.ts'
import { close, type PanelOutcome, stay, typed } from '../outcome.ts'

// Writing a stored workflow: a list of templates and their steps down the
// left, a form for whichever one you are on down the right.
//
// **A list and a form, and no canvas**, which is a decision with an argument
// rather than a limitation — it is in `templates-edit.ts`, beside the code
// that makes the edits. What is here is the *press*: which row the list is on,
// which field the keyboard is on, and what is being typed into it.
//
// **It holds no template.** Every change is handed to the subject, which
// applies it through core's pure `editWorkflow` and writes the draft back, so
// the form and the file can never be two different templates. A field is
// submitted when you leave it or press enter — a field at a time, never a
// keystroke at a time — and a tick or a choice goes at once, because there is
// nothing to finish typing.
//
// **It edits drafts.** A published version is immutable; the page says so, the
// store has no door that would change one, and Publish asks first because a
// version that has been published has to go on saying what it said.

export interface WorkflowPanel {
  kind: 'workflow'
  /** The template being edited. Empty until a row of the list is chosen. */
  template: string
  /** Which row of the chosen template the form is for: -1 the template, 0.. its steps. */
  row: number
  /** Which control the keyboard is on, of `workflowControls`. */
  index: number
  /** The field being typed into and what is in it, or null when none is open. */
  typing: { id: string; value: string } | null
  scroll: number
  listScroll: number
  /** Whether the form follows the control the keyboard is on, until you scroll it. */
  following: boolean
  busy: boolean
  /** What it last said: a save, a publish, or what a field was refused for. */
  said: string | null
  problem: string | null
  /** Publishing asks, because a published version never changes. */
  asking: 'publish' | null
}

export function workflowPanel(template = ''): WorkflowPanel {
  return {
    kind: 'workflow',
    template,
    row: -1,
    index: 0,
    typing: null,
    scroll: 0,
    listScroll: 0,
    following: true,
    busy: false,
    said: null,
    problem: null,
    asking: null,
  }
}

/** What the page's controls are, in the order the keyboard walks them. */
export function workflowControls(fields: readonly WorkflowField[]): string[] {
  return [...fields.map((field) => `field:${field.id}`), 'add', 'remove', 'publish', 'cancel']
}

/** One row of the list: a template, or one of the chosen template's steps. */
export interface WorkflowRow {
  /** `template:<name>` or `step:<n>`. */
  id: string
  template: string
  /** -1 for the template's own row. */
  step: number
}

/**
 * A key, while the page has the keyboard.
 *
 * `← →` move between the rows of the list and `tab`/`↑↓` through the form,
 * which is the one arrangement that does not fight itself: a list down the
 * left and a form down the right are two columns, and the keys that walk them
 * are the two axes.
 */
export function workflowKey(
  panel: WorkflowPanel,
  key: string | undefined,
  data: string,
  inputs: { fields?: readonly WorkflowField[]; rows?: readonly WorkflowRow[] } = {},
): PanelOutcome {
  const fields = inputs.fields ?? []
  const rows = inputs.rows ?? []
  const controls = workflowControls(fields)
  const at = controls[panel.index] ?? ''
  if (panel.asking) {
    if (key === 'escape' || key === 'n') return stay({ ...panel, asking: null })
    if (key === 'enter' || key === 'y') {
      return { panel: { ...panel, busy: true, asking: null }, submit: true, choice: 'publish' }
    }
    return stay(panel)
  }
  // Leaving the page with a field half typed saves it rather than dropping it,
  // which is what a settings field already does: what somebody typed is what
  // they meant, and a dismiss that silently loses it is the worst of the three
  // possible behaviours.
  if (key === 'escape') {
    return panel.typing
      ? { panel: { ...panel, typing: null, busy: true }, submit: true, choice: 'save' }
      : close
  }
  if (panel.busy) return stay(panel)
  if (key === 'left' || key === 'right') return move(panel, rows, key === 'right' ? 1 : -1)
  if (key === 'tab' || key === 'down') return walk(panel, controls, 1)
  if (key === 'shift+tab' || key === 'up') return walk(panel, controls, -1)
  if (key === 'pageUp' || key === 'pageDown') {
    const by = pageBy(key)
    if (by !== null) {
      return stay({ ...panel, scroll: Math.max(0, panel.scroll + by), following: false })
    }
  }
  if (key === 'enter' || (key === 'space' && !at.startsWith('field:'))) {
    return workflowPress(panel, at, fields)
  }
  if (at.startsWith('field:')) {
    const field = fields.find((one) => `field:${one.id}` === at)
    if (!field || field.off) return stay(panel)
    if (field.kind === 'check' || field.kind === 'choice') {
      return key === 'space' ? workflowPress(panel, at, fields) : stay(panel)
    }
    const value = panel.typing?.id === field.id ? panel.typing.value : field.value
    if (key === 'backspace') return typing(panel, field.id, [...value].slice(0, -1).join(''))
    if (key === 'ctrl+u') return typing(panel, field.id, '')
    if (key === 'space') return typing(panel, field.id, `${value} `)
    const text = typed(data, key)
    if (text) return typing(panel, field.id, value + text)
  }
  return stay(panel)
}

/** Pressing one of the page's controls. */
export function workflowPress(
  panel: WorkflowPanel,
  at: string,
  fields: readonly WorkflowField[],
): PanelOutcome {
  if (at === 'cancel') return close
  if (at === 'publish') {
    return stay({ ...panel, asking: 'publish', said: null, problem: null })
  }
  if (at === 'add' || at === 'remove') {
    return { panel: { ...panel, busy: true, said: null, problem: null }, submit: true, choice: at }
  }
  const field = fields.find((one) => `field:${one.id}` === at)
  if (!field || field.off) return stay(panel)
  if (field.kind === 'check' || field.kind === 'choice') {
    // A tick and a choice have nothing to finish typing, so they go at once:
    // the subject applies them and writes the draft back.
    return {
      panel: { ...panel, busy: true, said: null, problem: null },
      submit: true,
      choice: `press:${field.id}`,
    }
  }
  // Enter in a text field saves it and moves on, as it would in a form.
  return {
    panel: { ...panel, busy: true, said: null, problem: null },
    submit: true,
    choice: 'save',
  }
}

export function workflowClick(
  panel: WorkflowPanel,
  control: string,
  inputs: { fields?: readonly WorkflowField[]; rows?: readonly WorkflowRow[] } = {},
): PanelOutcome {
  const fields = inputs.fields ?? []
  const rows = inputs.rows ?? []
  if (control === 'close') return close
  if (control === 'no') return stay({ ...panel, asking: null })
  if (control === 'yes' && panel.asking) {
    return { panel: { ...panel, busy: true, asking: null }, submit: true, choice: 'publish' }
  }
  if (panel.busy) return stay(panel)
  if (control.startsWith('row:')) {
    const row = rows.find((one) => one.id === control.slice('row:'.length))
    if (!row) return stay(panel)
    // A row clicked with a field half typed saves the field first: the click
    // is a move, and a move must not be a way of losing what was typed.
    const next = { ...panel, template: row.template, row: row.step, index: 0, following: true }
    return panel.typing
      ? { panel: { ...next, busy: true }, submit: true, choice: 'save' }
      : stay({ ...next, scroll: 0 })
  }
  const control$ = control.startsWith('field:') ? control : control
  const index = workflowControls(fields).indexOf(control$)
  if (index >= 0) {
    const moved = { ...panel, index, following: true }
    return workflowPress(moved, control$, fields)
  }
  return stay(panel)
}

/** The row of the list the keyboard moves to, keeping whatever was typed. */
function move(panel: WorkflowPanel, rows: readonly WorkflowRow[], by: number): PanelOutcome {
  if (rows.length === 0) return stay(panel)
  const here = rows.findIndex((one) => one.template === panel.template && one.step === panel.row)
  const next = rows[Math.max(0, Math.min(rows.length - 1, (here < 0 ? 0 : here) + by))]
  if (!next) return stay(panel)
  const moved: WorkflowPanel = {
    ...panel,
    template: next.template,
    row: next.step,
    index: 0,
    following: true,
  }
  return panel.typing
    ? { panel: { ...moved, busy: true }, submit: true, choice: 'save' }
    : stay({ ...moved, scroll: 0 })
}

/** The next control the keyboard is on, saving a field it is walking off. */
function walk(panel: WorkflowPanel, controls: readonly string[], by: number): PanelOutcome {
  if (controls.length === 0) return stay(panel)
  const index = (panel.index + by + controls.length) % controls.length
  const moved: WorkflowPanel = { ...panel, index, following: true }
  return panel.typing
    ? { panel: { ...moved, busy: true }, submit: true, choice: 'save' }
    : stay(moved)
}

function typing(panel: WorkflowPanel, id: string, value: string): PanelOutcome {
  return stay({ ...panel, typing: { id, value }, said: null, problem: null })
}
