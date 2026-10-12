// The small charts: a ring and a segmented bar, both drawn by the stylesheet.
//
// **Numbers in, CSS out, and the numbers are always on the page as text too.**
// A chart here is decoration over a figure that is already said beside it in
// words, so every one is `aria-hidden` and none is the only statement of
// anything (1.1.1 and 1.4.1 — and the honest shape for a phone, where a chart
// nobody can read the value off is a picture).
//
// **No SVG, no canvas, no inline style.** The value reaches the drawing as a
// CSS custom property set through the CSSOM (`style.setProperty`), which the
// content policy allows and a `style=` attribute it would not; the ring is a
// `conic-gradient` and the bar is flex items. So a chart is one element and a
// property, and a delta that moves a figure moves the chart with one write.
//
// **Unknown is never drawn as nought.** A ring with nothing to say is a track
// with no arc and the class `is-unknown`, and the figure beside it says the
// word; a bar whose parts add to nothing is drawn empty, never as one full
// segment of the wrong thing.

import { el } from './dom.js'

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
