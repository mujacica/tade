// The workflows, as two screens: the workflows there are (here), and one
// workflow (`workflows-one.js`).
//
// **What somebody opening this page wants first** is which workflows are
// ready to run, which are being written, and whether any draft would not
// publish — then what each one *does*. So the page leads with the whole as one
// picture (how many, how they stand, what was run from them) and then the
// workflows as cards grouped the same way: the drafts first, because a draft
// is the one thing a device may write to; then what is published; then what
// Tade ships. Each card draws its workflow's shape — a column per stage, a dot
// per step, a curve per wait, and the stages in words beside it — its versions
// as a line, and the runs stamped from it.
//
// **A published version is a snapshot and never changes**, and a draft is a
// file no run reads: the line of versions draws them as two kinds of mark,
// always, so `v3` never means two things on one screen.
//
// **What is absent is the point.** There is no publish, no new, no rename and
// no delete: each decides what every future run does, and each is an act at
// the machine with no route at all (`workflows-one.js` names them).
//
// Nothing here decides a state, a count or a reason (`workflows-shape.js`).

import { mayFor } from '../access.js'
import { stack, stackIn } from '../charts.js'
import { el, glyphOf, into, keyed, markIn, skeleton, textIn } from '../dom.js'
import { count } from '../figures.js'
import { pathOf } from '../routes.js'
import { sayIn, section } from '../rows.js'
import { omitted, runsOf, workflowsOf } from '../store.js'
import { stateBox, stateBoxIn } from '../ui.js'
import {
  figureSaid,
  runsLine,
  runsLineIn,
  shape,
  shapeIn,
  versionLine,
  versionLineIn,
} from './workflows-draw.js'
import {
  GROUPS,
  groupsOf,
  overallOf,
  runsLineOf,
  standingMark,
  standingOf,
  stateOf,
} from './workflows-shape.js'

export { workflowScreen } from './workflows-one.js'

/* ── the workflows ─────────────────────────────────────────────────────────── */

export function workflowsScreen() {
  const node = el('div')
  const made = section('WORKFLOWS', { top: true })
  const coming = skeleton(3)
  const nothing = stateBox()
  const lead = leadOf()
  const groups = GROUPS.map((one) => groupOf(one))
  into(made.body, coming, nothing, lead.node, ...groups.map((one) => one.made.node))
  into(node, made.node)

  return {
    node,
    update(view) {
      const had = view.store.had === true
      const rows = had ? workflowsOf(view.store) : []
      const total = rows.length + omitted(view.store, 'workflows')
      figureSaid(made.figure, had ? count(total) : '', total, 'workflows')
      coming.hidden = had
      // **Two nothings, two sentences**: none written, and none this device
      // was granted — which carries its count, because *there are three and
      // you may not read them from here* is not *there are none*.
      stateBoxIn(nothing, had && rows.length === 0 ? nothingOf(view, total) : null)
      const runs = had ? runsOf(view.store) : []
      lead.node.hidden = rows.length === 0
      if (rows.length > 0) lead.fill(overallOf(rows, runs))
      const grouped = groupsOf(rows)
      groups.forEach((one, at) => {
        one.fill(grouped[at].rows, runs)
      })
    },
  }
}

function nothingOf(view, total) {
  if (!mayFor(view.store, 'workflows')) {
    return stateOf(
      'empty',
      'Not granted to this device',
      total === 0
        ? 'The workflows are a grant of their own, given at the machine when a device is paired.'
        : total === 1
          ? 'There is one workflow at the machine, and this device was not granted it.'
          : `There are ${total} workflows at the machine, and this device was not granted them.`,
    )
  }
  if (total > 0) return null
  return stateOf(
    'empty',
    'No workflows yet',
    'A workflow is the steps of work that arrives the same way again and again. One is written and published at the machine; a draft of it can then be filled in here.',
  )
}

/* ── the lead: how many, how they stand, and what ran from them ────────────── */

function leadOf() {
  const node = el('div', { class: 'ui-card wf-lead' })
  const figures = el('div', { class: 'wf-lead-figures' })
  const many = el('p', { class: 'wf-lead-many' })
  into(many, el('span', { class: 'wf-lead-n' }), el('span', { class: 'wf-lead-unit' }))
  const ran = el('p', { class: 'wf-lead-ran' })
  into(
    ran,
    el('span', { class: 'wf-lead-m' }),
    el('span', { class: 'wf-lead-unit' }),
    el('span', { class: 'wf-lead-going' }),
  )
  into(figures, many, ran)
  const parts = stack('How the workflows stand')
  into(node, figures, parts)
  return {
    node,
    fill(all) {
      const [n, unit] = many.children
      textIn(n, String(all.workflows))
      textIn(unit, all.workflows === 1 ? 'workflow' : 'workflows')
      const [m, word, going] = ran.children
      textIn(m, String(all.runs))
      textIn(word, all.runs === 1 ? 'plan stamped from them' : 'plans stamped from them')
      textIn(going, all.going === 0 ? '' : `${all.going} under way`)
      going.hidden = all.going === 0
      stackIn(parts, all.parts)
    },
  }
}

/* ── a group of cards ──────────────────────────────────────────────────────── */

function groupOf(group) {
  const made = section(group.heading)
  const list = el('ul', { class: 'wf-cards' })
  into(made.body, list)
  return {
    made,
    fill(rows, runs) {
      made.node.hidden = rows.length === 0
      figureSaid(made.figure, count(rows.length), rows.length, 'workflows')
      keyed(
        list,
        rows,
        (row) => row.name,
        createCard,
        (one, row) => fillCard(one, row, runs),
      )
    },
  }
}

/* ── one workflow, as a card ───────────────────────────────────────────────── */

let cards = 0

/**
 * A workflow as a card: its mark and name, what it is for, the shape its steps
 * make, its versions, the runs from it, and what would stop it publishing.
 *
 * **The name is the link, and the card is its target**: the whole card
 * answers a tap (`.wf-card-link::after`), but what a screen reader hears as
 * the link is the workflow's name, described by its line (`workflowSays`) —
 * not a paragraph of everything the card draws.
 */
function createCard() {
  cards += 1
  const item = el('li', { class: 'ui-card wf-card' })
  const head = el('div', { class: 'wf-card-head' })
  const glyph = glyphOf(standingMark('empty'))
  // Hidden, and still the link's description: a node `aria-describedby` names
  // is read from whether or not it is drawn, and drawn it would be read twice.
  const says = el('span', { attrs: { id: `wf-says${cards}`, hidden: '' } })
  const link = el('a', {
    class: 'wf-card-link',
    attrs: { href: '/workflows', 'aria-describedby': `wf-says${cards}` },
  })
  const tag = el('span', { class: 'ui-pill', text: 'ships with Tade' })
  into(head, glyph, link, tag, says)
  const about = el('p', { class: 'wf-card-about' })
  const drawn = shape()
  const foot = el('div', { class: 'wf-card-foot' })
  into(foot, versionLine(), runsLine())
  const stops = el('p', { class: 'wf-card-stops' })
  into(
    stops,
    el('span', { class: 'glyph t-failed', text: '▲', attrs: { 'aria-hidden': 'true' } }),
    el('span'),
  )
  return into(item, head, about, stops, drawn, foot)
}

function fillCard(item, row, runs) {
  const [head, about, stops, drawn, foot] = item.children
  const [glyph, link, tag, says] = head.children
  const standing = standingOf(row)
  markIn(glyph, standingMark(standing))
  item.setAttribute('data-standing', standing)
  link.setAttribute('href', pathOf({ view: 'workflow', name: row.name }))
  textIn(link, row.name)
  textIn(says, workflowSays(row))
  tag.hidden = !row.builtIn
  sayIn(about, row.title?.words ?? '')
  shapeIn(drawn, row)
  const [versions, ran] = foot.children
  versionLineIn(versions, row, runs)
  runsLineIn(ran, runsLineOf(row, runs))
  const n = row.problems.length
  stops.hidden = n === 0
  textIn(
    stops.lastChild,
    n === 0 ? '' : `${n} ${n === 1 ? 'thing' : 'things'} would stop it publishing`,
  )
}

/**
 * One workflow in a line.
 *
 * **A published version and a draft are said apart**, always: a published
 * version is a snapshot a run can still point at and never changes, and a
 * draft is a file no run reads. Collapsing them would make *v3* mean two
 * different things on one screen.
 */
export function workflowSays(row) {
  const bits = []
  if (row.builtIn) bits.push('one Tade ships')
  bits.push(row.published === null ? 'not published' : `published v${row.published}`)
  if (row.draft !== null) bits.push(`draft v${row.draft}`)
  if (row.steps.length > 0)
    bits.push(`${row.steps.length} ${row.steps.length === 1 ? 'step' : 'steps'}`)
  if (row.runs > 0) bits.push(`${row.runs} ${row.runs === 1 ? 'plan' : 'plans'}`)
  if (row.problems.length > 0) bits.push(`${row.problems.length} would stop it publishing`)
  return bits.join(' · ')
}
