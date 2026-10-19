// A flow: what waits on what, as a graph — a run's steps, a queue, a
// workflow's shape — drawn as boxes and curves, a create and a fill like every
// chart (`charts.js`), whose tones and conventions it keeps.
//
// **A box is as tall as its words.** A step's name is never cut to fit its
// box: the layout counts the lines it wraps onto (`linesOf`), without
// measuring the page, and lays every box on a line of the drawing as tall as
// the tallest there, so the curves still meet each side at its middle.

import { toneIn } from './charts.js'
import { el, into, keyed, textIn } from './dom.js'
import { svgOf } from './icons.js'

const round = (value) => Math.round(value * 100) / 100

/** A CSS custom property, written only when it changed. */
function varIn(node, name, value) {
  if (node.style.getPropertyValue(name) !== value) node.style.setProperty(name, value)
}

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
 * The room a box's words have, in CSS pixels (`charts.css`): its width less
 * its padding, its two edges, the glyph's column and the gap beside it; and a
 * line of them, at 13px set at 1.2 (`--step--1`, `--lead-tight`).
 */
const WORDS_ROOM = 184 - 2 * 12 - 1 - 3 - 16 - 8
const WORDS_LINE = 13 * 1.2
/** What a box is besides its lines, top and bottom: a 52px box holds two. */
const WORDS_PAD = 52 - 2 * WORDS_LINE
/**
 * A character's width at 13px, generously — a little wider than most, so a
 * box is drawn a shade tall rather than its words spilling over the next —
 * and twice that for a wide one: CJK and an emoji.
 */
const CHAR_PX = 7.5
const WIDE =
  /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6]|\p{Extended_Pictographic}/u

/**
 * How many lines a box's text wraps onto, without measuring the page: words
 * laid greedily into lines of `WORDS_ROOM`, and one too long for a line broken
 * where it runs out (`overflow-wrap: anywhere`). Nothing is cut — **a box is
 * as tall as its words**, so a long step's name is read whole in the map.
 */
export function linesOf(text) {
  if (typeof text !== 'string' || text.trim() === '') return 0
  const room = Math.floor(WORDS_ROOM / CHAR_PX)
  const width = (word) => [...word].reduce((sum, one) => sum + (WIDE.test(one) ? 2 : 1), 0)
  let lines = 1
  let used = 0
  for (const word of text.trim().split(/\s+/)) {
    let wide = width(word)
    const gap = used === 0 ? 0 : 1
    if (used + gap + wide <= room) {
      used += gap + wide
      continue
    }
    if (used > 0) lines += 1
    while (wide > room) {
      wide -= room
      lines += 1
    }
    used = wide
  }
  return lines
}

/**
 * Where each node and edge of a flow goes, pure: boxes in pixels and each edge
 * as a curve from the side of one box to the side of the next, with its
 * arrowhead. `direction` is `right` (layers left to right — a desk) or `down`
 * (layers top to bottom — a phone).
 *
 * **A box is as tall as its words** (`linesOf`), and every box on one line of
 * the drawing as tall as the tallest there, so the curves still meet each side
 * at its middle and no box runs into the next.
 */
export function flowGeometry(nodes, edges, direction = 'right') {
  const size = FLOW[direction] ?? FLOW.right
  const { at, layers, rows } = layered(nodes, edges)
  const across = direction === 'down' ? rows : layers
  const along = direction === 'down' ? layers : rows
  const lineOf = (node) => (direction === 'down' ? at.get(node.id).layer : at.get(node.id).row)
  const tall = Array.from({ length: along }, () => size.h)
  for (const node of nodes) {
    const lines = linesOf(node.label) + linesOf(node.under)
    const h = Math.ceil(WORDS_PAD + lines * WORDS_LINE)
    const line = lineOf(node)
    tall[line] = Math.max(tall[line], h)
  }
  const tops = []
  tall.reduce((top, h, n) => {
    tops[n] = top
    return top + h + size.gapY
  }, 0)
  const boxes = new Map()
  for (const node of nodes) {
    const spot = at.get(node.id)
    const col = direction === 'down' ? spot.row : spot.layer
    const line = lineOf(node)
    boxes.set(node.id, { x: col * (size.w + size.gapX), y: tops[line], h: tall[line] })
  }
  const paths = []
  for (const edge of edges) {
    const a = boxes.get(edge.from)
    const b = boxes.get(edge.to)
    if (a === undefined || b === undefined || edge.from === edge.to) continue
    if (direction === 'down') {
      const [x1, y1, x2, y2] = [a.x + size.w / 2, a.y + a.h, b.x + size.w / 2, b.y]
      const bend = round((y2 - y1) / 2)
      paths.push({
        ...edge,
        d: `M${x1} ${y1}C${x1} ${y1 + bend} ${x2} ${y2 - bend} ${x2} ${y2 - 1}`,
        head: `M${x2 - 4} ${y2 - 6}L${x2} ${y2 - 1}L${x2 + 4} ${y2 - 6}`,
      })
    } else {
      const [x1, y1, x2, y2] = [a.x + size.w, a.y + a.h / 2, b.x, b.y + b.h / 2]
      const bend = round((x2 - x1) / 2)
      paths.push({
        ...edge,
        d: `M${x1} ${y1}C${x1 + bend} ${y1} ${x2 - bend} ${y2} ${x2 - 1} ${y2}`,
        head: `M${x2 - 6} ${y2 - 4}L${x2 - 1} ${y2}L${x2 - 6} ${y2 + 4}`,
      })
    }
  }
  const width = Math.max(0, across * (size.w + size.gapX) - size.gapX)
  const height = Math.max(0, tall.reduce((sum, h) => sum + h + size.gapY, 0) - size.gapY)
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
      varIn(item, '--nh', `${box.h}px`)
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
