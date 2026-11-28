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

import { storesDrawn } from '../machines.js'
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

/**
 * The agents working, on every machine that is up, the longest at it first —
 * the one somebody wonders about — and by name among equals.
 */
export function workingOf(store) {
  const at = (task) => {
    const moved = Date.parse(task.movedAt ?? task.createdAt ?? '')
    return Number.isNaN(moved) ? Number.POSITIVE_INFINITY : moved
  }
  return everyStore(store)
    .filter((one) => one.up)
    .flatMap((one) =>
      rowsOf(one.store, 'tasks')
        .filter((task) => task.state === 'working')
        .map((task) => ({ machine: one.machine, task })),
    )
    .sort((a, b) => at(a.task) - at(b.task) || (a.task.id < b.task.id ? -1 : 1))
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
function partsSaid(...parts) {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : (many ?? one)}`)
    .join(' · ')
}
