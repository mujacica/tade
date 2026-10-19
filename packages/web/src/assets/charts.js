// The charts: every graphical component a page draws with, made once.
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
// **Unknown is never drawn as nought.** A value nobody could read is a gap in a
// line, a track with no arc, a hatched cell, and the word beside it says which.
//
// **No inline style and no markup.** Geometry reaches the drawing as SVG
// attributes or as CSS custom properties set through the CSSOM
// (`style.setProperty`), which the content policy allows and a `style=` would
// not. SVG elements are made in the namespace the sprite already has
// (`svgOf`), so no file spells a URL.

import { classOn, el, into, keyed, textIn } from './dom.js'
import { svgOf } from './icons.js'

/** The words a mark may be toned with, each a `tone-*` class in `charts.css`. */
export const TONES = ['wants', 'working', 'done', 'failed', 'here', 'queued', 'quiet', 'unknown']

/** Put one tone on a node, taking any other off. Anything else is no tone. */
export function toneIn(node, tone) {
  for (const one of TONES) classOn(node, `tone-${one}`, one === tone)
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)
const round = (value) => Math.round(value * 100) / 100
const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value))

/** A CSS custom property, written only when it changed. */
function varIn(node, name, value) {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value)
}

/** A sentence for a chart that is a picture, read instead of the drawing. */
function saidIn(node, said) {
  if (node.getAttribute('aria-label') !== said) node.setAttribute('aria-label', said)
}

/* ── the small ones, drawn by the stylesheet: a ring and a segmented bar ──── */

/**
 * Where each part of a ring ends, as percentages of the whole.
 *
 * Pure, so the arithmetic is a test: `[3, 1, 1]` of 5 is `[60, 80, 100]`. A
 * total of nought is `[]` — there is no arc to draw, which is different from
 * an arc of nought.
 */
export function stopsOf(parts) {
  const total = parts.reduce((sum, one) => sum + Math.max(0, one), 0)
  if (total <= 0) return []
  const stops = []
  let at = 0
  for (const one of parts) {
    at += Math.max(0, one)
    stops.push(Math.round((at / total) * 1000) / 10)
  }
  return stops
}

/** A ring of a kind (`checks`, `plan`, `state`): the stylesheet knows its tones. */
export function ringOf(kind) {
  return el('span', { class: `ring ring-${kind} is-unknown`, attrs: { 'aria-hidden': 'true' } })
}

/**
 * Fill a ring with its parts, in the kind's own order of tones.
 *
 * A plan ring is one part out of a hundred and its tone is the pressure, which
 * is a class rather than a colour here — `planPressure` decided it.
 */
export function ringIn(node, parts, tone = '') {
  const stops = stopsOf(parts)
  node.classList.toggle('is-unknown', stops.length === 0)
  for (let at = 0; at < 3; at += 1) {
    const value = stops[at] ?? stops.at(-1) ?? 0
    node.style.setProperty(`--p${at + 1}`, `${value}%`)
  }
  for (const name of ['is-fine', 'is-warm', 'is-tight']) {
    node.classList.toggle(name, name === `is-${tone}`)
  }
}

/** A plan window's share as a ring: its share of a hundred, and the rest a track. */
export function shareIn(node, used, pressure) {
  if (used === null || used === undefined || Number.isNaN(used)) {
    ringIn(node, [], '')
    return
  }
  const share = Math.max(0, Math.min(100, used))
  ringIn(node, [share, 100 - share], pressure)
}

/** A segmented bar: one span per part, in a fixed order of tones. */
export function barOf(tones) {
  const node = el('span', { class: 'seg', attrs: { 'aria-hidden': 'true' } })
  for (const tone of tones) node.append(el('span', { class: `seg-${tone}` }))
  return node
}

/** Each part's share of the bar, and nothing drawn for a part of nought. */
export function barIn(node, counts) {
  const parts = [...node.children]
  for (let at = 0; at < parts.length; at += 1) {
    const n = Math.max(0, counts[at] ?? 0)
    parts[at].hidden = n === 0
    parts[at].style.setProperty('flex-grow', String(n))
  }
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

/* ── a gauge: how full something is, out of a hundred ─────────────────────── */

/** The gauge's arc: a half circle, its ends on the box's floor. */
const ARC = 'M8 52A42 42 0 0 1 92 52'

/**
 * A gauge: a half ring and the figure under its middle — a plan window, a
 * budget, a share of the work. `role="img"`, its sentence written by the fill.
 */
export function gauge(label) {
  const node = el('div', { class: 'ui-gauge', attrs: { role: 'img', 'aria-label': label } })
  node.dataset.label = label
  const svg = svgOf('svg', { viewBox: '0 0 100 56', focusable: 'false', 'aria-hidden': 'true' })
  if (svg !== null) {
    svg.append(
      svgOf('path', { d: ARC, class: 'ui-gauge-track', pathLength: 100 }),
      svgOf('path', { d: ARC, class: 'ui-gauge-value', pathLength: 100 }),
    )
    node.append(svg)
  }
  into(
    node,
    el('span', { class: 'ui-gauge-figure', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'ui-gauge-under', attrs: { 'aria-hidden': 'true' } }),
  )
  return node
}

/**
 * Fill a gauge: `{ share, said, under, pressure }` — `share` of a hundred or
 * null for unknown, `said` the figure in words (`64%`), `pressure` one of
 * `fine`, `warm`, `tight`, which is the tone the arc takes.
 */
export function gaugeIn(node, one) {
  const share = isNumber(one.share) ? clamp(one.share, 0, 100) : null
  const value = node.querySelector('.ui-gauge-value')
  if (value !== null) {
    value.setAttribute('stroke-dasharray', `${share ?? 0} 100`)
    classOn(value, 'is-empty', share === null || share === 0)
  }
  toneIn(node, share === null ? 'unknown' : (PRESSURE[one.pressure] ?? 'working'))
  const figure = node.querySelector('.ui-gauge-figure')
  const under = node.querySelector('.ui-gauge-under')
  textIn(figure, share === null ? '—' : (one.said ?? `${Math.round(share)}%`))
  textIn(under, one.under ?? '')
  const parts = [node.dataset.label, share === null ? 'not known' : textOf(figure), one.under]
  saidIn(node, parts.filter(Boolean).join(': '))
}

/** How worrying a share is, as the tone it is drawn in. */
const PRESSURE = { fine: 'working', warm: 'here', tight: 'failed' }

const textOf = (node) => node.textContent ?? ''

/* ── a stack: the parts of a whole, side by side, and their legend ────────── */

/**
 * A stacked bar with its legend under it: how a whole divides — states of the
 * work, checks green and red and not run. The legend is the text; the bar is
 * `aria-hidden` over it.
 */
export function stack(label) {
  const node = el('div', { class: 'ui-stack', attrs: { role: 'group', 'aria-label': label } })
  into(
    node,
    el('div', { class: 'ui-stack-bar', attrs: { 'aria-hidden': 'true' } }),
    el('ul', { class: 'ui-legend' }),
  )
  return node
}

/** Fill a stack: `[{ key, label, n, tone }]` in the order they should read. */
export function stackIn(node, parts) {
  const [bar, legend] = node.children
  segmentsIn(bar, parts)
  legendIn(legend, parts)
}

function segmentsIn(bar, parts) {
  while (bar.children.length > parts.length) bar.lastChild.remove()
  while (bar.children.length < parts.length) bar.append(el('span'))
  parts.forEach((one, at) => {
    const part = bar.children[at]
    const n = isNumber(one.n) ? Math.max(0, one.n) : 0
    part.hidden = n === 0
    varIn(part, 'flex-grow', String(n))
    toneIn(part, one.tone)
  })
}

/**
 * A legend: a mark of each part's tone, its word, and its figure — the text
 * every chart with more than one part carries, so identity is never colour
 * alone. A part of nought stays in it (it is a fact), a `null` is `—`.
 */
export function legendIn(list, parts) {
  keyed(
    list,
    parts,
    (one) => one.key ?? one.label,
    () => {
      const item = el('li')
      into(
        item,
        el('span', { class: 'ui-legend-mark', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'ui-legend-label' }),
        el('span', { class: 'ui-legend-value' }),
      )
      return item
    },
    (item, one) => {
      const [mark, label, value] = item.children
      toneIn(mark, one.tone)
      textIn(label, one.label)
      textIn(value, isNumber(one.n) ? (one.said ?? String(one.n)) : '—')
    },
  )
}

/* ── a donut: a status ring with the figure in its middle ─────────────────── */

/** The donut's radius, chosen so its circumference is a hundred. */
const DONUT_R = 15.9155

/**
 * Where each part of a donut starts and how long it is, out of a hundred, with
 * a gap between parts so neighbours never run together. Pure.
 */
export function donutParts(parts, gap = 1.5) {
  const counts = parts.map((one) => (isNumber(one) ? Math.max(0, one) : 0))
  const total = counts.reduce((sum, one) => sum + one, 0)
  if (total === 0) return counts.map(() => null)
  const drawn = counts.filter((one) => one > 0).length
  const room = 100 - (drawn > 1 ? gap * drawn : 0)
  let at = 0
  return counts.map((one) => {
    if (one === 0) return null
    const length = round((one / total) * room)
    const part = { start: round(at), length }
    at += length + (drawn > 1 ? gap : 0)
    return part
  })
}

/**
 * A donut: a status ring — how a whole stands — with its figure in the
 * middle. `role="img"`; its sentence lists every part (`donutIn`).
 */
export function donut(label) {
  const node = el('div', { class: 'ui-donut', attrs: { role: 'img', 'aria-label': label } })
  node.dataset.label = label
  const svg = svgOf('svg', { viewBox: '0 0 36 36', focusable: 'false', 'aria-hidden': 'true' })
  if (svg !== null) {
    svg.append(svgOf('circle', { class: 'ui-donut-track', cx: 18, cy: 18, r: DONUT_R }))
    svg.append(svgOf('g'))
    node.append(svg)
  }
  const middle = el('span', { class: 'ui-donut-middle', attrs: { 'aria-hidden': 'true' } })
  into(middle, el('span', { class: 'ui-donut-figure' }), el('span', { class: 'ui-donut-under' }))
  node.append(middle)
  return node
}

/** Fill a donut: `[{ label, n, tone }]` and `{ said, under }` for its middle. */
export function donutIn(node, parts, middle = {}) {
  const group = node.querySelector('svg > g')
  const drawn = donutParts(parts.map((one) => one.n))
  if (group !== null) {
    while (group.children.length > parts.length) group.lastChild.remove()
    while (group.children.length < parts.length) {
      group.append(svgOf('circle', { cx: 18, cy: 18, r: DONUT_R, class: 'ui-donut-part' }))
    }
    parts.forEach((one, at) => {
      const ring = group.children[at]
      const part = drawn[at]
      // `hidden` is HTML's; an SVG element is taken out of the drawing by its own attribute.
      if (part === null) ring.setAttribute('display', 'none')
      else ring.removeAttribute('display')
      if (part === null) return
      toneIn(ring, one.tone)
      // Clockwise from twelve: the dash starts at the circle's own three, so
      // the offset turns it back a quarter.
      ring.setAttribute('stroke-dasharray', `${part.length} ${round(100 - part.length)}`)
      ring.setAttribute('stroke-dashoffset', String(round(25 - part.start)))
    })
  }
  const [figure, under] = node.querySelector('.ui-donut-middle').children
  textIn(figure, middle.said ?? '')
  textIn(under, middle.under ?? '')
  const known = parts.filter((one) => isNumber(one.n))
  const listed = known.map((one) => `${one.n} ${one.label}`).join(', ')
  saidIn(node, `${node.dataset.label}: ${listed === '' ? 'not known' : listed}`)
}

/* ── ranked bars: how much each one, longest first ────────────────────────── */

/**
 * Ranked bars: a label, a bar of its share of the largest, and its figure —
 * the way to compare projects, models or harnesses. **One tone**, because the
 * label is what tells them apart; a colour per category would be a legend to
 * learn. A list of real text, so it needs no sentence of its own.
 */
export function bars(label) {
  return el('ol', { class: 'ui-bars', attrs: { 'aria-label': label } })
}

/**
 * Fill ranked bars: `[{ key, label, value, said, href, under, tone }]`. `value`
 * sizes the bar against the largest; `said` is what is written; a `null` value
 * is drawn with no bar and its `said` (or `—`), never as an empty one.
 */
export function barsIn(node, rows) {
  const most = Math.max(0, ...rows.map((one) => (isNumber(one.value) ? one.value : 0)))
  keyed(
    node,
    rows,
    (one) => one.key ?? one.label,
    createBar,
    (item, one) => fillBar(item, one, most),
  )
}

function createBar() {
  const item = el('li')
  const name = el('a', { class: 'ui-bars-label' })
  const track = el('span', { class: 'ui-bars-track', attrs: { 'aria-hidden': 'true' } })
  into(track, el('span', { class: 'ui-bars-fill' }))
  into(
    item,
    name,
    el('span', { class: 'ui-bars-value' }),
    track,
    el('span', { class: 'ui-bars-under' }),
  )
  return item
}

function fillBar(item, one, most) {
  const [name, value, track, under] = item.children
  textIn(name, one.label)
  if (one.href) name.setAttribute('href', one.href)
  else name.removeAttribute('href')
  const known = isNumber(one.value)
  textIn(value, one.said ?? (known ? String(one.value) : '—'))
  track.hidden = !known
  if (known) varIn(track.firstChild, '--w', `${most === 0 ? 0 : round((one.value / most) * 100)}%`)
  toneIn(track, one.tone ?? 'working')
  textIn(under, one.under ?? '')
  under.hidden = !one.under
}

/* ── lanes: what each thing did, over the same stretch of time ───────────── */

/** Where an instant falls between two others, as a percentage, kept on the track. */
export function placeOf(at, from, to) {
  if (!isNumber(at) || !isNumber(from) || !isNumber(to) || to <= from) return null
  return round(clamp(((at - from) / (to - from)) * 100, 0, 100))
}

/**
 * Lanes (a swimlane timeline): a row per thing — an agent, a check, a step —
 * each a track of spans (when it was working, waiting, red) and marks (a
 * commit, a turn), over one shared axis with `now` drawn across every track.
 * Each lane says its spans in words to a screen reader.
 */
export function lanes(label) {
  const node = el('div', { class: 'ui-lanes', attrs: { role: 'group', 'aria-label': label } })
  into(
    node,
    el('ol', { class: 'ui-lanes-rows' }),
    el('div', { class: 'ui-lanes-axis', attrs: { 'aria-hidden': 'true' } }),
  )
  return node
}

/**
 * Fill lanes: `{ from, to, now, ticks: [{ at, said }], lanes: [{ key, label,
 * href, spans: [{ from, to, tone, said }], marks: [{ at, tone, said }] }] }`.
 * A span with no end yet runs to `now`.
 */
export function lanesIn(node, one) {
  const [rows, axis] = node.children
  const now = isNumber(one.now) ? one.now : one.to
  keyed(
    rows,
    one.lanes,
    (lane) => lane.key ?? lane.label,
    createLane,
    (item, lane) => fillLane(item, lane, one.from, one.to, now),
  )
  keyed(
    axis,
    one.ticks ?? [],
    (tick) => String(tick.at),
    () => el('span', { class: 'ui-lanes-tick' }),
    (tick, at) => {
      textIn(tick, at.said)
      varIn(tick, '--a', `${placeOf(at.at, one.from, one.to) ?? 0}%`)
    },
  )
}

function createLane() {
  const item = el('li')
  const track = el('span', { class: 'ui-lanes-track', attrs: { 'aria-hidden': 'true' } })
  into(track, el('span', { class: 'ui-lanes-now' }))
  into(item, el('a', { class: 'ui-lanes-label' }), track, el('span', { class: 'sr-only' }))
  return item
}

function fillLane(item, lane, from, to, now) {
  const [name, track, said] = item.children
  textIn(name, lane.label)
  if (lane.href) name.setAttribute('href', lane.href)
  else name.removeAttribute('href')
  const marks = [
    ...(lane.spans ?? []).map((one) => ({ ...one, kind: 'span' })),
    ...(lane.marks ?? []).map((one) => ({ ...one, kind: 'mark' })),
  ]
  const [nowLine] = track.children
  const nowAt = placeOf(now, from, to)
  nowLine.hidden = nowAt === null || nowAt >= 100
  varIn(nowLine, '--a', `${nowAt ?? 0}%`)
  while (track.children.length > marks.length + 1) track.lastChild.remove()
  while (track.children.length < marks.length + 1) track.append(el('span'))
  marks.forEach((one, at) => {
    const part = track.children[at + 1]
    classOn(part, 'ui-lanes-span', one.kind === 'span')
    classOn(part, 'ui-lanes-mark', one.kind === 'mark')
    toneIn(part, one.tone)
    const a = placeOf(one.kind === 'span' ? one.from : one.at, from, to) ?? 0
    const b = one.kind === 'span' ? (placeOf(one.to ?? now, from, to) ?? a) : a
    varIn(part, '--a', `${a}%`)
    varIn(part, '--b', `${Math.max(a, b)}%`)
  })
  textIn(
    said,
    marks
      .map((one) => one.said)
      .filter(Boolean)
      .join('; '),
  )
}

/* ── a flow: what waits on what, as a graph ───────────────────────────────── */

/**
 * The layers of a graph, pure: every node's depth is the longest chain of
 * what it waits on (a node waiting on nothing is in the first layer), and the
 * order inside a layer follows what it waits on, so edges cross as little as
 * two sweeps can manage. **A cycle is walked with a visited set** — these are
 * files anybody can edit, and a drawing may not hang a page on one.
 */
export function layered(nodes, edges) {
  const ids = nodes.map((one) => one.id)
  const known = new Set(ids)
  const before = new Map(ids.map((id) => [id, []]))
  for (const edge of edges) {
    if (!known.has(edge.from) || !known.has(edge.to) || edge.from === edge.to) continue
    before.get(edge.to).push(edge.from)
  }
  const depth = new Map()
  const walking = new Set()
  const depthOf = (id) => {
    if (depth.has(id)) return depth.get(id)
    if (walking.has(id)) return 0
    walking.add(id)
    const deepest = Math.max(-1, ...before.get(id).map(depthOf))
    walking.delete(id)
    depth.set(id, deepest + 1)
    return deepest + 1
  }
  const layers = []
  for (const id of ids) {
    const at = depthOf(id)
    while (layers.length <= at) layers.push([])
    layers[at].push(id)
  }
  const rowOf = new Map()
  const place = () => {
    for (const layer of layers) {
      layer.forEach((id, row) => {
        rowOf.set(id, row)
      })
    }
  }
  place()
  for (let sweep = 0; sweep < 2; sweep += 1) {
    for (const layer of layers.slice(1)) {
      const centre = (id) => {
        const rows = before
          .get(id)
          .filter((one) => depth.get(one) < depth.get(id))
          .map((one) => rowOf.get(one))
        return rows.length === 0 ? rowOf.get(id) : rows.reduce((a, b) => a + b, 0) / rows.length
      }
      const centres = new Map(layer.map((id) => [id, centre(id)]))
      layer.sort((a, b) => centres.get(a) - centres.get(b) || rowOf.get(a) - rowOf.get(b))
      place()
    }
  }
  const at = new Map(ids.map((id) => [id, { layer: depth.get(id), row: rowOf.get(id) }]))
  return { at, layers: layers.length, rows: Math.max(0, ...layers.map((one) => one.length)) }
}

/** A node's box and the room between them, in CSS pixels, per direction. */
const FLOW = {
  right: { w: 184, h: 52, gapX: 48, gapY: 12 },
  down: { w: 184, h: 52, gapX: 12, gapY: 36 },
}

/**
 * Where each node and edge of a flow goes, pure: boxes in pixels and each edge
 * as a curve from the side of one box to the side of the next, with its
 * arrowhead. `direction` is `right` (layers left to right — a desk) or `down`
 * (layers top to bottom — a phone).
 */
export function flowGeometry(nodes, edges, direction = 'right') {
  const size = FLOW[direction] ?? FLOW.right
  const { at, layers, rows } = layered(nodes, edges)
  const across = direction === 'down' ? rows : layers
  const along = direction === 'down' ? layers : rows
  const boxes = new Map()
  for (const node of nodes) {
    const spot = at.get(node.id)
    const col = direction === 'down' ? spot.row : spot.layer
    const row = direction === 'down' ? spot.layer : spot.row
    boxes.set(node.id, { x: col * (size.w + size.gapX), y: row * (size.h + size.gapY) })
  }
  const paths = []
  for (const edge of edges) {
    const a = boxes.get(edge.from)
    const b = boxes.get(edge.to)
    if (a === undefined || b === undefined || edge.from === edge.to) continue
    if (direction === 'down') {
      const [x1, y1, x2, y2] = [a.x + size.w / 2, a.y + size.h, b.x + size.w / 2, b.y]
      const bend = round((y2 - y1) / 2)
      paths.push({
        ...edge,
        d: `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2 - 1}`,
        head: `M${x2 - 4} ${y2 - 6}L${x2} ${y2 - 1}L${x2 + 4} ${y2 - 6}`,
      })
    } else {
      const [x1, y1, x2, y2] = [a.x + size.w, a.y + size.h / 2, b.x, b.y + size.h / 2]
      const bend = round((x2 - x1) / 2)
      paths.push({
        ...edge,
        d: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 1} ${y2}`,
        head: `M${x2 - 6} ${y2 - 4}L${x2 - 1} ${y2}L${x2 - 6} ${y2 + 4}`,
      })
    }
  }
  const width = Math.max(0, across * (size.w + size.gapX) - size.gapX)
  const height = Math.max(0, along * (size.h + size.gapY) - size.gapY)
  return { boxes, paths, width, height, size }
}

/**
 * A flow: a dependency graph — a run's steps, a queue, a workflow's shape —
 * drawn as boxes and curves, scrolling sideways in its own region when it is
 * wider than the screen (the one thing besides a table allowed to). Every
 * node is real text in reading order, a link where it has one, and says what
 * it waits on to a screen reader; the curves are `aria-hidden` over that.
 */
export function flow(label) {
  const node = el('div', {
    class: 'ui-flow scrolls',
    attrs: { role: 'region', 'aria-label': label, tabindex: '0' },
  })
  const canvas = el('div', { class: 'ui-flow-canvas' })
  const svg = svgOf('svg', { class: 'ui-flow-edges', focusable: 'false', 'aria-hidden': 'true' })
  if (svg !== null) canvas.append(svg)
  canvas.append(el('ol', { class: 'ui-flow-nodes' }))
  node.append(canvas)
  return node
}

/**
 * Fill a flow: `{ nodes: [{ id, label, under, tone, glyph, href }], edges:
 * [{ from, to, tone }] }` — an edge from what is waited on to what waits —
 * and a `direction` (`right` or `down`).
 */
export function flowIn(node, graph, direction = 'right') {
  const canvas = node.firstChild
  const drawn = flowGeometry(graph.nodes, graph.edges, direction)
  varIn(canvas, '--fw', `${drawn.width}px`)
  varIn(canvas, '--fh', `${drawn.height}px`)
  varIn(canvas, '--nw', `${drawn.size.w}px`)
  varIn(canvas, '--nh', `${drawn.size.h}px`)
  const svg = canvas.querySelector('svg')
  if (svg !== null) {
    svg.setAttribute('viewBox', `0 0 ${Math.max(1, drawn.width)} ${Math.max(1, drawn.height)}`)
    while (svg.children.length > drawn.paths.length) svg.lastChild.remove()
    while (svg.children.length < drawn.paths.length) {
      const group = svgOf('g')
      group.append(
        svgOf('path', { class: 'ui-flow-edge' }),
        svgOf('path', { class: 'ui-flow-head' }),
      )
      svg.append(group)
    }
    drawn.paths.forEach((one, at) => {
      const group = svg.children[at]
      toneIn(group, one.tone ?? null)
      group.firstChild.setAttribute('d', one.d)
      group.lastChild.setAttribute('d', one.head)
    })
  }
  const names = new Map(graph.nodes.map((one) => [one.id, one.label]))
  const waits = (id) =>
    graph.edges
      .filter((one) => one.to === id && names.has(one.from))
      .map((one) => names.get(one.from))
  // Reading order is the drawing's: layer by layer, top to bottom inside each.
  const order = [...graph.nodes].sort((a, b) => {
    const pa = drawn.boxes.get(a.id)
    const pb = drawn.boxes.get(b.id)
    return direction === 'down' ? pa.y - pb.y || pa.x - pb.x : pa.x - pb.x || pa.y - pb.y
  })
  keyed(
    canvas.lastChild,
    order,
    (one) => one.id,
    createFlowNode,
    (item, one) => {
      const box = drawn.boxes.get(one.id)
      varIn(item, '--x', `${box.x}px`)
      varIn(item, '--y', `${box.y}px`)
      const [link] = item.children
      const [glyph, name, under, said] = link.children
      toneIn(link, one.tone)
      textIn(glyph, one.glyph ?? '')
      textIn(name, one.label)
      textIn(under, one.under ?? '')
      const on = waits(one.id)
      textIn(said, on.length === 0 ? '' : `, waits on ${on.join(', ')}`)
      if (one.href) link.setAttribute('href', one.href)
      else link.removeAttribute('href')
    },
  )
}

function createFlowNode() {
  const item = el('li', { class: 'ui-flow-node' })
  const link = el('a', { class: 'ui-flow-box' })
  into(
    link,
    el('span', { class: 'ui-flow-glyph', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'ui-flow-name' }),
    el('span', { class: 'ui-flow-under' }),
    el('span', { class: 'sr-only' }),
  )
  return into(item, link)
}

/* ── a heat strip: a run of moments, each a cell ──────────────────────────── */

/**
 * Each value's level out of `levels`, pure: nought is level 0, the largest is
 * the top, and a `null` stays `null` — not looked at, which is not nothing.
 */
export function levelsOf(values, levels = 4) {
  const most = Math.max(0, ...values.filter(isNumber))
  return values.map((one) => {
    if (!isNumber(one)) return null
    if (one <= 0 || most === 0) return 0
    return Math.max(1, Math.ceil((one / most) * levels))
  })
}

/**
 * A heat strip: a row of cells — days, runs, commits — or, with `rows: 7`, a
 * calendar of weeks. A cell is a state (`tone`) or an amount (`level`, 0 to 4,
 * as `levelsOf` makes them); unknown is a hatched cell. `role="img"`, and the
 * sentence is the caller's (`said`), because only the caller knows what the
 * cells add up to.
 *
 * **Every cell is drawn**: a strip longer than its room scrolls sideways, and
 * opens at its newest end — which it keeps following as cells arrive, until the
 * reader scrolls back, and again once they scroll to the end.
 */
export function heat(label) {
  const node = el('div', { class: 'ui-heat scrolls', attrs: { role: 'img', 'aria-label': label } })
  node.addEventListener('scroll', () => {
    node.dataset.held = atEnd(node) ? '' : 'held'
  })
  return node
}

const atEnd = (node) => node.scrollLeft + node.clientWidth >= node.scrollWidth - 2

/** Fill a heat strip: `[{ tone, level }]`, `{ rows, said, tone }`. */
export function heatIn(node, cells, opts = {}) {
  varIn(node, '--rows', String(opts.rows ?? 1))
  while (node.children.length > cells.length) node.lastChild.remove()
  while (node.children.length < cells.length) node.append(el('span', { class: 'ui-heat-cell' }))
  cells.forEach((one, at) => {
    const cell = node.children[at]
    const level = one.level === undefined ? undefined : one.level
    const unknown = level === null || one.tone === 'unknown'
    toneIn(cell, unknown ? 'unknown' : (one.tone ?? opts.tone ?? 'working'))
    for (let n = 0; n <= 4; n += 1) classOn(cell, `is-l${n}`, level === n)
  })
  if (opts.said !== undefined) saidIn(node, opts.said)
  // After the cells are laid out: at the newest end unless the reader went
  // back, and reachable by the keyboard only where there is somewhere to go.
  globalThis.requestAnimationFrame?.(() => {
    if (node.dataset.held !== 'held') node.scrollLeft = node.scrollWidth
    if (node.scrollWidth > node.clientWidth) node.setAttribute('tabindex', '0')
    else node.removeAttribute('tabindex')
  })
}

/* ── steps: how far along something is ────────────────────────────────────── */

/** What each step's state is called out loud, and its mark. */
const STEP = {
  done: { word: 'done', glyph: '✓', tone: 'done' },
  now: { word: 'in progress', glyph: '', tone: 'working' },
  failed: { word: 'failed', glyph: '!', tone: 'failed' },
  wants: { word: 'waiting on you', glyph: '?', tone: 'wants' },
  next: { word: 'not started', glyph: '', tone: 'quiet' },
  skipped: { word: 'skipped', glyph: '–', tone: 'quiet' },
}

/**
 * Steps: a line of stops, each a dot and its word, the line between them
 * filled up to where things are — a run's stages, a pairing, a release. Turns
 * from a row into a column when its container is narrow.
 */
export function steps(label) {
  const node = el('div', { class: 'ui-steps' })
  node.append(el('ol', { attrs: { 'aria-label': label } }))
  return node
}

/** Fill steps: `[{ key, label, state, under }]`, `state` one of `STEP`'s. */
export function stepsIn(node, list) {
  keyed(
    node.firstChild,
    list,
    (one) => one.key ?? one.label,
    () => {
      const item = el('li')
      into(
        item,
        el('span', { class: 'ui-steps-dot', attrs: { 'aria-hidden': 'true' } }),
        el('span', { class: 'ui-steps-label' }),
        el('span', { class: 'ui-steps-under' }),
        el('span', { class: 'sr-only' }),
      )
      return item
    },
    (item, one) => {
      const mark = STEP[one.state] ?? STEP.next
      const [dot, label, under, said] = item.children
      toneIn(item, mark.tone)
      classOn(item, 'is-now', one.state === 'now')
      classOn(item, 'is-done', one.state === 'done')
      textIn(dot, mark.glyph)
      textIn(label, one.label)
      textIn(under, one.under ?? '')
      textIn(said, `, ${mark.word}`)
      if (one.state === 'now') item.setAttribute('aria-current', 'step')
      else item.removeAttribute('aria-current')
    },
  )
}
