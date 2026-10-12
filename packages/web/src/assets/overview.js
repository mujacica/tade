// The overview: every project at a glance, and what wants you at the top.
//
// The landing screen, and its one question is still *is anything stopped* —
// so the first thing under the header is six figures that answer it across
// every project at once (what wants you, what is working, what is queued, the
// checks, the money and the plan), each a tile that goes to the screen with
// the whole of it; then the work that wants somebody, with the presses this
// device was granted on each card; then every project as a card with its own
// counts drawn as a bar.
//
// **Nothing here derives a state.** Every count is the projection's own
// (`ProjectRow.counts`, `wantsYou`, `checksFold`, `spendFold`), every reason
// is `deriveState`'s clause verbatim, and a figure nobody could read is a dash
// with its word — never a nought. A chart is decoration over a number that is
// on the page as text beside it (`charts.js`).
//
// **Built once and then patched**, like every screen: a tile's figure is one
// text write, a card is filled in place (`keyed`), and a delta never moves
// where somebody's thumb is.

import { createAgentRow, fillAgentRow } from './agents.js'
import { barIn, barOf, ringIn, ringOf, shareIn } from './charts.js'
import { classOn, el, empty, glyphOf, into, keyed, markIn, textIn, toneOn } from './dom.js'
import { ageSaid, count, money, planPressure, tokensSaid } from './figures.js'
import { taskMark } from './glyphs.js'
import { icon } from './icons.js'
import { quickActs } from './quick.js'
import { pathOf, taskPath } from './routes.js'
import { section } from './rows.js'
import {
  agentsOf,
  checksFold,
  closedOf,
  findingsOf,
  intakeWaiting,
  omitted,
  plansOf,
  projectsOf,
  queueIn,
  reviewsOf,
  rowsOf,
  runsOf,
  spendFold,
  tasksIn,
  wantsYou,
} from './store.js'

/* ── the figures, as pure folds over what the store holds ──────────────────── */

/**
 * The six figures at the top, out of the store — pure, so a test can hold them.
 *
 * Every one is a count the projection already made or a fold the store
 * already does; this only puts them side by side. `plan` is the fullest window
 * any harness reported, because the plan that runs out first is the one that
 * stops the work.
 */
export function glanceOf(store) {
  const tasks = rowsOf(store, 'tasks')
  const wants = wantsYou(store)
  const by = (state) => wants.filter((task) => task.state === state).length
  const agents = agentsOf(store)
  const queue = queueIn(store, null)
  const checks = checksFold(tasks)
  let plan = null
  for (const row of plansOf(store)) {
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
      n: agents.length,
      stalled: agents.filter((task) => task.stalled).length,
    },
    queue: {
      n: queue.length + omitted(store, 'queue'),
      ready: queue.filter((row) => row.state?.kind === 'ready').length,
    },
    checks,
    spend: spendFold(tasks, omitted(store, 'tasks') > 0),
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

/* ── the screen ────────────────────────────────────────────────────────────── */

export function nowScreen(ctx = null) {
  const node = el('div', { class: 'overview' })

  const top = section('OVERVIEW', { top: true })
  top.node.classList.add('ov-top')
  const tiles = el('div', { class: 'tiles' })
  into(top.body, tiles)
  const made = {
    wants: tileOf({ icon: 'flag', label: 'Wants you', href: '#wants', tone: 'wants', bar: true }),
    working: tileOf({ icon: 'bolt', label: 'Working', href: '/agents', tone: 'working' }),
    queue: tileOf({ icon: 'queue', label: 'Queued', href: '/queue', tone: 'quiet' }),
    checks: tileOf({ icon: 'checks', label: 'Checks', href: '/checks', ring: 'checks' }),
    spend: tileOf({ icon: 'spend', label: 'Spend', href: '/spend', tone: 'quiet' }),
    plan: tileOf({ icon: 'clock', label: 'Plan', href: '/spend', ring: 'plan' }),
  }
  into(tiles, ...Object.values(made).map((one) => one.node))

  const wants = section('WANTS YOU')
  wants.node.setAttribute('id', 'wants')
  const inbox = el('a', { class: 'chip chip-link t-wants', attrs: { href: '/inbox' } })
  into(inbox, icon('inbox'), el('span'))
  wants.heading.after(inbox)
  const cards = el('div', { class: 'cards wants-cards' })
  const clear = el('div', { class: 'all-clear' })
  into(clear, icon('check'), el('span', { text: 'All clear' }))
  into(wants.body, cards, clear)

  const projects = section('PROJECTS')
  const grid = el('div', { class: 'projects-grid' })
  const left = el('p', { class: 'unknown' })
  into(projects.body, grid, left)

  // Every agent at work, here on a phone and a tablet; at a desk the dock
  // beside the work has the same list (`desk.js`), and this one steps aside.
  const working = section('AGENTS')
  working.node.classList.add('ov-agents')
  const agentList = el('ul', { class: 'rows' })
  const idle = empty('none running')
  into(working.body, agentList, idle)

  const signals = section('ELSEWHERE')
  const signalList = el('ul', { class: 'signals' })
  const shown = SIGNALS.map((one) => signalOf(one))
  into(signalList, ...shown.map((one) => one.node))
  into(signals.body, signalList)

  // **Closed, and nothing in them deleted**: each a link to its own page,
  // where it can be opened again. Absent where nothing is closed.
  const closed = section('CLOSED')
  const closedList = el('div', { class: 'chips' })
  into(closed.body, closedList)

  into(node, top.node, wants.node, projects.node, working.node, signals.node, closed.node)

  return {
    node,
    update(view) {
      const glance = glanceOf(view.store)
      tilesIn(made, glance, view)

      const rows = wantsYou(view.store)
      textIn(wants.figure, rows.length === 0 ? '' : String(rows.length))
      wants.figure.setAttribute('aria-label', `${rows.length} wanting you`)
      clear.hidden = rows.length > 0 || !view.store.had
      keyed(
        cards,
        rows,
        (task) => task.id,
        () => createWant(ctx),
        (one, task) => fillWant(one, task, view),
      )
      const waiting = intakeWaiting(view.store).length
      inbox.hidden = waiting === 0
      textIn(inbox.lastChild, `${waiting} request${waiting === 1 ? '' : 's'}`)

      const open = projectsOf(view.store).sort(busiest)
      textIn(projects.figure, open.length === 0 ? '' : String(open.length))
      keyed(
        grid,
        open,
        (row) => row.name,
        createProject,
        (one, row) => fillProject(one, row, view),
      )
      const gone = leftOut(view.store)
      textIn(left, gone)
      left.hidden = gone === ''

      const agents = agentsOf(view.store)
      textIn(working.figure, agents.length === 0 ? '' : String(agents.length))
      keyed(
        agentList,
        agents,
        (task) => task.id,
        createAgentRow,
        (one, task) => fillAgentRow(one, task, view),
      )
      idle.hidden = agents.length > 0 || !view.store.had

      for (const one of shown) one.update(view)

      const shut = closedOf(view.store)
      closed.node.hidden = shut.length === 0
      keyed(
        closedList,
        shut,
        (row) => row.name,
        () => {
          const link = el('a', { class: 'chip chip-link', attrs: { href: '/' } })
          into(link, icon('folder'), el('span'))
          return link
        },
        (one, row) => {
          one.setAttribute('href', pathOf({ view: 'project', project: row.name }))
          textIn(one.lastChild, row.name)
        },
      )
    },
  }
}

/** The projects, busiest first: what wants you, then what works, then by name. */
const busiest = (a, b) =>
  b.counts.wantsYou - a.counts.wantsYou ||
  b.counts.working - a.counts.working ||
  (a.name < b.name ? -1 : 1)

/**
 * What the projection left out, said out loud: a flat cap that said nothing
 * would lose four repositories without a word.
 */
function leftOut(store) {
  const parts = []
  for (const name of ['projects', 'tasks']) {
    const n = omitted(store, name)
    if (n > 0) parts.push(`${n} ${name}`)
  }
  return parts.length === 0 ? '' : `${parts.join(' and ')} not on this page`
}

/* ── a tile ────────────────────────────────────────────────────────────────── */

/**
 * One figure: an icon, its word, the number, a line under it, and — for the
 * three that have a shape — a chart. A link to where the whole of it is.
 */
function tileOf(spec) {
  const node = el('a', { class: `tile tile-${spec.tone ?? 'plain'}`, attrs: { href: spec.href } })
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
        : null
  into(node, head, figure, under, chart)
  return { node, figure, under, chart }
}

function tilesIn(made, glance, view) {
  const had = view.store.had
  const said = (one, figure, under, label) => {
    textIn(one.figure, had ? figure : '—')
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
  barIn(made.wants.chart, [w.blocked, w.failed, w.review])
  classOn(made.wants.node, 'is-hot', w.n > 0)

  const k = glance.working
  said(
    made.working,
    String(k.n),
    k.stalled > 0 ? `${k.stalled} stalled` : k.n === 0 ? 'idle' : 'running',
    `${k.n} agents working`,
  )
  classOn(made.working.node, 'is-hot', k.n > 0)

  const q = glance.queue
  said(
    made.queue,
    String(q.n),
    q.ready > 0 ? `${q.ready} ready` : q.n === 0 ? 'empty' : 'waiting',
    `${q.n} queued`,
  )

  const c = glance.checks
  const total = c.pass + c.fail + c.unknown
  said(
    made.checks,
    total === 0 ? '—' : c.fail > 0 ? `${c.fail}` : `${c.pass}/${total}`,
    total === 0
      ? 'none run'
      : c.fail > 0
        ? 'red'
        : c.unknown > 0
          ? `${c.unknown} not run`
          : 'green',
    `checks: ${c.pass} green, ${c.fail} red, ${c.unknown} not run here`,
  )
  ringIn(made.checks.chart, [c.pass, c.fail, c.unknown])
  classOn(made.checks.node, 'is-bad', c.fail > 0)

  const paid = money(glance.spend, view.may.spend)
  const figure = paid.said === '—' ? '—' : `${glance.spend.partial ? '≥' : ''}${paid.said}`
  const toks = tokensSaid(glance.spend)
  said(
    made.spend,
    figure,
    paid.said === '—' ? paid.why : toks === null ? 'today' : `${toks.said} tokens`,
    paid.said === '—' ? `spend: ${paid.why}` : `spend ${figure}`,
  )

  const p = glance.plan
  said(
    made.plan,
    p === null ? '—' : `${Math.round(p.used)}%`,
    p === null ? 'none reported' : `${p.label} · ${p.harness}`,
    p === null ? 'plan: none reported' : `${p.harness} ${p.label} plan ${Math.round(p.used)}% used`,
  )
  shareIn(made.plan.chart, p?.used ?? null, p === null ? '' : planPressure(p.used))
}

/** `2 blocked · 1 failed`, leaving out what is nought. */
function partsSaid(...parts) {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, word]) => `${n} ${word}`)
    .join(' · ')
}

/* ── a card that wants you ─────────────────────────────────────────────────── */

/**
 * One piece of work that wants somebody: its state, whose it is, why — in
 * `deriveState`'s own words — what it is waiting on, and the presses.
 *
 * The card is not a link: it holds buttons, and a button inside a link is two
 * targets in one place. Its name is the link, stretched over the card by the
 * stylesheet, and the presses sit above that.
 */
function createWant(ctx) {
  const node = el('article', { class: 'card want' })
  const top = el('div', { class: 'card-top' })
  const glyph = glyphOf(taskMark('blocked'))
  const link = el('a', { class: 'card-link', attrs: { href: '/' } })
  into(link, el('span', { class: 'card-project' }), el('span', { class: 'card-name' }))
  const age = el('span', { class: 'aside' })
  into(top, glyph, link, age)
  const why = el('p', { class: 'why' })
  const asked = el('p', { class: 'asked' })
  const quick = ctx === null ? null : quickActs(ctx)
  into(node, top, why, asked, quick?.node)
  node.quick = quick
  return node
}

function fillWant(node, task, view) {
  const [top, why, asked] = node.children
  const [glyph, link, age] = top.children
  const mark = taskMark(task.state)
  classOn(node, 'is-wants', task.state === 'blocked')
  classOn(node, 'is-failed', task.state === 'failed')
  classOn(node, 'is-review', task.state === 'review')
  markIn(glyph, mark)
  link.setAttribute('href', taskPath(task.id))
  textIn(link.children[0], task.project)
  textIn(link.children[1], task.name)
  const moved = ageSaid(task.movedAt, view.asOf, view.frozen)
  textIn(age, moved ?? '')
  textIn(why, task.reason)
  textIn(asked, task.approval === null ? '' : task.approval.tool)
  asked.hidden = task.approval === null
  node.quick?.update(task, view)
}

/* ── a project ─────────────────────────────────────────────────────────────── */

function createProject() {
  const node = el('a', { class: 'proj', attrs: { href: '/' } })
  const head = el('span', { class: 'proj-head' })
  const name = el('span', { class: 'proj-name' })
  into(head, icon('folder'), name, icon('chevron', 'proj-go'))
  const bar = barOf(['wants', 'working', 'queued', 'rest'])
  const stats = el('span', { class: 'proj-stats' })
  for (const [tone, glyph] of [
    ['t-wants', '◆'],
    ['t-working', '●'],
    ['t-quiet', '⌸'],
  ]) {
    const one = el('span', { class: `stat ${tone}` })
    into(
      one,
      el('span', { class: 'stat-glyph', text: glyph, attrs: { 'aria-hidden': 'true' } }),
      el('span'),
    )
    stats.append(one)
  }
  const foot = el('span', { class: 'proj-foot' })
  const checks = ringOf('checks')
  const checkSaid = el('span', { class: 'proj-checks' })
  const paid = el('span', { class: 'proj-paid' })
  into(foot, checks, checkSaid, paid)
  into(node, head, bar, stats, foot)
  return node
}

const STAT_NOUNS = ['wanting you', 'working', 'queued']

function fillProject(node, project, view) {
  const [head, bar, stats, foot] = node.children
  const [, name] = head.children
  const [checks, checkSaid, paid] = foot.children
  node.setAttribute('href', pathOf({ view: 'project', project: project.name }))
  textIn(name, project.name)
  const counts = project.counts
  barIn(bar, projectShape(counts))
  const figures = [counts.wantsYou, counts.working, counts.queued]
  ;[...stats.children].forEach((one, at) => {
    const n = figures[at] ?? 0
    textIn(one.lastChild, count(n))
    one.setAttribute('aria-label', `${n} ${STAT_NOUNS[at]}`)
    classOn(one, 'is-zero', n === 0)
  })
  const tasks = tasksIn(view.store, project.name)
  const fold = checksFold(tasks)
  ringIn(checks, [fold.pass, fold.fail, fold.unknown])
  const total = fold.pass + fold.fail + fold.unknown
  textIn(
    checkSaid,
    total === 0 ? 'no checks' : fold.fail > 0 ? `${fold.fail} red` : `${fold.pass}/${total} green`,
  )
  toneOn(checkSaid, fold.fail > 0 ? 't-failed' : total > 0 && fold.unknown === 0 ? 't-done' : '')
  const money_ = money(spendFold(tasks, counts.shown < counts.tasks), view.may.spend)
  textIn(paid, money_.said === '—' ? `— ${money_.why}` : money_.said)
}

/* ── elsewhere: the reads that are a count and a link ──────────────────────── */

const SIGNALS = [
  {
    view: 'inbox',
    icon: 'inbox',
    label: 'Inbox',
    of: (store) => intakeWaiting(store).length,
    tone: 't-wants',
  },
  {
    view: 'reviews',
    icon: 'reviews',
    label: 'Reviews',
    of: (store) => reviewsOf(store).offered.length,
    tone: '',
  },
  {
    view: 'findings',
    icon: 'findings',
    label: 'Findings',
    of: (store) => findingsOf(store).filter((one) => !one.accounted).length,
    tone: 't-failed',
  },
  { view: 'runs', icon: 'runs', label: 'Runs', of: (store) => runsOf(store).length, tone: '' },
  { view: 'talk', icon: 'talk', label: 'Tade', of: () => null, tone: '' },
]

function signalOf(spec) {
  const node = el('li')
  const link = el('a', { attrs: { href: pathOf({ view: spec.view }) } })
  const figure = el('span', { class: 'count' })
  into(
    link,
    icon(spec.icon),
    el('span', { class: 'label', text: spec.label }),
    figure,
    icon('chevron', 'go'),
  )
  into(node, link)
  return {
    node,
    update(view) {
      const n = spec.of(view.store)
      textIn(figure, n === null || n === 0 ? '' : String(n))
      toneOn(figure, n !== null && n > 0 ? spec.tone : '')
    },
  }
}
