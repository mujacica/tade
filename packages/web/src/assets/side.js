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

import { standingOf } from './acts.js'
import { agentMenu, holdOpens, sendAct } from './agent-menu.js'
import { classOn, el, glyphOf, into, keyed, markIn, textIn, toneOn } from './dom.js'
import { count, shortClockOf } from './figures.js'
import { checkMark, queueMark, rowMark, taskMark } from './glyphs.js'
import { icon, iconIn } from './icons.js'
import { pathOf, taskPath } from './routes.js'
import { projectsOf, queueIn, runAt, tasksIn } from './store.js'
import {
  agentGroups,
  queueAt,
  queueLine,
  queueName,
  queuePaused,
  queueTree,
  sideAgents,
} from './tree.js'
import { fullAccessOf } from './trouble.js'

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
  into(node, head, projects, none)
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
      const shown = projectsOf(view.store)
      const working = shown.reduce((n, one) => n + one.counts.working, 0)
      textIn(figure, working === 0 ? '' : `${count(working)} working`)
      none.hidden = shown.length > 0
      textIn(none, view.store.had ? 'no project is open' : 'not read yet')
      const on = view.where.view === 'task' ? `${view.where.project}/${view.where.task}` : null
      const here =
        view.where.view === 'project' || view.where.view === 'task' ? view.where.project : null
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
  const agents = sideAgents(tasksIn(view.store, project.name))
  textIn(agentsHead.children[1], agents.length === 0 ? '' : String(agents.length))
  noAgents.hidden = agents.length > 0
  textIn(noAgents, noAgentsSaid(view.store))
  for (const task of agents) at.rows.set(task.id, task)
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
  treeIn(queue, queueTree(rows), project.name, view)
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
  const presses = agentPresses(node, acting)
  into(line, link, presses.node)
  // What the window says beside the agent you have open, drawn only under that one.
  const detail = el('div', { class: 'side-detail' })
  detail.hidden = true
  into(detail, factLink(), factLink(), factLink())
  // What came of the last press on this row, said under it and let go.
  const said = el('p', { class: 'side-said', attrs: { role: 'status' } })
  said.hidden = true
  into(node, line, detail, said)
  node.sidePresses = presses
  if (acting !== null) holdOpens(link, (from) => presses.openMenu(from))
  return node
}

/**
 * Start or stop, close, and ⋯: the window's row's own presses, each through the
 * act door with what the row says it can be asked (`standingOf`). A verb this
 * device was not granted is not drawn at all; one it was, that cannot be done
 * now, is not drawn here and is in the menu with its reason.
 */
function agentPresses(item, acting) {
  const node = el('div', { class: 'side-acts' })
  const toggle = el('button', { class: 'tap icon side-press', attrs: { type: 'button' } })
  into(toggle, icon('play'))
  const shut = el('button', { class: 'tap icon side-press is-danger', attrs: { type: 'button' } })
  into(shut, icon('close'))
  const more = el('button', {
    class: 'tap icon side-press',
    attrs: { type: 'button', 'aria-haspopup': 'dialog' },
  })
  into(more, icon('more'))
  into(node, toggle, shut, more)
  node.hidden = acting === null
  let task = null
  let toggleVerb = null
  let asked = null
  let askedTimer = null
  let saidTimer = null
  let going = false

  const label = (press, verb, words) => {
    press.setAttribute('aria-label', asked === verb ? `Tap again to ${words.toLowerCase()}` : words)
    press.title = asked === verb ? 'Tap again to confirm' : words
    classOn(press, 'asked', asked === verb)
  }
  const relabel = () => {
    const name = task?.name ?? ''
    if (toggleVerb !== null) {
      label(toggle, toggleVerb, toggleVerb === 'stop' ? `Stop ${name}` : `Start ${name}`)
    }
    label(shut, 'remove', `Close ${name}`)
    more.setAttribute('aria-label', `More for ${name}`)
    more.title = 'More'
  }
  const press = async (verb) => {
    if (acting === null || task === null || going) return
    if ((verb === 'stop' || verb === 'remove') && asked !== verb) {
      asked = verb
      clearTimeout(askedTimer)
      askedTimer = setTimeout(() => {
        asked = null
        relabel()
      }, 4_000)
      relabel()
      return
    }
    asked = null
    relabel()
    going = true
    const said = item.querySelector('.side-said')
    said.hidden = false
    const came = await sendAct(acting.ctx, verb, acting.rowOf(task.id), {}, said)
    going = false
    clearTimeout(saidTimer)
    // Said long enough to read, then let go: the row itself shows what is true now.
    saidTimer = setTimeout(
      () => {
        said.hidden = true
      },
      came.ok ? 6_000 : 12_000,
    )
  }
  toggle.addEventListener('click', () => void press(toggleVerb))
  shut.addEventListener('click', () => void press('remove'))
  const openMenu = (from) => {
    if (acting === null || task === null) return
    const id = task.id
    acting.menu.open(id, from, () => acting.rowOf(id))
  }
  more.addEventListener('click', () => openMenu(more))

  return {
    node,
    openMenu,
    update(row, acts) {
      task = row
      // Whether this is the person's own device, off its own session: a drawing
      // hint, asked again of the record at the act (`Verb.theirs`).
      const theirs = acting !== null && fullAccessOf(acting.ctx.session?.() ?? null)
      const stop = standingOf('stop', row, acts)
      const start = standingOf('start', row, acts)
      toggleVerb = stop.kind === 'yes' ? 'stop' : start.kind === 'yes' ? 'start' : null
      toggle.hidden = toggleVerb === null
      if (toggleVerb !== null) iconIn(toggle, toggleVerb === 'stop' ? 'stop' : 'play')
      // Closing removes its worktree and branch: the person's own device's alone.
      shut.hidden = !theirs || standingOf('remove', row, acts).kind !== 'yes'
      relabel()
    },
  }
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
function treeIn(list, nodes, project, view) {
  keyed(
    list,
    nodes,
    (one) => one.row.task,
    createPiece,
    (item, one) => fillPiece(item, one, project, view),
  )
}

function createPiece() {
  const node = el('li')
  const link = el('a', { class: 'side-piece', attrs: { href: '/' } })
  into(
    link,
    glyphOf(queueMark({ kind: 'ready' })),
    el('span', { class: 'name' }),
    el('span', { class: 'at' }),
    el('span', { class: 'why' }),
  )
  const under = el('ul')
  into(node, link, under)
  return node
}

function fillPiece(node, one, project, view) {
  const [link, under] = node.children
  const [glyph, name, at, why] = link.children
  const row = one.row
  if (row.state.kind === 'there') link.removeAttribute('href')
  else link.setAttribute('href', taskPath(row.task))
  markIn(glyph, queueMark(row.state))
  textIn(name, queueName(row))
  textIn(at, queueAt(row.state, shortClockOf))
  textIn(why, queueLine(row.state, project))
  classOn(node, 'is-held', row.state.kind === 'held')
  under.hidden = one.children.length === 0
  treeIn(under, one.children, project, view)
}
