// What the right-hand side lists, as data: a project's agents in the window's
// order and its queue as the tree of what waits on what.
//
// Pure — no DOM, no clock — so `test/side-client.test.ts` holds the shape
// without a browser. `side.js` draws it.
//
// **The tree is the window's** (`treeStems` in the app's `plan-graph.ts`): a
// piece hangs under the queued work it waits on, so a chain reads top to
// bottom as the order it will run in, and work that can run side by side is
// side by side. The edges are the queue's own — each row's `waitsOn`, which is
// the `start.after` the rule reads — and nothing here decides whether a piece
// may start: its standing is `queueStateOf`'s, off the wire, and its words are
// `describeQueueState`'s (`queueSaid`).

import { joined } from './glyphs.js'

/** Siblings in the order the window draws them: what starts next, then what waits, then what will not start by itself. */
const STANDING = { ready: 0, waiting: 1, held: 2, scheduled: 3, paused: 4 }

/** A written `order` is only ever a preference among the ready, so a row without one goes after. */
const order = (row) => (row.order === null || row.order === undefined ? 1e9 : row.order)

const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

function sibling(a, b) {
  return (
    (STANDING[a.row.state.kind] ?? 9) - (STANDING[b.row.state.kind] ?? 9) ||
    order(a.row) - order(b.row) ||
    byText(a.row.task, b.row.task)
  )
}

/** Every task id a queued piece names as one it waits on: its edges, and its standing's own list. */
function waitsOn(row) {
  const named = (row.waitsOn ?? []).map((one) => one.task)
  if (row.state.kind === 'waiting') named.push(...row.state.on)
  if (row.state.kind === 'held' && typeof row.state.on === 'string') named.push(row.state.on)
  return [...new Set(named)]
}

/**
 * The queue as a forest: `{ row, depth, children }`, roots first.
 *
 * A piece's **depth** is the longest chain of queued work above it, and it
 * hangs under the deepest piece it waits on — so a piece that waits on two
 * things is drawn once, after both, and its own line says the other. Work it
 * waits on that is not queued (an agent already running) is a reason, not a
 * parent. A cycle is walked with a visited set and broken where it closes,
 * because these are files anybody can edit and a page may not hang on one.
 */
export function queueTree(rows) {
  const by = new Map(rows.map((row) => [row.task, row]))
  const depth = new Map()
  const depthOf = (id, seen) => {
    const known = depth.get(id)
    if (known !== undefined) return known
    if (seen.has(id)) return 0
    seen.add(id)
    let deepest = 0
    for (const one of waitsOn(by.get(id))) {
      if (by.has(one)) deepest = Math.max(deepest, depthOf(one, seen) + 1)
    }
    seen.delete(id)
    depth.set(id, deepest)
    return deepest
  }
  for (const row of rows) depthOf(row.task, new Set())

  const nodes = new Map(
    rows.map((row) => [row.task, { row, depth: depth.get(row.task) ?? 0, children: [] }]),
  )
  const roots = []
  for (const node of nodes.values()) {
    // Only ever under something shallower, which is what keeps a cycle in the
    // files from being a cycle in the drawing.
    const parents = waitsOn(node.row)
      .map((id) => nodes.get(id))
      .filter((one) => one !== undefined && one.depth < node.depth)
      .sort((a, b) => b.depth - a.depth || byText(a.row.task, b.row.task))
    const parent = parents[0]
    if (parent === undefined) roots.push(node)
    else parent.children.push(node)
  }
  const sorted = (list) => {
    list.sort(sibling)
    for (const one of list) sorted(one.children)
    return list
  }
  return sorted(roots)
}

/**
 * What a piece says at the end of its row, in a word or a time: the window's
 * right-hand column. Waiting work says nothing there — its line under the name
 * says what it waits on.
 */
export function queueAt(state, clock) {
  switch (state.kind) {
    case 'ready':
      return 'next'
    case 'held':
      return 'held'
    case 'scheduled':
      return clock(state.at)
    case 'paused':
      return state.parked ? 'parked' : 'paused'
    default:
      return ''
  }
}

/**
 * The line under a piece: `describeQueueState`'s words, with this project's own
 * name taken off the ids it names — the side is split by project, so
 * `tade/schema` under the `tade` heading is the heading said again. Ready work
 * has no line: its word at the end of the row is the whole of it.
 */
export function queueLine(state, project) {
  const mine = (id) => (id.startsWith(`${project}/`) ? id.slice(project.length + 1) : id)
  switch (state.kind) {
    case 'waiting':
      return `after ${joined(state.on.map(mine))}`
    case 'held':
      return `held: ${state.because}`
    case 'paused':
      return state.parked ? 'parked' : state.all ? 'paused with the queue' : 'paused'
    case 'scheduled':
      return 'waits for its time'
    default:
      return ''
  }
}

/** Whether every piece of a project's queue is paused because the whole queue is: one fact, said once at its heading. */
export function queuePaused(rows) {
  return rows.length > 0 && rows.every((row) => row.state.kind === 'paused' && row.state.all)
}

/**
 * A project's agents, as the window lists them down its side: every task that
 * has been started and is not queued or merged — finished ones included, with
 * their mark, as the window keeps them until somebody closes them — in the
 * order they were made, which is the window's own order until somebody drags
 * one. **Never sorted by state**: a list that reorders itself when an agent
 * finishes moves the row somebody was about to press.
 */
export function sideAgents(tasks) {
  return tasks
    .filter((task) => task.state !== 'queued' && task.state !== 'merged')
    .filter(
      (task) => !(task.state === 'parked' && (task.agents ?? 0) === 0 && (task.lanes ?? 0) === 0),
    )
    .sort((a, b) => byText(a.createdAt ?? '', b.createdAt ?? '') || byText(a.name, b.name))
}

/**
 * The agents grouped by the run (effort) they are part of, **only once there
 * are two** — the window's `groupedTasks`: with one run or none, a heading
 * says nothing the project's own does not. Work in no run comes last, under no
 * heading.
 */
export function agentGroups(agents) {
  const efforts = []
  for (const task of agents)
    if (task.effort && !efforts.includes(task.effort)) efforts.push(task.effort)
  if (efforts.length < 2) return [{ effort: null, agents }]
  const groups = efforts.map((effort) => ({
    effort,
    agents: agents.filter((task) => task.effort === effort),
  }))
  const rest = agents.filter((task) => !task.effort)
  return rest.length > 0 ? [...groups, { effort: null, agents: rest }] : groups
}

/** Which way each of the three docks stands: open unless somebody folded it. */
export const FOLDS = ['menu', 'side', 'tade']

/**
 * The folds read back from what this device kept, or every dock open.
 *
 * Kept as a word per dock rather than an object, so a value written by an
 * older page — or by hand — is read as *open* rather than thrown over.
 */
export function foldsFrom(kept) {
  const words = typeof kept === 'string' ? kept.split(',') : []
  return Object.fromEntries(FOLDS.map((one) => [one, words.includes(one)]))
}

/** The folds as the one string this device keeps. */
export function foldsTo(folds) {
  return FOLDS.filter((one) => folds[one] === true).join(',')
}
