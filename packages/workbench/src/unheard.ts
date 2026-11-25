import { lstat } from 'node:fs/promises'
import { WORKER_ENV } from '@tade/harnesses-core'
import type { LaneRecord } from './registry.ts'

// An agent working with nobody listening for it.
//
// Every Tade call an agent makes — `tade_done`, `checks_run`, a hook asking
// whether a command may run — goes over its run's socket, which the window
// listens on while it supervises the run. A lane alive with nobody listening is
// an agent that is still working and can reach nothing: each call answers
// "Tade isn't open", and the hooks that end a turn leave it beside the socket
// (`<socket>.missed`) for a window that never comes, because this one is open.
//
// On 2026-11-25 four agents moved to another account sat like that for over
// four hours and nobody was told: the lane looked busy, the agent said in its
// own pane that it could not report, and nothing anywhere else said a word.
// So the window looks, says so, and listens again (`Workbench.mendChannels`).

/** Why nobody is hearing an agent's lane. */
export type Unheard = 'unsupervised' | 'socket-gone'

/** One agent found unheard: its task, its lane, why, and whether its hooks have been leaving what they could not say. */
export interface UnheardLane {
  task: string
  lane: LaneRecord
  why: Unheard
  /** Its hooks found nobody and left what they had beside the socket: calls are being dropped. */
  missed: boolean
}

/**
 * Whether there is a socket at `path`: true, false, or null when it could not
 * be told — a look that could not look is not one that found nothing, so only
 * "it is not there" or "it is not a socket" is a socket gone.
 */
export async function socketAt(path: string): Promise<boolean | null> {
  try {
    return (await lstat(path)).isSocket()
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

/** Whether anything is at `path`: false only when nothing is, so a look that could not look never says calls were not dropped. */
async function present(path: string): Promise<boolean | null> {
  try {
    await lstat(path)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? false : null
  }
}

/**
 * The agent lanes alive with nobody listening: not supervised at all, or
 * supervised with the socket their lane was told to dial gone from the disk.
 * `supervised` is the supervisor's own answer, asked per lane.
 */
export async function unheardLanes(
  lanes: readonly LaneRecord[],
  supervised: (run: string) => boolean,
): Promise<UnheardLane[]> {
  const found: UnheardLane[] = []
  for (const lane of lanes) {
    if (lane.kind !== 'agent' || !lane.alive) continue
    const socket = lane.spec.env?.[WORKER_ENV.socket]
    let why: Unheard | null = null
    if (!supervised(lane.id)) why = 'unsupervised'
    else if (socket && (await socketAt(socket)) === false) why = 'socket-gone'
    if (!why) continue
    found.push({
      task: lane.task,
      lane,
      why,
      missed: socket ? (await present(`${socket}.missed`)) === true : false,
    })
  }
  return found
}

/**
 * Only what two looks in a row found: a stop and a start under the same lane
 * id — an account move, a harness change — leave a lane alive and unsupervised
 * for a moment, and mending that would race the start doing it properly.
 * `before` is the lane ids the last look found, and the lane's `startedAt` is
 * part of the key, so a lane started again since is a new lane.
 */
export function stillUnheard(
  found: readonly UnheardLane[],
  before: ReadonlySet<string>,
): { mend: UnheardLane[]; seen: Set<string> } {
  const seen = new Set(found.map(keyOf))
  return { mend: found.filter((one) => before.has(keyOf(one))), seen }
}

/** One unheard lane, as two looks recognise it: its id, which start of it, and why. */
export function keyOf(one: UnheardLane): string {
  return `${one.lane.id}@${one.lane.startedAt}#${one.why}`
}

/** What an unheard agent is, in the words its row and the orchestrator are given. */
export function unheardSaid(why: Unheard, missed: boolean): string {
  const what =
    why === 'unsupervised'
      ? 'its lane is working with nobody listening for it'
      : 'the socket its tool calls go to is gone'
  const dropped = missed ? ', and its hooks have been dropping what they had to say' : ''
  return `cannot reach Tade: ${what}, so every Tade call it makes is refused${dropped}`
}
