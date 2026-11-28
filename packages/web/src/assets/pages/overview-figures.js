// The overview's figures: the four tiles, the agents waiting on you and the
// agents working, as pure folds over the store — so every count and every word
// on the page is a test rather than a picture (`test/overview.test.ts`).
//
// **Every machine at once.** The overview is the one screen the page has (§10
// T5 of the Duo plan), so it draws this machine and each other one whose copy
// this door holds, rather than a pick of them: a phone looking at the VPS sees
// the Mac's agent waiting too, marked with the Mac's name. What wants you and
// what works are counted only where a machine is up — one that is not said
// them at its last word — and the queue and what finished are counted from
// whatever each copy last said.
//
// **Nothing here derives a state.** A task wants you because the window's
// `markOf` said so (`wantsYou`), it is working because `deriveState` said so,
// queued work stands where `queueStateOf` put it, and it is finished because
// the journal says so (`finished`). This only counts what came off the wire,
// groups it the way the tiles draw it, and words it.
//
// Nothing here touches the DOM.

import { machineSaid, storesDrawn } from '../machines.js'
import { queuedHere, rowsOf, wantsYou } from '../store.js'

/** The most marks a tile draws one by one; past it the last place says how many more. */
export const DOTS = 10

/** Queued work's standings, in the order a reader asks about them. */
const QUEUE_KINDS = ['ready', 'waiting', 'held', 'scheduled', 'paused']

/** Each store drawn, this machine's first: `{ machine, store, up }`, `machine` `''` for this one. */
const everyStore = (store) => storesDrawn(store, null)

/**
 * Whether `at` is on the same day as `now`, in the reader's own zone. A day is
 * the reader's: *finished today* on a phone in Sarajevo is Sarajevo's today.
 */
export function sameDay(at, now) {
  if (typeof at !== 'string' || at === '') return false
  const was = new Date(Date.parse(at))
  const is = new Date(now)
  if (Number.isNaN(was.getTime()) || Number.isNaN(is.getTime())) return false
  return (
    was.getFullYear() === is.getFullYear() &&
    was.getMonth() === is.getMonth() &&
    was.getDate() === is.getDate()
  )
}

/**
 * The four tiles: what is working, what is waiting on you, what is queued, and
 * what finished today — each a figure, a mark per thing and the line that
 * breaks it down.
 *
 * *Finished today* is a task the journal says is finished whose last move was
 * on the reader's today: what the machines still hold, so work finished and
 * then removed before the page asked is not in it, and the line says *still
 * held* rather than claiming a day's total.
 */
export function tilesOf(store, now) {
  const drawn = everyStore(store)
  const live = drawn.filter((one) => one.up)

  const running = live.flatMap((one) => rowsOf(one.store, 'tasks'))
  const working = running.filter((task) => task.state === 'working')
  const stalled = working.filter((task) => task.stalled).length

  const wanting = live.flatMap((one) => wantsYou(one.store))
  const approvals = wanting.filter((task) => task.approval !== null && task.approval !== undefined)
  const questions = wanting.filter((task) => !approvals.includes(task) && task.question === true)
  const deciding = wanting.length - approvals.length - questions.length

  const queue = drawn.flatMap((one) => queuedHere(one.store))
  const kinds = Object.fromEntries(QUEUE_KINDS.map((kind) => [kind, 0]))
  for (const row of queue) {
    const kind = row.state?.kind
    if (kind in kinds) kinds[kind] += 1
  }

  const finished = drawn
    .flatMap((one) => rowsOf(one.store, 'tasks'))
    .filter((task) => task.finished === true && sameDay(task.movedAt, now))

  return {
    working: {
      n: working.length,
      under: stalled > 0 ? `${stalled} stalled` : working.length > 0 ? 'running' : 'idle',
      // A stalled agent is still one of the working, gone quiet: a hollow mark.
      dots: dotsOf([
        { n: working.length - stalled, tone: 'working' },
        { n: stalled, tone: 'working', hollow: true },
      ]),
    },
    wants: {
      n: wanting.length,
      under:
        partsSaid(
          [approvals.length, 'approval', 'approvals'],
          [questions.length, 'question', 'questions'],
          [deciding, 'to decide'],
        ) || 'nothing waiting',
      dots: dotsOf([{ n: wanting.length, tone: 'wants' }]),
    },
    queue: {
      n: queue.length,
      under: partsSaid(...QUEUE_KINDS.map((kind) => [kinds[kind], kind])) || 'empty',
      // Ready to start is a filled mark; anything still waiting on something is hollow.
      dots: dotsOf([
        { n: kinds.ready, tone: 'queued' },
        { n: queue.length - kinds.ready, tone: 'queued', hollow: true },
      ]),
    },
    finished: {
      n: finished.length,
      under: finished.length > 0 ? 'still held' : 'none yet',
      dots: dotsOf([{ n: finished.length, tone: 'done' }]),
    },
  }
}

/**
 * The agents waiting on you, on every machine that is up: this one's first in
 * its own order, then each other's by machine name. `machine` is `''` here.
 */
export function waitingOf(store) {
  return everyStore(store)
    .filter((one) => one.up)
    .flatMap((one) => wantsYou(one.store).map((task) => ({ machine: one.machine, task })))
}

/* ── every agent, by machine and project ───────────────────────────────────── */

/**
 * An agent's mark, in the order a reader asks about them: what wants you,
 * what works, what is idle with its session open, what failed — and then what
 * is resting: not running, set aside, finished.
 */
export const KINDS = ['needs-you', 'working', 'idle', 'failed', 'stopped', 'parked', 'done']

/** What each mark is called when it is counted: `3 working · 1 waiting on you`. */
export const KIND_WORDS = {
  'needs-you': 'waiting on you',
  working: 'working',
  idle: 'idle',
  failed: 'failed',
  stopped: 'stopped',
  parked: 'parked',
  done: 'finished',
}

/** The marks folded under their count in a project, opened by a press: nothing to look at now. */
export const RESTING = new Set(['stopped', 'parked', 'done'])

/**
 * `deriveState`'s state as a mark, for a row from a machine whose window
 * predates `mark` — `rowMark`'s own fallback in `glyphs.js`, by state.
 */
const STATE_KINDS = {
  working: 'working',
  blocked: 'needs-you',
  failed: 'failed',
  review: 'done',
  merged: 'done',
  parked: 'parked',
}

/** A row's mark: the window's own (`markOf`, carried on the row), never one decided here. */
export function kindOf(task) {
  if (Object.hasOwn(KIND_WORDS, task?.mark)) return task.mark
  if (task?.finished === true) return 'done'
  return STATE_KINDS[task?.state] ?? 'stopped'
}

/**
 * How many of `tasks` carry each mark, and the line that says it, leaving out
 * what is nought: `{ n, by: { working: 3, … }, said: '3 working · 1 stopped' }`.
 */
export function countsOf(tasks) {
  const by = Object.fromEntries(KINDS.map((kind) => [kind, 0]))
  for (const task of tasks) by[kindOf(task)] += 1
  return {
    n: tasks.length,
    by,
    said: partsSaid(...KINDS.map((kind) => [by[kind], KIND_WORDS[kind]])),
  }
}

/** When a row's state began, as a number, or null: `since`, else its last move, else when it was made. */
export function sinceAt(task) {
  for (const at of [task?.since, task?.movedAt, task?.createdAt]) {
    const was = typeof at === 'string' ? Date.parse(at) : Number.NaN
    if (!Number.isNaN(was)) return was
  }
  return null
}

/**
 * Every agent on every machine whose store this door holds, this machine's
 * first: per machine its counts and whether it is up (with the window's words
 * for one that is not), and per project, by name, its counts, the agents to
 * look at — waiting on you, working, idle, failed, the longest in that state
 * first — and the resting ones, the newest first.
 *
 * Queued work is not an agent yet: it is `queueOf`'s. A machine that is not up
 * is drawn as of its last word, never left out: its agents are still there.
 */
export function agentsOf(store) {
  return everyStore(store).map((one) => {
    const tasks = rowsOf(one.store, 'tasks').filter((task) => task.state !== 'queued')
    const byProject = new Map()
    for (const task of tasks) {
      const list = byProject.get(task.project) ?? []
      list.push(task)
      byProject.set(task.project, list)
    }
    const projects = [...byProject.keys()].sort(byName).map((project) => {
      const rows = byProject.get(project)
      const active = rows
        .filter((task) => !RESTING.has(kindOf(task)))
        .sort((a, b) => rank(a) - rank(b) || oldestFirst(a, b))
      const resting = rows
        .filter((task) => RESTING.has(kindOf(task)))
        .sort((a, b) => oldestFirst(b, a))
      return {
        project,
        counts: countsOf(rows),
        active,
        resting,
        restingSaid: countsOf(resting).said,
      }
    })
    const seen = one.machine === '' ? null : seenOf(store, one.machine)
    return {
      machine: one.machine,
      up: one.up,
      state: one.machine === '' ? 'up' : seen === null ? 'not seen' : machineSaid(seen),
      counts: countsOf(tasks),
      projects,
    }
  })
}

/** Every agent on every machine, counted once: the line under the section's heading. */
export function everyAgentCounted(machines) {
  return countsOf(
    machines.flatMap((one) => one.projects.flatMap((p) => [...p.active, ...p.resting])),
  )
}

const rank = (task) => KINDS.indexOf(kindOf(task))

/** The longer in its state first; a row with no moment after those with one; then by id. */
function oldestFirst(a, b) {
  const at = (task) => sinceAt(task) ?? Number.POSITIVE_INFINITY
  return at(a) - at(b) || byName(a.id, b.id)
}

const seenOf = (store, machine) =>
  (Array.isArray(store?.machines) ? store.machines : []).find((row) => row.name === machine) ?? null

/* ── the queue ──────────────────────────────────────────────────────────────── */

/** Queued work's standings in the order it will start: what is next first. */
const QUEUE_ORDER = ['ready', 'scheduled', 'waiting', 'held', 'paused', 'there']

/**
 * Every machine's queued work, what starts next first: each with its machine,
 * its row (where it stands, `queueStateOf`'s answer, and what it waits on with
 * why) and its task row where the store holds one. Within a standing, the
 * queue's own order (`queueIn`: a written preference, then by name).
 */
export function queueOf(store) {
  const all = everyStore(store).flatMap((one) =>
    queuedHere(one.store).map((row) => ({
      machine: one.machine,
      row,
      task: one.store?.rows?.tasks?.get(row.task) ?? null,
    })),
  )
  const at = (one) => {
    const placed = QUEUE_ORDER.indexOf(one.row.state?.kind)
    return placed === -1 ? QUEUE_ORDER.length : placed
  }
  return all
    .map((one, index) => ({ one, index }))
    .sort((a, b) => at(a.one) - at(b.one) || a.index - b.index)
    .map(({ one }) => one)
}

/**
 * One mark per thing, in the order the parts are given, and how many did not
 * fit: `{ dots: [{ tone, hollow }], more }`.
 *
 * Past `most` the last place is the count of the rest rather than a mark, so a
 * tile never grows a second line of dots and never pretends twelve is all.
 */
export function dotsOf(parts, most = DOTS) {
  const all = []
  for (const part of parts) {
    const n = Number.isFinite(part.n) ? Math.max(0, part.n) : 0
    for (let at = 0; at < n; at += 1) all.push({ tone: part.tone, hollow: part.hollow === true })
  }
  if (all.length <= most) return { dots: all, more: 0 }
  return { dots: all.slice(0, most - 1), more: all.length - (most - 1) }
}

/** `2 approvals · 1 question`, leaving out what is nought. */
export function partsSaid(...parts) {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : (many ?? one)}`)
    .join(' · ')
}

const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
