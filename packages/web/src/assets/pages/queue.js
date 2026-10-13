// The queue: everything waiting, grouped by project, with what each piece waits
// on. Parked work stays in the list — a task with a `start` is queued work.

import { el, empty, into, keyed, textIn } from '../dom.js'
import { count } from '../figures.js'
import { createQueueRow, fillQueueRow, section } from '../rows.js'
import { omitted, queueIn } from '../store.js'
import { panel } from '../ui.js'

/* ── the queue ─────────────────────────────────────────────────────────────── */

/**
 * Everything waiting, grouped by project, with **what each piece waits on drawn
 * as an indent and a connector**.
 *
 * Parked work stays in the list. A task with a `start` is queued work, and
 * hiding one because somebody parked it would leave them with nothing to pick
 * back up.
 */
export function queueScreen() {
  const node = el('div')
  const made = section('QUEUE', { top: true })
  // **A filter by standing**, a chip each with its count: what can start next
  // is one tap from the whole queue, and a chip at nought is not offered.
  // The standing is `queueStateOf`'s, off the wire — this only counts it.
  const chips = el('div', { class: 'filter', attrs: { role: 'group', 'aria-label': 'Show' } })
  let only = null
  const chipsBy = new Map()
  for (const kind of [null, ...QUEUE_KINDS]) {
    const chip = el('button', {
      class: 'ui-chip filter-chip',
      attrs: { type: 'button', 'aria-pressed': kind === null ? 'true' : 'false' },
    })
    into(
      chip,
      el('span', { text: kind === null ? 'All' : QUEUE_WORDS[kind] }),
      el('span', { class: 'num' }),
    )
    chip.addEventListener('click', () => {
      only = kind
      for (const [one, node] of chipsBy)
        node.setAttribute('aria-pressed', one === only ? 'true' : 'false')
      if (last !== null) draw(last)
    })
    chipsBy.set(kind, chip)
    into(chips, chip)
  }
  let last = null
  const groups = el('div')
  const none = empty('nothing queued')
  into(made.body, chips, groups, none)
  const left = el('p', { class: 'unknown' })
  into(node, made.node, left)

  const draw = (view) => {
    last = view
    const every = queueIn(view.store, null)
    for (const [kind, chip] of chipsBy) {
      const n = kind === null ? every.length : every.filter((row) => row.state.kind === kind).length
      textIn(chip.lastChild, String(n))
      chip.hidden = kind !== null && n === 0 && only !== kind
    }
    const rows = only === null ? every : every.filter((row) => row.state.kind === only)
    textIn(made.figure, count(every.length))
    made.figure.setAttribute('aria-label', `${rows.length} queued`)
    none.hidden = rows.length > 0
    const projects = [...new Set(rows.map((row) => row.project))].sort()
    keyed(
      groups,
      projects,
      (name) => name,
      createQueueGroup,
      (one, name) => fillQueueGroup(one, name, rows, view),
    )
    const n = omitted(view.store, 'queue')
    textIn(left, n === 0 ? '' : `${n} more pieces of queued work are not on this page`)
    left.hidden = n === 0
    chips.hidden = every.length === 0
  }

  return { node, update: draw }
}

/** The standings a filter chip is offered for, in the order they are drawn. */
const QUEUE_KINDS = ['ready', 'waiting', 'scheduled', 'held', 'paused']

/** Each standing's word on its chip: `queueMark`'s own, made a heading. */
const QUEUE_WORDS = {
  ready: 'Next',
  waiting: 'Waiting',
  scheduled: 'Scheduled',
  held: 'Held',
  paused: 'Paused',
}

function createQueueGroup() {
  const node = el('div', { class: 'section' })
  const head = el('h3', { class: 'aside' })
  const list = panel('ul', 'queue')
  const said = el('p', { class: 'unknown' })
  return into(node, head, list, said)
}

function fillQueueGroup(node, name, rows, view) {
  const [head, list, said] = node.children
  textIn(head, name)
  const mine = rows.filter((row) => row.project === name)
  keyed(
    list,
    mine,
    (row) => row.task,
    createQueueRow,
    (one, row) => fillQueueRow(one, row, { ...view, project: name }),
  )
  // A whole project held at once is a different fact from four rows that each
  // happen to be paused, and it is the one a person can undo in one act.
  const all = mine.every((row) => row.state.kind === 'paused' && row.state.all)
  textIn(said, all && mine.length > 0 ? 'this project’s queue is paused' : '')
  said.hidden = !(all && mine.length > 0)
}
