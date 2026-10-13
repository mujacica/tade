// One plan (a run, on the wire): how far along it is, what in it wants
// somebody, and its graph — what is done, what is running, what is waiting and
// on what.
//
// **Two drawings of one graph, chosen by the room.** Boxes and curves (`flow`)
// where the work is wide, as the window's `plan-graph.ts`; under it, and alone
// on a phone, **stages** — a rail with a stop per layer, each step with what it
// waits on and why. Both read the wire's `layer` and `waits`.

import { flow, flowIn, legendIn } from '../charts.js'
import { el, glyphOf, into, keyed, markIn, skeleton, textIn, toneOn } from '../dom.js'
import { checkMark } from '../glyphs.js'
import { requestPath, taskPath } from '../routes.js'
import { pageBar, section } from '../rows.js'
import { runAt } from '../store.js'
import { facts, factsIn, panel, stateBox, stateBoxIn } from '../ui.js'
import { track, trackIn } from './runs-draw.js'
import {
  costSaid,
  directionFor,
  graphOf,
  paidOf,
  partMark,
  partOf,
  partsOf,
  runMark,
  shortNamesOf,
  stagesOf,
  stateOf,
  stepSays,
  waitsOf,
  whySaid,
} from './runs-shape.js'

export function runScreen(where) {
  const node = el('div')
  const glyph = glyphOf(partMark('waiting'))
  const bar = pageBar(where.run, { name: true, glyph, back: { text: 'Plans', href: '/plans' } })
  const fromLink = el('a', { class: 'press quietly small', text: 'The request behind it' })
  into(bar.tools, fromLink)
  const coming = skeleton(4)
  const gone = stateBox()

  const hero = heroOf()
  const needs = section('NEEDS YOU')
  const needList = panel('ul', 'rows')
  into(needs.body, needList)
  const graph = section('THE GRAPH')
  graph.node.classList.add('runs-graph')
  const drawing = flow('The plan’s steps, and what each waits on')
  into(graph.body, drawing)
  const stages = section('STAGE BY STAGE')
  const rail = el('ol', { class: 'runs-stages' })
  const empty = stateBox()
  into(stages.body, rail, empty)

  const parts = [hero, needs, graph, stages]
  into(node, bar.node, coming, gone, ...parts.map((one) => one.node))

  return {
    node,
    update(view) {
      const had = view.store.had === true
      const row = had ? runAt(view.store, where.run) : null
      coming.hidden = had
      stateBoxIn(
        gone,
        had && row === null
          ? stateOf(
              'empty',
              'Not on this device',
              'This plan is not one this device may read, or nothing is left of it: its task files are not there.',
            )
          : null,
      )
      fromLink.hidden = row?.from === null || row?.from === undefined
      if (row?.from) fromLink.setAttribute('href', requestPath(row.from.item))
      for (const one of parts) one.node.hidden = row === null
      glyph.hidden = row === null
      if (row === null) return

      markIn(glyph, runMark(row))
      hero.fill(row, view)
      const names = shortNamesOf(row.steps)

      const loud = row.steps.filter((step) => ['wants', 'failed'].includes(partOf(step)))
      needs.node.hidden = loud.length === 0
      textIn(needs.figure, loud.length === 0 ? '' : String(loud.length))
      needs.figure.setAttribute('aria-label', `${loud.length} steps`)
      keyed(
        needList,
        loud,
        (step) => step.task,
        createNeedRow,
        (one, step) => fillNeedRow(one, step, names),
      )

      // **No graph where there is no step.** A run whose tasks are all in
      // projects this device may not read, or whose task files are gone, has
      // nothing to draw — and an empty canvas under a heading reads as
      // something that failed to load rather than as an answer.
      graph.node.hidden = row.steps.length < 2
      if (row.steps.length >= 2) {
        const shape = graphOf(row, names)
        // The room is read off the region itself, which is on the page by the
        // time a screen is first painted (`boot.js` attaches, then paints).
        flowIn(drawing, shape, directionFor(shape, drawing.clientWidth))
      }
      stateBoxIn(
        empty,
        row.steps.length > 0
          ? null
          : stateOf(
              'empty',
              'No step to draw',
              row.total === 0 && row.projects.length === 0
                ? 'None of its steps is in a project this device may read.'
                : 'Nothing is left of this plan: its task files are not there.',
            ),
      )
      const staged = stagesOf(row)
      textIn(stages.figure, staged.length === 0 ? '' : String(staged.length))
      stages.figure.setAttribute('aria-label', `${staged.length} stages`)
      keyed(
        rail,
        staged,
        (stage) => String(stage.layer),
        createStage,
        (one, stage) => fillStage(one, stage, row, names, view),
      )
    },
  }
}

/* ── the hero: how far along, and the run's facts ──────────────────────────── */

/**
 * How far along the run is, drawn: the fraction large, a segment per step in
 * its step's tone, the parts in words under it, and the run's facts beside
 * them — the one card on the screen, so it is what the eye lands on first.
 */
function heroOf() {
  const node = el('div', { class: 'ui-card runs-hero' })
  const progress = el('div', { class: 'runs-hero-progress' })
  const figure = el('p', { class: 'runs-hero-figure' })
  into(
    figure,
    el('span', { class: 'runs-hero-done' }),
    el('span', { class: 'runs-hero-total' }),
    el('span', { class: 'runs-hero-label', text: 'steps finished' }),
  )
  const line = track('is-big')
  const legend = el('ul', { class: 'ui-legend', attrs: { 'aria-label': 'The steps, by part' } })
  into(progress, figure, line, legend)
  const about = facts('About this plan')
  into(node, progress, about)
  return {
    node,
    fill(row, view) {
      const [done, total] = figure.children
      textIn(done, String(row.finished))
      textIn(total, `/${row.total}`)
      figure.setAttribute('aria-label', `${row.finished} of ${row.total} steps finished`)
      trackIn(line, row)
      legendIn(legend, partsOf(row.steps))
      const checks = checkMark(row.checks)
      factsIn(about, [
        { label: 'checks', value: checks.word, tone: checks.tone },
        // **Which dash it is, said in the one place with room for it.** Not
        // granted, not recorded and nought are three different mornings.
        { label: 'cost', value: costSaid(row.usd, view) },
        {
          label: 'workflow',
          value: row.stamp === null ? 'none' : `${row.stamp.name}@${row.stamp.version}`,
          under: row.stamp === null ? 'ordinary tasks' : null,
        },
        {
          label: row.projects.length === 1 ? 'project' : 'projects',
          value: row.projects.join(', ') || '—',
          under: row.projects.length === 0 ? 'none this device may read' : null,
        },
        ...(row.retries > 0
          ? [
              {
                label: 'delivery',
                value: `${row.retries} ${row.retries === 1 ? 'retry' : 'retries'}`,
                under: 'before the plan existed',
              },
            ]
          : []),
      ])
    },
  }
}

/* ── what wants somebody ───────────────────────────────────────────────────── */

function createNeedRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  const glyph = glyphOf(partMark('wants'))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  into(link, glyph, name, aside, under)
  return into(node, link)
}

function fillNeedRow(node, step, names) {
  const [link] = node.children
  const [glyph, name, aside, under] = link.children
  const mark = partMark(partOf(step))
  link.setAttribute('href', taskPath(step.task))
  markIn(glyph, mark)
  textIn(name, names.get(step.task) ?? step.name)
  textIn(aside, step.project)
  textIn(under, `${mark.word} · ${stepSays(step)}`)
}

/* ── the graph, as stages ──────────────────────────────────────────────────── */

function createStage() {
  const item = el('li', { class: 'runs-stage' })
  const head = el('div', { class: 'runs-stage-head' })
  const stop = el('span', { class: 'runs-stage-stop', attrs: { 'aria-hidden': 'true' } })
  const title = el('h3', { class: 'runs-stage-title' })
  const said = el('span', { class: 'runs-stage-said' })
  const tally = el('span', { class: 'runs-stage-tally' })
  into(head, stop, title, said, tally)
  return into(item, head, el('ul', { class: 'runs-steps' }))
}

function fillStage(item, stage, row, names, view) {
  const [head, list] = item.children
  const [stop, title, said, tally] = head.children
  const finished = stage.done === stage.steps.length
  for (const part of ['finished', 'working', 'wants', 'failed', 'waiting']) {
    item.classList.toggle(`is-${part}`, stage.part === part)
  }
  textIn(stop, finished ? '✓' : String(stage.layer + 1))
  textIn(title, stage.name)
  textIn(said, stage.said)
  textIn(tally, `${stage.done}/${stage.steps.length}`)
  tally.setAttribute('aria-label', `${stage.done} of ${stage.steps.length} finished`)
  keyed(
    list,
    stage.steps,
    (step) => step.task,
    createStep,
    (one, step) => fillStep(one, step, row, names, view),
  )
}

/**
 * One step, as a card in its stage: its mark and name — the link to its
 * agent, and the card is its target — where it works and how its checks and
 * review stand, what it cost, and what it waits on with why.
 */
function createStep() {
  const item = el('li', { class: 'ui-card runs-step' })
  const head = el('div', { class: 'runs-step-head' })
  const glyph = glyphOf(partMark('waiting'))
  const link = el('a', { class: 'runs-step-link', attrs: { href: '/' } })
  const cost = el('span', { class: 'runs-step-cost' })
  into(head, glyph, link, cost)
  const meta = el('p', { class: 'runs-step-meta' })
  into(meta, el('span', { class: 'ui-pill runs-step-project' }), el('span'))
  const waits = el('ul', { class: 'runs-waits' })
  return into(item, head, meta, waits)
}

function fillStep(item, step, row, names, view) {
  const [head, meta, waits] = item.children
  const [glyph, link, cost] = head.children
  const part = partOf(step)
  for (const one of ['finished', 'review', 'working', 'wants', 'failed', 'waiting', 'parked']) {
    item.classList.toggle(`is-${one}`, part === one)
  }
  markIn(glyph, partMark(part))
  link.setAttribute('href', taskPath(step.task))
  textIn(link, names.get(step.task) ?? step.name)
  // A step's cost only where it has one: nought on a step no agent has been
  // on is not worth a column, and *not granted* is said once, in the facts.
  const paid = paidOf(step.usd, view, step.usd !== null && step.usd > 0)
  textIn(cost, paid.said === '—' ? '' : paid.said)
  const [project, words] = meta.children
  textIn(project, step.project)
  textIn(words, stepSays(step))
  keyed(
    waits,
    waitsOf(step, row),
    (wait) => wait.task,
    createWait,
    (one, wait) => fillWait(one, wait, view),
  )
}

function createWait() {
  const item = el('li')
  const glyph = el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } })
  const name = el('span', { class: 'runs-wait-name' })
  into(
    name,
    el('span', { class: 'sr-only', text: 'after ' }),
    el('span'),
    el('span', { class: 'sr-only' }),
  )
  const why = el('span', { class: 'runs-wait-why' })
  return into(item, glyph, name, why)
}

/**
 * One wait: what it is on, whether that has finished, and why — the reason
 * somebody gave, or which nothing it is where there is none.
 */
function fillWait(item, wait, view) {
  const [glyph, name, why] = item.children
  const mark = wait.finished ? partMark('finished') : partMark(wait.part)
  textIn(glyph, mark.glyph)
  toneOn(glyph, mark.tone)
  const [, said, state] = name.children
  textIn(said, wait.name)
  textIn(state, `, ${wait.finished ? 'finished' : mark.word}`)
  textIn(why, whySaid(wait, view))
}
