// The person's other machines, as the machine this page talks to has seen
// them (`machines` on the snapshot): which are up, and which closed, slept or
// went without a word — so a phone looking at the VPS is told the Mac is
// closed, and that the VPS carries on with its own work regardless.
//
// Pure: rows in, words out. The words are the window's own
// (`seenSaid` in `@tade/core`), held equal by `test/machines-client.test.ts`.

import { shortClockOf } from './figures.js'
import { agentsOf, emptyStore, wantsYou } from './store.js'

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
  if (row.way === 'here') return 'up'
  const at = shortClockOf(row.since)
  if (row.state === 'up') return `up since ${at}`
  if (row.state === 'closed') return `closed ${at}, said goodbye`
  if (row.state === 'asleep') return `asleep since ${at}`
  return `lost ${at} — no goodbye: asleep, or off the network`
}

/** Which way it is linked, as a word under its name. */
export function machineWay(row) {
  if (row.way === 'here') return 'the one this page is talking to'
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

/* ── what each machine is doing ────────────────────────────────────────────── */

// Each machine's own figures (`host` on the snapshot for this one, on its row
// for the others): its processors, memory and disk, what Tade uses of it, and
// a trail for a sparkline. **What a machine cannot say is a dash, never
// nought**, and a machine that never said any — an older Tade there — says so
// in a line rather than three empty tiles. The words for sizes are the
// window's own (`megabytes` and `room` in `@tade/extension-resources`).

/** This machine, as the page draws it beside the others: first, and up while the page hears it. */
export function hereOf(store) {
  const host = store?.host
  if (host === null || typeof host !== 'object') return null
  return { name: 'This machine', way: 'here', state: 'up', since: null, host }
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value)

/** Bytes of memory as the window says them: `840 MB`, `22.1 GB`. */
export function megabytesSaid(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/** Bytes of disk as the window says them: `112 GB`, `5.0 GB`, `1.2 TB`. */
export function roomSaid(bytes) {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 10 * 1024 ** 3) return `${Math.round(bytes / 1024 ** 3)} GB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/** A share of a core or of a whole as the window says it: `91%`, `2.5%`. */
export function percentSaid(value) {
  return value >= 10 ? `${Math.round(value)}%` : `${value.toFixed(1)}%`
}

/** How worrying a share used is: past nine tenths tight, past three quarters warm. */
const pressureOf = (used) => (used >= 90 ? 'tight' : used >= 75 ? 'warm' : 'fine')

/**
 * A machine's figures in words, for its three tiles and its line about Tade —
 * or null where it has said none. Pure: a host in, words out.
 */
export function figuresOf(host) {
  if (host === null || typeof host !== 'object') return null
  const cpu = isNumber(host.cpu) ? host.cpu : null
  const memory =
    host.memory && isNumber(host.memory.used) && host.memory.total > 0 ? host.memory : null
  const disk = host.disk && isNumber(host.disk.free) && host.disk.total > 0 ? host.disk : null
  const memoryShare = memory ? (memory.used / memory.total) * 100 : null
  const diskUsed = disk ? 100 - (disk.free / disk.total) * 100 : null
  // Under a tenth free is the strip's warning too (`DISK_LOW`), and said in words.
  const diskLow = disk !== null && disk.free / disk.total < 0.1
  const cpuUnder = [
    isNumber(host.load) ? `load ${host.load.toFixed(2)}` : null,
    isNumber(host.cores) ? `${host.cores} ${host.cores === 1 ? 'core' : 'cores'}` : null,
  ].filter(Boolean)
  const tade = host.tade
  return {
    cpu: {
      label: 'CPU',
      said: cpu === null ? '—' : `${Math.round(cpu)}%`,
      under: cpuUnder.length > 0 ? cpuUnder.join(' · ') : 'cannot say',
      pressure: cpu === null ? 'fine' : pressureOf(cpu),
      trail: Array.isArray(host.trail?.cpu) ? host.trail.cpu : [],
    },
    memory: {
      label: 'Memory',
      said: memoryShare === null ? '—' : `${Math.round(memoryShare)}%`,
      under: memory
        ? `${megabytesSaid(memory.used)} of ${megabytesSaid(memory.total)}`
        : 'cannot say',
      pressure: memoryShare === null ? 'fine' : pressureOf(memoryShare),
      trail: Array.isArray(host.trail?.memory) ? host.trail.memory : [],
    },
    disk: {
      label: 'Disk',
      said: disk ? `${roomSaid(disk.free)} free` : '—',
      under: disk
        ? [
            `of ${roomSaid(disk.total)}`,
            disk.volumes > 1 ? `fullest of ${disk.volumes}` : null,
            diskLow ? 'running out' : null,
          ]
            .filter(Boolean)
            .join(' · ')
        : 'cannot say',
      pressure: disk === null ? 'fine' : diskLow ? 'tight' : diskUsed >= 80 ? 'warm' : 'fine',
      used: diskUsed,
    },
    tade:
      tade && isNumber(tade.cpu) && isNumber(tade.memory)
        ? `Tade and its agents: ${percentSaid(tade.cpu)} CPU · ${megabytesSaid(tade.memory)} · ${tade.processes} ${tade.processes === 1 ? 'process' : 'processes'}`
        : 'Tade and its agents: —',
    at: typeof host.at === 'string' ? host.at : null,
  }
}

/** What is said of a machine with no figures: why there are none. */
export function noFiguresSaid(row) {
  if (row.way === 'here') return 'Figures: — this machine has not looked yet'
  return 'Figures: — it has not said any; an older Tade there says none'
}

/** Under figures that are not current — a machine not up — when they were. */
export function figuresAsOf(row, figures) {
  if (row.state === 'up' || figures?.at == null) return null
  return `as of ${shortClockOf(figures.at)}, when it last said them`
}

/* ── what a machine that is not up was doing ──────────────────────────────── */

// A machine that is not up is drawn as of its last word, in words read off
// what it said of itself (`fresh.detach`), never *working* (add-away-surface).

/** Its agents that were working at its last word, out of its copy. */
export function wasWorking(copy) {
  const tasks = copy?.rows?.tasks
  if (!(tasks instanceof Map)) return []
  return [...tasks.values()].filter((task) => task.mark === 'working')
}

/** What became of an agent that was working there, in words — or null where the machine is up. */
export function wasDoingSaid(row, copy) {
  if (row.state === 'up' || copy == null) return null
  const at = shortClockOf(row.since)
  const outlives = copy.fresh?.detach
  if (outlives === false) {
    return `stopped with the window, ${at} — reopens when ${row.name}’s window opens`
  }
  if (outlives === true) return `was working at ${at}; may have moved on`
  return `was working at ${at}, as of its last word`
}

/** The card's one line about its work: `closed 14:02 · 3 agents were working` — or null where it is up. */
export function lastWordSaid(row, copy) {
  if (row.state === 'up' || copy == null) return null
  const state = stateWord(row)
  const n = wasWorking(copy).length
  if (n === 0) return `${state} · nothing was working`
  const agents = n === 1 ? '1 agent was working' : `${n} agents were working`
  const outlives = copy.fresh?.detach
  if (outlives === false) return `${state} · ${agents}; they reopen when its window opens`
  if (outlives === true) return `${state} · ${agents}; they may have moved on`
  return `${state} · ${agents}`
}

/* ── every other machine's agents ──────────────────────────────────────────── */

/** Each other machine with an agent in its copy, by name — out of its own store, never one merged list. */
export function agentsElsewhere(store) {
  const seen = new Map(seenIn(store).map((row) => [row.name, row]))
  const out = []
  for (const [machine, copy] of copiesIn(store)) {
    const agents = agentsOf(copy)
    if (agents.length === 0) continue
    const row = seen.get(machine) ?? null
    const up = row?.state === 'up'
    const at = typeof copy.fresh?.at === 'string' ? Date.parse(copy.fresh.at) : Number.NaN
    out.push({
      machine,
      up,
      asOf: Number.isNaN(at) ? null : at,
      said: up
        ? null
        : row === null
          ? `as of ${shortClockOf(copy.fresh?.at ?? null)}`
          : lastWordSaid(row, copy),
      working: up || row === null ? null : wasDoingSaid(row, copy),
      agents,
    })
  }
  return out.sort((a, b) => byName(a.machine, b.machine))
}

/** What wants the person on every other machine that is up, in its own order, by machine name. */
export function wantsElsewhere(store) {
  const up = new Set(
    seenIn(store)
      .filter((row) => row.state === 'up')
      .map((row) => row.name),
  )
  return [...copiesIn(store)]
    .filter(([machine]) => up.has(machine))
    .sort(([a], [b]) => byName(a, b))
    .flatMap(([machine, copy]) => wantsYou(copy).map((task) => ({ machine, task })))
}

/* ── one other machine's screen ───────────────────────────────────────────── */

/** What `/m/<machine>/…` is drawn from: its copy, its clock, whether it is up, and the line over it. */
export function thereOf(store, machine, live, now) {
  const copy = copiesIn(store).get(machine) ?? null
  const row = seenIn(store).find((one) => one.name === machine) ?? null
  const up = row?.state === 'up'
  if (copy === null) {
    const none = emptyStore()
    none.had = store?.had === true
    return {
      store: none,
      asOf: now,
      frozen: false,
      up,
      line: `${machine} · nothing of it is held here — it was never heard, or this device is not sent the other machines`,
    }
  }
  const said = typeof copy.fresh?.at === 'string' ? Date.parse(copy.fresh.at) : Number.NaN
  const running = up && live
  const asOf = running || Number.isNaN(said) ? now : said
  const as = Number.isNaN(said) ? '' : ` · as of ${shortClockOf(copy.fresh.at)}`
  const state = row === null ? null : stateWord(row)
  const line = `${machine}${state === null ? '' : ` · ${state}`}${running ? '' : as}`
  return { store: copy, asOf, frozen: !running && !Number.isNaN(said), up, line }
}

/** A machine's state in two or three words: `closed 14:02`. */
function stateWord(row) {
  const at = shortClockOf(row.since)
  if (row.state === 'up') return `up since ${at}`
  if (row.state === 'asleep') return `asleep since ${at}`
  return `${row.state} ${at}`
}

const copiesIn = (store) => (store?.copies instanceof Map ? store.copies : new Map())
const seenIn = (store) => (Array.isArray(store?.machines) ? store.machines : [])
const byName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
