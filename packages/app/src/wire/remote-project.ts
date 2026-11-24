import { randomBytes } from 'node:crypto'
import type { RemoteLink } from '@tade/remotes-core'
import type { Machine, RemoteProject } from '../machines.ts'
import { type MenuItem, remoteProjectMenuItems } from '../panels/menu/state.ts'
import { saidOf } from './remote-agent.ts'

// A project's tab on another machine: its `×` and its `≡`, as a tab here has.
//
// **Closing it is that machine's own close**, asked at its door as its owner
// (`/api/act/close`, the window's own Close there, which deletes nothing and
// stops none of its agents), with what this window last saw of the project
// (`was`, its row's `rev`) and of the machine (`rev`), so a press against a
// screen gone stale is that machine's to refuse. Offered only where its row
// says close may be asked now (`can`); where it says not, its sentence is the
// reason. What it answered is said, in its words, as text.

/** The link holding a machine, and whether it is up. */
export type ReachThere = (machine: string) => { link: RemoteLink; live: boolean } | null

/** Whether that machine lets the project be closed now, and why not where it does not. */
export function closingThere(
  machine: Machine,
  project: RemoteProject,
): { ok: true } | { ok: false; why: string } {
  if (machine.link !== 'live') return { ok: false, why: `${machine.name} is not linked right now` }
  const no = project.cannot.find((one) => one.verb === 'close')
  if (no) return { ok: false, why: no.why }
  if (!project.can.includes('close') || project.rev === null || machine.rev === null) {
    return { ok: false, why: `${machine.name} has not said it may be closed from here` }
  }
  return { ok: true }
}

/** The `≡` of a project's tab on another machine: what it lets be done, and what cannot cross the link. */
export function remoteProjectItems(machine: Machine, project: RemoteProject): MenuItem[] {
  return remoteProjectMenuItems({
    machine: machine.name,
    live: machine.link === 'live',
    talks: machine.talk !== null,
    running: project.agents.filter((agent) => agent.mark === 'working').length,
    close: closingThere(machine, project),
  })
}

/**
 * Close a project on another machine, at its own door: what it said of it, as
 * the sentence to say — thrown with the reason where it was not done.
 */
export async function closeThere(
  reach: ReachThere,
  machine: Machine,
  project: RemoteProject,
): Promise<string> {
  const may = closingThere(machine, project)
  if (!may.ok) throw new Error(`${project.name} on ${machine.name}: ${may.why}`)
  const held = reach(machine.name)
  if (held === null || !held.live) throw new Error(`${machine.name} is not linked right now`)
  const answer = await held.link.request(machine.name, '/api/act/close', {
    project: project.name,
    was: project.rev,
    key: randomBytes(12).toString('base64url'),
    rev: machine.rev,
    confirm: true,
  })
  return saidOf(answer, machine.name, 'close')
}
