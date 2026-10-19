// Building the page, and the one thing that is hard about it: changing it
// without taking somebody's place in it away.
//
// **Every value reaches the DOM through `textContent`.** There is no markup
// path here at all — no template string that becomes HTML, no attribute built
// by concatenation, and the one reader of markdown (`markdown.js`) builds its
// own nodes from a closed list and puts every character in a text node — so a
// note somebody pasted a `<script>` into is a note that says `<script>`. The content policy has no
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
 *
 * **The parent is the list and holds nothing else.** The rows are placed at
 * the front, so a child without a `data-key` is not removed but does end up
 * after them — which is almost never what somebody who put it there meant. A
 * sentence that belongs beside a list goes next to the list's parent, not
 * inside it. `test/dom.test.ts` pins that behaviour so it is a decision rather
 * than a surprise.
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
  return el('p', { class: 'empty nothing', text: said })
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
 * Free text somebody wrote, whole, foldable.
 *
 * **Whole, and never an ellipsis.** Every text crosses whole (`BUDGET` in
 * `page.ts`), and the house rule about a note is that it is never reworded:
 * three dots written into the text cannot be told from three dots the person
 * typed. `white-space: pre-wrap` keeps the shape they typed it in and long
 * lines wrap; a block taller than its box scrolls inside it (`.said.whole`),
 * and that box takes the keyboard only while it has somewhere to scroll
 * (`scrollsIn`), so a short note is not a tab stop.
 *
 * The fold is **this page's** and opens onto all of it with one press.
 */
export function proseOf(said, folded = false) {
  if (said === null || said === undefined) return null
  const node = el('div')
  const body = el('p', { class: folded ? 'said whole folded' : 'said whole', text: said.words })
  into(node, body)
  if (folded) {
    const more = el('button', { class: 'more', text: 'more', attrs: { type: 'button' } })
    more.addEventListener('click', () => {
      classOn(body, 'folded', false)
      more.replaceWith(el('span', { class: 'sr-only', text: 'shown in full' }))
    })
    into(node, more)
  }
  scrollsIn(body)
  return node
}

let sizes = null

/**
 * Watch one box of prose, and let the keyboard into it exactly while it
 * scrolls: a region that scrolls and cannot be reached from the keyboard is
 * one a person without a pointer cannot read to its end. One observer for the
 * page, and a box that left it is let go when its size falls to nothing.
 */
function scrollsIn(body) {
  if (typeof ResizeObserver !== 'function') return
  sizes ??= new ResizeObserver((seen) => {
    for (const one of seen) {
      const box = one.target
      if (!box.isConnected) {
        sizes.unobserve(box)
        continue
      }
      const scrolls = !box.classList.contains('folded') && box.scrollHeight > box.clientHeight + 1
      if (scrolls) box.setAttribute('tabindex', '0')
      else box.removeAttribute('tabindex')
    }
  })
  sizes.observe(body)
}

let hints = 0

/**
 * An explanation behind a press: a small `?` that opens the sentence under it.
 *
 * **The surface is options and values; the explanation lives where somebody
 * asks.** A sentence that is true and worth having — why a bar is up, why a
 * box is not drawn — is kept, whole and verbatim, one tap away, rather than
 * set as a paragraph across a screen that is otherwise figures. A button and
 * not a hover, because a phone has no pointer to hover with, and
 * `aria-expanded` so a screen reader hears that there is more and whether it
 * is open.
 *
 * Returns the two nodes so a caller can put the press in its line and the
 * body under it; `said` is the sentence and is never reworded here.
 */
export function hintOf(said, klass = 'hint-body') {
  hints += 1
  const id = `hint${hints}`
  const press = el('button', {
    class: 'hint',
    text: '?',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': 'Why' },
  })
  const body = el('p', { class: klass, text: said, attrs: { id } })
  body.hidden = true
  press.addEventListener('click', () => {
    body.hidden = !body.hidden
    press.setAttribute('aria-expanded', body.hidden ? 'false' : 'true')
  })
  return { press, body }
}

/**
 * Write a figure, and mark that it moved: `bump` replays a short flash on the
 * node so a number that changed under somebody's eyes is seen to have.
 *
 * Only on a change — a beat that wrote the same figure again is not news —
 * and only after the first write, which is arriving rather than changing.
 */
export function figureIn(node, said) {
  const want = said === null || said === undefined ? '' : String(said)
  if (node.textContent === want) return false
  const first = node.textContent === ''
  node.textContent = want
  if (!first) {
    node.classList.remove('bump')
    // Reading a layout property restarts the animation the class names.
    void node.offsetWidth
    node.classList.add('bump')
  }
  return true
}

/**
 * `hintOf` for more than one sentence: a `?` and a region to put them in.
 *
 * The region is the caller's to fill, and is hidden until asked for; the
 * press says what it is about in its label, since a `?` alone is a glyph.
 */
export function foldOf(label) {
  hints += 1
  const id = `fold${hints}`
  const press = el('button', {
    class: 'hint',
    text: '?',
    attrs: { type: 'button', 'aria-expanded': 'false', 'aria-controls': id, 'aria-label': label },
  })
  const body = el('div', { class: 'fold ui-panel', attrs: { id } })
  body.hidden = true
  press.addEventListener('click', () => {
    body.hidden = !body.hidden
    press.setAttribute('aria-expanded', body.hidden ? 'false' : 'true')
  })
  return { press, body }
}

/**
 * A press that did something, felt: one short tick where the device can give
 * one (Android's vibration; iOS gives none to a page, and that is fine).
 */
export function felt() {
  try {
    navigator.vibrate?.(8)
  } catch {
    // A browser that has the method and refuses it has nothing to feel.
  }
}

/**
 * Write a row's state, and mark that it changed: a state that moved under
 * somebody's eyes — working to review, waiting to running — glows once
 * (`motion.css`), so the change is seen rather than found.
 *
 * Only on a change from a state the row already showed: a row arriving is
 * not a row changing.
 */
export function stateIn(node, state) {
  const was = node.getAttribute('data-state')
  if (was === state) return
  node.setAttribute('data-state', state)
  if (was === null) return
  node.classList.remove('changed')
  void node.offsetWidth
  node.classList.add('changed')
}

/** Which sections somebody folded, for as long as the page is open. */
const folded = new Set()

/**
 * Make a section fold: a press in its header that hides its body and shows
 * it again, with `aria-expanded`, remembered by `key` while the page is
 * open — so a delta, or coming back to the screen, leaves it as it was left.
 */
export function foldable(made, key) {
  hints += 1
  const id = `fold-body${hints}`
  made.body.setAttribute('id', id)
  const press = el('button', {
    class: 'section-fold',
    attrs: { type: 'button', 'aria-controls': id },
  })
  const set = (open) => {
    made.body.hidden = !open
    press.setAttribute('aria-expanded', open ? 'true' : 'false')
    press.setAttribute('aria-label', `${open ? 'Fold' : 'Unfold'} ${made.heading.textContent}`)
    made.node.classList.toggle('is-folded', !open)
  }
  press.addEventListener('click', () => {
    const open = made.body.hidden
    if (open) folded.delete(key)
    else folded.add(key)
    set(open)
  })
  set(!folded.has(key))
  made.figure.after(press)
  return press
}
