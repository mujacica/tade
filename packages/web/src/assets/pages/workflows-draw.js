// The workflows page's own drawings, each a **create and a fill** like a chart
// (`charts.js`): a workflow's shape as a track of named dots, the line of its
// versions, and the runs stamped from it as marks and counts.
//
// All three are this page's for now and listed under *Shared components
// wanted*: a graph small enough to sit on a card is the runs page's map too,
// and a line of versions is what any page showing a published thing would
// draw. The geometry and the words are `workflows-shape.js`' and pure; what is
// here only puts them into nodes that already exist, so a delta moves a dot
// rather than rebuilding the drawing.

import { classOn, el, into, keyed, textIn, toneOn } from '../dom.js'
import { svgOf } from '../icons.js'
import { shapeSaid, trackOf, trackSaid, versionsOf, versionsSaid } from './workflows-shape.js'

/** An attribute, written only when it changed, so a repaint touches nothing that stayed. */
function attrIn(node, name, value) {
  const want = String(value)
  if (node.getAttribute(name) !== want) node.setAttribute(name, want)
}

/** A group holding exactly `n` children, made by `make`, reusing the ones it has. */
function sized(group, n, make) {
  while (group.children.length > n) group.lastChild.remove()
  while (group.children.length < n) group.append(make())
}

/**
 * A heading's figure and its noun for a screen reader — the noun only where
 * there is a figure, because a label on an empty span is a name for nothing
 * (axe's `aria-prohibited-attr`).
 */
export function figureSaid(node, said, n, noun) {
  textIn(node, said)
  if (said === '') node.removeAttribute('aria-label')
  else attrIn(node, 'aria-label', `${n} ${noun}`)
}

/* ── the shape: a track of named dots ──────────────────────────────────────── */

/** A CSS variable on one element, through the CSSOM — the policy refuses a `style` attribute. */
function varIn(node, name, value) {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value)
}

/**
 * A workflow's shape as a card has room for it: **a track** — a column per
 * stage spread evenly across the card, each step a dot with its name over it,
 * and a line from each dot to the dot of what waits on it — with the count in
 * words under it.
 *
 * `role="img"` with `trackSaid`'s sentence, which has every name whole. A name
 * longer than its column has room for wraps to two lines and is then cut;
 * hovering it or tapping it shows it whole (`.is-cut`, measured after the
 * page lays it out), and a tap anywhere else on the card still opens the
 * workflow, where every step is named in full.
 */
export function shape(extra = '') {
  const node = el('div', { class: extra === '' ? 'wf-shape' : `wf-shape ${extra}` })
  const track = el('div', { class: 'wf-track', attrs: { role: 'img', 'aria-label': 'steps' } })
  const svg = svgOf('svg', {
    class: 'wf-track-lines',
    focusable: 'false',
    'aria-hidden': 'true',
    preserveAspectRatio: 'none',
  })
  if (svg !== null) track.append(svg)
  track.append(el('ol', { class: 'wf-track-steps' }))
  // Wired once: a tap on a name that was cut shows it whole, and a second tap
  // puts it back. Only a cut name takes the pointer (`.is-cut`), so a tap on
  // anything else falls through to the card's own link.
  track.addEventListener('click', (event) => {
    const hit = event.target instanceof Element ? event.target.closest('.wf-track-name') : null
    if (hit === null || !hit.classList.contains('is-cut')) return
    const open = !hit.classList.contains('is-open')
    for (const one of track.querySelectorAll('.wf-track-name.is-open'))
      classOn(one, 'is-open', false)
    classOn(hit, 'is-open', open)
  })
  const said = el('p', { class: 'wf-shape-said' })
  return into(node, track, said)
}

export function shapeIn(node, row) {
  const drawn = trackOf(row.places)
  const [track, said] = node.children
  track.hidden = drawn.steps.length === 0
  attrIn(track, 'aria-label', trackSaid(row))
  varIn(track, '--fh', `${drawn.height}px`)
  const svg = track.querySelector('svg')
  if (svg !== null) {
    attrIn(svg, 'viewBox', `0 0 ${Math.max(1, drawn.width)} ${Math.max(1, drawn.height)}`)
    sized(svg, drawn.lines.length, () =>
      svgOf('path', { class: 'wf-track-line', 'vector-effect': 'non-scaling-stroke' }),
    )
    drawn.lines.forEach((one, at) => {
      attrIn(svg.children[at], 'd', one.d)
    })
  }
  const steps = track.querySelector('.wf-track-steps')
  keyed(
    steps,
    drawn.steps,
    (one) => one.name,
    createTrackStep,
    (item, one) => {
      varIn(item, '--x', `${one.left}%`)
      varIn(item, '--y', `${one.top}px`)
      varIn(item, '--w', `${100 / drawn.cols}%`)
      for (const edge of ['start', 'middle', 'end']) classOn(item, `is-${edge}`, one.edge === edge)
      textIn(item.firstChild, one.name)
    },
  )
  textIn(said, shapeSaid(row.places))
  cutLater(track)
}

function createTrackStep() {
  const item = el('li', { class: 'wf-track-step' })
  return into(item, el('span', { class: 'wf-track-name' }), el('span', { class: 'wf-track-dot' }))
}

/** Tracks waiting for the page to lay them out before their names are measured. */
const MEASURING = new WeakSet()

/**
 * Which names are cut, read once the page has laid them out — a name is cut
 * where its two lines hold less than it says. **Read after the frame and not
 * in the fill**, because a card being filled for the first time is not on the
 * page yet and measures nothing.
 */
function cutLater(track) {
  if (MEASURING.has(track) || typeof requestAnimationFrame !== 'function') return
  MEASURING.add(track)
  requestAnimationFrame(() => {
    MEASURING.delete(track)
    for (const name of track.querySelectorAll('.wf-track-name')) {
      if (name.classList.contains('is-open')) continue
      classOn(
        name,
        'is-cut',
        name.scrollHeight > name.clientHeight + 1 || name.scrollWidth > name.clientWidth + 1,
      )
    }
  })
}

/* ── the line of its versions ──────────────────────────────────────────────── */

/**
 * The versions as a line: a filled stop per published version, oldest first,
 * the newest one lit, and the draft after them as a ring on a dashed line —
 * because it is a promise and not a snapshot yet. Under a version a run points
 * at, how many. `role="img"`, and its sentence is `versionsSaid`'s.
 */
export function versionLine(extra = '') {
  const node = el('div', {
    class: extra === '' ? 'wf-versions' : `wf-versions ${extra}`,
    attrs: { role: 'img', 'aria-label': 'versions' },
  })
  const earlier = el('span', { class: 'wf-versions-earlier' })
  const list = el('ol', { class: 'wf-versions-line' })
  return into(node, earlier, list)
}

export function versionLineIn(node, row, runs) {
  const line = versionsOf(row, runs)
  attrIn(node, 'aria-label', `Versions: ${versionsSaid(row, runs)}`)
  const [earlier, list] = node.children
  textIn(earlier, line.earlier === 0 ? '' : `${line.earlier} earlier`)
  earlier.hidden = line.earlier === 0
  node.hidden = line.marks.length === 0
  // A draft that would not publish is drawn in the tone the lead gives it.
  classOn(node, 'is-broken', row.problems.length > 0)
  keyed(
    list,
    line.marks,
    (one) => one.key,
    () => {
      const item = el('li', { class: 'wf-version' })
      return into(
        item,
        el('span', { class: 'wf-version-dot' }),
        el('span', { class: 'wf-version-label' }),
        el('span', { class: 'wf-version-under' }),
      )
    },
    (item, one) => {
      const [, label, under] = item.children
      for (const kind of ['published', 'newest', 'draft']) {
        classOn(item, `is-${kind}`, one.kind === kind)
      }
      textIn(label, one.label)
      textIn(under, one.under)
    },
  )
}

/* ── the runs stamped from it ──────────────────────────────────────────────── */

/**
 * The runs from a workflow as marks and counts — `● 1 under way · ✓ 2
 * finished` — or *no plans yet*. Each mark is a glyph in its tone with its word
 * beside it, so the colour is never the only thing saying it.
 */
export function runsLine() {
  const node = el('p', { class: 'wf-runs' })
  const none = el('span', { class: 'wf-runs-none', text: 'no plans yet' })
  return into(node, none, el('span', { class: 'wf-runs-parts' }))
}

export function runsLineIn(node, line) {
  const [none, parts] = node.children
  none.hidden = line.total > 0
  keyed(
    parts,
    line.parts,
    (one) => one.key,
    () => {
      const part = el('span', { class: 'wf-runs-part' })
      return into(
        part,
        el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'wf-runs-n' }),
        el('span', { class: 'wf-runs-word' }),
      )
    },
    (part, one) => {
      const [glyph, n, word] = part.children
      textIn(glyph, one.glyph)
      toneOn(glyph, one.tone)
      textIn(n, String(one.n))
      textIn(word, one.word)
    },
  )
}
