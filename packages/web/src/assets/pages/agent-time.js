// One agent's timeline: what it has been doing, drawn over time and then said
// moment by moment — the agent page's (`agent.js`), from the answer its screen
// card asks for (`agent-pane.js`).
//
// **A lane each for the agent running, its turns, its tools, its checks and
// its commits**, over one axis that ends at now, so a run that has gone quiet
// is a gap anybody can see and a red check sits under the turn that made it.
// Under it the moments themselves, newest first, the newest few shown and the
// rest one press away: the chart is the shape and the list is the words, and
// neither is the only statement of anything.
//
// Built once and filled on every paint, like every region: a delta writes text
// and classes into nodes that are already here, so the fold somebody opened
// stays open.

import { lanes, lanesIn } from '../charts.js'
import { el, into, keyed, skeleton, textIn, toneOn } from '../dom.js'
import { ageSaid } from '../figures.js'
import { section } from '../rows.js'
import { stateBox, stateBoxIn } from '../ui.js'
import { FOLD, foldSaid, momentsOf, stateOf, timelineOf } from './agent-shape.js'

export function timeline() {
  const part = section('TIMELINE')
  part.node.id = 'ag-time'
  const card = el('div', { class: 'ui-panel ag-time' })
  const chart = lanes('What it has been doing, over time')
  chart.classList.add('ag-lanes')
  const list = el('ul', { class: 'ui-timeline ag-moments' })
  const foot = el('div', { class: 'ag-time-foot' })
  const fold = el('button', {
    class: 'press quietly small ag-fold',
    attrs: { type: 'button', 'aria-expanded': 'false' },
  })
  const older = el('span', { class: 'ag-older', text: 'older moments were not sent' })
  into(foot, fold, older)
  const waiting = skeleton(5)
  waiting.classList.add('ag-time-coming')
  const state = stateBox()
  into(card, waiting, chart, list, foot)
  into(part.body, card, state)

  let open = false
  let shown = 0
  fold.addEventListener('click', () => {
    open = !open
    foldIn()
  })

  // The moments past the first few, folded: `hidden` on each, and the last one
  // shown ends the rule, so the line stops at the last dot drawn.
  const foldIn = () => {
    const items = [...list.children]
    items.forEach((item, at) => {
      item.hidden = !open && at >= FOLD
      item.classList.toggle('is-end', !open && at === FOLD - 1)
    })
    const hidden = Math.max(0, items.length - FOLD)
    fold.hidden = hidden === 0
    fold.setAttribute('aria-expanded', String(open))
    textIn(fold, foldSaid(hidden, open))
  }

  return {
    node: part.node,
    /** `heard` is the screen card's `{ answer, failed }`; `checks` its record of runs. */
    update(heard, task, checks, view) {
      const { answer, failed } = heard
      waiting.hidden = answer !== null || failed !== null
      if (answer === null) {
        card.hidden = failed !== null
        chart.hidden = true
        list.hidden = true
        foot.hidden = true
        textIn(part.figure, '')
        stateBoxIn(
          state,
          failed === null ? null : stateOf('error', 'Couldn’t read what it has been doing', failed),
        )
        return
      }
      const drawn = timelineOf(answer, task, checks.tree, checks.own, view.asOf)
      const busy = drawn.lanes.some((one) => one.spans.length + one.marks.length > 0)
      const moments = momentsOf(answer)
      card.hidden = !busy && moments.length === 0
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
      chart.hidden = !busy
      if (busy) lanesIn(chart, drawn)
      textIn(part.figure, busy ? `the last ${drawn.span}` : '')
      list.hidden = moments.length === 0
      keyed(
        list,
        moments,
        (one) => one.key,
        createMoment,
        (one, moment) => fillMoment(one, moment, view),
      )
      if (moments.length !== shown) {
        shown = moments.length
        foldIn()
      }
      older.hidden = !answer.more
      foot.hidden = fold.hidden && older.hidden
    },
  }
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
