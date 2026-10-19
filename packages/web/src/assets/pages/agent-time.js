// One agent's timeline: what it has been doing, drawn over time and then said
// moment by moment — the agent page's (`agent.js`), from the answer its screen
// card asks for (`agent-pane.js`).
//
// **A lane each for the agent running, its turns, its tools, its checks and
// its commits**, over one axis that ends at now, so a run that has gone quiet
// is a gap anybody can see and a red check sits under the turn that made it.
// Under it the moments themselves, newest first, every one: the chart is the
// shape and the list is the words, and neither is the only statement of
// anything.
//
// **It reads on to the agent's first moment.** An answer carries the newest
// stretch; the list scrolls in a region of its own, and as the reader nears
// its end — or where it is too short to scroll — the moments before are read
// out of the journal at the machine (`/moments?before=`) and put under it,
// with every moment it was sent kept (`momentsKept`). The chart widens with
// them, so it always covers what the list holds.
//
// Built once and filled on every paint, like every region: a delta writes text
// and classes into nodes that are already here.

import { lanes, lanesIn } from '../charts.js'
import { readFrom } from '../conversation.js'
import { el, into, keyed, skeleton, textIn, toneOn } from '../dom.js'
import { ageSaid } from '../figures.js'
import { section } from '../rows.js'
import { stateBox, stateBoxIn } from '../ui.js'
import { momentsKept, momentsOf, stateOf, timelineOf } from './agent-shape.js'

/** How near its end the list counts as reached, in pixels: a few moments before it. */
const NEAR_END = 240

export function timeline() {
  const part = section('TIMELINE')
  part.node.id = 'ag-time'
  const card = el('div', { class: 'ui-panel ag-time' })
  const chart = lanes('What it has been doing, over time')
  chart.classList.add('ag-lanes')
  const list = el('ul', {
    class: 'ui-timeline ag-moments',
    attrs: { tabindex: '0', 'aria-label': 'What it has done, newest first' },
  })
  const foot = el('div', { class: 'ag-time-foot' })
  const reading = el('p', {
    class: 'ag-reading',
    text: 'reading what it did before',
    attrs: { role: 'status' },
  })
  const again = el('button', {
    class: 'press quietly small',
    text: 'Read what it did before',
    attrs: { type: 'button' },
  })
  into(foot, reading, again)
  const waiting = skeleton(5)
  waiting.classList.add('ag-time-coming')
  const state = stateBox()
  into(card, waiting, chart, list, foot)
  into(part.body, card, state)

  const kept = momentsKept()
  /** The agent's own path, from its answer; null before the first. */
  let path = null
  let busy = false
  let stalled = false
  /** What the last paint was handed, so a page read further back draws with it. */
  let last = null

  const footIn = () => {
    reading.hidden = !busy
    again.hidden = busy || !stalled
    foot.hidden = reading.hidden && again.hidden
  }

  const go = async () => {
    const before = kept.earlier
    if (busy || stalled || before === null || path === null) return
    busy = true
    footIn()
    const got = await readFrom(`${path}/moments?before=${encodeURIComponent(before)}`)
    busy = false
    const page = got.status === 200 && got.body !== null && got.body.v === 1 ? got.body : null
    if (page !== null && page.why === null) kept.older(page)
    // Not on this device any more: nothing before it to read here.
    else if (page?.why === 'not here') kept.older({ activity: [], earlier: null })
    else stalled = true
    footIn()
    if (last !== null) fill(...last)
    // Still near the end with more to read — a short list, or a fast thumb.
    globalThis.requestAnimationFrame?.(look)
  }

  /** Read on where the reader is near the end of the list, or where it cannot scroll at all. */
  function look() {
    if (kept.earlier === null) return
    const left = list.scrollHeight - list.scrollTop - list.clientHeight
    if (left < NEAR_END) void go()
  }

  list.addEventListener('scroll', look, { passive: true })
  again.addEventListener('click', () => {
    stalled = false
    void go()
  })
  footIn()

  function fill(heard, task, checks, view) {
    const { answer, failed } = heard
    waiting.hidden = answer !== null || failed !== null
    if (answer === null) {
      card.hidden = failed !== null
      chart.hidden = true
      list.hidden = true
      textIn(part.figure, '')
      stateBoxIn(
        state,
        failed === null ? null : stateOf('error', 'Couldn’t read what it has been doing', failed),
      )
      return
    }
    kept.newest(answer)
    path = `/api/agent/${agentPath(answer.task)}`
    const held = kept.held()
    const drawn = timelineOf(held, task, checks.tree, checks.own, view.asOf)
    const busyLanes = drawn.lanes.some((one) => one.spans.length + one.marks.length > 0)
    const moments = momentsOf(held)
    card.hidden = !busyLanes && moments.length === 0 && held.earlier === null
    stateBoxIn(
      state,
      card.hidden
        ? stateOf(
            'empty',
            'Nothing written down about it yet',
            'Its turns, tools, checks and commits show here as they happen.',
            'clock',
          )
        : null,
    )
    chart.hidden = !busyLanes
    if (busyLanes) lanesIn(chart, drawn)
    textIn(part.figure, busyLanes ? `the last ${drawn.span}` : '')
    list.hidden = moments.length === 0
    keyed(
      list,
      moments,
      (one) => one.key,
      createMoment,
      (one, moment) => fillMoment(one, moment, view),
    )
  }

  return {
    node: part.node,
    /** `heard` is the screen card's `{ answer, failed }`; `checks` its record of runs. */
    update(heard, task, checks, view) {
      last = [heard, task, checks, view]
      fill(heard, task, checks, view)
      look()
    },
  }
}

/** `project/task` as two segments of a path, each encoded. */
function agentPath(task) {
  const [project = '', ...rest] = task.split('/')
  return `${encodeURIComponent(project)}/${encodeURIComponent(rest.join('/'))}`
}

function createMoment() {
  const node = el('li')
  const row = el('div')
  const glyph = el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } })
  const said = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  into(row, glyph, said, aside)
  into(node, row)
  return node
}

function fillMoment(node, moment, view) {
  const [row] = node.children
  const [glyph, said, aside] = row.children
  textIn(glyph, moment.glyph)
  toneOn(glyph, moment.tone)
  textIn(said, moment.said)
  const age = ageSaid(moment.at, view.asOf, view.frozen)
  textIn(aside, age ?? '')
}
