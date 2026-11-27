// The right-hand side: the work, split by project, as the window's own side
// list draws it.
//
// The window has places nowhere and the work down its side, a project at a
// time: its AGENTS, each with its mark and what it is doing, grouped by the run
// it is part of once there are two; and its SMART QUEUE as a tree of what
// waits on what. A page has room for every project at once, so here it is one
// heading per project with both under it — the same marks (`rowMark`, the
// window's `markOf` carried on the row), the same words (`queueSaid`'s), the
// same order, and the queue hung as the window hangs it (`tree.js`).
//
// **The agent you have open says what the window says beside it**: the plan it
// is part of, with how much of it is finished, and how its checks stood at the
// commit in hand — the window's ACTIONS page in two lines, each a link to the
// page that has the rest. That is where Plans and Checks meet one agent; their
// own pages stay in the menu for what spans every project.
//
// Built once and patched, like every screen: a delta writes text and classes
// into nodes that are already there, so a project somebody folded stays folded
// and nothing moves under a pointer. **Which projects are folded is kept for as
// long as the page is, and never on the device's disk**: a project's name is
// somebody's work, and what a device keeps has no text in it
// (`LAST_VIEW_IS_A_COPY`).

import { agentMenu, agentPresses, holdOpens } from './agent-menu.js'
import { classOn, el, glyphOf, into, keyed, markIn, textIn, toneOn } from './dom.js'
import { count, shortClockOf } from './figures.js'
import { checkMark, queueMark, rowMark, taskMark } from './glyphs.js'
import { icon } from './icons.js'
import { drawsOf, HERE, thereOf } from './machines.js'
import { pathOf, taskPath } from './routes.js'
import { copiesOf, projectsOf, queueIn, runAt, tasksIn } from './store.js'
import { linksThere, machineChips, machinePicked } from './there.js'
import {
  agentGroups,
  queueAt,
  queueLine,
  queueName,
  queuePaused,
  queueTree,
  sideAgents,
} from './tree.js'

/** The side, built once: a heading, a list of projects, and the press that folds it. */
export function sideOf(ctx = null) {
  const node = el('aside', { class: 'side', attrs: { 'aria-label': 'Agents and queue' } })
  const head = el('div', { class: 'side-top' })
  const title = el('h2', { text: 'Work', attrs: { id: 'side-head' } })
  const figure = el('span', { class: 'figure' })
  into(head, title, figure)
  const projects = el('div', { class: 'side-projects' })
  const none = el('p', { class: 'empty side-none' })
  const folded = new Set()
  // The machine chips, and each other machine's projects under its line, after this one's.
  const chips = machineChips()
  const mark = el('p', { class: 'there-line', text: 'This machine' })
  const elsewhere = el('div')
  into(node, head, chips.node, mark, projects, none, elsewhere)
  // **An agent's row offers what the window's row does**: start or stop, close,
  // and its whole menu (`agent-menu.js`) — on a ⋯, a long-press or a
  // right-click. The rows the presses read are the ones last drawn, so a press
  // echoes what the screen shows.
  const rows = new Map()
  const acting =
    ctx === null ? null : { ctx, menu: agentMenu(ctx), rowOf: (id) => rows.get(id) ?? null }
  let was = null
  return {
    node,
    update(view) {
      const pick = machinePicked(view.store)
      chips.update(view.store)
      const mine = drawsOf(pick, HERE)
      const shown = mine ? projectsOf(view.store) : []
      const working = shown.reduce((n, one) => n + one.counts.working, 0)
      textIn(figure, working === 0 ? '' : `${count(working)} working`)
      none.hidden = !mine || shown.length > 0
      textIn(none, view.store.had ? 'no project is open' : 'not read yet')
      const { on, here } = litOf(view.where, undefined)
      const copies = copiesOf(view.store)
      mark.hidden = !mine || copies.length === 0
      keyed(
        elsewhere,
        copies.filter((one) => drawsOf(pick, one.machine)),
        (one) => one.machine,
        createThere,
        (one, { machine }) => fillThere(one, machine, view),
      )
      keyed(
        projects,
        shown,
        (row) => row.name,
        () => createProject(folded),
        (one, row) => fillProject(one, row, view, { on, here, folded, rows, acting }),
      )
      // **Arriving at an agent brings its row into the side's view**, once, on
      // the navigation and never on a delta — a list that scrolled itself
      // every beat would move the row somebody was reaching for.
      if (on !== was) {
        const lit = on === null ? null : node.querySelector('.side-agent[aria-current="page"]')
        // Not drawn yet — no snapshot, or the side folded or shut — is asked
        // again on the next paint rather than given up on.
        if (on === null) was = on
        else if (lit !== null && lit.offsetParent !== null) {
          lit.closest('li')?.scrollIntoView({ block: 'nearest' })
          was = on
        }
      }
    },
  }
}

/** The task and project the page is on, where they are `machine`'s (`undefined` is this one's). */
function litOf(where, machine) {
  if (where.machine !== machine) return { on: null, here: null }
  const on = where.view === 'task' ? `${where.project}/${where.task}` : null
  const here = where.view === 'project' || where.view === 'task' ? where.project : null
  return { on, here }
}

/* ── another machine's ─────────────────────────────────────────────────────── */

function createThere() {
  const node = el('section', { class: 'side-there' })
  into(node, el('p', { class: 'there-line' }), el('div', { class: 'side-projects' }))
  // Its folds are its own: `tade` folded here is not `tade` folded there.
  node.folded = new Set()
  return node
}

/** Another machine's projects, out of its copy and clock, nothing to press, every link that machine's. */
function fillThere(node, machine, view) {
  const on = thereOf(view.store, machine, view.standing === 'live', view.now ?? Date.now())
  const [line, list] = node.children
  textIn(line, on.line)
  classOn(node, 'is-there-down', !on.up)
  const at = { ...view, store: on.store, asOf: on.asOf, frozen: on.frozen }
  const lit = { ...litOf(view.where, machine), folded: node.folded, rows: new Map(), acting: null }
  keyed(
    list,
    projectsOf(on.store),
    (row) => row.name,
    () => createProject(node.folded),
    (one, row) => fillProject(one, row, at, lit),
  )
  linksThere(list, machine)
}

/**
 * Why a project has no agents down the side: nobody running, or nothing read
 * yet — never the first said for the second, which is a page with no snapshot
 * reporting a machine where nothing works.
 */
export function noAgentsSaid(store) {
  return store.had ? 'no agent is running' : 'not read yet'
}

/* ── a project ─────────────────────────────────────────────────────────────── */

function createProject(folded) {
  const node = el('section', { class: 'side-project' })
  const head = el('div', { class: 'side-head' })
  const twist = el('button', {
    class: 'tree-twist',
    attrs: { type: 'button', 'aria-expanded': 'true' },
  })
  into(twist, icon('chevron', 'twist'))
  const link = el('a', { class: 'side-name', attrs: { href: '/' } })
  const wants = el('span', { class: 'ui-count is-wants' })
  const working = el('span', { class: 'ui-count is-working' })
  into(link, el('span', { class: 'tree-name' }), wants, working)
  into(head, twist, link)
  const body = el('div', { class: 'side-body' })
  const agentsHead = label('Agents')
  const groups = el('div', { class: 'side-groups' })
  const noAgents = el('p', { class: 'side-quiet' })
  const queueHead = label('Queue')
  const queue = el('ul', { class: 'side-queue', attrs: { 'aria-label': 'Queue' } })
  into(body, agentsHead.node, groups, noAgents, queueHead.node, queue)
  into(node, head, body)
  twist.addEventListener('click', () => {
    const name = node.getAttribute('data-key') ?? ''
    const shut = !body.hidden
    body.hidden = shut
    if (shut) folded.add(name)
    else folded.delete(name)
    twist.setAttribute('aria-expanded', shut ? 'false' : 'true')
    twist.setAttribute('aria-label', `${shut ? 'Open' : 'Fold'} ${name}`)
  })
  return node
}

/** A small heading inside a project, with its figure: the window's section label. */
function label(word) {
  const node = el('h3', { class: 'side-label' })
  const figure = el('span', { class: 'figure' })
  const note = el('span', { class: 'side-note' })
  into(node, el('span', { text: word }), figure, note)
  return { node, figure, note }
}

function fillProject(node, project, view, at) {
  const [head, body] = node.children
  const [twist, link] = head.children
  const [name, wants, working] = link.children
  link.setAttribute('href', pathOf({ view: 'project', project: project.name }))
  if (project.name === at.here) link.setAttribute('aria-current', 'page')
  else link.removeAttribute('aria-current')
  textIn(name, project.name)
  const counts = project.counts
  textIn(wants, counts.wantsYou === 0 ? '' : String(counts.wantsYou))
  wants.setAttribute('aria-label', `${counts.wantsYou} wanting you`)
  textIn(working, counts.working === 0 ? '' : String(counts.working))
  working.setAttribute('aria-label', `${counts.working} working`)
  // **The project you are in is never folded away from you**: arriving at it is
  // asking to see it, whatever was folded last week.
  const shut = at.folded.has(project.name) && project.name !== at.here
  body.hidden = shut
  twist.setAttribute('aria-expanded', shut ? 'false' : 'true')
  twist.setAttribute('aria-label', `${shut ? 'Open' : 'Fold'} ${project.name}`)
  if (shut) return

  const [agentsHead, groups, noAgents, queueHead, queue] = body.children
  const tasks = tasksIn(view.store, project.name)
  const agents = sideAgents(tasks)
  textIn(agentsHead.children[1], agents.length === 0 ? '' : String(agents.length))
  noAgents.hidden = agents.length > 0
  textIn(noAgents, noAgentsSaid(view.store))
  // Queued work's too, for its ⋯.
  for (const task of tasks) at.rows.set(task.id, task)
  keyed(
    groups,
    agentGroups(agents),
    (group) => group.effort ?? '',
    createGroup,
    (one, group) => fillGroup(one, group, view, at.on, at.acting),
  )

  const rows = queueIn(view.store, project.name)
  textIn(queueHead.children[1], rows.length === 0 ? '' : String(rows.length))
  // A whole project's queue paused at once is one fact, and the one a person
  // can undo in one act — said once at the heading rather than on every row.
  textIn(
    queueHead.children[2],
    queuePaused(rows) ? 'paused' : rows.length === 0 ? 'nothing queued' : '',
  )
  queue.hidden = rows.length === 0
  treeIn(queue, queueTree(rows), project.name, view, at)
}

/* ── its agents ────────────────────────────────────────────────────────────── */

function createGroup() {
  const node = el('div', { class: 'side-group' })
  const run = el('a', { class: 'side-run', attrs: { href: '/' } })
  const list = el('ul', { class: 'side-agents' })
  into(node, run, list)
  return node
}

function fillGroup(node, group, view, on, acting) {
  const [run, list] = node.children
  // The plan's own slug, as the window heads the group with it — a link to the
  // plan's graph, which is where *what waits on what* across it is drawn.
  run.hidden = group.effort === null
  if (group.effort !== null) {
    run.setAttribute('href', pathOf({ view: 'run', run: group.effort }))
    textIn(run, group.effort)
  }
  keyed(
    list,
    group.agents,
    (task) => task.id,
    () => createAgent(acting),
    (one, task) => fillAgent(one, task, view, on),
  )
}

function createAgent(acting) {
  const node = el('li')
  const line = el('div', { class: 'side-line' })
  const link = el('a', { class: 'side-agent', attrs: { href: '/' } })
  into(
    link,
    glyphOf(taskMark('working')),
    el('span', { class: 'name' }),
    el('span', { class: 'doing' }),
  )
  const presses = agentPresses(acting, () => node.querySelector('.side-said'))
  into(line, link, presses.node)
  // What the window says beside the agent you have open, drawn only under that one.
  const detail = el('div', { class: 'side-detail' })
  detail.hidden = true
  into(detail, factLink(), factLink(), factLink())
  // What came of the last press on this row, said under it and let go.
  const said = el('p', { class: 'side-said agent-said', attrs: { role: 'status' } })
  said.hidden = true
  into(node, line, detail, said)
  node.sidePresses = presses
  if (acting !== null) holdOpens(link, (from) => presses.openMenu(from))
  return node
}

function factLink() {
  const node = el('a', { class: 'side-fact', attrs: { href: '/' } })
  into(
    node,
    el('span', { class: 'glyph', attrs: { 'aria-hidden': 'true' } }),
    el('span', { class: 'fact-word' }),
    el('span', { class: 'fact-said' }),
  )
  return node
}

function fillAgent(node, task, view, on) {
  const [line, detail] = node.children
  const link = line.children[0]
  const [glyph, name, doing] = link.children
  node.sidePresses?.update(task, view.may?.acts ?? {})
  link.setAttribute('href', taskPath(task.id))
  const lit = task.id === on
  if (lit) link.setAttribute('aria-current', 'page')
  else link.removeAttribute('aria-current')
  const mark = rowMark(task)
  markIn(glyph, mark)
  textIn(name, task.name)
  // What it is doing, in `deriveState`'s own clause; its mark's word where it
  // gave none — never a second wording of the state.
  textIn(doing, task.reason === '' ? mark.word : task.reason)
  classOn(link, 'stalled', task.stalled === true)
  detail.hidden = !lit
  if (lit) detailIn(detail, task, view)
}

/**
 * The run this agent is part of and how its checks stand: two facts the
 * window shows beside an agent, each one link from the page that has all of
 * it. A fact with nothing behind it is not drawn — an agent in no plan has no
 * plan line, rather than a line saying so.
 */
function detailIn(detail, task, view) {
  const [run, checks, review] = detail.children
  const effort = task.effort ?? null
  const row = effort === null ? null : runAt(view.store, effort)
  run.hidden = effort === null
  if (effort !== null) {
    run.setAttribute('href', pathOf({ view: 'run', run: effort }))
    factIn(
      run,
      '⑁',
      't-quiet',
      'plan',
      row === null ? effort : `${effort} · ${row.finished} of ${row.total} done`,
    )
  }
  const mark = checkMark(task.checks.state)
  checks.setAttribute('href', '/checks')
  const failed = task.checks.failed.length > 0 ? ` · ${task.checks.failed.join(', ')}` : ''
  factIn(
    checks,
    mark.glyph,
    mark.tone,
    'checks',
    `${mark.word}${failed}${task.checks.overridden ? ' · overruled' : ''}`,
  )
  review.hidden = task.review === null || task.review === undefined
  if (!review.hidden) {
    review.setAttribute('href', '/reviews')
    factIn(review, '◴', 't-quiet', 'review', task.review.state)
  }
}

function factIn(node, glyph, tone, word, said) {
  const [mark, words, rest] = node.children
  textIn(mark, glyph)
  toneOn(mark, tone)
  textIn(words, word)
  textIn(rest, said)
}

/* ── its queue, as a tree ──────────────────────────────────────────────────── */

/**
 * One level of the tree, and every level under it: a list in a list, so a
 * screen reader hears the nesting the lines draw — *list, level two* — and the
 * stylesheet draws the window's `╰─` from the nesting alone. Plain lists rather
 * than `role="tree"`, which promises arrow keys this does not answer.
 */
function treeIn(list, nodes, project, view, at) {
  keyed(
    list,
    nodes,
    (one) => one.row.task,
    () => createPiece(at.acting),
    (item, one) => fillPiece(item, one, project, view, at),
  )
}

/** Queued work, its ⋯ and hold opening the window's queued-work menu. */
function createPiece(acting) {
  const node = el('li')
  const line = el('div', { class: 'side-line' })
  const link = el('a', { class: 'side-piece', attrs: { href: '/' } })
  into(
    link,
    glyphOf(queueMark({ kind: 'ready' })),
    el('span', { class: 'name' }),
    el('span', { class: 'at' }),
    el('span', { class: 'why' }),
  )
  const acts = el('span', { class: 'side-acts' })
  const more = el('button', {
    class: 'tap icon side-press',
    attrs: { type: 'button', 'aria-haspopup': 'dialog', title: 'More' },
  })
  into(more, icon('more'))
  into(acts, more)
  acts.hidden = true
  into(line, link, acts)
  into(node, line, el('ul'))
  const open = (from) => {
    const id = node.pieceTask
    if (id) acting.menu.open(id, from, () => acting.rowOf(id))
  }
  more.addEventListener('click', () => open(more))
  if (acting !== null) holdOpens(link, open)
  return node
}

function fillPiece(node, one, project, view, at) {
  const [line, under] = node.children
  const [link, acts] = line.children
  const [glyph, name, when, why] = link.children
  const row = one.row
  if (row.state.kind === 'there') link.removeAttribute('href')
  else link.setAttribute('href', taskPath(row.task))
  markIn(glyph, queueMark(row.state))
  textIn(name, queueName(row))
  textIn(when, queueAt(row.state, shortClockOf))
  textIn(why, queueLine(row.state, project))
  classOn(node, 'is-held', row.state.kind === 'held')
  // Not for work elsewhere.
  const offered = at.acting !== null && row.state.kind !== 'there' && at.rows.has(row.task)
  node.pieceTask = offered ? row.task : null
  acts.hidden = !offered
  acts.firstChild.setAttribute('aria-label', `More for ${queueName(row)}`)
  under.hidden = one.children.length === 0
  treeIn(under, one.children, project, view, at)
}
