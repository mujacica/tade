// One setting, drawn: a line that opens. The settings page's own component,
// used both in the list of what this device may change and in each group, so
// a setting looks the same wherever it is.
//
// **The line is the answer, and the rest is one tap away.** A row says its
// name and its value and nothing else — the value in one column down the right
// edge of every card, quiet where nothing is set — and ends in a quiet chevron,
// or in an amber *Change* where this device may change it. What it means, when
// a change applies, why it is changed at the machine and the control are under
// it, asked for rather than set under every one of a hundred and fifty rows.
//
// The rules each part keeps are the machine's before they are this page's:
//
// - **A key is never here.** The machine sends `set` or `not set`, so a key's
//   row draws that and says so when opened, and the one thing a device may do
//   to one is clear it (`changeBody` sends nothing else for it) — except the
//   person's own device, whose key rows carry `sets` and a hidden box to type
//   a new one into, which is what is sent and never what was shown.
// - **A reason only to a device that may change anything.** `settingStanding`
//   is `off` for one that was not granted changing settings, and then a row
//   says nothing about controls at all: a sentence naming a scope somebody does
//   not have is a map of what else to ask for.
// - **Two presses, and the body's own `confirm: true`**: the press stops a
//   mis-tap, the literal means no body says *do not*. Leaving the press puts it
//   back, so a first tap left behind is not a second one waiting.
// - **What was typed survives a refusal.** Only a `200` clears a box; a `409`
//   writes what is true now into the row's value and leaves the box alone.

import { afterAnswer, CHANGE_PATH, changeBody } from '../acts.js'
import { keyOf } from '../controls.js'
import { classOn, el, into, textIn } from '../dom.js'
import { icon } from '../icons.js'
import { dlIn } from '../rows.js'
import { answerIn } from '../ui.js'
import {
  afterChange,
  drawnOf,
  editorOf,
  factsOf,
  KEY_TYPED,
  KEYS_SAID,
  nowSaid,
  pressWord,
  typedSaid,
} from './settings-shape.js'

let made = 0

/** An id no other element on the page has. */
function idOf(what) {
  made += 1
  return `st-${what}-${made}`
}

/**
 * Write a row's value into its cell: the words, or the caps of a key
 * combination, and *default* beside a value nothing set.
 */
export function valueIn(node, row) {
  const value = drawnOf(row)
  node.className = 'st-value'
  node.classList.add(`is-${value.kind}`)
  classOn(node, 'is-mono', value.mono)
  classOn(node, 'is-on', value.on)
  const parts =
    value.caps.length > 0
      ? value.caps.map((cap) => el('kbd', { text: cap }))
      : [el('span', { class: 'st-said', text: value.text })]
  if (value.tag !== null) parts.push(el('span', { class: 'st-tag', text: value.tag }))
  node.replaceChildren(...parts)
}

/**
 * One setting as a row of a card.
 *
 * `opts`: `crumb` (what the row is one of, where it is out of its group),
 * `standing` (`settingStanding`'s answer), `open` (whether it starts opened),
 * `toggled(open)` (told when somebody opens or closes it), and, where the
 * standing is `yes`, `ctx` and `saved(sync)` — told after an answer moved the
 * value, so every other drawing of this setting says the same.
 *
 * Returns the node, `fill(sync)` to redraw the value (and, with `sync`, the
 * control, to what is now set) and `row`.
 */
export function settingRow(row, opts) {
  const more = idOf('more')
  const node = el('li', { class: 'st-row' })
  const line = el('button', {
    class: 'st-line',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': more },
  })
  const name = el('span', { class: 'st-name' })
  into(name, el('span', { class: 'st-title', text: row.title }))
  if (opts.crumb) into(name, el('span', { class: 'st-crumb', text: opts.crumb }))
  const value = el('span', { class: 'st-value' })
  const yes = opts.standing.kind === 'yes'
  const end = yes
    ? el('span', { class: 'st-change', text: 'Change' })
    : el('span', { class: 'st-end', attrs: { 'aria-hidden': 'true' } })
  if (!yes) into(end, icon('chevron', 'st-chev'))
  into(line, name, value, end)
  classOn(node, 'is-here', yes)

  const under = el('div', { class: 'st-more', attrs: { id: more } })
  if (row.means !== '') into(under, el('p', { class: 'st-means', text: row.means }))
  const facts = el('dl', { class: 'dl st-facts' })
  into(under, facts)
  if (row.held !== null) into(under, el('p', { class: 'st-aside', text: KEYS_SAID }))
  if (opts.standing.kind === 'no' && opts.standing.why !== '') {
    const why = el('p', { class: 'st-why' })
    into(why, icon('laptop', 'st-why-ic'), el('span', { text: opts.standing.why }))
    into(under, why)
  }
  const editor = yes ? editorFor(row, opts) : null
  if (editor !== null) into(under, editor.node)
  into(node, line, under)

  const set = (open) => {
    under.hidden = !open
    line.setAttribute('aria-expanded', open ? 'true' : 'false')
    classOn(node, 'is-open', open)
  }
  line.addEventListener('click', () => {
    const open = under.hidden
    set(open)
    opts.toggled(open)
  })

  const fill = (sync = false) => {
    valueIn(value, row)
    dlIn(facts, factsOf(row))
    // The value, whole, in the face its line draws it in — where it is said.
    const now = facts.children[0]?.textContent === 'Now' ? facts.children[1] : null
    if (now !== null) classOn(now, 'is-mono', drawnOf(row).mono)
    if (sync) editor?.sync()
  }
  fill()
  set(opts.open === true)
  return { node, fill, row }
}

/**
 * The control under a row this device may change: the options, a box or a
 * clear, the press that asks twice, and the line its answer is said on.
 */
function editorFor(row, opts) {
  const editor = editorOf(row)
  const node = el('div', { class: 'st-edit' })
  const label = `${row.title}, a new value`
  let control = null
  let read = () => ''
  let sync = () => {}

  if (editor.kind === 'pick') {
    // Every option at once, one tap each: a radio group under its own name.
    const group = el('fieldset', { class: 'st-pick' })
    into(group, el('legend', { class: 'sr-only', text: label }))
    const name = idOf('pick')
    for (const option of editor.options) {
      const choice = el('label', { class: 'st-option' })
      const box = el('input', { attrs: { type: 'radio', name, value: option.value } })
      into(choice, box, el('span', { text: option.label }))
      into(group, choice)
    }
    // **On what it is now**, so a mistaken pair of taps sends the value that
    // is already set — answered *was already that* — rather than whichever
    // option happens to be first.
    sync = () => {
      for (const box of group.querySelectorAll('input')) box.checked = box.value === (row.was ?? '')
    }
    read = () => group.querySelector('input:checked')?.value ?? row.was ?? ''
    control = group
  } else if (editor.kind === 'list') {
    const box = el('select', { class: 'st-box', attrs: { 'aria-label': label } })
    for (const option of editor.options) {
      into(box, el('option', { text: option.label, attrs: { value: option.value } }))
    }
    sync = () => {
      box.value = row.was ?? ''
    }
    read = () => box.value
    control = box
  } else if (editor.kind === 'number' || editor.kind === 'text') {
    // **Empty, with what is set now as its placeholder**: a box pre-filled
    // with the value reads as an edit somebody already made.
    const box = el('input', {
      class: 'st-box',
      attrs: {
        type: 'text',
        inputmode: editor.kind === 'number' ? 'decimal' : 'text',
        'aria-label': label,
        maxlength: '2000',
        autocomplete: 'off',
        spellcheck: 'false',
        placeholder: `now ${row.shown === '' ? row.fallback || nowSaid(row) : row.shown}`,
      },
    })
    read = () => box.value
    control = box
  } else if (editor.kind === 'secret') {
    // **Hidden, empty and never filled in**: the page was never sent the key,
    // and a box that showed what was typed would be a key on a screen.
    const box = el('input', {
      class: 'st-box',
      attrs: {
        type: 'password',
        'aria-label': `${row.title}, a new key`,
        maxlength: '2000',
        autocomplete: 'new-password',
        spellcheck: 'false',
        placeholder: `now ${row.held}`,
      },
    })
    into(node, el('p', { class: 'st-aside', text: KEY_TYPED }))
    read = () => box.value
    control = box
  }
  sync()

  // Quiet until it has been asked once, then amber: the one colour that means
  // *this one counts*, as every press that asks twice is drawn.
  const press = el('button', { class: 'press quietly small st-save', attrs: { type: 'button' } })
  const said = el('p', { class: 'st-answer', attrs: { role: 'status' } })
  const presses = el('div', { class: 'presses st-presses' })
  into(presses, press)
  if (control !== null) into(node, control)
  into(node, presses, said)

  let armed = false
  let going = false
  const word = () => {
    textIn(press, pressWord(editor, armed, going, read()))
    classOn(press, 'asked', armed)
  }
  const disarm = () => {
    if (!armed || going) return
    armed = false
    word()
  }
  word()
  // A value changed after an answer is a new question: the old answer, and a
  // first tap on the old value, both go.
  const changed = () => {
    disarm()
    // A key's box says *clear* or *save* by whether anything is typed in it.
    if (editor.kind === 'secret' && !going) word()
    if (!going) answerIn(said, '', null)
  }
  control?.addEventListener('change', changed)
  control?.addEventListener('input', changed)
  press.addEventListener('blur', disarm)
  press.addEventListener('click', async () => {
    if (going) return
    const value = read()
    const first = typedSaid(editor, value)
    if (first !== null) {
      answerIn(said, first, null)
      control?.focus()
      return
    }
    if (!armed) {
      armed = true
      word()
      return
    }
    going = true
    press.disabled = true
    word()
    const got = await opts.ctx.ask(
      'POST',
      CHANGE_PATH,
      changeBody(row, value, keyOf(), opts.ctx.revOf()),
    )
    going = false
    armed = false
    press.disabled = false
    word()
    const came = afterAnswer(got, opts.ctx.sentence(got))
    answerIn(said, came.said, came.trouble)
    // What is true now goes into the row, and the box is emptied only by a
    // `200`: a `409` is the world having moved, not a reason to throw away a
    // value (`afterChange`).
    const after = afterChange(row, editor, got.body?.rev, came)
    if (after.row !== null) {
      Object.assign(row, after.row)
      opts.saved(after.sync)
    }
    if (after.clear) control.value = ''
  })
  return { node, sync }
}
