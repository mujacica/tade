// The runs page's own drawings, each a **create and a fill** like a chart
// (`charts.js`): a run's map — its graph in dots, the size of a card — and a
// run's track, one segment per step.
//
// Both are this page's for now and are listed under *Shared components
// wanted*: a graph small enough to sit in a row is something the queue and the
// designer would draw too. The geometry is `runs-shape.js`'s and pure; what is
// here only puts it into nodes that already exist, so a delta twice a second
// moves a dot rather than rebuilding the drawing.

import { toneIn } from '../charts.js'
import { classOn, el } from '../dom.js'
import { svgOf } from '../icons.js'
import { dotPath, inOrder, MAP, mapOf, mapSaid, partOf, toneOfPart } from './runs-shape.js'

/** The parts drawn as an outline rather than filled: somewhere along the way, not arrived. */
const HOLLOW = new Set(['waiting', 'review', 'parked'])

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

/* ── a run's map ───────────────────────────────────────────────────────────── */

/**
 * A run's graph in dots: a column per stage, a dot per step in the shape and
 * tone of its mark, and a line from each step to what waits on it — solid
 * where the step it leaves has finished, dashed where it is still a promise.
 * A step at work breathes as its glyph does in a row.
 *
 * `role="img"`, and its sentence is written by the fill (`mapSaid`): the dots
 * are a picture of the counts the card says in words beside it.
 */
export function runMap() {
  const node = el('span', { class: 'runs-map', attrs: { role: 'img', 'aria-label': 'steps' } })
  const svg = svgOf('svg', { class: 'runs-map-svg', focusable: 'false', 'aria-hidden': 'true' })
  if (svg !== null) {
    svg.append(svgOf('g', { class: 'runs-map-lines' }), svgOf('g', { class: 'runs-map-dots' }))
    node.append(svg)
  }
  return node
}

export function runMapIn(node, run, room = 0) {
  const drawn = mapOf(run, room)
  attrIn(node, 'aria-label', mapSaid(run))
  node.hidden = drawn.dots.length === 0
  const svg = node.firstChild
  if (svg === null || svg === undefined || drawn.dots.length === 0) return
  attrIn(svg, 'viewBox', `0 0 ${drawn.width} ${drawn.height}`)
  attrIn(svg, 'width', drawn.width)
  attrIn(svg, 'height', drawn.height)
  const [lines, dots] = svg.children
  sized(lines, drawn.lines.length, () => svgOf('path', { class: 'runs-map-line' }))
  drawn.lines.forEach((one, at) => {
    const line = lines.children[at]
    attrIn(line, 'd', one.d)
    classOn(line, 'is-ahead', !one.done)
  })
  sized(dots, drawn.dots.length, () => {
    const dot = svgOf('g', { class: 'runs-map-dot' })
    dot.append(
      svgOf('circle', { class: 'runs-map-halo' }),
      svgOf('path', { class: 'runs-map-shape' }),
    )
    return dot
  })
  drawn.dots.forEach((one, at) => {
    const dot = dots.children[at]
    const [halo, shape] = dot.children
    toneIn(dot, toneOfPart(one.part))
    classOn(dot, 'is-hollow', HOLLOW.has(one.part))
    classOn(dot, 'is-working', one.part === 'working')
    attrIn(halo, 'cx', one.x)
    attrIn(halo, 'cy', one.y)
    attrIn(halo, 'r', MAP.r)
    attrIn(shape, 'd', dotPath(one))
  })
}

/* ── a run's track ─────────────────────────────────────────────────────────── */

/**
 * A run's progress as a line of segments, **one per step**, in the order the
 * map draws them, each in its step's tone — so "two of six" is two green
 * segments of six, and the violet one is the one to go and look at. Decoration
 * over the fraction written beside it, so `aria-hidden`.
 */
export function track(extra = '') {
  return el('span', {
    class: extra === '' ? 'runs-track' : `runs-track ${extra}`,
    attrs: { 'aria-hidden': 'true' },
  })
}

export function trackIn(node, run) {
  const steps = inOrder(run.steps)
  sized(node, steps.length, () => el('span'))
  steps.forEach((step, at) => {
    toneIn(node.children[at], toneOfPart(partOf(step)))
  })
}
