import type { Config } from './config.ts'
import { NOT_A_REMOTE } from './remotes.ts'

// Where queued work waits: here, or on the machine that never sleeps.
//
// A queue on a laptop is a queue that stops when the lid closes. So work queued
// for later goes to the hub — the machine `machine.hub` names, or the one remote
// this machine links to — whenever the hub has the project and nothing ties the
// work here, and the night's queue runs with the lid shut. It goes there as a
// take (`/api/take`), the same as "Start on vps": that machine then starts it by
// its own rule, so nothing ever has to take over a closed machine's work, which
// could not be done safely — a laptop starting offline would start it too.
//
// **Only work that waits.** Work that starts now starts where it was asked for,
// in front of whoever asked. **What ties work here** is said, never guessed: a
// project the hub does not have, a wait on work of this machine's that has not
// finished (what it builds on is commits here, which the hub cannot see until
// they are pushed), files only this machine holds, and a measurement of this
// machine (a race, a replay). The hub not linked now keeps it here too — sent
// nowhere, said.
//
// Pure: facts in, one answer and its reason out.

/** The hub, and why it is the one. */
export interface Hub {
  /** Its name here, `remotes.<name>`. */
  name: string
  why: string
}

/**
 * Which machine is the hub, as this machine's config says: `machine.hub`, or
 * the one remote where there is exactly one. Null for none — `here` said, no
 * remote, several and none named, or one named that is gone (`gone` says it).
 */
export function hubOf(config: Pick<Config, 'machine' | 'remotes'>): {
  hub: Hub | null
  gone?: string
} {
  const said = config.machine.hub
  const remotes = Object.keys(config.remotes)
  if (said === NOT_A_REMOTE) return { hub: null }
  if (said !== undefined) {
    if (remotes.includes(said)) return { hub: { name: said, why: 'machine.hub names it' } }
    return {
      hub: null,
      gone: `machine.hub names ${said}, which is not a remote here, so no queued work is sent anywhere`,
    }
  }
  const [only] = remotes
  if (remotes.length === 1 && only !== undefined) {
    return { hub: { name: only, why: 'it is the one machine this one links to' } }
  }
  return { hub: null }
}

/** What placing one piece of queued work is decided on. */
export interface PlaceFacts {
  hub: Hub | null
  /** What this machine calls itself in a sentence. */
  self: string
  /** Its link is up now. */
  hubUp: boolean
  /** The one project there that is this work's repository, or null. */
  projectThere: string | null
  /** It would start the moment it is made: nothing unfinished to wait on, and no later time. */
  startsNow: boolean
  /** Work of this machine's it waits on that has not finished. */
  waitsHere: readonly string[]
  /** It has files only this machine holds (attachments to its context). */
  filesHere: boolean
  /** A race's entrant or a replay. */
  measurement: boolean
}

/** Where it waits: here (with why, where there is anything to say) or on the hub. */
export type Placed = { on: null; why: string | null } | { on: string; project: string; why: string }

/** Where one piece of queued work should wait, and why. */
export function placeQueued(facts: PlaceFacts): Placed {
  const hub = facts.hub
  if (hub === null || facts.startsNow) return { on: null, why: null }
  const stays = (because: string) => ({ on: null, why: `stays on ${facts.self}: ${because}` })
  if (facts.measurement) return stays('it is a measurement of this machine')
  if (facts.projectThere === null) {
    return stays(`${hub.name} has no one project that is this repository`)
  }
  if (facts.waitsHere.length > 0) {
    const them = facts.waitsHere
    return stays(
      `it builds on ${them.join(', ')}, which ${them.length === 1 ? 'works' : 'work'} here`,
    )
  }
  if (facts.filesHere) return stays('it has files only this machine holds')
  if (!facts.hubUp) {
    return stays(`${hub.name} is not linked now, so it was not sent there`)
  }
  return {
    on: hub.name,
    project: facts.projectThere,
    why: `placed on ${hub.name} from ${facts.self}: it waits for later and nothing ties it to ${facts.self}, and ${hub.name} is the hub (${hub.why}), so closing the lid strands nothing`,
  }
}
