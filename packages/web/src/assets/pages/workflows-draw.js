// The workflows page's own drawings, each a **create and a fill** like a chart
// (`charts.js`): a workflow's shape as a small map, the line of its versions,
// and the runs stamped from it as marks and counts.
//
// All three are this page's for now and listed under *Shared components
// wanted*: a graph small enough to sit on a card is the runs page's map too,
// and a line of versions is what any page showing a published thing would
// draw. The geometry and the words are `workflows-shape.js`' and pure; what is
// here only puts them into nodes that already exist, so a delta moves a dot
// rather than rebuilding the drawing.

import { classOn, el, into, keyed, textIn, toneOn } from '../dom.js'
import { svgOf } from '../icons.js'
import { MAP, shapeOf, shapeSaid, stagesOf, versionsOf, versionsSaid } from './workflows-shape.js'

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

/* ── the shape: a map, and the stages beside it ────────────────────────────── */

/**
 * A workflow's shape as a card has room for it: the map — a column per stage,
 * a dot per step, a curve from each to what waits on it — and beside it the
 * stages in words, a number and the steps in it. The map is decoration over
 * the words (`aria-hidden`), and the words are real text a person can read
 * and select.
 */
export function shape(extra = '') {
  const node = el('div', { class: extra === '' ? 'wf-shape' : `wf-shape ${extra}` })
  const svg = svgOf('svg', { class: 'wf-map', focusable: 'false', 'aria-hidden': 'true' })
  if (svg !== null) {
    svg.append(svgOf('g', { class: 'wf-map-lines' }), svgOf('g', { class: 'wf-map-dots' }))
    node.append(svg)
  }
  const stages = el('ol', { class: 'wf-shape-stages' })
  const said = el('p', { class: 'wf-shape-said' })
  return into(node, stages, said)
}

export function shapeIn(node, row) {
  const drawn = shapeOf(row.places)
  const svg = node.querySelector('svg')
  if (svg !== null) {
    svg.hidden = drawn.dots.length === 0
    attrIn(svg, 'viewBox', `0 0 ${Math.max(1, drawn.width)} ${Math.max(1, drawn.height)}`)
    attrIn(svg, 'width', drawn.width)
    attrIn(svg, 'height', drawn.height)
    const [lines, dots] = svg.children
    sized(lines, drawn.lines.length, () => svgOf('path', { class: 'wf-map-line' }))
    drawn.lines.forEach((one, at) => {
      attrIn(lines.children[at], 'd', one.d)
    })
    sized(dots, drawn.dots.length, () => svgOf('circle', { class: 'wf-map-dot' }))
    drawn.dots.forEach((one, at) => {
      const dot = dots.children[at]
      attrIn(dot, 'cx', one.x)
      attrIn(dot, 'cy', one.y)
      attrIn(dot, 'r', MAP.r)
    })
  }
  const stages = node.querySelector('.wf-shape-stages')
  keyed(
    stages,
    stagesOf(row),
    (stage) => stage.key,
    createStageLine,
    (item, stage) => {
      const [n, heard, names] = item.children
      textIn(n, stage.n === null ? '↻' : String(stage.n))
      textIn(heard, stage.heard)
      classOn(item, 'is-cycle', stage.n === null)
      textIn(names, stage.steps.map((one) => one.name).join(' · '))
    },
  )
  textIn(node.querySelector('.wf-shape-said'), shapeSaid(row.places))
}

function createStageLine() {
  const item = el('li')
  // The number is drawn; what a screen reader hears is the stage and what it waits on.
  return into(
    item,
    el('span', { class: 'wf-shape-n', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'sr-only' }),
    el('span', { class: 'wf-shape-names' }),
  )
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
 * finished` — or *never run*. Each mark is a glyph in its tone with its word
 * beside it, so the colour is never the only thing saying it.
 */
export function runsLine() {
  const node = el('p', { class: 'wf-runs' })
  const none = el('span', { class: 'wf-runs-none', text: 'never run' })
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
