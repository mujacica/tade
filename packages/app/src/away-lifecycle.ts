import type { Lane, TadeEvent } from '@tade/core'
import type { AgentLane, Can, Cannot, ProjectIn } from '@tade/web'

// What the lifecycle verbs read, out of what the window already holds: where a
// task's agent lane stands, and what the journal says about where each project
// lives.
//
// **Pure**, like `away.ts` beside it — no `node:`, no clock, nothing to await —
// and for the reason that file gives: the facts a verb's revision is built from
// are the ones a test can build a table over. The same two functions answer the
// projection on a beat and the window's door at the act (`wire/web-lifecycle.ts`),
// so the row a device tapped and the re-check it meets are one reading of one
// thing, never two spellings of it.

/**
 * One project, as the journal's lines about where it lives say.
 *
 * `closedFrom` is the one value in this file that may never leave the machine:
 * it is where the project lived, written by the close that took it off the list,
 * and it is what opening it again puts back — so a device names a project, and
 * the folder comes from here.
 */
export interface ProjectLine {
  /** How many times `projects.<name>.root` was written: opened, moved or closed. */
  changes: number
  /** Where it lived when it last closed, or null while its last line opened it. */
  closedFrom: string | null
}

/** The path of the one setting that says where a project lives. */
const ROOT = /^projects\.([a-z0-9][a-z0-9-]*)\.root$/

/**
 * Whether a journal line wrote where a project lives: opened, moved or closed.
 *
 * What `Live` keeps of `config_changed` from the whole journal, because a
 * project closed last month is one a device can still open again and the last
 * five hundred events would have forgotten it.
 */
export function aboutRoot(event: TadeEvent): boolean {
  if (event.type !== 'config_changed') return false
  const path = (event.detail as { path?: unknown } | undefined)?.path
  return typeof path === 'string' && ROOT.test(path)
}

/**
 * Every project the journal has written a root for, newest line last.
 *
 * **A fold over `config_changed`, never a list kept beside it.** Opening a
 * project writes one with nothing as `was`; closing one writes one with nothing
 * as `now` and where it lived as `was` (`Projects.closeProject`). So the last
 * line for a name says whether it was closed and from where, and the count of
 * them is the project's generation — what tells a replayed close from a fresh
 * one after somebody opened it again. A line whose values are not strings is a
 * line somebody else wrote, and is counted but read as saying nothing.
 */
export function projectLines(events: readonly TadeEvent[]): Map<string, ProjectLine> {
  const out = new Map<string, ProjectLine>()
  for (const event of events) {
    if (event.type !== 'config_changed') continue
    const detail = (event.detail ?? {}) as Record<string, unknown>
    const name = typeof detail.path === 'string' ? ROOT.exec(detail.path)?.[1] : undefined
    if (name === undefined) continue
    const was = typeof detail.was === 'string' ? detail.was : ''
    const now = typeof detail.now === 'string' ? detail.now : null
    const before = out.get(name)?.changes ?? 0
    out.set(name, { changes: before + 1, closedFrom: now === '' && was !== '' ? was : null })
  }
  return out
}

/**
 * Where a task's own agent lane stands, out of the lanes status listed for it.
 *
 * **Its own lane, by id, and nothing else**: `<task>/agent`, the one name every
 * agent Tade runs is given. A terminal somebody opened beside it is another
 * lane and says nothing about the agent, and an adopted session is not a lane
 * at all — so neither can make a task look stoppable, or reopenable.
 */
export function agentLaneOf(task: {
  id: string
  lanes: readonly Pick<Lane, 'id' | 'alive'>[]
}): AgentLane {
  const lane = task.lanes.find((one) => one.id === `${task.id}/agent`)
  if (lane === undefined) return 'none'
  return lane.alive ? 'running' : 'stopped'
}

/**
 * What may be asked of a whole project: `ableOn`'s rule, one level up.
 *
 * Every project verb in exactly one of the two lists, with the reason beside
 * the one it cannot do — and **possible, never permitted**: the `projects`
 * scope and the setting are asked at the act.
 */
export function projectAble(open: boolean): { can: Can[]; cannot: Cannot[] } {
  return open
    ? {
        can: [{ verb: 'close', how: 'now' }],
        cannot: [{ verb: 'open', why: 'it is open' }],
      }
    : {
        can: [{ verb: 'open', how: 'now' }],
        cannot: [{ verb: 'close', why: 'it is already closed' }],
      }
}

/**
 * The projects the journal says were closed and are not open again: a name and
 * a count, and **never where they lived**, which stays in the journal for the
 * window's own door to read at the act.
 */
export function closedIn(
  lines: ReadonlyMap<string, ProjectLine>,
  open: ReadonlySet<string>,
): ProjectIn[] {
  const out: ProjectIn[] = []
  for (const [name, line] of lines) {
    if (line.closedFrom === null || open.has(name)) continue
    out.push({ name, title: '', open: false, changes: line.changes, ...projectAble(false) })
  }
  return out
}
