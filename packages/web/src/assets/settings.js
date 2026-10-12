// What Tade is set up with, as this device may read it — and the few settings
// it may change.
//
// **Asked when the screen opens, never on the stream.** Settings change when
// somebody changes one, so a phone is not sent forty rows of them on every
// beat for a page nobody has open: this screen asks `/api/settings` once when
// it is drawn and again after a change.
//
// The rules this page keeps, each of them the machine's before it is this
// page's:
//
// - **A key is never on this page.** The machine sends `set` or `not set` and
//   nothing of the key, so there is nothing here to hide — and the one thing a
//   device may ever do to one is clear it, which is all `changeBody` can send
//   for a row that holds one.
// - **A control nothing could carry out is absent with its reason.** A row a
//   device may not change says where it is changed (`why`), and a device that
//   was not granted changing anything is told nothing about controls at all: a
//   sentence naming a scope somebody does not have is a map of what else to
//   ask for.
// - **Two presses, and the body's own `confirm: true`.** Neither stands in for
//   the other: the press stops a mis-tap, and the literal means there is no
//   body that says *do not*.
// - **What was typed survives a refusal.** A `409` redraws the value that is
//   true now beside the box and leaves the box alone.
// - **Nothing here derives anything.** What may be changed, and what a change
//   must echo, is on the row (`may`, `was`); the page only draws it.

import {
  afterAnswer,
  CHANGE_PATH,
  changeBody,
  SETTINGS_PATH,
  settingStanding,
  settingsSaid,
  shownOf,
} from './acts.js'
import { el, hintOf, into, textIn } from './dom.js'
import { section } from './rows.js'
import { keyOf } from './screens.js'
import { callout, note, panel } from './ui.js'

/**
 * The screen: built once on open, again after a change, and **never by a
 * paint** — a page that rebuilt its rows twice a second would wipe a value
 * somebody was halfway through typing.
 */
export function settingsScreen(ctx) {
  const node = el('div')
  const top = section('SETTINGS', { top: true })
  const said = el('p', { class: 'empty nothing' })
  const withheld = el('p', { class: 'unknown' })
  const keys = callout('A key or a token is said as set or not set and is never shown here.')
  const groups = el('div')
  into(top.body, said, withheld, keys)
  into(node, top.node, groups)

  let answer = null
  let acts = {}
  let drawnWith = null
  let gone = false

  const draw = () => {
    textIn(said, settingsSaid(answer))
    said.hidden = settingsSaid(answer) === ''
    const n = answer?.withheld ?? 0
    textIn(
      withheld,
      n === 0 ? '' : `${n} settings of projects this device does not read are not here`,
    )
    withheld.hidden = n === 0
    keys.hidden = answer?.granted !== true
    drawnWith = acts.configure === true
    groups.replaceChildren(
      ...(answer?.granted === true ? answer.groups : []).map((group) => groupNode(group)),
    )
  }

  const load = async () => {
    const got = await ctx.ask('GET', SETTINGS_PATH)
    if (gone) return
    if (got.status === 200 && got.body !== null && typeof got.body.granted === 'boolean') {
      answer = got.body
    } else {
      answer = { granted: false, groups: [], withheld: 0 }
      textIn(said, ctx.sentence(got))
    }
    draw()
  }

  const groupNode = (group) => {
    const part = section(group.title.toUpperCase())
    const list = panel('ul', 'settings-list')
    for (const row of group.settings) into(list, rowNode(row))
    into(part.body, list)
    return part.node
  }

  const rowNode = (row) => {
    // **A setting is a name and a value on one line**, the value as a pill;
    // what its options mean, and why it cannot be changed from here, are one
    // `?` each — the sentences are kept whole, and asked for rather than set
    // under every row.
    const item = el('li', { class: 'setting' })
    const line = el('div', { class: 'setting-line' })
    const name = el('span', { class: 'setting-name' })
    if (row.scope !== null) into(name, el('span', { class: 'ui-pill', text: row.scope }))
    into(name, el('span', { text: row.title }))
    const value = el('span', { class: 'ui-pill is-mono setting-value', text: shownOf(row) })
    into(line, name, value)
    if (row.means !== '') {
      const means = hintOf(row.means)
      into(line, means.press)
      into(item, line, means.body)
    } else {
      into(item, line)
    }
    const tags = el('div', { class: 'ui-notes setting-tags' })
    if (!row.live) into(tags, note('on restart', 'applies when Tade next starts', 'refresh'))
    const standing = settingStanding(row, acts)
    if (standing.kind === 'no' && standing.why !== '') {
      into(tags, note('at the machine', standing.why, 'laptop'))
    }
    if (tags.children.length > 0) into(item, tags)
    if (standing.kind === 'yes') into(item, controlFor(row, value))
    return item
  }

  /**
   * One change: a box shaped like the setting, and the press that asks twice.
   *
   * The box starts empty rather than holding what is stored — the designer's
   * own rule (`.field`): a box pre-filled with the value reads as an edit
   * somebody already made.
   */
  const controlFor = (row, value) => {
    const node = el('div')
    const box = boxFor(row)
    const press = el('button', { class: 'press quietly', attrs: { type: 'button' } })
    const status = el('p', { attrs: { role: 'status' } })
    const presses = el('div', { class: 'presses' })
    into(presses, press)
    into(node, box, presses, status)
    const word = row.held === null ? 'Change it' : 'Clear it'
    let asked = false
    let going = false
    const settle = () => {
      textIn(press, asked ? 'Tap again to confirm' : word)
      press.classList.toggle('asked', asked)
    }
    settle()
    press.addEventListener('click', async () => {
      if (going) return
      if (!asked) {
        asked = true
        settle()
        return
      }
      going = true
      press.disabled = true
      const got = await ctx.ask(
        'POST',
        CHANGE_PATH,
        changeBody(row, box?.value ?? '', keyOf(), ctx.revOf()),
      )
      going = false
      press.disabled = false
      asked = false
      settle()
      const came = afterAnswer(got, ctx.sentence(got))
      textIn(status, came.said)
      // What is true now goes beside the box, and the box is left alone: a
      // `409` is the world having moved, not a reason to throw away a value.
      const now = got.body?.rev
      if (typeof now === 'string' && (came.ok || came.moved)) {
        row.was = now
        if (row.held === null) row.shown = now
        else row.held = now === 'set' ? 'set' : 'not set'
        textIn(value, shownOf(row))
      }
      if (came.ok && box !== null) box.value = ''
    })
    return node
  }

  void load()

  return {
    node,
    update(view) {
      acts = view.may?.acts ?? {}
      // Rebuilt only when what this device may do changed — a grant somebody
      // made at the machine — and never on an ordinary paint.
      if (answer !== null && drawnWith !== (acts.configure === true)) draw()
    },
    leave() {
      gone = true
    },
  }
}

/**
 * A box shaped like the setting, labelled by its title. Null for a key, which
 * is only ever cleared and so takes nothing typed.
 */
function boxFor(row) {
  if (row.held !== null) return null
  const label = `${row.title}, a new value`
  if (row.kind === 'choice' || row.kind === 'flag') {
    const box = el('select', { attrs: { 'aria-label': label } })
    const options = row.kind === 'flag' ? ['true', 'false'] : row.options
    for (const one of options) {
      // Nothing set is a choice of its own for some — a project's push mode
      // goes back to the machine's — and an empty option would draw as nothing.
      const text = one === '' ? `nothing set — ${row.fallback}` : one
      into(box, el('option', { text, attrs: { value: one } }))
    }
    // **On what it is now**, so a mistaken pair of taps sends the value that
    // is already set — answered *was already that* — rather than whichever
    // option happens to be first.
    box.value = row.was ?? ''
    return box
  }
  return el('input', {
    attrs: {
      type: row.kind === 'number' ? 'number' : 'text',
      'aria-label': label,
      maxlength: '2000',
    },
  })
}
