// The overview: the one screen the page has (§10 T5 of the Duo plan), cut down
// to the basics and the conversation with Tade.
//
// Read in the order somebody opening it on a phone asks: **is anything
// waiting on me, is the work moving, and what is Tade saying.** So it is drawn
// in that order:
//
// 1. **Four tiles** — working, waiting on you, queued, finished today — each a
//    figure, a mark per thing and the line that breaks it down.
// 2. **Waiting on you**, every machine's that is up, each with its question —
//    the command it would run, whole — and its answers (`quick.js`).
// 3. **Working**, one line each: the agent, its state, how long since it moved.
// 4. **Tade**: the conversation and the box to type in (`talkPart`).
//
// **Tapping an agent opens it in the full view** (`agentPath`): the window
// itself, focused on it, where its screen, its lane to type into, its changes
// and every panel are. There is no second agent page here, and nothing else
// Tade shows is drawn twice: spend, checks, the queue, settings and the rest
// are panels of the window.
//
// The large screen upright and anything wider draws the agents beside the
// conversation (`overview.css`); the small screen upright is one column.
//
// **Nothing here derives a state.** Every figure is `overview-figures.js`'s
// fold over what came off the wire, held by `test/overview.test.ts`; every
// reason is `deriveState`'s clause verbatim; a figure nobody could read is a
// dash. **Built once and then patched**, like every screen: a figure is one
// text write, a row is filled in place (`keyed`), and a delta never moves
// where somebody's thumb is.

import { stat, statIn, stats, toneIn } from '../charts.js'
import { classOn, el, glyphOf, into, keyed, markIn, stateIn, textIn, toneOn } from '../dom.js'
import { ageSaid } from '../figures.js'
import { AGENT_MARKS, rowMark, taskMark } from '../glyphs.js'
import { icon } from '../icons.js'
import { quickActs } from '../quick.js'
import { agentPath } from '../routes.js'
import { section } from '../rows.js'
import { talkPart } from '../talk.js'
import { thereCtx } from '../there.js'
import { tilesOf, waitingOf, workingOf } from './overview-figures.js'

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

  const working = section('WORKING')
  working.node.setAttribute('id', 'working')
  const workList = el('ul', { class: 'ov-agents ui-panel rows' })
  const idle = el('p', { class: 'empty nothing', text: 'No agent is working' })
  into(working.body, workList, idle)

  into(work, tiles.node, waiting.node, working.node)
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

      const agents = had ? workingOf(store) : []
      textIn(working.figure, agents.length === 0 ? '' : String(agents.length))
      keyed(
        workList,
        agents,
        (one) => `${one.machine}\u0000${one.task.id}`,
        createAgent,
        (item, one) => fillAgent(item, one, view),
      )
      idle.hidden = !had || agents.length > 0

      talk.update(view)
    },
  }
}

/* ── the tiles ─────────────────────────────────────────────────────────────── */

/**
 * The four tiles, each the shared stat with a mark per thing under its
 * figure. Working and waiting are presses to their own lists below; queued
 * and finished are the window's to show whole, in the full view.
 */
const TILES = [
  { key: 'working', label: 'Working', href: '#working', tone: 'working' },
  { key: 'wants', label: 'Waiting on you', href: '#waiting', tone: 'wants' },
  { key: 'queue', label: 'Queued', href: null, tone: 'queued' },
  { key: 'finished', label: 'Finished today', href: null, tone: 'done' },
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

/* ── an agent working ──────────────────────────────────────────────────────── */

/** One working agent, one line: its mark, its name and where, its state, its age. */
function createAgent() {
  const node = el('li', { class: 'ov-agent' })
  const link = el('a', { attrs: { href: '/' } })
  const who = el('span', { class: 'ov-agent-who' })
  into(who, el('span', { class: 'ov-agent-name' }), el('span', { class: 'ov-agent-project' }))
  into(
    link,
    glyphOf(AGENT_MARKS.working, 'ov-agent-mark'),
    who,
    el('span', { class: 'ov-agent-state' }),
    el('span', { class: 'ov-agent-age' }),
  )
  into(node, link)
  return node
}

function fillAgent(node, one, view) {
  const { task, machine } = one
  const [link] = node.children
  const [glyph, who, state, age] = link.children
  const [name, project] = who.children
  link.setAttribute('href', agentPath(task.id, machine))
  markIn(glyph, rowMark(task))
  stateIn(link, task.state)
  classOn(link, 'stalled', task.stalled)
  textIn(name, task.name)
  textIn(project, whereSaid(task, machine))
  textIn(state, task.stalled ? 'stalled' : 'working')
  const moved = ageSaid(task.movedAt ?? task.createdAt, view.asOf, view.frozen)
  textIn(age, moved ?? '')
  age.setAttribute('aria-label', moved === null ? 'never moved' : `moved ${moved} ago`)
}

/** The presses' context for an agent on `machine`: another machine's go through this door (`thereCtx`). */
const ctxFor = (ctx, machine) =>
  ctx === null ? null : machine === '' ? ctx : thereCtx(ctx, machine)

/** Where an agent is: its project, and the machine in front where it is not this one. */
const whereSaid = (task, machine) =>
  machine === '' ? task.project : `${machine} · ${task.project}`
