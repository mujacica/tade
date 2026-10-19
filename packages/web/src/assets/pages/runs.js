// The plans, as two screens: the plans there are (here), and one plan's own
// graph (`runs-run.js`).
//
// **A plan to a person, a run on the wire**: only what is read was renamed;
// views, files, classes and `RunRow` still say run.
//
// **A run is an effort and nothing new**: one ordinary task per repository,
// each with its own branch, checks, review and done rule, grouped by the fold
// of the task files that name it. So nothing here keeps anything, and what is
// drawn as a graph is read out of the same `start.after` the queue's own rule
// reads.
//
// **What wants you first**, then what is moving and how far along, then what
// is done: every step as a ring, then a card per plan still going (its map and
// what is happening now) and a quiet row per finished one.
//
// Nothing here decides a state, a count or a reason (`runs-shape.js`).

import { donut, donutIn, legendIn } from '../charts.js'
import { el, glyphOf, into, keyed, markIn, skeleton, textIn, toneOn } from '../dom.js'
import { count } from '../figures.js'
import { pathOf } from '../routes.js'
import { sayIn, section } from '../rows.js'
import { runsOf } from '../store.js'
import { panel, stateBox, stateBoxIn } from '../ui.js'
import { runMap, runMapIn, track, trackIn } from './runs-draw.js'
import {
  GROUPS,
  groupsOf,
  nowOf,
  overallOf,
  paidOf,
  partMark,
  runMark,
  runSays,
  stateOf,
} from './runs-shape.js'

export { runScreen } from './runs-run.js'
export { runSays, stepSays } from './runs-shape.js'

/* ── the runs ──────────────────────────────────────────────────────────────── */

export function runsScreen() {
  const node = el('div')
  const made = section('PLANS', { top: true })
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
      const rows = had ? runsOf(view.store) : []
      textIn(made.figure, had ? count(rows.length) : '')
      made.figure.setAttribute('aria-label', `${rows.length} plans`)
      coming.hidden = had
      stateBoxIn(
        nothing,
        had && rows.length === 0
          ? stateOf(
              'empty',
              'No plans yet',
              'A plan is one piece of work carried out across projects: every task that names the same effort, in the order they wait on each other. Start one from a workflow, or ask Tade to plan one.',
            )
          : null,
      )
      lead.node.hidden = rows.length === 0
      if (rows.length > 0) lead.fill(overallOf(rows))
      const grouped = groupsOf(rows)
      groups.forEach((one, at) => {
        one.fill(grouped[at].runs, view)
      })
    },
  }
}

/* ── the lead: every step of every run, and the runs by where they stand ───── */

/** The figures beside the ring, in the order a person wants them. */
const FIGURES = [
  { key: 'needs', label: 'need you', tone: 't-wants' },
  { key: 'going', label: 'under way', tone: 't-working' },
  { key: 'finished', label: 'finished', tone: 't-done' },
]

function leadOf() {
  const node = el('div', { class: 'ui-card runs-lead' })
  const ring = donut('Every step of every plan')
  const figures = el('ul', {
    class: 'runs-lead-figures',
    attrs: { 'aria-label': 'Plans, by where they stand' },
  })
  for (const one of FIGURES) {
    const item = el('li', { class: 'runs-lead-figure' })
    into(item, el('span', { class: 'runs-lead-n' }), el('span', { text: one.label }))
    figures.append(item)
  }
  const legend = el('ul', { class: 'ui-legend', attrs: { 'aria-label': 'Every step, by part' } })
  into(node, ring, figures, legend)
  return {
    node,
    fill(all) {
      donutIn(ring, all.parts, {
        said: `${all.done}/${all.steps}`,
        under: 'steps done',
      })
      FIGURES.forEach((one, at) => {
        const item = figures.children[at]
        const [n] = item.children
        textIn(n, String(all[one.key]))
        // A figure takes its tone only where there is something to see:
        // nought violet would be a colour saying *act* about nothing.
        toneOn(n, all[one.key] > 0 ? one.tone : null)
        item.setAttribute(
          'aria-label',
          `${all[one.key]} ${all[one.key] === 1 ? 'plan' : 'plans'} ${one.label}`,
        )
      })
      legendIn(legend, all.parts)
    },
  }
}

/* ── the groups ────────────────────────────────────────────────────────────── */

/**
 * One group of runs under its heading: cards for what is still going, where
 * the map and the line about now earn their room, and plain rows for what is
 * finished or out of sight, where they would only be noise.
 */
function groupOf(group) {
  const made = section(group.heading)
  const cards = group.key === 'needs' || group.key === 'going'
  const list = cards ? el('ul', { class: 'runs-cards' }) : panel('ul', 'rows')
  into(made.body, list)
  return {
    made,
    fill(runs, view) {
      made.node.hidden = runs.length === 0
      textIn(made.figure, count(runs.length))
      made.figure.setAttribute('aria-label', `${runs.length} plans`)
      if (cards) {
        keyed(
          list,
          runs,
          (row) => row.run,
          createCard,
          (one, row) => fillCard(one, row, view),
        )
        // **The maps last, once every card is on the page**, so each is drawn
        // to the room its card has: every width read first, then every map
        // written, which is one layout for the group rather than one a card.
        const maps = [...list.children].map((card) => card.querySelector('.runs-map'))
        const rooms = maps.map((map) => map?.clientWidth ?? 0)
        maps.forEach((map, at) => {
          if (map !== null && runs[at] !== undefined) runMapIn(map, runs[at], rooms[at])
        })
      } else
        keyed(
          list,
          runs,
          (row) => row.run,
          createRunRow,
          (one, row) => fillRunRow(one, row, view),
        )
    },
  }
}

/* ── a run, as a card ──────────────────────────────────────────────────────── */

/**
 * A run still going: its mark, its name and how far along it is, the line of
 * its steps, its map, and the loudest of what is happening in it now.
 *
 * **The name is the link, and the card is its target**: the whole card
 * answers a tap (`.runs-card-link::after`), but what a screen reader hears as
 * the link is the run's name — not a paragraph of everything the card says.
 */
function createCard() {
  const item = el('li', { class: 'ui-card runs-card' })
  const head = el('div', { class: 'runs-card-head' })
  const glyph = glyphOf(partMark('waiting'))
  const link = el('a', { class: 'runs-card-link', attrs: { href: '/plans' } })
  const tally = el('span', { class: 'runs-tally' })
  into(tally, el('span', { class: 'runs-tally-done' }), el('span', { class: 'runs-tally-total' }))
  into(head, glyph, link, tally)
  const meta = el('p', { class: 'runs-card-meta' })
  // The ✕ carries the red and the words stay a text grey: red as text is under
  // AA on a card washed in its own tone, which is where this line most often is.
  const red = el('span', { class: 'runs-card-red' })
  into(
    red,
    el('span', { class: 'glyph t-failed', text: '✕', attrs: { 'aria-hidden': 'true' } }),
    el('span', { text: 'checks red' }),
  )
  into(meta, el('span'), red)
  const line = track()
  const now = el('div', { class: 'runs-now' })
  into(now, el('ul'), el('p', { class: 'runs-now-more' }))
  // Five parts, each on a row the card shares with the cards beside it
  // (`grid-template-rows: subgrid`), so two runs side by side line up.
  return into(item, head, meta, line, runMap(), now)
}

function fillCard(item, run, view) {
  const [head, meta, line, , now] = item.children
  const [glyph, link, tally] = head.children
  const [done, total] = tally.children
  markIn(glyph, runMark(run))
  link.setAttribute('href', pathOf({ view: 'run', run: run.run }))
  textIn(link, run.run)
  textIn(done, String(run.finished))
  textIn(total, `/${run.total}`)
  tally.setAttribute('aria-label', `${run.finished} of ${run.total} steps finished`)
  const [where, red] = meta.children
  textIn(where, metaOf(run, view))
  // **Red is the one check a card says**: a run's checks that nobody ran here
  // are its own screen's to explain, and green is what the track already says.
  red.hidden = run.checks !== 'fail'
  trackIn(line, run)
  const [list, more] = now.children
  const said = nowOf(run)
  keyed(list, said.lines, (one) => one.task, createNowLine, fillNowLine)
  sayIn(more, said.more === 0 ? '' : `${said.more} more open`)
}

/**
 * Where a run is and what it came from, in one quiet line: its projects, the
 * workflow it was stamped from, and its cost where there is a figure — never
 * a dash in a line of clauses, which the run's own screen has room to explain.
 */
function metaOf(run, view) {
  const bits = [run.projects.join(' · ') || 'no project this device may read']
  if (run.stamp !== null) bits.push(`${run.stamp.name}@${run.stamp.version}`)
  const paid = paidOf(run.usd, view, run.usd !== null && run.usd > 0)
  if (paid.said !== '—') bits.push(paid.said)
  return bits.join(' · ')
}

function createNowLine() {
  const item = el('li')
  // The glyph is the picture and the clause beside the name is the word, so a
  // screen reader hears *wants you* once rather than twice.
  const glyph = el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } })
  const name = el('span', { class: 'runs-now-name' })
  const said = el('span', { class: 'runs-now-said' })
  return into(item, glyph, name, said)
}

function fillNowLine(item, one) {
  const [glyph, name, said] = item.children
  const mark = partMark(one.part)
  textIn(glyph, mark.glyph)
  toneOn(glyph, mark.tone)
  textIn(name, one.name)
  textIn(said, one.said)
}

/* ── a run, as a row: finished, or out of sight ────────────────────────────── */

function createRunRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/plans' } })
  const glyph = glyphOf(partMark('finished'))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(link, glyph, name, aside, under)
  return into(node, link)
}

function fillRunRow(node, row, view) {
  const [link] = node.children
  const [glyph, name, aside, under] = link.children
  link.setAttribute('href', pathOf({ view: 'run', run: row.run }))
  markIn(glyph, runMark(row))
  textIn(name, row.run)
  textIn(aside, row.total === 0 ? '' : `${row.finished}/${row.total}`)
  aside.setAttribute('aria-label', `${row.finished} of ${row.total} steps finished`)
  // A run with no step this device may read says so, rather than *every step
  // finished* of nought steps — which is the one sentence it must not say.
  textIn(
    under,
    row.steps.length === 0
      ? 'none of its steps is in a project this device may read'
      : runSays(row, view),
  )
}
