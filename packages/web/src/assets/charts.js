// The charts: the stat tile and its sparkline, which the overview's four tiles
// are drawn with (`pages/overview.js`).
//
// **Numbers in, a drawing out, and the numbers are on the page as words too.**
// Each component is a **create and a fill**, like a row (`rows.js`): built once,
// then patched on every delta, so a chart that moves never takes the keyboard's
// place or a half-made selection with it. And each one carries its own text
// alternative — a sentence on a `role="img"`, or real text beside the marks —
// so nothing here is the only statement of anything (1.1.1, 1.4.1).
//
// **Tone is a word, never a colour.** A mark takes one of `TONES` and the
// stylesheet (`charts.css`) maps it to the palette's meaning: `wants` violet,
// `working` amber, `done` green, `failed` red, `here` amber, `queued` and
// `quiet` grey, `unknown` a hatch. A page never names a hex, and a category
// that is not a state (a project, a model) is told apart by its **label**, not
// by a sixth hue — ranked bars, not a rainbow (DESIGN.md).
//
// **Unknown is never drawn as nought.** A value nobody could read is a dash in
// a figure and a gap in a line.
//
// **No inline style and no markup.** Geometry reaches the drawing as SVG
// attributes or as CSS custom properties set through the CSSOM
// (`style.setProperty`), which the content policy allows and a `style=` would
// not. SVG elements are made in the namespace the sprite already has
// (`svgOf`), so no file spells a URL.

import { classOn, el, into, textIn } from './dom.js'
import { svgOf } from './icons.js'

/** The words a mark may be toned with, each a `tone-*` class in `charts.css`. */
export const TONES = ['wants', 'working', 'done', 'failed', 'here', 'queued', 'quiet', 'unknown']

/** Put one tone on a node, taking any other off. Anything else is no tone. */
export function toneIn(node, tone) {
  for (const one of TONES) classOn(node, `tone-${one}`, one === tone)
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round = (value) => Math.round(value * 100) / 100

/** A CSS custom property, written only when it changed. */
function varIn(node, name, value) {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value)
}

/* ── a sparkline: how a figure moved, with the gaps where nobody looked ───── */

/** The sparkline's drawing box; the SVG stretches it to whatever room it has. */
const SPARK = { w: 100, h: 32 }

/**
 * A sparkline's geometry, pure: one line and one area per run of known values
 * (a `null` breaks the line rather than dropping it to nought), and where the
 * last known value is, as percentages, for the dot drawn over the end.
 */
export function sparkPath(values, w = SPARK.w, h = SPARK.h) {
  const known = values.filter(isNumber)
  if (known.length === 0) return { lines: [], areas: [], last: null }
  const lo = Math.min(...known)
  const hi = Math.max(...known)
  const n = values.length
  const x = (at) => round(n === 1 ? w : (at / (n - 1)) * w)
  // A flat series is a line through the middle, not one lying on the floor.
  const y = (value) => round(hi === lo ? h / 2 : h - ((value - lo) / (hi - lo)) * (h - 2) - 1)
  const lines = []
  const areas = []
  let run = []
  const close = () => {
    if (run.length > 1) {
      const points = run.map(([px, py]) => `${px} ${py}`)
      lines.push(`M${points.join('L')}`)
      areas.push(`M${run[0][0]} ${h}L${points.join('L')}L${run.at(-1)[0]} ${h}Z`)
    }
    run = []
  }
  let last = null
  values.forEach((value, at) => {
    if (!isNumber(value)) {
      close()
      return
    }
    run.push([x(at), y(value)])
    last = { x: round((x(at) / w) * 100), y: round((y(value) / h) * 100) }
  })
  close()
  return { lines, areas, last }
}

/** A sparkline: decoration beside a figure that says the number in words. */
export function spark() {
  const node = el('span', { class: 'ui-spark', attrs: { 'aria-hidden': 'true' } })
  const svg = svgOf('svg', {
    viewBox: `0 0 ${SPARK.w} ${SPARK.h}`,
    preserveAspectRatio: 'none',
    focusable: 'false',
  })
  if (svg !== null) {
    svg.append(svgOf('g', { class: 'ui-spark-area' }), svgOf('g', { class: 'ui-spark-line' }))
    node.append(svg)
  }
  node.append(el('span', { class: 'ui-spark-dot' }))
  return node
}

/** Draw a series into a sparkline, in a tone (`working` by default). */
export function sparkIn(node, values, tone = 'working') {
  toneIn(node, tone)
  const drawn = sparkPath(values ?? [])
  const svg = node.querySelector('svg')
  if (svg !== null) {
    const [areas, lines] = svg.children
    pathsIn(areas, drawn.areas)
    pathsIn(lines, drawn.lines, { 'vector-effect': 'non-scaling-stroke' })
  }
  const dot = node.lastChild
  dot.hidden = drawn.last === null
  if (drawn.last !== null) {
    varIn(dot, '--x', `${drawn.last.x}%`)
    varIn(dot, '--y', `${drawn.last.y}%`)
  }
}

/** One `<path>` per shape, reusing the ones already there. */
function pathsIn(group, shapes, attrs = {}) {
  while (group.children.length > shapes.length) group.lastChild.remove()
  while (group.children.length < shapes.length) group.append(svgOf('path', attrs))
  shapes.forEach((d, at) => {
    const path = group.children[at]
    if (path.getAttribute('d') !== d) path.setAttribute('d', d)
  })
}

/* ── a stat: the one figure a tile exists to say ─────────────────────────── */

/**
 * A stat tile: a quiet label, the figure large, a line under it, and how it
 * moved as a sparkline at its foot. A link where `href` is given — a figure is
 * always one press from the whole of it. Lay several in `stats()`.
 */
export function stat(label, href = null) {
  const node = el(href === null ? 'div' : 'a', {
    class: href === null ? 'ui-stat' : 'ui-stat is-link',
    attrs: { href },
  })
  const figure = el('span', { class: 'ui-stat-figure' })
  into(figure, el('span', { class: 'ui-stat-value' }), el('span', { class: 'ui-stat-unit' }))
  const delta = el('span', { class: 'ui-stat-delta' })
  into(
    node,
    el('span', { class: 'ui-stat-label', text: label }),
    figure,
    el('span', { class: 'ui-stat-under' }),
    delta,
    spark(),
  )
  return node
}

/**
 * Fill a stat: `{ value, unit, under, tone, trend, delta: { said, tone } }`.
 * A `null` value is `—` and never a nought; a trend with nothing known draws
 * no line at all.
 */
export function statIn(node, one) {
  const [, figure, under, delta, line] = node.children
  const [value, unit] = figure.children
  const known = one.value !== null && one.value !== undefined && one.value !== ''
  textIn(value, known ? one.value : '—')
  classOn(figure, 'is-unknown', !known)
  toneIn(figure, known ? (one.tone ?? null) : null)
  textIn(unit, known ? (one.unit ?? '') : '')
  textIn(under, one.under ?? '')
  under.hidden = !one.under
  textIn(delta, one.delta?.said ?? '')
  toneIn(delta, one.delta?.tone ?? null)
  delta.hidden = !one.delta?.said
  const trend = one.trend ?? []
  line.hidden = !trend.some(isNumber)
  if (!line.hidden) sparkIn(line, trend, one.tone ?? 'working')
}

/** A row of stat tiles: as many across as fit, each the same height. */
export function stats(label) {
  return el('div', { class: 'ui-stats', attrs: { role: 'group', 'aria-label': label } })
}
