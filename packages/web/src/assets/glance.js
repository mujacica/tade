// The glance: six figures across every project — or one — as pure folds over the
// store, and the tiles that draw them. Shared, because the overview leads with
// all six (`pages/overview.js`) and a project's page leads with its own
// (`pages/project.js`); the number a tile says is the same rule on both.

import { mayFor } from './access.js'
import { barIn, barOf, ringOf } from './charts.js'
import { classOn, el, figureIn, into, textIn } from './dom.js'
import { money, planPressure, tokensSaid } from './figures.js'
import { icon } from './icons.js'
import {
  checksFold,
  omitted,
  plansOf,
  queueIn,
  rowsOf,
  runningOf,
  spendFold,
  wantsYou,
} from './store.js'
import { meter, meterIn } from './ui.js'

/* ── the figures, as pure folds over what the store holds ──────────────────── */

/**
 * The six figures at the top, out of the store — pure, so a test can hold them.
 *
 * Every one is a count the projection already made or a fold the store
 * already does; this only puts them side by side. `plan` is the fullest window
 * any harness reported, because the plan that runs out first is the one that
 * stops the work.
 */
export function glanceOf(store, project = null) {
  const mine = (task) => project === null || task.project === project
  const tasks = rowsOf(store, 'tasks').filter(mine)
  const wants = wantsYou(store).filter(mine)
  const by = (state) => wants.filter((task) => task.state === state).length
  const running = runningOf(store).filter(mine)
  const stalled = tasks.filter((task) => task.state === 'working' && task.stalled).length
  const queue = queueIn(store, project)
  const checks = checksFold(tasks)
  let plan = null
  // A plan is a harness's, not a project's: one project's page has no plan.
  for (const row of project === null ? plansOf(store) : []) {
    for (const window of row.windows ?? []) {
      if (plan === null || window.used > plan.used) {
        plan = { used: window.used, label: window.label, harness: row.harness }
      }
    }
  }
  return {
    wants: {
      n: wants.length,
      blocked: by('blocked'),
      failed: by('failed'),
      review: by('review'),
    },
    working: {
      n: running.length,
      stalled,
    },
    queue: {
      n: queue.length + (project === null ? omitted(store, 'queue') : 0),
      ready: queue.filter((row) => row.state?.kind === 'ready').length,
    },
    checks,
    spend: spendFold(tasks, omitted(store, 'tasks') > 0),
    tasks: tasks.length,
    plan,
  }
}

/**
 * One project's bar: what wants you, what works, what waits, and the rest.
 *
 * Out of `ProjectRow.counts`, which counts every task in the project whether
 * or not it fitted on this page — so the bar of a project with ninety tasks is
 * the true shape of all ninety, not of the sixty that arrived.
 */
export function projectShape(counts) {
  const wants = counts.wantsYou ?? 0
  const working = counts.working ?? 0
  const queued = counts.queued ?? 0
  const rest = Math.max(0, (counts.tasks ?? 0) - wants - working - queued)
  return [wants, working, queued, rest]
}

/**
 * The tiles, into a `.tiles` grid: all six, or the ones named, each a link to
 * where the whole of it is (`to` names another place for any of them — a
 * project's page sends each to its own section).
 */
export function glanceTiles(into_, names = TILES, to = {}) {
  const made = {}
  for (const name of names) {
    const spec = TILE_SPECS[name]
    made[name] = tileOf({ ...spec, href: to[name] ?? spec.href })
    into_.append(made[name].node)
  }
  return made
}

const TILE_SPECS = {
  wants: { icon: 'flag', label: 'Wants you', href: '#wants', tone: 'wants', bar: true },
  working: { icon: 'bolt', label: 'Working', href: '/agents', tone: 'working' },
  queue: { icon: 'queue', label: 'Queued', href: '/queue', tone: 'quiet' },
  spend: { icon: 'spend', label: 'Spend', href: '/spend', tone: 'quiet' },
  // **The quotas are a figure like the others, on the same line**: the window
  // that runs out first, as its share and a bar — every account's windows are
  // a press away, on the Spend page. A project's page has no quota.
  quota: { icon: 'clock', label: 'Quota', href: '/spend#quotas', tone: 'quiet', meter: true },
}

const TILES = Object.keys(TILE_SPECS)

/* ── a tile ────────────────────────────────────────────────────────────────── */

/**
 * One figure: an icon, its word, the number, a line under it, and — for the
 * three that have a shape — a chart. A link to where the whole of it is.
 */
function tileOf(spec) {
  const node = el('a', {
    class: `ui-card tile tile-${spec.tone ?? 'plain'}`,
    attrs: { href: spec.href },
  })
  const head = el('span', { class: 'tile-head' })
  into(
    head,
    el('span', { class: 'tile-ic' }),
    el('span', { class: 'tile-label', text: spec.label }),
  )
  head.firstChild.append(icon(spec.icon))
  const figure = el('span', { class: 'tile-figure' })
  const under = el('span', { class: 'tile-under' })
  const chart =
    spec.ring !== undefined
      ? ringOf(spec.ring)
      : spec.bar === true
        ? barOf(['wants', 'failed', 'done'])
        : spec.meter === true
          ? meter()
          : null
  into(node, head, figure, under, chart)
  return { node, figure, under, chart }
}

export function tilesIn(made, glance, view) {
  const had = view.store.had
  // Nothing read yet is a shimmer where the figure will be (`motion.css`),
  // never a dash that reads as *nobody recorded it* and never a nought; a
  // figure that moves afterwards flashes once (`figureIn`).
  // A tile not drawn on this page (a project's has no plan) is skipped.
  const said = (one, figure, under, label) => {
    if (one === undefined) return
    figureIn(one.figure, had ? figure : '')
    textIn(one.under, had ? under : '')
    one.node.setAttribute('aria-label', had ? label : `${label}: not read yet`)
  }

  const w = glance.wants
  said(
    made.wants,
    String(w.n),
    w.n === 0
      ? 'nothing stopped'
      : partsSaid([w.blocked, 'blocked'], [w.failed, 'failed'], [w.review, 'review']),
    `${w.n} wanting you`,
  )
  if (made.wants !== undefined) {
    barIn(made.wants.chart, [w.blocked, w.failed, w.review])
    classOn(made.wants.node, 'is-hot', w.n > 0)
  }

  const k = glance.working
  said(
    made.working,
    String(k.n),
    k.stalled > 0 ? `${k.stalled} stalled` : k.n === 0 ? 'idle' : 'running',
    `${k.n} agents working`,
  )
  if (made.working !== undefined) classOn(made.working.node, 'is-hot', k.n > 0)

  const q = glance.queue
  said(
    made.queue,
    String(q.n),
    q.ready > 0 ? `${q.ready} ready` : q.n === 0 ? 'empty' : 'waiting',
    `${q.n} queued`,
  )

  const paid = money(glance.spend, mayFor(view.store, 'tasks.spend'))
  const figure = paid.said === '—' ? '—' : `${glance.spend.partial ? '≥' : ''}${paid.said}`
  const toks = tokensSaid(glance.spend)
  said(
    made.spend,
    figure,
    paid.said === '—' ? paid.why : toks === null ? 'today' : `${toks.said} tokens`,
    paid.said === '—' ? `spend: ${paid.why}` : `spend ${figure}`,
  )

  // The tightest window of any account. *Not granted* and *none reported*
  // are two different dashes, and neither is a nought.
  if (made.quota !== undefined) {
    const may = mayFor(view.store, 'plans')
    const plan = may ? glance.plan : null
    said(
      made.quota,
      plan === null ? '—' : `${Math.round(plan.used)}%`,
      !may ? 'not granted' : plan === null ? 'none reported' : `${plan.harness} · ${plan.label}`,
      plan === null
        ? `quota: ${may ? 'none reported' : 'not granted'}`
        : `quota ${Math.round(plan.used)}% used`,
    )
    made.quota.chart.hidden = plan === null || !had
    if (plan !== null) meterIn(made.quota.chart, plan.used, planPressure(plan.used))
  }
}

/** `2 blocked · 1 failed`, leaving out what is nought. */
function partsSaid(...parts) {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}
