// The agents: every one running. One of them looked into is `pages/agent-pane.js`.
//
// **Nothing here types into a lane.** There is no box that reaches one and no
// key that does. What a person on a phone may say to an agent goes through the
// verbs on the task screen (`steer`, a message into a conversation that is
// already running) or through Tade (`talk.js`, and the strip on a desk). What
// they may *do* to one is what the window's own row offers — stop, close, and
// its menu on a ⋯, a long-press or a right-click (`agent-menu.js`) — each a
// verb gated at the machine and written down under the device's id.
//
// **What its screen shows is asked for only while somebody is looking.** The
// pane asks `/api/agent/...` while its page is open and visible, every
// `EVERY_MS`, and the asking is what makes the window go on reading the lane
// (`web-lanes.ts`): a page that is navigated away from, hidden or closed stops
// asking and the window stops reading a beat or two later. Nothing about it
// rides on the stream, which every screen pays for.
//
// **The rows are an agent's bytes, so they are text and only text.** One text
// node in a `<pre>`, set through `textContent` like everything else — never
// markup, never a link, never a colour read out of an escape — and what the
// machine took out of them (`screen.ts`) is drawn as the `…` it left.

import { agentMenu, agentPresses, holdOpens } from './agent-menu.js'
import { classOn, el, empty, glyphOf, into, keyed, markIn, stateIn, textIn } from './dom.js'
import { ageSaid, count } from './figures.js'
import { rowMark, taskMark } from './glyphs.js'
import { agentsElsewhere } from './machines.js'
import { taskPath, thereHref } from './routes.js'
import { section } from './rows.js'
import { agentsOf } from './store.js'
import { panel } from './ui.js'

/* ── every agent running ───────────────────────────────────────────────────── */

/**
 * The agents, by project: what each is doing, what it runs on, and why.
 *
 * The window's own side list as a page. On a desk it is also a column beside
 * every screen (`desk.js`), and both read `agentsOf` so they cannot disagree.
 */
export function agentsScreen(ctx = null) {
  const node = el('div')
  // The presses each row reads its agent through: the one menu, and the rows
  // as last drawn, so a press echoes what the screen shows.
  const rows = new Map()
  const acting =
    ctx === null ? null : { ctx, menu: agentMenu(ctx), rowOf: (id) => rows.get(id) ?? null }
  const made = section('AGENTS', { top: true })
  const groups = el('div')
  const none = empty('no agent is running')
  // Every other machine's, after this one's: a group a machine (`machines.js`).
  const elsewhere = el('div')
  into(made.body, groups, none, elsewhere)
  const rest = el('p', { class: 'unknown' })
  into(node, made.node, rest)
  return {
    node,
    update(view) {
      const agents = agentsOf(view.store)
      const others = agentsElsewhere(view.store)
      rows.clear()
      for (const task of agents) rows.set(task.id, task)
      textIn(made.figure, count(agents.length))
      made.figure.setAttribute('aria-label', `${agents.length} agents running`)
      none.hidden = agents.length > 0 || others.length > 0
      keyed(
        groups,
        byProject(agents),
        (group) => group.project,
        createGroup,
        (one, group) => fillGroup(one, group, view, acting),
      )
      keyed(
        elsewhere,
        others,
        (group) => group.machine,
        createElsewhere,
        (one, group) => fillElsewhere(one, group, view),
      )
      const idle = view.store.rows.tasks.size - agents.length
      // **Counted, never left out in silence**: a page of four agents that did
      // not say twelve tasks have none would read as the whole of the work.
      textIn(
        rest,
        idle > 0 ? `${idle} other task${idle === 1 ? ' has' : 's have'} no agent running` : '',
      )
      rest.hidden = idle === 0
    },
  }
}

/** Agents grouped by project, in the order `agentsOf` gave them. */
export function byProject(agents) {
  const groups = new Map()
  for (const task of agents) {
    const held = groups.get(task.project) ?? { project: task.project, agents: [] }
    held.agents.push(task)
    groups.set(task.project, held)
  }
  return [...groups.values()]
}

function createGroup() {
  const made = section('project')
  // A list on a phone and a grid of cards where the work has room for two.
  const list = panel('ul', 'rows agent-list')
  into(made.body, list)
  return made.node
}

function fillGroup(node, group, view, acting) {
  const [head, body] = node.children
  const [heading, figure] = head.children
  const [list] = body.children
  textIn(heading, group.project)
  heading.setAttribute('aria-label', `Project ${group.project}`)
  textIn(figure, count(group.agents.length))
  keyed(
    list,
    group.agents,
    (task) => task.id,
    () => agentRowWith(acting),
    (one, task) => fillAgentRow(one, task, view),
  )
}

/* ── another machine's ─────────────────────────────────────────────────────── */

// Each row leads to that machine's page for it (`thereHref`), with no presses yet.

function createElsewhere() {
  const made = section('machine')
  const said = el('p', { class: 'under elsewhere-said' })
  const list = panel('ul', 'rows agent-list')
  into(made.body, said, list)
  made.node.classList.add('elsewhere')
  return made.node
}

function fillElsewhere(node, group, view) {
  const [head, body] = node.children
  const [heading, figure] = head.children
  const [said, list] = body.children
  textIn(heading, group.machine)
  heading.setAttribute('aria-label', `Machine ${group.machine}`)
  textIn(figure, count(group.agents.length))
  textIn(said, group.said ?? '')
  said.hidden = group.said === null
  classOn(node, 'down', !group.up)
  // A machine nobody hears is drawn as of its last word, its ages frozen there.
  const at = group.up || group.asOf === null ? view : { ...view, asOf: group.asOf, frozen: true }
  keyed(
    list,
    group.agents,
    (task) => task.id,
    () => agentRowWith(null),
    (one, task) => {
      fillAgentRow(one, task, at)
      const [link] = one.children
      link.setAttribute('href', thereHref(group.machine, link.getAttribute('href')) ?? '/')
      const why = link.children[4]
      if (group.working !== null && task.mark === 'working') textIn(why, group.working)
    },
  )
}

/** One agent's row, alone: the overview's, which `keyed` builds with no argument of ours. */
export function createAgentRow() {
  return agentRowWith(null)
}

/**
 * One agent's row; with `acting`, its presses at its end and a line under it
 * for what came of one. Its own name, so `keyed` handing a builder the row it
 * is for can never be read as the presses' context.
 */
function agentRowWith(acting) {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  const glyph = glyphOf(taskMark('working'))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const runs = el('span', { class: 'under runs' })
  const why = el('span', { class: 'under' })
  into(link, glyph, name, aside, runs, why)
  into(node, link)
  if (acting !== null) {
    const said = el('p', { class: 'agent-said', attrs: { role: 'status' } })
    said.hidden = true
    const presses = agentPresses(acting, () => said)
    into(node, presses.node, said)
    node.classList.add('with-acts')
    node.agentPresses = presses
    holdOpens(link, (from) => presses.openMenu(from))
  }
  return node
}

/**
 * One agent: its state, its task, what it runs on, and `deriveState`'s own
 * clause — verbatim, because a second wording of it is a second state machine.
 */
export function fillAgentRow(node, task, view) {
  const [link] = node.children
  const [glyph, name, aside, runs, why] = link.children
  link.setAttribute('href', taskPath(task.id))
  markIn(glyph, rowMark(task))
  stateIn(link, task.state)
  textIn(name, task.name)
  const age = ageSaid(task.movedAt, view.asOf, view.frozen)
  textIn(aside, age ?? '')
  aside.setAttribute('aria-label', age === null ? 'never moved' : `moved ${age} ago`)
  textIn(runs, runsOn(task))
  textIn(why, task.reason)
  classOn(link, 'stalled', task.stalled)
  node.agentPresses?.update(task, view.may?.acts ?? {})
}

/**
 * Where an agent works and what it runs on, in the order you look for them:
 * its project, the harness with the account it signs in as, then the model.
 * A harness or model nobody wrote down is a dash — never left out, which
 * would read as the other being the whole answer; an account this device was
 * not granted is simply not said.
 */
export function runsOn(task) {
  const account = task.account?.words ?? null
  const harness = `${task.harness ?? '—'}${account === null ? '' : ` (${account})`}`
  return `${task.project} · ${harness} · ${task.model ?? '—'}`
}
