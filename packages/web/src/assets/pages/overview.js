// The overview: the one screen the page has (§10 T5 of the Duo plan): what the
// person needs to know about every agent on every machine, and the
// conversation with Tade.
//
// Read in the order somebody opening it on a phone asks: **is anything
// waiting on me, what is every agent doing, what starts next, and what is
// Tade saying.** So it is drawn in that order:
//
// 1. **Four tiles** — working, waiting on you, queued, finished today — each a
//    figure, a mark per thing and the line that breaks it down.
// 2. **Waiting on you**, every machine's that is up, each with its question —
//    the command it would run, whole — and its answers (`quick.js`).
// 3. **Agents**, every one on every machine whose store this door holds, by
//    machine and then project, each with its counts — working, waiting on
//    you, idle, failed, stopped, parked, finished. An agent's row is its mark
//    and name, how long it has been in its state, its state and why in
//    `deriveState`'s words, what it is doing now (its newest tool call, as
//    the window saw it), and the harness and model it runs on. What is
//    resting — stopped, parked, finished — folds under its count in each
//    project, one press to open; nothing is cut, and the region scrolls.
// 4. **Queue**: every machine's queued work, what starts next first, each
//    with where it stands in the queue's own words and what it waits on, why.
// 5. **Tade**: the conversation and the box to type in (`talkPart`).
//
// **Tapping an agent opens it in the full view** (`agentPath`): the window
// itself, focused on it, where its screen, its lane to type into, its changes
// and every panel are. There is no second agent page here, and nothing else
// Tade shows is drawn twice: spend, checks, settings and the rest are panels
// of the window.
//
// The large screen upright and anything wider draws the agents beside the
// conversation (`overview.css`); the small screen upright is one column.
//
// **Nothing here derives a state.** Every figure is `overview-figures.js`'s
// fold over what came off the wire, held by `test/overview.test.ts`; every
// reason is `deriveState`'s clause verbatim; a figure nobody could read is a
// dash. **Built once and then patched**, like every screen: a figure is one
// text write, a row is filled in place (`keyed`), a folded list keeps whether
// somebody opened it, and a delta never moves where somebody's thumb is.

import { stat, statIn, stats, toneIn } from '../charts.js'
import { classOn, el, glyphOf, into, keyed, markIn, stateIn, textIn, toneOn } from '../dom.js'
import { ageSaid, shortClockOf } from '../figures.js'
import { AGENT_MARKS, queueMark, queueSaid, rowMark, taskMark, toolNamed } from '../glyphs.js'
import { icon } from '../icons.js'
import { quickActs } from '../quick.js'
import { agentPath } from '../routes.js'
import { section } from '../rows.js'
import { talkPart } from '../talk.js'
import { thereCtx } from '../there.js'
import {
  agentsOf,
  everyAgentCounted,
  KIND_WORDS,
  kindOf,
  queueOf,
  tilesOf,
  waitingOf,
} from './overview-figures.js'

/* ── the screen ────────────────────────────────────────────────────────────── */

export function nowScreen(ctx = null) {
  const node = el('div', { class: 'overview' })
  const work = el('div', { class: 'ov-work' })

  const tiles = tilesView()

  const waiting = section('WAITING ON YOU')
  waiting.node.setAttribute('id', 'waiting')
  const waitList = el('ol', { class: 'ov-wants ui-panel' })
  const clear = clearLine()
  into(waiting.body, waitList, clear.node)

  const agents = section('AGENTS')
  agents.node.setAttribute('id', 'agents')
  const everyOne = el('p', { class: 'ov-sum' })
  const machineList = el('ol', { class: 'ov-machines' })
  const none = el('p', { class: 'empty nothing', text: 'No agent on any machine' })
  into(agents.body, everyOne, machineList, none)

  const queue = section('QUEUE')
  queue.node.setAttribute('id', 'queue')
  const queueList = el('ol', { class: 'ov-queue ui-panel' })
  const nothingQueued = el('p', { class: 'empty nothing', text: 'Nothing is queued' })
  into(queue.body, queueList, nothingQueued)

  into(work, tiles.node, waiting.node, agents.node, queue.node)
  const talk = talkPart(ctx)
  into(node, work, talk.node)

  return {
    node,
    leave: () => talk.leave(),
    update(view) {
      const store = view.store
      const had = store.had
      tiles.update(had ? tilesOf(store, view.asOf) : null)

      const wanting = had ? waitingOf(store) : []
      textIn(waiting.figure, wanting.length === 0 ? '' : String(wanting.length))
      toneOn(waiting.figure, wanting.length > 0 ? 't-wants' : '')
      waiting.figure.setAttribute('aria-label', `${wanting.length} waiting on you`)
      keyed(
        waitList,
        wanting,
        (one) => `${one.machine}\u0000${one.task.id}`,
        (one) => createWant(ctxFor(ctx, one.machine)),
        (item, one) => fillWant(item, one, view),
      )
      clear.update(had && wanting.length === 0)

      const machines = had ? agentsOf(store) : []
      const counted = everyAgentCounted(machines)
      textIn(agents.figure, counted.n === 0 ? '' : String(counted.n))
      agents.figure.setAttribute('aria-label', `${counted.n} agents`)
      textIn(everyOne, counted.said)
      // Said only across machines: with one holding agents, its own line says it.
      everyOne.hidden = machines.filter((one) => one.counts.n > 0).length < 2
      // A machine with nothing on it is still a machine somebody wants to know
      // is up; with only this one and nothing anywhere, the one empty line.
      const drawn = counted.n === 0 ? [] : machines
      keyed(
        machineList,
        drawn,
        (one) => `m${one.machine}`,
        createMachine,
        (item, one) => fillMachine(item, one, view),
      )
      none.hidden = !had || counted.n > 0

      const queued = had ? queueOf(store) : []
      textIn(queue.figure, queued.length === 0 ? '' : String(queued.length))
      queue.figure.setAttribute('aria-label', `${queued.length} queued`)
      keyed(
        queueList,
        queued,
        (one) => `${one.machine}\u0000${one.row.task}`,
        createQueued,
        (item, one) => fillQueued(item, one),
      )
      nothingQueued.hidden = !had || queued.length > 0

      talk.update(view)
    },
  }
}

/* ── the tiles ─────────────────────────────────────────────────────────────── */

/**
 * The four tiles, each the shared stat with a mark per thing under its
 * figure, and each a press to the list below that holds what it counts.
 */
const TILES = [
  { key: 'working', label: 'Working', href: '#agents', tone: 'working' },
  { key: 'wants', label: 'Waiting on you', href: '#waiting', tone: 'wants' },
  { key: 'queue', label: 'Queued', href: '#queue', tone: 'queued' },
  { key: 'finished', label: 'Finished today', href: '#agents', tone: 'done' },
]

function tilesView() {
  const node = stats('The work, right now')
  node.classList.add('ov-tiles')
  const made = TILES.map((spec) => {
    const one = stat(spec.label, spec.href)
    one.classList.add('ov-tile')
    const dots = dotsView()
    one.append(dots)
    node.append(one)
    return { spec, node: one, dots }
  })
  return {
    node,
    update(figures) {
      // Nothing read yet is a shimmer where each figure will be, never a dash
      // that reads as *nobody recorded it* and never a nought.
      if (figures === null) return
      for (const { spec, node: one, dots } of made) {
        const tile = figures[spec.key]
        const hot = tile.n > 0
        statIn(one, { value: String(tile.n), under: tile.under, tone: hot ? spec.tone : null })
        classOn(one, 'is-hot', hot && spec.key === 'wants')
        dotsIn(dots, tile.dots)
      }
    },
  }
}

/**
 * A mark per thing — an agent, a task — in its tone; hollow for one still
 * waiting on something, and the count of the rest where they do not fit.
 * `aria-hidden`: the figure and the line beside it say it in words.
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

/* ── an agent waiting on you ───────────────────────────────────────────────── */

/**
 * One agent waiting on you: its mark, its name and where it is, why in
 * `deriveState`'s own words, how long ago, and its answers.
 *
 * The row is not a link: it holds buttons, and a button inside a link is two
 * targets in one place. Its name is the link — to the agent in the full view —
 * and the presses sit beside it.
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

function fillWant(node, one, view) {
  const { task, machine } = one
  const [glyph, link, age, why] = node.children
  markIn(glyph, rowMark(task))
  stateIn(node, task.state)
  link.setAttribute('href', agentPath(task.id, machine))
  textIn(link.children[0], task.name)
  textIn(link.children[1], whereSaid(task, machine))
  const moved = ageSaid(task.movedAt, view.asOf, view.frozen)
  textIn(age, moved ?? '')
  age.setAttribute('aria-label', moved === null ? 'never moved' : `moved ${moved} ago`)
  textIn(why, task.reason)
  node.quick?.update(task, view)
}

/** Nothing waiting on you on any machine: one calm line. */
function clearLine() {
  const node = el('div', { class: 'ov-clear ui-panel', attrs: { role: 'status' } })
  const mark = el('span', { class: 'ov-clear-mark t-done' })
  mark.append(icon('check'))
  into(node, mark, el('strong', { text: 'Nothing needs you' }))
  node.hidden = true
  return {
    node,
    update(shown) {
      node.hidden = !shown
    },
  }
}

/* ── every agent, by machine and project ───────────────────────────────────── */

/**
 * One machine: its name and whether it is up — a machine that is not is drawn
 * as of its last word, dimmed, never left out — the counts of its agents, and
 * its projects.
 */
function createMachine() {
  const node = el('li', { class: 'ov-machine' })
  const head = el('div', { class: 'ov-machine-head' })
  into(
    head,
    el('h3', { class: 'ov-machine-name' }),
    el('span', { class: 'ov-machine-state' }),
    el('p', { class: 'ov-machine-counts' }),
  )
  into(node, head, el('ol', { class: 'ov-projects' }))
  return node
}

function fillMachine(node, one, view) {
  const [head, projects] = node.children
  const [name, state, counts] = head.children
  textIn(name, one.machine === '' ? 'This machine' : one.machine)
  textIn(state, one.machine === '' && view.standing !== 'live' ? 'not answering' : one.state)
  toneOn(state, one.up ? 't-done' : 't-wants')
  classOn(node, 'is-down', !one.up)
  textIn(counts, one.counts.n === 0 ? 'no agents' : one.counts.said)
  keyed(
    projects,
    one.projects,
    (project) => `p${project.project}`,
    createProject,
    (item, project) => fillProject(item, project, one.machine, view),
  )
}

/**
 * One project on a machine: its name and counts, the agents to look at, and
 * the resting ones folded under their count — opened by a press, and kept
 * open across every delta, since the node is the same one.
 */
function createProject() {
  const node = el('li', { class: 'ov-project ui-panel' })
  const head = el('div', { class: 'ov-project-head' })
  into(head, el('h4', { class: 'ov-project-name' }), el('span', { class: 'ov-project-counts' }))
  const active = el('ul', { class: 'ov-agents rows' })
  const rest = el('details', { class: 'ov-rest' })
  into(rest, el('summary', { class: 'ov-rest-said' }), el('ul', { class: 'ov-agents rows' }))
  into(node, head, active, rest)
  return node
}

function fillProject(node, project, machine, view) {
  const [head, active, rest] = node.children
  const [name, counts] = head.children
  textIn(name, project.project)
  textIn(counts, project.counts.said)
  const row = (list, tasks) =>
    keyed(
      list,
      tasks.map((task) => ({ machine, task })),
      (one) => one.task.id,
      createAgent,
      (item, one) => fillAgent(item, one, view),
    )
  row(active, project.active)
  const [said, resting] = rest.children
  textIn(said, project.restingSaid)
  row(resting, project.resting)
  rest.hidden = project.resting.length === 0
}

/**
 * One agent: its mark, its name and how long it has been in its state; its
 * state and why; what it is doing now; the harness and model it runs on. The
 * whole row is the link to it in the full view.
 */
function createAgent() {
  const node = el('li', { class: 'ov-agent' })
  const link = el('a', { attrs: { href: '/' } })
  const doing = el('span', { class: 'ov-agent-doing' })
  into(
    doing,
    el('span', { class: 'ov-doing-tool' }),
    el('span', { class: 'ov-doing-about' }),
    el('span', { class: 'ov-doing-age' }),
  )
  const state = el('span', { class: 'ov-agent-state' })
  into(state, el('span', { class: 'ov-state-word' }), el('span', { class: 'ov-state-why' }))
  into(
    link,
    glyphOf(AGENT_MARKS.working, 'ov-agent-mark'),
    el('span', { class: 'ov-agent-name' }),
    el('span', { class: 'ov-agent-age' }),
    state,
    doing,
    el('span', { class: 'ov-agent-ran' }),
  )
  into(node, link)
  return node
}

function fillAgent(node, one, view) {
  const { task, machine } = one
  const [link] = node.children
  const [glyph, name, age, state, doing, ran] = link.children
  link.setAttribute('href', agentPath(task.id, machine))
  const mark = rowMark(task)
  markIn(glyph, mark)
  stateIn(link, task.state)
  classOn(link, 'stalled', task.stalled === true)
  textIn(name, task.name)

  // How long in this state: since it began where the machine says, else its last move.
  const began = task.since ?? null
  const at = began ?? task.movedAt ?? task.createdAt
  const long = ageSaid(at, view.asOf, view.frozen)
  textIn(age, long ?? '')
  const word = KIND_WORDS[kindOf(task)]
  age.setAttribute(
    'aria-label',
    long === null ? 'never moved' : began !== null ? `${word} for ${long}` : `moved ${long} ago`,
  )

  // Its state in its tone, and why in `deriveState`'s own words where they say more.
  const [stateWord, stateWhy] = state.children
  textIn(stateWord, task.stalled === true ? `${mark.word} · stalled` : mark.word)
  toneOn(stateWord, mark.tone)
  const why = typeof task.reason === 'string' ? task.reason : ''
  textIn(stateWhy, why === mark.word ? '' : why)

  // What it is doing now: its newest tool call as the window saw it.
  const did = task.doing ?? null
  doing.hidden = did === null
  if (did !== null) {
    const [tool, about, when] = doing.children
    textIn(tool, toolNamed(did.tool))
    textIn(about, did.about)
    const ago = ageSaid(did.at, view.asOf, view.frozen)
    const how = did.ok === false ? 'failed' : did.ok === null ? 'running' : ''
    textIn(when, [how, ago === null ? '' : `${ago} ago`].filter(Boolean).join(' · '))
    classOn(doing, 'is-failed', did.ok === false)
  }

  // What it runs on. A dash is *not recorded*, never a guess.
  textIn(ran, `${task.harness ?? '—'} · ${task.model ?? '—'}`)
}

/* ── the queue ─────────────────────────────────────────────────────────────── */

/**
 * One piece of queued work: where it stands (next, after what, held and why,
 * at what time) in the queue's own words, its name and where it is, and what
 * it waits on with the reason written for each. A link to it in the full view.
 */
function createQueued() {
  const node = el('li', { class: 'ov-queued' })
  const link = el('a', { attrs: { href: '/' } })
  const who = el('span', { class: 'ov-queued-who' })
  into(who, el('span', { class: 'ov-queued-name' }), el('span', { class: 'ov-queued-where' }))
  into(
    link,
    glyphOf(queueMark({ kind: 'ready' }), 'ov-queued-mark'),
    who,
    el('span', { class: 'ov-queued-said' }),
    el('span', { class: 'ov-queued-why' }),
  )
  into(node, link)
  return node
}

function fillQueued(node, one) {
  const { row, machine, task } = one
  const [link] = node.children
  const [glyph, who, said, why] = link.children
  const [name, where] = who.children
  link.setAttribute('href', agentPath(row.task, machine))
  const mark = queueMark(row.state)
  markIn(glyph, mark)
  textIn(name, task?.name ?? row.task.slice(row.project.length + 1))
  textIn(where, whereSaid(row, machine))
  textIn(said, queueSaid(row.state, shortClockOf))
  toneOn(said, mark.tone)
  const reasons = (row.waitsOn ?? [])
    .filter((wait) => wait.why !== null && wait.why !== undefined)
    .map((wait) => `${wait.task}: ${wait.why.words}${wait.why.more ? '…' : ''}`)
  textIn(why, reasons.join(' · '))
  why.hidden = reasons.length === 0
}

/** The presses' context for an agent on `machine`: another machine's go through this door (`thereCtx`). */
const ctxFor = (ctx, machine) =>
  ctx === null ? null : machine === '' ? ctx : thereCtx(ctx, machine)

/** Where an agent is: its project, and the machine in front where it is not this one. */
const whereSaid = (task, machine) =>
  machine === '' ? task.project : `${machine} · ${task.project}`
