// The components, made: one factory per look the page repeats (`ui.css`).
//
// **A screen asks for a pill rather than building one.** Each factory returns
// the element with the component's class and nothing else the screen did not
// ask for, so a component looks the same on every screen and changing how it
// looks is one rule in `ui.css`. Text goes in through `textContent` as it does
// everywhere on this page; nothing here builds markup.

import { el, hintOf, into, textIn, toneOn } from './dom.js'
import { icon } from './icons.js'

/** A panel: the container a list of rows sits in. */
export function panel(tag = 'div', extra = '') {
  return el(tag, { class: extra === '' ? 'ui-panel' : `ui-panel ${extra}` })
}

/**
 * A note: a word with its icon, and the sentence behind it one `?` away.
 *
 * What a setting is (*on restart*, *at the machine*) and what is true of a
 * task (*shared checkout*, *not run here*): the word is what is seen, and the
 * sentence is kept whole for whoever asks. One node, so a screen can hide it.
 */
export function note(word, sentence, drawn) {
  const node = el('span', { class: 'ui-note' })
  const line = el('span', { class: 'ui-note-line' })
  const hint = hintOf(sentence, 'ui-note-why')
  into(line, icon(drawn), el('span', { text: word }), hint.press)
  into(node, line, hint.body)
  return node
}

/**
 * A command an agent is waiting to run, whole: wrapped under itself with its
 * own line breaks kept, never cut at the edge — and where the machine did not
 * send all of it, how many characters it left out. Hidden until `commandIn`
 * gives it one.
 */
export function command() {
  const node = el('div', { class: 'ui-command' })
  const text = el('pre', {
    class: 'ui-command-text',
    attrs: { 'aria-label': 'what it asks to run' },
  })
  into(node, text, el('p', { class: 'ui-command-cut' }))
  node.hidden = true
  return node
}

/** Show a command (`{ text, notShown }`, as a row's approval carries it), or hide it with null. */
export function commandIn(node, said) {
  node.hidden = said === null || said === undefined
  if (node.hidden) return
  const [text, cut] = node.children
  textIn(text, said.text)
  cut.hidden = said.notShown === 0
  textIn(cut, said.notShown === 0 ? '' : `… ${notShownSaid(said.notShown)}`)
}

/** `1 character not shown`, `2,048 characters not shown`. */
export function notShownSaid(n) {
  return `${n.toLocaleString('en')} character${n === 1 ? '' : 's'} not shown`
}

/**
 * A problem: what went wrong, red, with its icon, in a few words, the one
 * thing to do, and a press where the page can do it (`trouble.js` has the
 * words). Hidden until `problemIn` gives it one; `role="alert"`, so a screen
 * reader hears it once as it arrives.
 */
export function problem() {
  const node = el('div', { class: 'ui-problem', attrs: { role: 'alert' } })
  const words = el('div', { class: 'ui-problem-words' })
  into(words, el('strong'), el('span'), fixList())
  const press = el('button', { class: 'press small', attrs: { type: 'button' } })
  press.hidden = true
  into(node, icon('alert'), words, press)
  node.hidden = true
  return node
}

/**
 * The small *how to fix this* list a problem carries (`trouble.js`'s `steps`):
 * a heading and the steps, numbered, each a few words — where to click at the
 * machine, the command to run, what to pair. Hidden where there are none.
 */
function fixList() {
  const node = el('div', { class: 'ui-fix' })
  into(
    node,
    el('span', { class: 'ui-fix-head', text: 'How to fix this' }),
    el('ol', { attrs: { 'aria-label': 'How to fix this' } }),
  )
  node.hidden = true
  return node
}

function fixListIn(node, steps) {
  const list = Array.isArray(steps) ? steps : []
  node.hidden = list.length === 0
  const ol = node.lastChild
  while (ol.children.length > list.length) ol.lastElementChild?.remove()
  while (ol.children.length < list.length) ol.append(el('li'))
  list.forEach((step, at) => {
    const item = ol.children[at]
    if (item.dataset.said === step) return
    item.dataset.said = step
    // A command between backticks is set as code; every part a text node.
    item.replaceChildren(
      ...step.split('`').map((part, odd) => el(odd % 2 === 1 ? 'code' : 'span', { text: part })),
    )
  })
}

/**
 * Show a problem, or hide it with null. `action` is `{ word, run }` for the one
 * press that answers it, or nothing where the fix is at the machine. Its cause
 * (`why`) goes under the title and its steps below that; a trouble with
 * neither says its `fix` there instead.
 */
export function problemIn(node, trouble, action = null) {
  node.hidden = trouble === null
  if (trouble === null) return
  const [, words, press] = node.children
  const [title, why, steps] = words.children
  textIn(title, trouble.title)
  textIn(why, trouble.why ?? trouble.fix)
  fixListIn(steps, trouble.why === undefined ? [] : trouble.steps)
  press.hidden = action === null
  if (action !== null) {
    textIn(press, action.word)
    press.onclick = action.run
  }
}

/**
 * A status line that is Tade's sentence when a press worked and a problem when
 * it did not: the one node every press already has, so no screen grows a
 * second one. `trouble` is `troubleOf`'s answer, null for a success.
 */
export function answerIn(node, said, trouble) {
  node.classList.toggle('ui-problem', trouble !== null)
  node.classList.toggle('is-inline', trouble !== null)
  if (trouble === null) {
    textIn(node, said)
    return
  }
  const words = el('span', { class: 'ui-problem-words' })
  into(words, el('strong', { text: trouble.title }), el('span', { text: trouble.fix }))
  node.replaceChildren(icon('alert'), words)
}
