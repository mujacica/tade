// The money: what the work cost today, how full each plan is, and where it went.
//
// **What somebody opening this wants first** is what this has cost since the
// day began, and whether a plan is about to stop the work: so the bill, a
// plan's worth at list and the tokens lead, then every plan as a card of
// gauges, fullest first, then where it went as ranked bars by project, agent,
// harness or model. Three claims in three places, each with its mark and word,
// and never added (`spend-shape.js` says every figure).
//
// **The period is said once, in the bar** (`fresh.spendSince`, in this reader's
// clock). No period buttons: the projection carries one figure per task, not a
// series, so *this week* is a question this data cannot answer.

import { mayFor } from '../access.js'
import { bars, barsIn, gauge, gaugeIn } from '../charts.js'
import { classOn, el, into, keyed, skeleton, textIn, toneOn } from '../dom.js'
import { count } from '../figures.js'
import { nothingSaid, section } from '../rows.js'
import { omitted, plansOf, rowsOf, spendSince } from '../store.js'
import { stateBox, stateBoxIn } from '../ui.js'
import {
  GROUPS,
  leadOf,
  periodOf,
  plansShape,
  pressureSaid,
  spentAny,
  wentOf,
} from './spend-shape.js'

/** A region's state, as `stateBoxIn` takes it, with this page's mark unless it says. */
function stateOf(kind, title, line, icon = 'spend') {
  return { kind, icon, title, line }
}

/** Which way the page was last asked where it went, for as long as the page is open. */
let chosen = 'project'

export function spendScreen() {
  const node = el('div')
  const made = section('SPEND', { top: true })
  const coming = skeleton(4)
  const closed = stateBox()
  closed.classList.add('spend-closed')
  const money = moneyView()
  const plans = plansView()
  const went = wentView()
  into(made.body, coming, closed, money.made.node, plans.made.node, went.made.node)
  into(node, made.node)

  return {
    node,
    update(view) {
      const store = view.store
      const had = store.had === true
      coming.hidden = had
      const granted = mayFor(store, 'tasks.spend')
      const period = had && granted ? periodOf(spendSince(store), view.asOf) : null
      textIn(made.figure, period ?? '')
      const tasks = had && granted ? rowsOf(store, 'tasks') : []
      const partial = omitted(store, 'tasks') > 0
      const lead = leadOf(tasks, { granted, partial })
      const spent = spentAny(lead.fold)
      // Two nulls, two sentences: not granted is not nothing spent. And a
      // period with nothing spent and no plan is one sentence for the page.
      const bare = had && granted && !spent && plansOf(store).length === 0
      stateBoxIn(
        closed,
        had && !granted
          ? stateOf(
              'empty',
              'This device cannot read what the work costs',
              'What each device may read is decided at the machine; the Devices screen lists what this one was given.',
            )
          : bare
            ? stateOf(
                'empty',
                period === null ? 'Nothing spent yet' : `Nothing spent ${period}`,
                'Each agent’s turns are added here as it runs, and each plan’s windows as its harness says them.',
              )
            : null,
      )
      const open = had && granted && !bare
      money.made.node.hidden = !open
      plans.made.node.hidden = !open
      // Nothing spent is said once, by the lead, and there is nothing to ask it by.
      went.made.node.hidden = !open || !spent
      if (!open) return
      money.fill(lead, period)
      plans.fill(view)
      if (spent) went.fill(tasks, partial)
    },
  }
}

/* ── the lead: what it cost ────────────────────────────────────────────────── */

/** The bill large, a plan's worth and the tokens beside it: a hairline between, never a sum. */
function moneyView() {
  const made = section('SPENT')
  const card = el('dl', { class: 'ui-panel spend-money', attrs: { 'aria-label': 'What it cost' } })
  const billed = cellOf('Billed', 'spend-billed')
  const parts = el('ul', { class: 'spend-parts', attrs: { 'aria-label': 'Made of' } })
  const holder = el('dd', { class: 'spend-parts-holder' })
  into(holder, parts)
  billed.node.append(holder)
  const plan = cellOf('On a plan')
  const toks = cellOf('Tokens')
  into(card, billed.node, plan.node, toks.node)
  const nothing = stateBox()
  into(made.body, nothing, card)
  return {
    made,
    fill(lead, period) {
      // A period with nothing in it is one sentence, not three dashes.
      const none = !spentAny(lead.fold)
      card.hidden = none
      stateBoxIn(
        nothing,
        none
          ? stateOf(
              'empty',
              period === null ? 'Nothing spent yet' : `Nothing spent ${period}`,
              'Each agent’s turns are added here as it runs.',
            )
          : null,
      )
      cellIn(billed, lead.billed)
      cellIn(plan, lead.onPlan)
      cellIn(toks, lead.tokens)
      holder.hidden = lead.billed.parts.length === 0
      keyed(
        parts,
        lead.billed.parts,
        (one) => one.key,
        () => into(el('li'), el('span', { class: 'spend-part-figure' }), el('span')),
        (item, one) => {
          textIn(item.firstChild, one.said)
          textIn(item.lastChild, one.word)
        },
      )
    },
  }
}

function cellOf(label, extra = '') {
  const node = el('div', { class: extra === '' ? 'spend-cell' : `spend-cell ${extra}` })
  const value = el('dd', { class: 'spend-figure' })
  const word = el('dd', { class: 'spend-word' })
  into(node, el('dt', { text: label }), value, word)
  return { node, value, word }
}

/** A cell's figure, or its dash in the quiet grey with the word that says which dash. */
function cellIn(cell, one) {
  textIn(cell.value, one.value ?? '—')
  classOn(cell.value, 'is-unknown', one.value === null)
  textIn(cell.word, one.word)
}

/* ── the plans: every account's windows as gauges ──────────────────────────── */

/**
 * The accounts with windows as gauge cards, and those with nothing to gauge —
 * cannot tell, per token — as one panel of rows beside them, stretched to the
 * cards' height so the two columns end on one line; stacked on a phone.
 */
function plansView() {
  const made = section('PLAN LIMITS')
  // The overview's plan limits are a link to here.
  made.node.setAttribute('id', 'quotas')
  const none = stateBox()
  const grid = el('div', { class: 'spend-plan-grid' })
  const list = el('ul', { class: 'spend-plans', attrs: { 'aria-label': 'Plans with windows' } })
  const others = el('ul', {
    class: 'ui-panel spend-others',
    attrs: { 'aria-label': 'Plans with nothing to show' },
  })
  into(grid, list, others)
  into(made.body, none, grid)
  return {
    made,
    fill(view) {
      const rows = plansOf(view.store)
      const cards = plansShape(rows, view.asOf)
      textIn(made.figure, rows.length === 0 ? '' : count(rows.length))
      // A label on an empty figure is one axe refuses: said only when drawn.
      if (rows.length === 0) made.figure.removeAttribute('aria-label')
      else made.figure.setAttribute('aria-label', `${rows.length} accounts`)
      stateBoxIn(
        none,
        rows.length > 0
          ? null
          : stateOf(
              'empty',
              'No plan reported',
              nothingSaid(
                mayFor(view.store, 'plans'),
                omitted(view.store, 'plans'),
                'A sign-in on a plan says how much of it is used while its agents run.',
              ),
              'clock',
            ),
      )
      const gauged = cards.filter((one) => one.kind === 'windows')
      const rest = cards.filter((one) => one.kind !== 'windows')
      grid.hidden = rows.length === 0
      list.hidden = gauged.length === 0
      others.hidden = rest.length === 0
      classOn(grid, 'is-split', gauged.length > 0 && rest.length > 0)
      keyed(list, gauged, (one) => one.key, createPlan, fillPlan)
      keyed(others, rest, (one) => one.key, createOther, fillOther)
    },
  }
}

function createOther() {
  return into(
    el('li', { class: 'spend-other' }),
    el('strong', { class: 'spend-plan-name' }),
    el('span', { class: 'spend-plan-harness' }),
    el('span', { class: 'spend-plan-line' }),
  )
}

/** An account with no window to draw: its name, its harness, and the line for why. */
function fillOther(item, card) {
  const [name, harness, line] = item.children
  textIn(name, card.name)
  textIn(harness, card.account === null ? '' : card.harness)
  harness.hidden = card.account === null
  textIn(line, card.line)
}

function createPlan() {
  const item = el('li', { class: 'ui-card spend-plan' })
  const head = el('div', { class: 'spend-plan-head' })
  into(
    head,
    el('strong', { class: 'spend-plan-name' }),
    el('span', { class: 'spend-plan-harness' }),
    el('span', { class: 'ui-pill spend-plan-pill' }),
  )
  into(item, head, el('div', { class: 'spend-gauges' }))
  return item
}

/** One account's windows, a gauge each. Red is never alone: the card says *nearly out*. */
function fillPlan(item, card) {
  const [head, gauges] = item.children
  const [name, harness, pill] = head.children
  textIn(name, card.name)
  textIn(harness, card.account === null ? '' : card.harness)
  harness.hidden = card.account === null
  const word = pressureSaid(card)
  textIn(pill, word)
  pill.hidden = word === ''
  toneOn(pill, card.pressure === 'tight' ? 't-failed' : null)
  classOn(item, 'is-tight', card.pressure === 'tight')
  keyed(
    gauges,
    card.windows,
    (one) => one.key,
    (one) => gauge(`${card.name} ${one.label} window`),
    (node, one) => gaugeIn(node, one),
  )
}

/* ── where it went ─────────────────────────────────────────────────────────── */

function wentView() {
  const made = section('WHERE IT WENT')
  const switcher = el('div', {
    class: 'spend-by',
    attrs: { role: 'group', 'aria-label': 'Where it went, by' },
  })
  const presses = new Map()
  let last = null
  for (const one of GROUPS) {
    const press = el('button', {
      class: 'ui-chip spend-by-press',
      text: one.word,
      attrs: { type: 'button', 'aria-pressed': String(one.key === chosen) },
    })
    press.addEventListener('click', () => {
      chosen = one.key
      for (const [key, node] of presses) node.setAttribute('aria-pressed', String(key === chosen))
      if (last !== null) draw(...last)
    })
    presses.set(one.key, press)
    switcher.append(press)
  }
  const panel = el('div', { class: 'ui-panel spend-went' })
  const list = bars('Where it went')
  const quiet = el('p', { class: 'spend-quiet' })
  into(panel, list, quiet)
  into(made.body, switcher, panel)

  const draw = (tasks, partial) => {
    last = [tasks, partial]
    for (const [key, node] of presses) node.setAttribute('aria-pressed', String(key === chosen))
    const went = wentOf(tasks, chosen, { partial })
    const by = GROUPS.find((one) => one.key === chosen) ?? GROUPS[0]
    list.setAttribute('aria-label', `Where it went, by ${by.noun[0]}, ${went.measure}`)
    textIn(made.figure, went.rows.length === 0 ? '' : `by ${went.measure}`)
    barsIn(list, went.rows)
    went.rows.forEach((row, at) => {
      const item = list.children[at]
      classOn(item, 'is-plan', row.kind === 'plan')
      classOn(item, 'is-unrecorded', row.unrecorded)
      classOn(item, 'is-mono', chosen === 'harness' || chosen === 'model')
    })
    textIn(quiet, went.quietSaid)
    quiet.hidden = went.quietSaid === ''
  }
  return { made, fill: draw }
}
