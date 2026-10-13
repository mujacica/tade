// A draft's form: one row per field `workflowFields` gives, each saved on its
// own — the one thing a device may do to a stored workflow.
//
// **Saving is one field at a time**, which is the bound rather than a
// limitation: the body carries a field id, a value and the draft's own hash,
// so an edit from a stale screen meets a draft that has moved and is refused —
// and there is no shape in which it writes a whole template, renames one or
// publishes anything. The form's rows are `workflowFields`' own, which is the
// form the window walks, so neither can offer a field the validator would
// refuse.
//
// **A box starts with what the field holds**, so changing a word is changing
// a word rather than typing the whole of it again — except where only the
// start of it was sent, which starts empty and says why (`prefillOf`). What
// somebody typed is theirs: a delta never writes over a box that differs from
// what it was last filled with, and a refusal leaves it where it was.

import { afterAnswer, draftBody, savingOf } from '../acts.js'
import { el, into, keyed, textIn } from '../dom.js'
import { sayIn } from '../rows.js'
import { answerIn } from '../ui.js'
import {
  choicesOf,
  cutOf,
  editorOf,
  fieldLabel,
  fieldSaid,
  prefillOf,
  toggleSaid,
} from './workflows-shape.js'

/**
 * The form for one scope — `template` or a step's name — made once and
 * patched. `ctx` is the page's way to ask the machine (`boot.js`).
 */
export function form(ctx, label) {
  const node = el('div', { class: 'wf-form' })
  const list = el('ul', { class: 'wf-fields', attrs: { 'aria-label': label } })
  const none = el('p', { class: 'wf-form-none', text: 'Nothing here can be filled in.' })
  into(node, list, none)
  const held = { row: null, scope: 'template' }
  return {
    node,
    update(row, part, view) {
      held.row = row
      held.scope = part.scope
      const acts = view.may.acts ?? {}
      none.hidden = part.fields.length > 0
      keyed(
        list,
        part.fields,
        (field) => `${field.id}:${editorOf(field)}`,
        createField,
        (item, field) => fillField(item, field, savingOf(row, field, acts), send, row.rev),
      )
    },
  }

  /**
   * One save. **The key is minted once per press**: a press whose answer never
   * arrived is a press whose repeat must not be a second write, and the key is
   * what lets the machine tell the two apart. Only a `200` counts as saved —
   * a `409` is somebody else having saved the same draft, and what was typed
   * stays in the box (`afterAnswer`).
   */
  function send(field, value, press, said, control) {
    if (ctx === undefined || ctx === null || held.row === null) return
    const key = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`
    const body = draftBody(held.row, held.scope, field.id, value, key, ctx.revOf())
    press.disabled = true
    void ctx.ask('POST', '/api/draft/save', body).then((answer) => {
      press.disabled = false
      const came = afterAnswer(answer, ctx.sentence(answer))
      said.hidden = false
      answerIn(said, came.ok ? 'Saved to the draft.' : came.said, came.trouble)
      // What was saved is what the field holds now, so the next fill sees an
      // untouched box rather than one somebody is still typing in.
      // **And it stays in the box until the machine has read the draft
      // again**: a beat that lands before then still carries the old value,
      // and putting that back would look like the save undoing itself.
      if (came.ok && control !== null) {
        control.setAttribute('data-was', control.value)
        control.setAttribute('data-saved-at', held.row.rev ?? '')
      }
      if (control !== null) dirtyIn(control.closest('.wf-field').wf)
    })
  }
}

let fields = 0

/**
 * One field, built once for the control its kind wants. The `<label>` is tied
 * to the box with `for`/`id`, so tapping the label puts the keyboard in the
 * field — on a phone the difference between a 44px target and a 16px one.
 */
function createField(field) {
  fields += 1
  const id = `wf-f${fields}`
  const item = el('li', { class: 'wf-field' })
  const editor = editorOf(field)
  const head = el('div', { class: 'wf-field-head' })
  const label =
    editor === 'toggle'
      ? el('span', { class: 'wf-field-label' })
      : el('label', { class: 'wf-field-label', attrs: { for: id } })
  const now = el('span', { class: 'wf-field-now' })
  // **A box that says what is stored looks like an edit nobody made**, so one
  // that differs from it says so until it is saved.
  const dirty = el('span', { class: 'wf-field-dirty', text: 'not saved' })
  dirty.hidden = true
  into(head, label, now, dirty)
  const control =
    editor === 'toggle'
      ? null
      : editor === 'choice'
        ? el('select', { attrs: { id } })
        : editor === 'long'
          ? el('textarea', { attrs: { id, rows: '3' } })
          : el('input', { attrs: { id, type: 'text', autocomplete: 'off' } })
  const means = el('p', { class: 'wf-field-means' })
  const cut = el('p', { class: 'wf-field-cut' })
  const off = el('p', { class: 'wf-field-off' })
  const foot = el('div', { class: 'wf-field-foot' })
  const press = el('button', {
    class: editor === 'toggle' ? 'press quietly small' : 'press small',
    text: 'Save',
    attrs: { type: 'button' },
  })
  const said = el('p', { class: 'wf-field-said', attrs: { role: 'status' } })
  said.hidden = true
  into(foot, press, said)
  into(item, head, control, means, cut, off, foot)
  item.wf = { editor, label, now, dirty, control, means, cut, off, press, said, field, send: null }
  if (control !== null) {
    control.addEventListener('input', () => {
      // What was said about the last save is not about what is typed now.
      said.hidden = true
      dirtyIn(item.wf)
    })
  }
  // Wired once: a listener added on every fill would send one save per delta
  // the row has seen, which is the bug a page that patches rather than
  // rebuilds is most likely to have. It reads the field as last filled.
  press.addEventListener('click', () => {
    const parts = item.wf
    if (parts.send === null) return
    const value =
      parts.editor === 'toggle'
        ? parts.field.value?.words === 'true'
          ? 'false'
          : 'true'
        : parts.control.value
    parts.send(parts.field, value, press, said, parts.control)
  })
  return item
}

function fillField(item, field, standing, send, rev) {
  const parts = item.wf
  parts.field = field
  textIn(parts.label, fieldLabel(field))
  const yes = standing.kind === 'yes'
  parts.send = yes ? send : null
  // **The value in words where it cannot be changed here, and the box where it
  // can** — never both, which would be the same fact said twice on one line.
  textIn(parts.now, yes && parts.editor !== 'toggle' ? '' : fieldSaid(field))
  parts.now.hidden = yes && parts.editor !== 'toggle'
  if (parts.control !== null) {
    parts.control.hidden = !yes
    parts.control.setAttribute('aria-describedby', describedBy(parts))
    if (parts.editor === 'choice') choicesIn(parts.control, field)
    prefillIn(parts.control, prefillOf(field), rev)
  }
  dirtyIn(parts)
  // Said while it is being written, where the consequence is not in the name.
  sayIn(parts.means, yes ? field.means : '')
  sayIn(parts.cut, yes ? cutOf(field) : '')
  // **Absent with its reason, never disabled** — `acts.js`' rule. The reason a
  // whole workflow cannot be saved from here is said once at the top of its
  // screen; what is said here is the field's own, which the template wrote.
  sayIn(parts.off, standing.kind === 'no' && field.off ? field.off : '')
  parts.press.hidden = !yes
  textIn(parts.press, parts.editor === 'toggle' ? toggleSaid(field) : 'Save')
  parts.press.setAttribute(
    'aria-label',
    parts.editor === 'toggle' ? toggleSaid(field) : `Save ${fieldLabel(field)} to the draft`,
  )
}

/** Whether a box differs from what the field holds, said beside its label. */
function dirtyIn(parts) {
  const control = parts.control
  parts.dirty.hidden =
    control === null || control.hidden || control.value === (control.getAttribute('data-was') ?? '')
}

/** The ids a box is described by: what it means, and that only its start was sent. */
function describedBy(parts) {
  for (const [node, tail] of [
    [parts.means, 'm'],
    [parts.cut, 'c'],
  ]) {
    if (node.id === '') node.id = `${parts.control.id}${tail}`
  }
  return `${parts.means.id} ${parts.cut.id}`
}

/**
 * A box filled with what the field holds — **only while nobody has typed in
 * it**. `data-was` is what it was last filled with; a box that still says that
 * is untouched and follows the draft, and one that does not is somebody's
 * sentence and is left alone, focused or not.
 */
function prefillIn(control, now, rev) {
  const saved = control.getAttribute('data-saved-at')
  if (saved !== null) {
    if (saved === (rev ?? '')) return
    control.removeAttribute('data-saved-at')
  }
  const was = control.getAttribute('data-was')
  const untouched = was === null || control.value === was
  if (untouched && control.value !== now && control.ownerDocument.activeElement !== control) {
    control.value = now
  }
  if (untouched) control.setAttribute('data-was', now)
}

/** A choice's options, rebuilt only when the list of them changed. */
function choicesIn(select, field) {
  const options = choicesOf(field)
  const same =
    select.options.length === options.length &&
    options.every((one, at) => select.options[at]?.value === one.value)
  if (same) return
  const chosen = select.value
  select.replaceChildren(
    ...options.map((one) => el('option', { text: one.said, attrs: { value: one.value } })),
  )
  if (options.some((one) => one.value === chosen)) select.value = chosen
}
