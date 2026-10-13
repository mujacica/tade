// The control room at a desk: the window's own parts, in type.
//
// The window has projects along its top, its agents down the side, the work in
// the middle and the orchestrator in a strip at the foot. A phone has room for
// one of those at a time, which is why the page is a column with a tab bar and
// Tade one press away in the command bar; a laptop has room for all of them,
// and a page that drew a phone's column in the middle of 1440 pixels would be
// asking somebody to navigate for what the window shows at a glance. So the
// frame gains three parts, and **nothing in them is new information**:
//
// - **Projects**, along the top from a tablet up: the projection's own counts
//   per project — what wants you, what is working, what is queued — each a
//   link to the project.
// - **Agents**, in the dock beside the work at a desk: every task with an agent
//   on it (`agentsOf`, the Agents screen's own list), by project, with what it
//   runs on. Each a link to the agent's own page.
// - **Tade**, under them in the same dock: the last lines of the conversation
//   and the same box the conversation screen has (`composerOf`). The one way
//   anything here says something to the work is through Tade, which is
//   narrowed to what this device was granted at the machine.
//
// **Built once and patched**, like every screen: a part is filled on every
// paint and rebuilt never, so focus and a half-typed message survive a delta.
// Hidden below its width by the stylesheet alone, so a tablet turned on its
// side gains the dock without anything here knowing.

import { mayFor } from './access.js'
import { runsOn } from './agents.js'
import { classOn, el, empty, glyphOf, into, keyed, markIn, textIn, toneOn } from './dom.js'
import { count } from './figures.js'
import { CHAT_KINDS, rowMark, taskMark } from './glyphs.js'
import { icon } from './icons.js'
import { navFor, pathOf, taskPath } from './routes.js'
import { agentsOf, chatOf, projectsOf, talkOf } from './store.js'
import { composerOf, saidOn, whoSaid } from './talk.js'

/** How many lines of the conversation the dock shows: the exchange that just happened. */
const STRIP_LINES = 6

/** The three parts, built once, empty until the first paint fills them. */
export function deskParts(ctx) {
  const projects = el('nav', { class: 'projects', attrs: { 'aria-label': 'Projects' } })

  const side = el('nav', { class: 'side ui-panel', attrs: { 'aria-label': 'Running agents' } })
  const sideHead = el('div', { class: 'section-head' })
  const sideTitle = el('h2', { text: 'AGENTS', attrs: { 'aria-label': 'Agents' } })
  const sideFigure = el('span', { class: 'figure' })
  into(sideHead, sideTitle, sideFigure)
  const groups = el('div')
  const noAgents = empty('no agent is running')
  into(side, sideHead, groups, noAgents)

  const strip = el('section', {
    class: 'strip ui-panel',
    attrs: { 'aria-labelledby': 'strip-head' },
  })
  const stripHead = el('div', { class: 'section-head' })
  const stripTitle = el('h2', {
    text: 'TADE',
    attrs: { id: 'strip-head', 'aria-label': 'Tade' },
  })
  const whole = el('a', {
    class: 'tap icon',
    attrs: { href: '/talk', 'aria-label': 'The whole conversation' },
  })
  into(whole, icon('arrow'))
  into(stripHead, stripTitle, whole)
  const lines = el('ul', { class: 'lines' })
  const quiet = el('p', { class: 'empty nothing' })
  const typing = composerOf(ctx, {
    label: 'what to ask Tade',
    placeholder: 'Ask Tade…',
    send: 'Ask',
    rows: '2',
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
      agentsIn({ node: side, groups, figure: sideFigure, none: noAgents }, view)
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
  const link = el('a', { class: 'ui-chip', attrs: { href: '/' } })
  const name = el('span', { class: 'name' })
  const wants = el('span', { class: 'ui-count is-wants' })
  const working = el('span', { class: 'ui-count is-working' })
  const queued = el('span', { class: 'ui-count' })
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
function figureIn(node, n, _glyph, noun) {
  // A count, as every count on the page is (`ui.css`): nothing at nought.
  textIn(node, n === 0 ? '' : String(n))
  node.setAttribute('aria-label', `${n} ${noun}`)
}

/* ── agents ────────────────────────────────────────────────────────────────── */

function agentsIn(made, view) {
  // **Not beside the Agents screen**, which is the same list with more on each
  // row: two of one list side by side is one too many, and the dock gives the
  // room to Tade instead.
  const there = navFor(view.where) === 'agents'
  made.node.hidden = there
  if (there) return
  const agents = agentsOf(view.store)
  textIn(made.figure, count(agents.length))
  made.figure.setAttribute('aria-label', `${agents.length} agents running`)
  made.none.hidden = agents.length > 0
  textIn(made.none, noAgentsSaid(view.store))
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

/**
 * Why the side list is empty: nobody running, or nothing read yet — never the
 * first said for the second, which is a page with no snapshot reporting a
 * machine where nothing works.
 */
export function noAgentsSaid(store) {
  return store.had ? 'no agent is running' : 'not read yet'
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
  markIn(glyph, rowMark(task))
  textIn(name, task.name)
  textIn(runs, runsOn(task))
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
  const may = mayFor(view.store, 'chat')
  const talk = talkOf(view.store)
  const shown = may ? chatOf(view.store).slice(-STRIP_LINES) : []
  keyed(made.lines, shown, (line) => line.id, createLine, fillLine)
  // **The absences, each in its own words**, as the conversation screen has
  // them. A surface that is off is the composer's to say (`reasonFor`), once,
  // under where the box would be; what is left here is this device not being
  // granted the lines, or nothing having been said.
  const said =
    (talk ?? null) === null
      ? ''
      : !may
        ? 'Not granted'
        : shown.length === 0
          ? 'Nothing said yet'
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
