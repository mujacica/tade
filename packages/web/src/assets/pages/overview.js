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

import { mayFor } from '../access.js'
import { createAgentRow, fillAgentRow } from '../agents.js'
import { barIn, barOf, ringIn, ringOf } from '../charts.js'
import {
  classOn,
  el,
  empty,
  foldable,
  glyphOf,
  hintOf,
  into,
  keyed,
  markIn,
  stateIn,
  textIn,
  toneOn,
} from '../dom.js'
import { ageSaid, money } from '../figures.js'
import { glanceOf, glanceTiles, projectShape, tilesIn } from '../glance.js'
import { rowMark, taskMark } from '../glyphs.js'
import { icon } from '../icons.js'
import { quickActs } from '../quick.js'
import { pathOf, taskPath } from '../routes.js'
import { section } from '../rows.js'
import {
  agentsOf,
  checksFold,
  closedOf,
  findingsOf,
  intakeWaiting,
  omitted,
  projectsOf,
  reviewsOf,
  runsOf,
  spendFold,
  tasksIn,
  wantsYou,
} from '../store.js'
import { changesSeen, KINDS } from '../toasts.js'
import { count, countIn, panel } from '../ui.js'

/* ── the screen ────────────────────────────────────────────────────────────── */

export function nowScreen(ctx = null) {
  const node = el('div', { class: 'overview' })

  const top = section('OVERVIEW', { top: true })
  top.node.classList.add('ov-top')
  const tiles = el('div', { class: 'tiles' })
  into(top.body, tiles)
  const made = glanceTiles(tiles)

  const wants = section('WANTS YOU')
  foldable(wants, 'overview:wants')
  wants.node.setAttribute('id', 'wants')
  const inbox = el('a', { class: 'ui-chip t-wants', attrs: { href: '/inbox' } })
  into(inbox, icon('inbox'), el('span'))
  wants.heading.after(inbox)
  const cards = el('div', { class: 'ui-panel cards wants-cards' })
  const clear = el('div', { class: 'all-clear' })
  into(clear, icon('check'), el('span', { text: 'All clear' }))
  into(wants.body, cards, clear)

  const projects = section('PROJECTS')
  foldable(projects, 'overview:projects')
  const grid = el('div', { class: 'projects-grid' })
  const left = el('p', { class: 'unknown' })
  into(projects.body, grid, left)

  // Every agent at work, here on a phone and a tablet; at a desk the dock
  // beside the work has the same list (`desk.js`), and this one steps aside.
  const working = section('AGENTS')
  foldable(working, 'overview:agents')
  working.node.classList.add('ov-agents')
  const agentList = panel('ul', 'rows')
  const idle = empty('none running')
  into(working.body, agentList, idle)

  // **What changed while this page was open**, newest first: the toasts'
  // own crossings, kept for a glance back — and only those, so a reload
  // starts it over and its `?` says so.
  const recent = section('CHANGES')
  foldable(recent, 'overview:changes')
  const recentWhy = hintOf('Since this page opened. A reload starts it over.')
  recent.figure.before(recentWhy.press)
  const recentList = panel('ul', 'rows')
  into(recent.body, recentWhy.body, recentList)

  const signals = section('ELSEWHERE')
  foldable(signals, 'overview:elsewhere')
  const signalList = panel('ul', 'signals')
  const shown = SIGNALS.map((one) => signalOf(one))
  into(signalList, ...shown.map((one) => one.node))
  into(signals.body, signalList)

  // **Closed, and nothing in them deleted**: each a link to its own page,
  // where it can be opened again. Absent where nothing is closed.
  const closed = section('CLOSED')
  const closedList = el('div', { class: 'chips' })
  into(closed.body, closedList)

  into(
    node,
    top.node,
    wants.node,
    projects.node,
    working.node,
    recent.node,
    signals.node,
    closed.node,
  )

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

      const log = changesSeen()
      recent.node.hidden = log.length === 0
      keyed(
        recentList,
        log,
        (one) => one.key,
        createChange,
        (one, change) => fillChange(one, change, view),
      )

      for (const one of shown) one.update(view)

      const shut = closedOf(view.store)
      closed.node.hidden = shut.length === 0
      keyed(
        closedList,
        shut,
        (row) => row.name,
        () => {
          const link = el('a', { class: 'ui-chip', attrs: { href: '/' } })
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
  const node = el('article', { class: 'ui-card card want' })
  const top = el('div', { class: 'card-top' })
  const glyph = glyphOf(taskMark('blocked'))
  const link = el('a', { class: 'card-link', attrs: { href: '/' } })
  into(link, el('span', { class: 'card-project' }), el('span', { class: 'card-name' }))
  const age = el('span', { class: 'aside' })
  into(top, glyph, link, age)
  const why = el('p', { class: 'why' })
  const asked = el('p', { class: 'ui-pill is-mono t-working asked' })
  const quick = ctx === null ? null : quickActs(ctx)
  into(node, top, why, asked, quick?.node)
  node.quick = quick
  return node
}

function fillWant(node, task, view) {
  const [top, why, asked] = node.children
  const [glyph, link, age] = top.children
  const mark = rowMark(task)
  classOn(node, 'is-wants', task.mark === 'needs-you')
  classOn(node, 'is-failed', task.mark === 'failed')
  classOn(node, 'is-review', task.state === 'review')
  markIn(glyph, mark)
  stateIn(node, task.state)
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
  const node = el('a', { class: 'ui-card proj', attrs: { href: '/' } })
  const head = el('span', { class: 'proj-head' })
  const name = el('span', { class: 'proj-name' })
  into(head, icon('folder'), name, icon('chevron', 'proj-go'))
  const bar = barOf(['wants', 'working', 'queued', 'rest'])
  // What wants you, what works and what waits, as the counts the rail and
  // the chips draw (`ui.css`): nothing at nought.
  const stats = el('span', { class: 'proj-stats' })
  into(stats, count('wants'), count('working'), count())
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
    countIn(one, figures[at] ?? 0, STAT_NOUNS[at])
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
  const money_ = money(
    spendFold(tasks, counts.shown < counts.tasks),
    mayFor(view.store, 'tasks.spend'),
  )
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

/* ── what changed ──────────────────────────────────────────────────────────── */

function createChange() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  into(
    link,
    el('span', { class: 'glyph' }),
    el('span', { class: 'name' }),
    el('span', { class: 'aside' }),
    el('span', { class: 'under' }),
  )
  return into(node, link)
}

function fillChange(node, change, view) {
  const [link] = node.children
  const [glyph, name, age, word] = link.children
  const kind = KINDS[change.kind]
  link.setAttribute('href', taskPath(change.id))
  glyph.textContent = ''
  glyph.append(icon(kind?.icon ?? 'bolt'))
  toneOn(glyph, kind?.tone ?? '')
  textIn(name, change.id)
  textIn(word, kind?.word ?? change.kind)
  toneOn(word, kind?.tone ?? '')
  textIn(age, ageSaid(new Date(change.at).toISOString(), view.asOf, view.frozen) ?? '')
}
