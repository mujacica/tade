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

/** A count: how many, empty and so not drawn at nought. `kind` is `wants`, `working`, `loud` or neutral. */
export function count(kind = '') {
  return el('span', { class: kind === '' ? 'ui-count' : `ui-count is-${kind}` })
}

/** Write a count: nothing at nought, `99+` past it, and the noun for a screen reader. */
export function countIn(node, n, noun) {
  textIn(node, n === 0 ? '' : n > 99 ? '99+' : String(n))
  node.setAttribute('aria-label', `${n} ${noun}`)
}

/** A meter: a share of something as a bar. `meterIn` fills it. */
export function meter() {
  const node = el('span', { class: 'ui-meter', attrs: { 'aria-hidden': 'true' } })
  into(node, el('span'))
  return node
}

/** Fill a meter to a share of a hundred, toned by how worrying it is. */
export function meterIn(node, share, pressure = 'fine') {
  const part = Math.max(0, Math.min(100, Number.isFinite(share) ? share : 0))
  node.firstChild.style.setProperty('width', `${part}%`)
  node.classList.toggle('is-warm', pressure === 'warm')
  node.classList.toggle('is-tight', pressure === 'tight')
}

/** A callout: the sentence that may never get comfortable, where somebody is deciding. */
export function callout(text, bad = false) {
  return el('p', { class: bad ? 'ui-callout is-bad' : 'ui-callout', text })
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
 * A problem: what went wrong, red, with its icon, in a few words, the one
 * thing to do, and a press where the page can do it (`trouble.js` has the
 * words). Hidden until `problemIn` gives it one; `role="alert"`, so a screen
 * reader hears it once as it arrives.
 */
export function problem() {
  const node = el('div', { class: 'ui-problem', attrs: { role: 'alert' } })
  const words = el('span', { class: 'ui-problem-words' })
  into(words, el('strong'), el('span'))
  const press = el('button', { class: 'press small', attrs: { type: 'button' } })
  press.hidden = true
  into(node, icon('alert'), words, press)
  node.hidden = true
  return node
}

/**
 * Show a problem, or hide it with null. `action` is `{ word, run }` for the one
 * press that answers it, or nothing where the fix is at the machine.
 */
export function problemIn(node, trouble, action = null) {
  node.hidden = trouble === null
  if (trouble === null) return
  const [, words, press] = node.children
  textIn(words.firstChild, trouble.title)
  textIn(words.lastChild, trouble.fix)
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

/**
 * Facts: a row of figures in one panel — a label, the value, a line under it —
 * the overview's tiles at the size of a heading. `factsIn` fills it.
 */
export function facts(label = 'Facts') {
  return el('dl', { class: 'ui-facts', attrs: { 'aria-label': label } })
}

/**
 * Fill a row of facts, reusing the cells it has: `{ label, value, under, tone }`
 * each, a null value drawn as `—` rather than left out, so the row keeps its
 * shape while a figure is unknown. A selection in a value survives a repaint
 * that wrote the same text.
 */
export function factsIn(node, cells) {
  while (node.children.length > cells.length) node.lastElementChild?.remove()
  while (node.children.length < cells.length) {
    const cell = el('div', { class: 'ui-fact' })
    into(cell, el('dt'), el('dd'), el('dd', { class: 'ui-fact-under' }))
    node.append(cell)
  }
  cells.forEach((one, at) => {
    const [label, value, under] = node.children[at].children
    textIn(label, one.label)
    textIn(value, one.value ?? '—')
    toneOn(value, one.tone ?? null)
    textIn(under, one.under ?? '')
    under.hidden = one.under === undefined || one.under === null || one.under === ''
  })
}
