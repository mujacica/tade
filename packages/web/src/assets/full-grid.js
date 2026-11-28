// The full view's screen: the window's rows as a monospace grid of spans
// (§10 T4 of the Duo plan). One `div` a row and one `span` a run of one paint
// (`full-cells.js`), every value through `textContent` and every colour through
// the CSSOM — never markup, which the content policy would refuse anyway.
//
// **Only the rows that changed are touched.** The window hands back every row
// on every draw; a row whose text is the one already drawn is left as it is,
// so a frame where only the clock moved rebuilds one row, and a text selection
// in a row nobody changed survives the beat.
//
// **A cell is a measured thing.** The face's width at 1 px of type (`ratio`) is
// read off a probe in the page's own monospace face, once, and the grid is laid
// out from it: a row is exactly `columns` cells wide and `rowPx` tall, so the
// cell under a finger is arithmetic (`cellAt`), not a hit test on spans.

import { el } from './dom.js'
import { runsOf } from './full-cells.js'

/** The grid in `host`, with what draws into it and reads a press off it. */
export function gridOn(host) {
  const node = el('div', { class: 'fv-grid' })
  host.append(node)
  /** What each row was last drawn as: a row whose text is the same is left alone. */
  let drawn = []
  let font = 12
  let ratio = 0.6
  let rowPx = 14.4
  let columns = 0

  /** The face's width at 1 px of type, and how tall a line is, in this browser's monospace. */
  function measure() {
    const probe = el('span', { class: 'fv-probe', text: 'M'.repeat(100) })
    node.append(probe)
    const width = probe.getBoundingClientRect().width
    probe.remove()
    // 100 characters at 100 px: a face that measured nothing is not one to divide by.
    ratio = width > 0 ? width / 100 / 100 : 0.6
    return { ratio, lead: 1.2 }
  }

  /** Lay the grid out for `font` px type, `cols` × `rows` cells. */
  function size(fit) {
    font = fit.font
    columns = fit.columns
    rowPx = Math.round(fit.font * 1.2 * 100) / 100
    node.style.setProperty('--fv-font', `${font}px`)
    node.style.setProperty('--fv-row', `${rowPx}px`)
    node.style.setProperty('--fv-width', `${Math.ceil(font * ratio * columns)}px`)
    // A new size draws every row again: the same text is laid out anew.
    drawn = []
  }

  /** Draw these rows, touching only those that changed. */
  function paint(rows) {
    while (node.children.length > rows.length) node.lastElementChild?.remove()
    while (node.children.length < rows.length) node.append(el('div', { class: 'fv-row' }))
    for (let at = 0; at < rows.length; at++) {
      const row = rows[at] ?? ''
      if (drawn[at] === row) continue
      drawn[at] = row
      const line = node.children[at]
      if (line === undefined) continue
      line.replaceChildren(...runsOf(row).map(spanOf))
    }
    drawn.length = rows.length
  }

  /** The cell under a point on the glass, or null outside the grid. */
  function cellAt(clientX, clientY) {
    const box = node.getBoundingClientRect()
    const x = Math.floor((clientX - box.left) / (font * ratio))
    const y = Math.floor((clientY - box.top) / rowPx)
    if (x < 0 || y < 0 || x >= columns || y >= drawn.length) return null
    return { x, y }
  }

  /** A link drawn as one (OSC 8) under a point, which a tap follows on this phone. */
  function linkAt(clientX, clientY) {
    const under = document.elementFromPoint(clientX, clientY)
    const span = under?.closest?.('.fv-grid span[data-link]')
    return span?.getAttribute('data-link') ?? null
  }

  /** The row element at `y`, for a long press that starts a selection on it. */
  function rowAt(y) {
    return node.children[y] ?? null
  }

  return {
    node,
    measure,
    size,
    paint,
    cellAt,
    linkAt,
    rowAt,
    rowPx: () => rowPx,
  }
}

/** One run as a span: its text, its paint through the CSSOM, and its link. */
function spanOf(run) {
  const marks = [
    run.bold ? 'b' : '',
    run.italic ? 'i' : '',
    run.underline ? 'u' : '',
    run.wide ? 'w' : '',
  ]
    .filter((one) => one !== '')
    .join(' ')
  const span = el('span', {
    text: run.text,
    ...(marks === '' ? {} : { class: marks }),
    attrs: { 'data-link': safeLink(run.link) },
  })
  span.style.color = run.ink
  if (run.ground !== null) span.style.backgroundColor = run.ground
  return span
}

/**
 * A link a tap may open: `http`, `https` and `mailto` only. A row is text an
 * agent wrote, and a `javascript:` link in it is one nobody meant to follow.
 */
export function safeLink(url) {
  if (typeof url !== 'string' || url.length > 2048) return null
  return /^(https?:|mailto:)/i.test(url) ? url : null
}
