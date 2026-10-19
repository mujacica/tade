// The agents: every one running. One of them looked into is `pages/agent-pane.js`.
//
// **Read-only, and the absences are the point.** Nothing here writes to an
// agent: there is no box that types into a lane, no key that reaches one, and
// no route a page could use for either. What a person on a phone may say to an
// agent goes through the verbs on the task screen (`steer`, a message into a
// conversation that is already running) or through Tade (`talk.js`, and the
// strip on a desk) — both of which already exist, are gated at the machine and
// are written down under the device's id.
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

import { classOn, el, empty, glyphOf, into, keyed, markIn, stateIn, textIn } from './dom.js'
import { ageSaid, count } from './figures.js'
import { rowMark, taskMark } from './glyphs.js'
import { taskPath } from './routes.js'
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
export function agentsScreen() {
  const node = el('div')
  const made = section('AGENTS', { top: true })
  const groups = el('div')
  const none = empty('no agent is running')
  into(made.body, groups, none)
  const rest = el('p', { class: 'unknown' })
  into(node, made.node, rest)
  return {
    node,
    update(view) {
      const agents = agentsOf(view.store)
      textIn(made.figure, count(agents.length))
      made.figure.setAttribute('aria-label', `${agents.length} agents running`)
      none.hidden = agents.length > 0
      keyed(
        groups,
        byProject(agents),
        (group) => group.project,
        createGroup,
        (one, group) => fillGroup(one, group, view),
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

function fillGroup(node, group, view) {
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
    createAgentRow,
    (one, task) => fillAgentRow(one, task, view),
  )
}

export function createAgentRow() {
  const node = el('li')
  const link = el('a', { attrs: { href: '/' } })
  const glyph = glyphOf(taskMark('working'))
  const name = el('span', { class: 'name' })
  const aside = el('span', { class: 'aside' })
  const runs = el('span', { class: 'under runs' })
  const why = el('span', { class: 'under' })
  into(link, glyph, name, aside, runs, why)
  into(node, link)
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
