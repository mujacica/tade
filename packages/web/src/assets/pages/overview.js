// The overview: every project at a glance, and what wants you before anything
// that is merely true.
//
// The landing screen, read in the order somebody opening it asks: **is anything
// waiting on me, is the work moving, what is next, and what is it costing —
// how close is a plan to stopping it.** So it is drawn in that order:
//
// 1. **The board**, one panel under the bar: four cells — what needs you, what
//    is working, what is queued, the checks — each a figure, a mark per thing
//    and the line that breaks it down, and under them the money with where
//    most of it went and a gauge per plan window, fullest first. Every cell is
//    a press to the screen with the whole of it.
// 2. **What needs you**, with the presses this device was granted on each row;
//    what failed under it, red; a calm line when nothing does.
// 3. **Every project as one row of a grid**, every column on the same line as
//    the one above it: the shape of its work, its counts, its checks, its money.
// 4. The agents at work (on a phone and a tablet — at a desk they are down the
//    side), what changed while the page was open, and what was closed.
//
// **Nothing here derives a state.** Every figure is `overview-figures.js`'s
// fold over what came off the wire, held by `test/overview.test.ts`; every
// reason is `deriveState`'s clause verbatim; a figure nobody could read is a
// dash with its word. A chart is decoration over a number that is on the page
// as text beside it.
//
// **Built once and then patched**, like every screen: a figure is one text
// write, a row is filled in place (`keyed`), and a delta never moves where
// somebody's thumb is.

import { createAgentRow, fillAgentRow } from '../agents.js'
import {
  barIn,
  barOf,
  bars,
  barsIn,
  gauge,
  gaugeIn,
  ringIn,
  ringOf,
  stat,
  statIn,
  stats,
  toneIn,
} from '../charts.js'
import {
  classOn,
  el,
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
import { ageSaid } from '../figures.js'
import { rowMark, taskMark } from '../glyphs.js'
import { icon } from '../icons.js'
import { quickActs } from '../quick.js'
import { pathOf, taskPath } from '../routes.js'
import { section } from '../rows.js'
import { closedOf, intakeWaiting, omitted, projectsOf, wantsYou } from '../store.js'
import { changesSeen, KINDS } from '../toasts.js'
import { meter, meterIn, panel, stateBox, stateBoxIn } from '../ui.js'
import {
  boardOf,
  failedOf,
  gaugesOf,
  moneyOf,
  projectRowsOf,
  workingOf,
} from './overview-figures.js'

/* ── the screen ────────────────────────────────────────────────────────────── */

export function nowScreen(ctx = null) {
  const node = el('div', { class: 'overview' })

  const top = section('OVERVIEW', { top: true })
  const board = boardView()
  into(top.body, board.node)

  const wants = section('NEEDS YOU')
  wants.node.setAttribute('id', 'wants')
  const wantList = el('ol', { class: 'ov-wants ui-panel' })
  const inbox = inboxRow()
  const clear = clearLine()
  into(wants.body, wantList, inbox.node, clear.node)

  const failed = section('FAILED')
  const failList = el('ol', { class: 'ov-wants ov-failed ui-panel' })
  into(failed.body, failList)

  const projects = section('PROJECTS')
  foldable(projects, 'overview:projects')
  const table = projectTable()
  const projectsState = stateBox()
  const left = el('p', { class: 'unknown' })
  const shut = el('div', { class: 'ov-closed' })
  const shutList = el('div', { class: 'ov-closed-list' })
  into(shut, el('span', { class: 'ov-closed-label', text: 'Closed' }), shutList)
  into(projects.body, table.node, projectsState, left, shut)

  // Every agent at work, here on a phone and a tablet; at a desk the side
  // beside the work has the same list (`side.js`), and this one steps aside.
  const working = section('WORKING')
  foldable(working, 'overview:agents')
  working.node.classList.add('ov-agents')
  const agentList = panel('ul', 'rows')
  into(working.body, agentList)

  // **What changed while this page was open**, newest first: the toasts'
  // own crossings, kept for a glance back — and only those, so a reload
  // starts it over and its `?` says so.
  const recent = section('CHANGES')
  foldable(recent, 'overview:changes')
  const recentWhy = hintOf('Since this page opened. A reload starts it over.')
  recent.figure.before(recentWhy.press)
  const recentList = panel('ul', 'rows')
  into(recent.body, recentWhy.body, recentList)

  into(node, top.node, wants.node, failed.node, projects.node, working.node, recent.node)

  return {
    node,
    update(view) {
      const store = view.store
      const had = store.had
      const open = projectsOf(store)
      textIn(top.figure, had ? countSaid(open.length, 'project', 'projects') : '')
      // One fold per beat, read by the board and by the calm line alike.
      const figures = had ? boardOf(store) : null
      board.update(view, figures)

      // What needs you: the rows, the inbox's requests under them, and a
      // calm line where there is neither.
      const rows = wantsYou(store)
      const waiting = intakeWaiting(store).length
      textIn(wants.figure, rows.length === 0 ? '' : String(rows.length))
      toneOn(wants.figure, rows.length > 0 ? 't-wants' : '')
      wants.figure.setAttribute('aria-label', `${rows.length} wanting you`)
      keyed(
        wantList,
        rows,
        (task) => task.id,
        () => createWant(ctx),
        (one, task) => fillWant(one, task, view),
      )
      inbox.update(waiting)
      clear.update(figures, had && rows.length === 0 && waiting === 0)

      const broke = failedOf(store)
      failed.node.hidden = broke.length === 0
      textIn(failed.figure, broke.length === 0 ? '' : String(broke.length))
      toneOn(failed.figure, broke.length > 0 ? 't-failed' : '')
      keyed(
        failList,
        broke,
        (task) => task.id,
        () => createWant(ctx),
        (one, task) => fillWant(one, task, view),
      )

      const lines = had ? projectRowsOf(store) : []
      textIn(projects.figure, lines.length === 0 ? '' : String(lines.length))
      table.update(lines)
      table.node.hidden = lines.length === 0
      stateBoxIn(
        projectsState,
        !had
          ? boxOf('loading', 'Reading the projects')
          : lines.length === 0
            ? boxOf(
                'empty',
                'No project is open',
                'Open a project in Tade at the machine and its work shows here.',
                'folder',
              )
            : null,
      )
      const gone = leftOut(store)
      textIn(left, gone)
      left.hidden = gone === ''
      const closed = closedOf(store)
      shut.hidden = closed.length === 0
      keyed(
        shutList,
        closed,
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

      const agents = workingOf(store)
      working.node.hidden = agents.length === 0
      textIn(working.figure, agents.length === 0 ? '' : String(agents.length))
      keyed(
        agentList,
        agents,
        (task) => task.id,
        createAgentRow,
        (one, task) => fillAgentRow(one, task, view),
      )

      const log = changesSeen()
      recent.node.hidden = log.length === 0
      textIn(recent.figure, log.length === 0 ? '' : String(log.length))
      keyed(
        recentList,
        log,
        (one) => one.key,
        createChange,
        (one, change) => fillChange(one, change, view),
      )
    },
  }
}

const countSaid = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** A region's state, in `stateBoxIn`'s shape. */
const boxOf = (kind, title, line = null, drawn = undefined) => ({ kind, title, line, icon: drawn })

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

/* ── the board ─────────────────────────────────────────────────────────────── */

/**
 * The four cells, each the shared stat with a mark per thing under its
 * figure; a press to where the whole of it is.
 */
const CELLS = [
  { key: 'wants', label: 'Needs you', href: '#wants', tone: 'wants' },
  { key: 'working', label: 'Working', href: '/agents', tone: 'working' },
  { key: 'queue', label: 'Queued', href: '/queue', tone: null },
  { key: 'checks', label: 'Checks', href: '/checks', tone: 'failed', unit: 'red' },
]

function boardView() {
  const node = el('div', { class: 'ov-board ui-panel' })
  const work = stats('The work, right now')
  work.classList.add('ov-cells')
  const cells = CELLS.map((spec) => {
    const one = stat(spec.label, spec.href)
    one.classList.add('ov-cell')
    const dots = dotsView()
    one.append(dots)
    work.append(one)
    return { spec, node: one, dots }
  })

  // The money: the figure is a press to the Spend screen, and where most of
  // it went is a press to each project.
  const money = el('div', { class: 'ov-money' })
  const spent = stat('Spend', '/spend')
  spent.classList.add('ov-cell')
  const most = bars('Most spent, by project')
  most.classList.add('ov-most')
  into(money, spent, most)

  // The plan windows, fullest first: the one that runs out first is the one
  // that stops the work. Every account's windows are a press away.
  const plan = el('div', {
    class: 'ov-plan',
    attrs: { role: 'group', 'aria-label': 'Plan limits' },
  })
  const head = el('a', { class: 'ov-plan-head', attrs: { href: '/spend#quotas' } })
  into(head, el('span', { text: 'Plan limits' }), icon('chevron', 'ov-go'))
  // A gauge per window where there is the room; on a phone, a line each —
  // the name, the share and a bar — so every window fits beside the money.
  const gauges = el('div', { class: 'ov-gauges' })
  const lines = el('ul', { class: 'ov-meters' })
  into(plan, head, gauges, lines)

  const below = el('div', { class: 'ov-budget' })
  into(below, money, plan)
  into(node, work, below)

  return {
    node,
    update(view, figures) {
      // Nothing read yet is a shimmer where each figure will be, never a
      // dash that reads as *nobody recorded it* and never a nought.
      if (figures === null) {
        gaugesIn(gauges, lines, [])
        return
      }
      for (const { spec, node: one, dots } of cells) {
        const cell = figures[spec.key]
        const hot = cell.n > 0
        statIn(one, {
          value: String(cell.n),
          unit: spec.unit,
          under: cell.under,
          tone: hot ? spec.tone : null,
        })
        classOn(one, 'is-hot', hot && spec.key === 'wants')
        dotsIn(dots, cell.dots)
      }
      const paid = moneyOf(view.store)
      statIn(spent, { value: paid.value, under: paid.under })
      most.hidden = paid.top.length === 0
      barsIn(most, paid.top)
      gaugesIn(gauges, lines, gaugesOf(view.store, view.asOf))
    },
  }
}

/** The plan windows, as gauges and as lines, each reused by key. */
function gaugesIn(node, lines, list) {
  keyed(
    node,
    list,
    (one) => one.key,
    (one) => gauge(one.label),
    (item, one) => {
      gaugeIn(item, one)
      classOn(item, 'is-unread', one.share === null)
    },
  )
  keyed(lines, list, (one) => one.key, createMeter, fillMeter)
}

function createMeter() {
  const node = el('li', { class: 'ov-meter' })
  const name = el('span', { class: 'ov-meter-name' })
  into(name, el('strong'), el('span'))
  into(node, name, el('span', { class: 'ov-meter-value' }), meter())
  return node
}

/** The window first — `5h`, `week` — because two accounts' names cut to the same ellipsis. */
function fillMeter(node, one) {
  const [name, value, bar] = node.children
  textIn(name.firstChild, one.window ?? '')
  name.firstChild.hidden = one.window === null
  textIn(name.lastChild, one.who)
  textIn(value, one.share === null ? '—' : one.said)
  bar.hidden = one.share === null
  if (one.share !== null) meterIn(bar, one.share, one.pressure)
  classOn(node, 'is-unread', one.share === null)
}

/**
 * A mark per thing — an agent, a task, a request — in its tone; hollow for
 * one still waiting on something, and the count of the rest where they do not
 * fit. `aria-hidden`: the figure and the line beside it say it in words.
 */
function dotsView() {
  const node = el('span', { class: 'ov-dots', attrs: { 'aria-hidden': 'true' } })
  node.append(el('span', { class: 'ov-more' }))
  return node
}

function dotsIn(node, drawn) {
  const more = node.lastChild
  while (node.children.length - 1 > drawn.dots.length) node.firstChild.remove()
  while (node.children.length - 1 < drawn.dots.length) {
    node.insertBefore(el('span', { class: 'ov-dot' }), more)
  }
  drawn.dots.forEach((one, at) => {
    const dot = node.children[at]
    toneIn(dot, one.tone)
    classOn(dot, 'is-hollow', one.hollow)
  })
  textIn(more, drawn.more > 0 ? `+${drawn.more}` : '')
  more.hidden = drawn.more === 0
}

/* ── a row that wants somebody ─────────────────────────────────────────────── */

/**
 * One piece of work that wants somebody — or that failed: its mark, its name
 * and project, why in `deriveState`'s own words, how long ago, and the
 * presses this device was granted.
 *
 * The row is not a link: it holds buttons, and a button inside a link is two
 * targets in one place. Its name is the link, stretched over the row by the
 * stylesheet, and the presses sit above that.
 */
function createWant(ctx) {
  const node = el('li', { class: 'ov-want' })
  const glyph = glyphOf(taskMark('blocked'), 'ov-want-mark')
  const link = el('a', { class: 'ov-want-link', attrs: { href: '/' } })
  into(link, el('span', { class: 'ov-want-name' }), el('span', { class: 'ov-want-project' }))
  const age = el('span', { class: 'ov-want-age' })
  const why = el('p', { class: 'ov-want-why' })
  const quick = ctx === null ? null : quickActs(ctx)
  quick?.node.classList.add('ov-want-acts')
  into(node, glyph, link, age, why, quick?.node)
  node.quick = quick
  return node
}

function fillWant(node, task, view) {
  const [glyph, link, age, why] = node.children
  markIn(glyph, rowMark(task))
  stateIn(node, task.state)
  link.setAttribute('href', taskPath(task.id))
  textIn(link.children[0], task.name)
  textIn(link.children[1], task.project)
  const moved = ageSaid(task.movedAt, view.asOf, view.frozen)
  textIn(age, moved ?? '')
  age.setAttribute('aria-label', moved === null ? 'never moved' : `moved ${moved} ago`)
  textIn(why, task.reason)
  node.quick?.update(task, view)
}

/** The inbox's requests, waiting for a yes: somebody else blocked on this machine. */
function inboxRow() {
  const node = el('a', { class: 'ov-inbox ui-panel', attrs: { href: '/inbox' } })
  const mark = el('span', { class: 'ov-inbox-mark t-wants' })
  mark.append(icon('inbox'))
  const words = el('span', { class: 'ov-inbox-words' })
  into(node, mark, words, icon('chevron', 'ov-go'))
  node.hidden = true
  return {
    node,
    update(n) {
      node.hidden = n === 0
      textIn(words, `${countSaid(n, 'request', 'requests')} waiting in the inbox`)
    },
  }
}

/** Nothing waiting on anybody: one calm line, and what is going on instead. */
function clearLine() {
  const node = el('div', { class: 'ov-clear ui-panel', attrs: { role: 'status' } })
  const mark = el('span', { class: 'ov-clear-mark t-done' })
  mark.append(icon('check'))
  const words = el('span', { class: 'ov-clear-words' })
  const line = el('span', { class: 'ov-clear-line' })
  into(words, el('strong', { text: 'Nothing needs you' }), line)
  into(node, mark, words)
  node.hidden = true
  return {
    node,
    update(figures, shown) {
      node.hidden = !shown
      if (!shown) return
      const going = [
        figures.working.n > 0 ? `${figures.working.n} working` : null,
        figures.queue.n > 0 ? `${figures.queue.n} queued` : null,
      ].filter(Boolean)
      textIn(line, going.length === 0 ? 'and nothing is running' : going.join(' · '))
    },
  }
}

/* ── the projects: one grid, every column on one line ──────────────────────── */

/**
 * The projects as one table drawn as a grid: a head naming the columns at a
 * desk, and a row per project whose cells sit under them. On a phone the head
 * steps aside and each row is three lines — name and money, the shape of its
 * work, its counts and checks — with each count's word beside it.
 */
function projectTable() {
  const node = el('div', { class: 'ov-table ui-panel' })
  const head = el('div', { class: 'ov-proj-head', attrs: { 'aria-hidden': 'true' } })
  for (const [word, klass] of PROJECT_COLUMNS) into(head, el('span', { class: klass, text: word }))
  const list = el('ol', { class: 'ov-projects', attrs: { 'aria-label': 'Projects' } })
  into(node, head, list)
  return {
    node,
    update(lines) {
      keyed(list, lines, (row) => row.name, createProject, fillProject)
    },
  }
}

const PROJECT_COLUMNS = [
  ['Project', 'ov-c-name'],
  ['Work', 'ov-c-bar'],
  ['Needs you', 'ov-c-n'],
  ['Working', 'ov-c-n'],
  ['Queued', 'ov-c-n'],
  ['Checks', 'ov-c-checks'],
  ['Spend', 'ov-c-spend'],
]

/** Each count's word, said beside it on a phone and read aloud everywhere. */
const COUNT_WORDS = [
  ['needs you', 'need you', 'wants'],
  ['working', 'working', 'working'],
  ['queued', 'queued', 'queued'],
]

function createProject() {
  const node = el('li')
  const link = el('a', { class: 'ov-proj', attrs: { href: '/' } })
  const name = el('span', { class: 'ov-proj-name' })
  const bar = barOf(['wants', 'working', 'queued', 'rest'])
  bar.classList.add('ov-proj-bar')
  const counts = COUNT_WORDS.map(([, , kind]) => {
    const one = el('span', { class: `ov-n ov-n-${kind}` })
    into(one, el('span', { class: 'ov-n-value' }), el('span', { class: 'ov-n-word' }))
    return one
  })
  const checks = el('span', { class: 'ov-proj-checks' })
  into(checks, ringOf('checks'), el('span'))
  const spend = el('span', { class: 'ov-proj-spend' })
  into(link, name, bar, ...counts, checks, spend)
  return into(node, link)
}

function fillProject(node, row) {
  const [link] = node.children
  const [name, bar, ...rest] = link.children
  const counts = rest.slice(0, 3)
  const [checks, spend] = rest.slice(3)
  link.setAttribute('href', row.href)
  textIn(name, row.name)
  barIn(bar, row.shape)
  ;[row.wants, row.working, row.queued].forEach((n, at) => {
    const [value, word] = counts[at].children
    const [one, many] = COUNT_WORDS[at]
    textIn(value, String(n))
    textIn(word, ` ${n === 1 ? one : many}`)
    classOn(counts[at], 'is-zero', n === 0)
  })
  const [ring, said] = checks.children
  ringIn(ring, row.checks.parts)
  textIn(said, row.checks.said)
  toneOn(said, row.checks.tone)
  textIn(spend, row.spend ?? `— ${row.spendWhy}`)
  classOn(spend, 'is-unknown', row.spend === null)
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
