// A section: the one piece every part of the overview is headed by — the
// agents waiting on you, the agents working, the conversation — and the
// blocks of a card's controls (`controls.js`).

import { el, hintOf, into } from './dom.js'

/**
 * A section: a heading, a figure, and a body that is never left blank.
 *
 * The heading is the page's one uppercase and carries an `aria-label` in
 * sentence case, so a screen reader reads a heading instead of spelling it. The
 * body is a landmark of its own (`aria-labelledby`), which is what makes the
 * page navigable by region rather than by scrolling.
 */
let seq = 0

export function section(title, opts = {}) {
  seq += 1
  const id = `h${seq}`
  const node = el('section', { class: 'section', attrs: { 'aria-labelledby': id } })
  const head = el('div', { class: 'section-head' })
  const heading = el('h2', { text: title, attrs: { id, 'aria-label': sentence(title) } })
  const figure = el('span', { class: 'figure' })
  into(head, heading, figure)
  // What the section is, when it needs saying: one `?` at the end of its line,
  // the sentence under it only when asked — never a paragraph on the page.
  const hint = opts.hint === undefined ? null : hintOf(opts.hint)
  if (hint !== null) head.append(hint.press)
  const body = el('div')
  into(node, head)
  if (hint !== null) into(node, hint.body)
  into(node, body)
  return { node, body, figure, heading }
}

/** `WANTS YOU` read aloud as "Wants you", not as five letters and three. */
function sentence(title) {
  const words = title.toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}
