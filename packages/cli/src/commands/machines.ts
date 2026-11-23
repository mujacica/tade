import {
  defaultConfigPath,
  loadConfig,
  type MachineSeen,
  machineLabel,
  machinesSeenFrom,
  type RemoteConfig,
  type SyncState,
  seenSaid,
  syncSaid,
  tadeHome,
} from '@tade/core'
import { readJournal } from '@tade/workbench/events'
import { type CopyHeld, copiesHeld } from '@tade/workbench/feeds'
import { heldBy } from '@tade/workbench/lock'
import { readMachine } from '@tade/workbench/machine-file'
import { type LinkSeen, linksSeen } from '@tade/workbench/remotes'
import type { Command } from 'commander'
import { Exit, type Io } from '../io.ts'

// `tade machines` — every machine of the person's, as this one knows it: up,
// asleep, closed or lost and since when (`machine_seen`), where the two stand
// with their journals, notes and settings compared (`in step`, `behind by 3
// lines`, `1 conflict`), and how much of each one's journal is kept here,
// relayed ones included.
//
// **Files only**, as `tade remote status` is: the config, the journal's
// `machine_seen` and link lines, and what each copy keeps beside it
// (`feed.json`, `sync.json`). So it answers with the window open or closed and
// never opens the workbench; what it says is as of the last exchange, and says
// when that was.

/** One machine as the command says it. */
export interface FleetRow {
  /** Its name here: `remotes.<name>`, or what it calls itself. */
  name: string
  /** `to`: this machine links to it. `from`: it links to this one. `relayed`: only its journal is here. */
  way: 'to' | 'from' | 'relayed'
  id: string | null
  /** As last seen: the state and since when, in words. Null where it never was. */
  seen: string | null
  state: MachineSeen['state'] | null
  /** Where the link last stood, for a machine this one links to and has no state for. */
  link: string | null
  /** Where the two stand, in words, and as of when. Null where they were never compared. */
  synced: string | null
  sync: SyncState | null
  /** Lines of its journal kept here. */
  lines: number
  /** Copies of its journal set aside by a fork. */
  forks: number
}

/** A moment, as a terminal reads it: `2026-11-22 14:02`. */
function clock(at: number): string {
  return new Date(at).toISOString().slice(0, 16).replace('T', ' ')
}

/** How a link last stood, in the words a terminal gets. */
export function linkSaid(link: LinkSeen | null): string {
  if (link === null) return 'not linked yet'
  const at = link.at.slice(0, 16).replace('T', ' ')
  if (link.word === 'up') return `up since ${at}`
  if (link.word === 'ended') return `signed out there at ${at}: ${link.said}`
  return `down since ${at}${link.said === '' ? '' : `: ${link.said}`}`
}

/**
 * Every machine of the person's, folded from what this home holds: each it
 * links to, each that links to it, then each whose journal arrived only
 * through another. Pure but for nothing: the caller reads the files.
 */
export function fleetRows(
  remotes: Readonly<Record<string, RemoteConfig>>,
  seen: readonly MachineSeen[],
  links: ReadonlyMap<string, LinkSeen>,
  copies: readonly CopyHeld[],
  hereId: string | null,
): FleetRow[] {
  const used = new Set<string>()
  const copyFor = (match: (one: CopyHeld) => boolean): CopyHeld | null => {
    const found = copies.find((one) => !used.has(one.meta.machine) && match(one)) ?? null
    if (found !== null) used.add(found.meta.machine)
    return found
  }
  const rowOf = (
    name: string,
    way: FleetRow['way'],
    state: MachineSeen | null,
    copy: CopyHeld | null,
    link: LinkSeen | null,
  ): FleetRow => {
    const sync = copy?.sync?.state ?? null
    return {
      name,
      way,
      id: copy?.meta.machine ?? null,
      seen: state === null ? null : seenSaid(state, clock),
      state: state?.state ?? null,
      link: way === 'to' && state === null ? linkSaid(link) : null,
      synced: sync === null ? null : `${syncSaid(sync)} (as of ${clock(sync.at)})`,
      sync,
      lines: copy?.lines ?? 0,
      forks: copy?.meta.forks.length ?? 0,
    }
  }
  const rows: FleetRow[] = []
  for (const name of Object.keys(remotes).sort()) {
    const state = seen.find((one) => one.way === 'to' && one.machine === name) ?? null
    const copy = copyFor((one) => one.sync?.way === 'to' && one.sync.called === name)
    rows.push(rowOf(name, 'to', state, copy, links.get(name) ?? null))
  }
  for (const state of seen) {
    if (state.way !== 'from') continue
    // By what its link paired as, never what it calls itself: the two need not agree.
    const paired = (one: CopyHeld) => one.sync?.way === 'from' && one.sync.label === state.machine
    rows.push(rowOf(state.machine, 'from', state, copyFor(paired), null))
  }
  for (const copy of copies) {
    if (used.has(copy.meta.machine) || copy.meta.machine === hereId) continue
    const way = copy.sync?.way ?? 'relayed'
    rows.push(rowOf(copy.sync?.called ?? copy.meta.name, way, null, copy, null))
  }
  return rows
}

/** One row, in the words a terminal gets: `vps  up since 14:02 · in step · 1204 lines kept here`. */
export function rowSaid(row: FleetRow): string {
  const parts = [
    row.seen ?? row.link ?? (row.way === 'relayed' ? 'relayed through another machine' : null),
  ]
  parts.push(row.synced ?? (row.way === 'relayed' ? null : 'not compared yet'))
  if (row.lines > 0)
    parts.push(`${row.lines} journal ${row.lines === 1 ? 'line' : 'lines'} kept here`)
  if (row.forks > 0)
    parts.push(`${row.forks} ${row.forks === 1 ? 'copy' : 'copies'} set aside by a fork`)
  return `${row.name}  ${parts.filter((one) => one !== null).join(' · ')}`
}

/** Every machine as this home knows it, read from its files. */
export async function fleetOf(
  home: string,
  remotes: Readonly<Record<string, RemoteConfig>>,
): Promise<{ here: { name: string; id: string | null; epoch: string | null }; rows: FleetRow[] }> {
  const journal = await readJournal(home, {
    types: ['machine_seen', 'remote_linked', 'remote_unlinked'],
  })
  const machine = await readMachine(home)
  const rows = fleetRows(
    remotes,
    machinesSeenFrom(journal),
    linksSeen(journal),
    await copiesHeld(home),
    machine?.id ?? null,
  )
  return {
    here: { name: machineLabel(), id: machine?.id ?? null, epoch: machine?.epoch.id ?? null },
    rows,
  }
}

export function registerMachines(program: Command, io: Io, setExit: (code: number) => void): void {
  program
    .command('machines')
    .description(
      'Every machine of yours as this one knows it: up, asleep, closed or lost, whether the two are in step, and how much of its journal is kept here',
    )
    .option('--json', 'machine-readable output')
    .action(async (opts: { json?: boolean }) => {
      const path = defaultConfigPath()
      const loaded = await loadConfig(path)
      if (!loaded.ok) {
        io.err(`${path} could not be read: \`tade config --check\` says what is wrong with it`)
        setExit(Exit.error)
        return
      }
      const home = tadeHome()
      const window = (await heldBy(home)) !== null
      const fleet = await fleetOf(home, loaded.config.remotes)
      if (opts.json) {
        io.out(JSON.stringify({ window, ...fleet }, null, 2))
        return
      }
      const id =
        fleet.here.id === null
          ? 'no id yet: one is minted when Tade first opens here'
          : `id ${fleet.here.id}, journal epoch ${fleet.here.epoch}`
      io.out(`this machine  ${fleet.here.name}  ${id}`)
      if (fleet.rows.length === 0) {
        io.out('no other machines: `tade remote add <name> --ssh <host>` links one')
        return
      }
      for (const row of fleet.rows) io.out(rowSaid(row))
      if (!window) {
        io.out(
          'no window is open on this home, so nothing is exchanged now: what is above is as of the last time one was',
        )
      }
    })
}
