// The person's other machines, as the machine this page talks to has seen
// them (`machines` on the snapshot): which are up, and which closed, slept or
// went without a word — so a phone looking at the VPS is told the Mac is
// closed, and that the VPS carries on with its own work regardless.
//
// Pure: rows in, words out. The words are the window's own
// (`seenSaid` in `@tade/core`), held equal by `test/machines-client.test.ts`.

import { shortClockOf } from './figures.js'
import { wantsYou } from './store.js'

/** Every machine, the ones that are not up first, then by name. */
export function machinesOf(store) {
  const rows = seenIn(store)
  return [...rows].sort(
    (a, b) =>
      Number(a.state === 'up') - Number(b.state === 'up') ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/** One machine's state in words: `closed 14:02, said goodbye`. */
export function machineSaid(row) {
  if (row.way === 'here') return 'up'
  const at = shortClockOf(row.since)
  if (row.state === 'up') return `up since ${at}`
  if (row.state === 'closed') return `closed ${at}, said goodbye`
  if (row.state === 'asleep') return `asleep since ${at}`
  return `lost ${at} — no goodbye: asleep, or off the network`
}

/** The tone a state is drawn in: up is calm, a goodbye is quiet, a silence is a warning. */
export function machineTone(row) {
  if (row.state === 'up') return 't-done'
  if (row.state === 'lost') return 't-wants'
  return ''
}

/**
 * Each machine's up or down, as the header draws it: the machine this page
 * talks to first — up while the page hears it (`live`), the one row nothing
 * on the snapshot can say — then every other one it has seen, in
 * `machinesOf`'s order. `{ key, name, up, said, short, tone }`: `short` is
 * what the header has room for — `lost 16:20` — and `said` the whole sentence,
 * which is its label.
 */
export function machinesUpOf(store, live) {
  const here = {
    key: '',
    name: 'This machine',
    up: live,
    said: live ? 'up' : 'not answering this page',
    short: live ? 'up' : 'not answering',
    tone: live ? 't-done' : 't-wants',
  }
  return [
    here,
    ...machinesOf(store).map((row) => ({
      key: `@${row.name}`,
      name: row.name,
      up: row.state === 'up',
      said: row.state === 'up' ? 'up' : machineSaid(row),
      short: row.state === 'up' ? 'up' : `${row.state} ${shortClockOf(row.since)}`,
      tone: machineTone(row),
    })),
  ]
}

/* ── every machine's rows on one page ──────────────────────────────────────── */

/** This machine, as a store's machine; another is its name. */
export const HERE = ''

/**
 * Each store the overview draws, this machine's first and then each other's
 * copy by name: `{ machine, store, up }`, this machine always up. `picked`
 * narrows it to one machine (`HERE` this one); `null` is every machine.
 */
export function storesDrawn(store, picked = null) {
  const up = new Set(
    seenIn(store)
      .filter((row) => row.state === 'up')
      .map((row) => row.name),
  )
  const copies = copiesIn(store)
  return [
    { machine: HERE, store, up: true },
    ...[...copies.keys()].sort(byName).map((machine) => ({
      machine,
      store: copies.get(machine),
      up: up.has(machine),
    })),
  ].filter((one) => picked === null || picked === one.machine)
}

/** What wants the person on every other machine that is up, in its own order, by machine name. */
export function wantsElsewhere(store) {
  return storesDrawn(store)
    .filter((one) => one.machine !== HERE && one.up)
    .flatMap((one) => wantsYou(one.store).map((task) => ({ machine: one.machine, task })))
}

/**
 * How many things want the person on every machine that is up, this one
 * included: the app icon's badge. It sits outside the page, so it counts what
 * the overview draws under *Waiting on you*, and a home screen never reads
 * calm while another machine is waiting.
 */
export function wantsAnywhere(store) {
  return wantsYou(store).length + wantsElsewhere(store).length
}

const copiesIn = (store) => (store?.copies instanceof Map ? store.copies : new Map())
const seenIn = (store) => (Array.isArray(store?.machines) ? store.machines : [])
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
