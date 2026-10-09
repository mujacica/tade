// Building the page, and the one thing that is hard about it: changing it
// without taking somebody's place in it away.
//
// **Every value reaches the DOM through `textContent`.** There is no markup
// path here at all — no template string that becomes HTML, no Markdown
// renderer, no attribute built by concatenation — so a note somebody pasted a
// `<script>` into is a note that says `<script>`. The content policy has no
// `unsafe-inline` to fall back on and `test/assets.test.ts` asserts no file in
// this folder so much as reaches for `innerHTML`, but the reason those two hold
// is that nothing here wants them.
//
// **A delta must not move the page under somebody's hands.** Two rules do that
// work:
//
// 1. **A screen is built once and then patched.** Each one returns its node and
//    an `update` that writes text and classes into the nodes it already made.
//    Nothing re-creates a region because a figure moved, so focus stays where
//    the keyboard put it, a half-made text selection survives, and the scroll
//    position is the browser's own business.
// 2. **A list is reconciled by key, and a row is only moved when the order
//    actually changed.** Re-inserting a node blurs what is focused inside it in
//    some browsers, so `keyed` compares what is already at each position first
//    and leaves it alone when it is right.
//
// `textIn` writes only when the text differs, for the same reason: assigning
// `textContent` collapses a selection inside the node even when the bytes are
// identical.

/**
 * One element. `class` and `text` because they are nine in ten of the calls,
 * `attrs` for the rest, and no child list — a parent appends, which keeps the
 * reading order of the code the reading order of the page.
 */
export function el(tag, props = {}) {
  const node = document.createElement(tag)
  if (props.class !== undefined) node.className = props.class
  if (props.text !== undefined) node.textContent = props.text
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === null || value === undefined) continue
    node.setAttribute(name, String(value))
  }
  return node
}

/** Several children at once, in order, skipping the nulls a caller passes. */
export function into(parent, ...children) {
  for (const child of children) if (child !== null && child !== undefined) parent.append(child)
  return parent
}

/**
 * Text, written only when it changed.
 *
 * The guard is not an optimisation: assigning `textContent` replaces the node's
 * children, which collapses a text selection inside it and scrolls a long
 * region back to the top — even when the bytes are the same. On a page that
 * redraws every two seconds that is a selection nobody can make.
 */
export function textIn(node, said) {
  const want = said === null || said === undefined ? '' : String(said)
  if (node.textContent !== want) node.textContent = want
  return node
}

/** A class, on or off, written only when it changed. */
export function classOn(node, name, on) {
  if (node.classList.contains(name) !== on) node.classList.toggle(name, on)
}

/** The tone class of a mark, swapped without disturbing the others. */
const TONES = [
  't-wants',
  't-failed',
  't-working',
  't-done',
  't-here',
  't-quiet',
  'is-live',
  'is-stale',
  'is-reconnecting',
  'is-gone',
  'is-closed',
]

export function toneOn(node, tone) {
  for (const name of TONES) classOn(node, name, name === tone)
}

/**
 * A state's glyph with its word beside it, where the word is for a screen
 * reader and the glyph is for everybody.
 *
 * **A state is never colour alone.** The glyph differs in shape, the word says
 * it in letters, and the tone is the third thing rather than the only one — so
 * the page reads correctly to somebody who does not see the hue, and to
 * somebody who is listening to it.
 */
export function glyphOf(mark, extra = '') {
  const node = el('span', { class: `glyph ${mark.tone}${extra === '' ? '' : ` ${extra}`}` })
  const sign = el('span', { attrs: { 'aria-hidden': 'true' }, text: mark.glyph })
  return into(node, sign, el('span', { class: 'sr-only', text: ` ${mark.word}` }))
}

/** The same, repainted in place: the glyph, the word and the tone together. */
export function markIn(node, mark) {
  const [sign, word] = node.children
  if (sign !== undefined) textIn(sign, mark.glyph)
  if (word !== undefined) textIn(word, ` ${mark.word}`)
  toneOn(node, mark.tone)
}

/**
 * A figure, with the count's own noun for anybody listening.
 *
 * `5` on its own is read aloud as "five", which is not an answer to anything.
 * The visible text stays the figure and the noun goes in an `aria-label`, so
 * the column still lines up.
 */
export function figureOf(said, label, klass = 'figure') {
  return el('span', { class: klass, text: said, attrs: { 'aria-label': label } })
}

/**
 * A list, reconciled by key.
 *
 * `create` makes a row's node and `fill` writes a row into one, so a row that
 * was already here is **filled and not rebuilt** — which is what keeps focus,
 * a text selection and the scroll where they were. A node is moved only when
 * what is already at its position is the wrong one: re-inserting an element
 * blurs whatever is focused inside it in some browsers, and a list that
 * reordered nothing would otherwise blur the row somebody was on twice a
 * second.
 */
export function keyed(parent, rows, keyOf, create, fill) {
  const held = new Map()
  for (const node of parent.children) {
    const key = node.getAttribute('data-key')
    if (key !== null) held.set(key, node)
  }
  let at = 0
  for (const row of rows) {
    const key = keyOf(row)
    let node = held.get(key)
    if (node === undefined) {
      node = create(row)
      node.setAttribute('data-key', key)
    } else {
      held.delete(key)
    }
    fill(node, row)
    const here = parent.children[at]
    if (here !== node) {
      if (here === undefined) parent.append(node)
      else parent.insertBefore(node, here)
    }
    at += 1
  }
  // Whatever is left was not in the new rows. Removed last, so the comparison
  // above is against a list that still has them and never shuffles twice.
  for (const node of held.values()) node.remove()
}

/**
 * A region's four drawings, in one place: coming, empty, unknown, and failed.
 *
 * The default for all four is a blank area that reads as broken, which is why
 * none of them is left to a caller to remember. `skeleton` draws the row
 * height it is expecting rather than a spinner — *this many rows are coming* is
 * a different and more useful claim than *something is happening*.
 */
export function skeleton(rows = 3) {
  const node = el('div', { class: 'skeleton', attrs: { 'aria-busy': 'true' } })
  for (let n = 0; n < rows; n += 1) node.append(el('span'))
  return node
}

export function empty(said) {
  return el('p', { class: 'empty', text: said })
}

/**
 * `—`, and **which** unknown it is.
 *
 * Three cases and never one: not run here, not recorded, could not look. A
 * failed look drawn as an empty list is the one degradation that reads as
 * "nothing is happening", which is why the word is not optional.
 */
export function unknown(word) {
  const node = el('p', { class: 'unknown' })
  return into(node, el('span', { class: 'dash', text: '—' }), el('span', { text: word }))
}

/**
 * Free text somebody wrote, as much of it as the budget allowed, foldable.
 *
 * **`more` and never an ellipsis.** The house rule about a note is that it is
 * never reworded, and three dots written into the text cannot be told from
 * three dots the person typed. So what the page draws is the prefix it was
 * given and a control that says there is more of it — and `white-space:
 * pre-wrap` keeps the shape they typed it in.
 *
 * Two different "more" are deliberately told apart. The fold is **this page's**
 * and opens; `said.more` is **the budget's** and cannot, because the rest of
 * those words never left the machine. A page that offered to expand what it was
 * not sent would be a control that does nothing.
 */
export function proseOf(said, folded = false) {
  if (said === null || said === undefined) return null
  const node = el('div')
  const body = el('p', { class: folded ? 'said folded' : 'said', text: said.words })
  into(node, body)
  const capped = () =>
    said.more ? el('p', { class: 'unknown', text: 'more than this was written down' }) : null
  if (folded) {
    const more = el('button', { class: 'more', text: 'more', attrs: { type: 'button' } })
    more.addEventListener('click', () => {
      classOn(body, 'folded', false)
      more.replaceWith(capped() ?? el('span', { class: 'sr-only', text: 'shown in full' }))
    })
    into(node, more)
  } else {
    into(node, capped())
  }
  return node
}
