// A run of a workflow, as two screens: the runs there are, and one run's own
// graph.
//
// **A run is an effort and nothing new**: one ordinary task per repository,
// each with its own branch, checks, review and done rule, grouped by the fold
// of the task files that name it. So nothing here keeps anything, and what is
// drawn as a graph is read out of the same `start.after` the queue's own rule
// reads.
//
// **Layers and not a canvas.** A node canvas needs a layout engine, hit
// testing and a zoom, and at 360 pixels there is nowhere to put any of them.
// What a reader needs is which steps can go now, which wait, and on what — and
// a layer number answers all three. The window draws the same graph with boxes
// and lines because it has the room (`plan-graph.ts`); both read the same
// `waits`, so neither is a second layout of a different graph.
//
// Nothing here decides a state, a count or a reason.

import { el, glyphOf, into, keyed, markIn, textIn } from './dom.js'
import { count, money } from './figures.js'
import { checkMark, reviewMark, stepMark } from './glyphs.js'
import { pathOf, requestPath, taskPath } from './routes.js'
import { createWaitRow, dl, dlIn, fillWaitRow, sayIn, section } from './rows.js'
import { mayRead, omitted, runAt, runsOf } from './store.js'

/* ── the runs ──────────────────────────────────────────────────────────────── */

export function runsScreen() {
  const node = el('div')
  const made = section('RUNS', { top: true })
  const list = el('ul', { class: 'rows' })
  const none = el('p', {
    class: 'empty',
    text: 'nothing is running as a workflow: a run is the tasks that name one effort',
  })
  into(made.body, list, none)
  const left = el('p', { class: 'unknown' })
  into(node, made.node, left)

  return {
    node,
    update(view) {
      const rows = runsOf(view.store)
      textIn(made.figure, count(rows.length))
      made.figure.setAttribute('aria-label', `${rows.length} runs`)
      none.hidden = rows.length > 0
      keyed(
        list,
        rows,
        (row) => row.run,
        createRunRow,
        (one, row) => fillRunRow(one, row, view),
      )
      const n = omitted(view.store, 'runs')
      sayIn(left, n === 0 ? '' : `${n} more runs are not on this page`)
    },
  }
}

function createRunRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/runs' } })
  const glyph = glyphOf(checkMark('unknown'))
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
  markIn(glyph, checkMark(row.checks))
  textIn(name, row.run)
  textIn(aside, `${row.finished}/${row.total}`)
  aside.setAttribute('aria-label', `${row.finished} of ${row.total} steps finished`)
  textIn(under, runSays(row, view))
}

/**
 * One run in a line: what is happening, and what it has cost.
 *
 * **Partial completion is a fraction and never a percentage.** "Two of three"
 * is what somebody can act on — the third is the one to go and look at — and a
 * percentage is a figure about a run rather than about a step.
 */
export function runSays(row, view) {
  const active = row.steps.filter((step) => step.active)
  const waiting = row.steps.filter((step) => !step.finished && !step.active)
  const bits = []
  if (active.length > 0) bits.push(`${active.map((step) => step.name).join(', ')} working`)
  else if (waiting.length > 0) bits.push(`${waiting.length} waiting`)
  else if (row.total > 0) bits.push('every step finished')
  if (row.retries > 0)
    bits.push(`${row.retries} delivery ${row.retries === 1 ? 'retry' : 'retries'}`)
  if (row.stamp !== null) bits.push(`${row.stamp.name}@${row.stamp.version}`)
  // **The figure or nothing, never a dash in a list of clauses.** `money`
  // answers with the three dashes apart — not granted, not recorded, nought —
  // and a row's quiet line is the wrong place to say which: the run's own
  // screen has the room and says it there.
  const paid = money(
    { usd: row.usd ?? 0, usdEstimated: 0, hasCost: row.usd !== null && row.usd > 0 },
    mayRead(view.store, 'spend'),
  )
  if (paid.said !== '—') bits.push(paid.said)
  return bits.join(' · ')
}

/* ── one run ───────────────────────────────────────────────────────────────── */

/**
 * One run, as layers: everything in a layer can go once the layers before it
 * have finished, and what each step waits on is drawn under it.
 *
 * **Layers and not a canvas**, which is the same decision the designer makes
 * and for a harder reason: a node canvas needs a layout engine, hit testing
 * and a zoom, and at 360 pixels there is nowhere to put any of it. What a
 * reader needs is which steps can go now, which wait, and on what — and a
 * layer number answers all three. The window draws the same graph with boxes
 * and lines because it has the room (`plan-graph.ts`); both read the same
 * `waits`, so neither is a second layout of a different graph.
 */
export function runScreen(where) {
  const node = el('div')
  const back = el('a', { class: 'back', text: '‹ Runs', attrs: { href: '/runs' } })
  const head = el('div', { class: 'page-head' })
  const glyph = glyphOf(checkMark('unknown'))
  const title = el('h1', { text: where.run })
  into(head, glyph, title)
  const gone = el('p', { class: 'empty' })

  const about = section('THE RUN')
  const facts = dl()
  const fromLink = el('a', { class: 'press ghost', text: 'The request behind it' })
  into(about.body, facts, fromLink)

  const steps = section('THE STEPS')
  const layers = el('div', { class: 'layers' })
  const none = el('p', { class: 'empty' })
  into(steps.body, layers, none)

  const parts = [about, steps]
  into(node, back, head, gone, ...parts.map((one) => one.node))

  return {
    node,
    update(view) {
      const row = runAt(view.store, where.run)
      gone.hidden = row !== null
      textIn(gone, row === null ? 'This run is not on this device, or is not there.' : '')
      for (const one of parts) one.node.hidden = row === null
      if (row === null) return
      markIn(glyph, checkMark(row.checks))
      dlIn(facts, [
        ['steps', `${row.finished} of ${row.total} finished`],
        ['depth', `${row.layers} ${row.layers === 1 ? 'layer' : 'layers'}`],
        ['repositories', row.projects.join(', ') || '—'],
        [
          'workflow',
          row.stamp === null ? 'none: ordinary tasks' : `${row.stamp.name}@${row.stamp.version}`,
        ],
        ['checks', checkMark(row.checks).word],
        ['delivery retries', String(row.retries)],
        // **Which dash it is, said in the one place with room for it.** Not
        // granted, not recorded and nought are three different mornings, and
        // a page that drew the first two the same way would tell somebody
        // their work cost nothing when their phone was never allowed to ask.
        ['cost', costSaid(row.usd, view)],
      ])
      fromLink.hidden = row.from === null
      if (row.from !== null) fromLink.setAttribute('href', requestPath(row.from.item))
      // **No layer where there is no step.** A run whose tasks are all in
      // projects this device may not read, or whose task files are gone, has
      // nothing to put in a column — and a heading with nothing under it reads
      // as something that failed to load rather than as an answer.
      none.hidden = row.steps.length > 0
      textIn(
        none,
        row.steps.length > 0
          ? ''
          : row.total === 0 && row.projects.length === 0
            ? 'none of its steps is in a project this device may read'
            : 'nothing is left of this run: its task files are not there',
      )
      const deep = Array.from({ length: row.layers }, (_, n) => n)
      keyed(
        layers,
        deep,
        (n) => String(n),
        createLayer,
        (one, n) =>
          fillLayer(
            one,
            n,
            row.steps.filter((step) => step.layer === n),
            view,
          ),
      )
    },
  }
}

function createLayer() {
  const node = el('div', { class: 'layer' })
  const head = el('h3', { class: 'aside' })
  const list = el('ul', { class: 'rows' })
  return into(node, head, list)
}

function fillLayer(node, n, steps, view) {
  const [head, list] = node.children
  textIn(head, n === 0 ? 'can go first' : `after layer ${n}`)
  keyed(
    list,
    steps,
    (step) => step.task,
    createStepRow,
    (one, step) => fillStepRow(one, step, view),
  )
}

function createStepRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  const glyph = glyphOf(stepMark({ state: 'queued', finished: false, active: false }))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const under = el('span', { class: 'under' })
  const waits = el('ul', { class: 'waits' })
  into(link, glyph, name, aside, under)
  return into(node, link, waits)
}

function fillStepRow(node, step, view) {
  const [link, waits] = node.children
  const [glyph, name, aside, under] = link.children
  link.setAttribute('href', taskPath(step.task))
  markIn(glyph, stepMark(step))
  textIn(name, step.name)
  const paid = money(
    { usd: step.usd ?? 0, usdEstimated: 0, hasCost: step.usd !== null },
    mayRead(view.store, 'spend'),
  )
  textIn(aside, paid.said)
  aside.setAttribute('aria-label', paid.why === '' ? `cost ${paid.said}` : `cost ${paid.why}`)
  textIn(under, stepSays(step, view))
  keyed(waits, step.waits, (wait) => wait.task, createWaitRow, fillWaitRow)
}

/**
 * One step in a line: its checks, its review, and **how many agents have been
 * on it**.
 *
 * The last of those is the retry history and there is no counter behind it: it
 * is how many `run_started` lines the journal still holds for this task, so
 * *two* means somebody or something started it again. A figure of one is not
 * worth saying and is left out.
 */
export function stepSays(step, view) {
  const bits = [checkMark(step.checks).word]
  if (step.review !== null) bits.push(`review ${reviewMark(step.review).word}`)
  if (step.runs > 1) bits.push(`${step.runs} agents have been on it`)
  if (step.parked) bits.push('set aside')
  if (!mayRead(view.store, 'spend')) bits.push('cost not granted')
  return bits.join(' · ')
}

/**
 * What one figure of money says, with **which** dash it is where it is one.
 *
 * `money`'s own three answers, put into the one shape a labelled fact takes:
 * the figure where there is one, and the word for the dash where there is not.
 * Not granted, not recorded and nought are three different mornings.
 */
function costSaid(usd, view) {
  const paid = money(
    { usd: usd ?? 0, usdEstimated: 0, hasCost: usd !== null },
    mayRead(view.store, 'spend'),
  )
  return paid.why === '' ? paid.said : `${paid.said} ${paid.why}`
}
