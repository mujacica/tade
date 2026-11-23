// The person's other machines, as the machine this page talks to has seen
// them (`machines` on the snapshot): which are up, and which closed, slept or
// went without a word — so a phone looking at the VPS is told the Mac is
// closed, and that the VPS carries on with its own work regardless.
//
// Pure: rows in, words out. The words are the window's own
// (`seenSaid` in `@tade/core`), held equal by `test/machines-client.test.ts`.

import { shortClockOf } from './figures.js'

/** Every machine, the ones that are not up first, then by name. */
export function machinesOf(store) {
  const rows = Array.isArray(store?.machines) ? store.machines : []
  return [...rows].sort(
    (a, b) =>
      Number(a.state === 'up') - Number(b.state === 'up') ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  )
}

/** One machine's state in words: `closed 14:02, said goodbye`. */
export function machineSaid(row) {
  const at = shortClockOf(row.since)
  if (row.state === 'up') return `up since ${at}`
  if (row.state === 'closed') return `closed ${at}, said goodbye`
  if (row.state === 'asleep') return `asleep since ${at}`
  return `lost ${at} — no goodbye: asleep, or off the network`
}

/** Which way it is linked, as a word under its name. */
export function machineWay(row) {
  return row.way === 'to' ? 'this machine links to it' : 'it links to this machine'
}

/**
 * What the person does about a machine that is not up, in a few words — or
 * null for one that is. A goodbye is Tade closed there; a sleep wakes on its
 * own; a silence is a machine off or off the network, and the link comes back
 * by itself once it answers.
 */
export function machineFix(row) {
  if (row.state === 'closed') return 'To fix: open Tade there — tade app, or tade serve'
  if (row.state === 'asleep') return 'To fix: wake it; its work carries on'
  if (row.state === 'lost') return 'To fix: check it is on and online; it relinks by itself'
  return null
}

/** The tone a state is drawn in: up is calm, a goodbye is quiet, a silence is a warning. */
export function machineTone(row) {
  if (row.state === 'up') return 't-done'
  if (row.state === 'lost') return 't-wants'
  return ''
}
