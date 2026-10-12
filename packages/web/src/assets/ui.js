// The components, made: one factory per look the page repeats (`ui.css`).
//
// **A screen asks for a pill rather than building one.** Each factory returns
// the element with the component's class and nothing else the screen did not
// ask for, so a component looks the same on every screen and changing how it
// looks is one rule in `ui.css`. Text goes in through `textContent` as it does
// everywhere on this page; nothing here builds markup.

import { el, hintOf, into, textIn } from './dom.js'
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
