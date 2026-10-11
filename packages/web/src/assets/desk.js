// The control room at a desk: the window's own shape, in type.
//
// The window has projects along its top, its agents down the side, the work in
// the middle and the orchestrator in a strip at the foot. A phone has room for
// one of those at a time, which is why the page is a column with a tab bar;
// a laptop has room for all four, and a page that drew a phone's column in the
// middle of 1440 pixels would be asking somebody to navigate for what the
// window shows at a glance. So at a desk (`frame.css`, 1280px and up) the
// frame gains three parts, and **nothing in them is new information**:
//
// - **Projects**, along the top: the projection's own counts per project —
//   what wants you, what is working, what is queued — each a link to the
//   project. Also on a tablet, where it wraps.
// - **Agents**, down the side: every task with an agent on it (`agentsOf`,
//   the Agents screen's own list), by project, with what it runs on. Each a
//   link to the agent's own page.
// - **Tade**, in a strip at the foot: the last few lines of the conversation
//   and the same box the conversation screen has (`composerOf`). The one way
//   anything here says something to the work is through Tade, which is
//   narrowed to what this device was granted at the machine.
//
// **Built once and patched**, like every screen: a part is filled on every
// paint and rebuilt never, so focus and a half-typed message survive a delta.
// Hidden below its width by the stylesheet alone, so a tablet turned on its
// side gains the side list without anything here knowing.

import { classOn, el, empty, glyphOf, into, keyed, markIn, textIn, toneOn } from './dom.js'
import { count } from './figures.js'
import { CHAT_KINDS, taskMark } from './glyphs.js'
import { navFor, pathOf, taskPath } from './routes.js'
import { agentsOf, chatOf, mayRead, projectsOf, talkOf } from './store.js'
import { composerOf, saidOn, whoSaid } from './talk.js'

/** How many lines of the conversation the strip shows: the exchange that just happened. */
const STRIP_LINES = 3

/** The three parts, built once, empty until the first paint fills them. */
export function deskParts(ctx) {
  const projects = el('nav', { class: 'projects', attrs: { 'aria-label': 'Projects' } })

  const side = el('nav', { class: 'side', attrs: { 'aria-label': 'Running agents' } })
  const sideHead = el('div', { class: 'section-head' })
  const sideTitle = el('h2', { text: 'AGENTS', attrs: { 'aria-label': 'Agents' } })
  const sideFigure = el('span', { class: 'figure' })
  into(sideHead, sideTitle, sideFigure)
  const groups = el('div')
  const noAgents = empty('no agent is running')
  into(side, sideHead, groups, noAgents)

  const strip = el('section', { class: 'strip', attrs: { 'aria-labelledby': 'strip-head' } })
  const stripHead = el('div', { class: 'section-head' })
  const stripTitle = el('h2', {
    text: 'WITH TADE',
    attrs: { id: 'strip-head', 'aria-label': 'With Tade' },
  })
  const whole = el('a', { text: 'The whole conversation ›', attrs: { href: '/talk' } })
  into(stripHead, stripTitle, whole)
  const lines = el('ul', { class: 'lines' })
  const quiet = el('p', { class: 'empty' })
  const typing = composerOf(ctx, {
    label: 'what to ask Tade',
    placeholder: 'ask Tade something',
    send: 'Ask',
    rows: '1',
  })
  const composer = el('div', { class: 'composer' })
  into(composer, ...typing.nodes)
  into(strip, stripHead, lines, quiet, composer)

  return {
    projects,
    side,
    strip,
    update(view) {
      projectsIn(projects, view)
      agentsIn({ groups, figure: sideFigure, none: noAgents }, view)
      stripIn({ node: strip, lines, quiet }, view)
      typing.update(talkOf(view.store))
    },
  }
}

/* ── projects ──────────────────────────────────────────────────────────────── */

function projectsIn(nav, view) {
  const here =
    view.where.view === 'project' || view.where.view === 'task' ? view.where.project : null
  keyed(
    nav,
    projectsOf(view.store),
    (row) => row.name,
    createProject,
    (one, row) => fillProject(one, row, here),
  )
}

function createProject() {
  const link = el('a', { attrs: { href: '/' } })
  const name = el('span', { class: 'name' })
  const wants = el('span', { class: 'count t-wants' })
  const working = el('span', { class: 'count t-working' })
  const queued = el('span', { class: 'count t-quiet' })
  into(link, name, wants, working, queued)
  return link
}

/**
 * One project: its name and the three counts that are true over every task in
 * it, cut or not — `ProjectRow.counts` is the projection's own, so a project
 * whose tasks did not all fit on this page still says how many want you.
 */
function fillProject(link, project, here) {
  const [name, wants, working, queued] = link.children
  link.setAttribute('href', pathOf({ view: 'project', project: project.name }))
  if (project.name === here) link.setAttribute('aria-current', 'page')
  else link.removeAttribute('aria-current')
  textIn(name, project.name)
  figureIn(wants, project.counts.wantsYou, '◆', 'wanting you')
  figureIn(working, project.counts.working, '●', 'working')
  figureIn(queued, project.counts.queued, '⌸', 'queued')
}

/** A count with its glyph, hidden at nought: a badge that says 0 is a badge nobody reads. */
function figureIn(node, n, glyph, noun) {
  node.hidden = n === 0
  textIn(node, n === 0 ? '' : `${glyph} ${count(n)}`)
  node.setAttribute('aria-label', `${n} ${noun}`)
}

/* ── agents ────────────────────────────────────────────────────────────────── */

function agentsIn(made, view) {
  const agents = agentsOf(view.store)
  textIn(made.figure, count(agents.length))
  made.figure.setAttribute('aria-label', `${agents.length} agents running`)
  made.none.hidden = agents.length > 0
  const groups = new Map()
  for (const task of agents) {
    const held = groups.get(task.project) ?? { project: task.project, agents: [] }
    held.agents.push(task)
    groups.set(task.project, held)
  }
  const on = view.where.view === 'task' ? `${view.where.project}/${view.where.task}` : null
  keyed(
    made.groups,
    [...groups.values()],
    (group) => group.project,
    createGroup,
    (one, group) => fillGroup(one, group, on),
  )
}

function createGroup() {
  const node = el('div', { class: 'group' })
  const head = el('h3')
  const list = el('ul')
  into(node, head, list)
  return node
}

function fillGroup(node, group, on) {
  const [head, list] = node.children
  textIn(head, group.project)
  keyed(
    list,
    group.agents,
    (task) => task.id,
    createAgent,
    (one, task) => fillAgent(one, task, on),
  )
}

function createAgent() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  const glyph = glyphOf(taskMark('working'))
  const name = el('span', { class: 'name' })
  const runs = el('span', { class: 'runs' })
  into(link, glyph, name, runs)
  into(node, link)
  return node
}

function fillAgent(node, task, on) {
  const [link] = node.children
  const [glyph, name, runs] = link.children
  link.setAttribute('href', taskPath(task.id))
  if (task.id === on) link.setAttribute('aria-current', 'page')
  else link.removeAttribute('aria-current')
  markIn(glyph, taskMark(task.state))
  textIn(name, task.name)
  textIn(runs, task.model ?? task.harness ?? '—')
  classOn(link, 'stalled', task.stalled)
}

/* ── the strip ─────────────────────────────────────────────────────────────── */

/**
 * The last few lines, or why there are none, and the box.
 *
 * **Not drawn on the conversation's own screen**, which has the whole of it
 * and the same box: two boxes for one message on one page is one too many.
 */
function stripIn(made, view) {
  const there = navFor(view.where) === 'talk'
  made.node.hidden = there
  if (there) return
  const may = mayRead(view.store, 'talk')
  const talk = talkOf(view.store)
  const shown = may ? chatOf(view.store).slice(-STRIP_LINES) : []
  keyed(made.lines, shown, (line) => line.id, createLine, fillLine)
  // **The absences, each in its own words**, as the conversation screen has
  // them. A surface that is off is the composer's to say (`reasonFor`), once,
  // under where the box would be; what is left here is this device not being
  // granted the lines, or nothing having been said.
  const said =
    talk === null
      ? ''
      : !may
        ? 'The conversation is not granted to this device.'
        : shown.length === 0
          ? 'Nothing said yet.'
          : ''
  textIn(made.quiet, said)
  made.quiet.hidden = said === ''
}

/**
 * One line of the conversation, on one row: who, and the words.
 *
 * Cut to the row rather than wrapped, because the strip sits under the work
 * and a reply that grew it would push the work off the screen. The whole of
 * every line is one link away, on the conversation's own screen; the cut is
 * the stylesheet's, so nothing here shortens anybody's words.
 */
function createLine() {
  const node = el('li')
  into(node, el('span', { class: 'who' }), el('span', { class: 'words' }))
  return node
}

function fillLine(node, line) {
  const [who, words] = node.children
  const kind = CHAT_KINDS[line.kind] ?? CHAT_KINDS.tade
  textIn(who, [whoSaid(line), kind.word, line.tool].filter((one) => one).join(' · '))
  toneOn(who, kind.tone)
  textIn(words, saidOn(line))
}
