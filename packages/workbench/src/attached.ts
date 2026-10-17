import type { LaneRecord } from './registry.ts'

// Terminals that are another machine's agents: a lane here running the line
// that machine gave for one of its agents, over `ssh -t` or mosh
// (REMOTE-TADE.md §3.4) — what pressing enter on an agent there opens.
//
// A lane like any terminal: the driver runs it, the registry keeps it, the
// lower pane draws it, and under tmux it outlives the window. What makes one
// an attachment is its id, `remotes/<machine>/<n>` in a task `remotes/<machine>`.
// `remotes` is a name no project may have (checked where one is opened, as
// `chats` is), so none can ever be a repository's — and `terminalsFrom` lists
// none of them: the orchestrator's terminal tools type into shells here, and
// nothing gets into another machine's agent but a person at this one or that
// machine's own owner channel.
//
// Its title is the task there, which is how the one already open for an agent
// is put in front again rather than a second opened beside it.

/** The first segment of every attachment's lane id, and a project name nothing may use. */
export const ATTACHED = 'remotes'

/** An attachment, as the lower pane's tab and the window's search for one see it. */
export interface AttachedInfo {
  /** Its lane: `remotes/vps/1`. */
  id: string
  /** The machine it is a terminal to, as this one's config names it. */
  machine: string
  /** The task there whose agent it shows, as its title has it. */
  task: string
  startedAt: number
}

/** Whether this is an attachment's lane — `remotes/<machine>/<n>`. */
export function isAttachedLane(id: string): boolean {
  return /^remotes\/[a-z0-9][a-z0-9-]*\/\d+$/.test(id)
}

/** The live attachments among a registry's lanes, oldest first. */
export function attachedFrom(lanes: readonly LaneRecord[]): AttachedInfo[] {
  return lanes
    .filter((lane) => lane.alive && lane.kind === 'terminal' && isAttachedLane(lane.id))
    .map((lane) => ({
      id: lane.id,
      machine: lane.id.split('/')[1] ?? '',
      task: lane.title,
      startedAt: lane.startedAt,
    }))
    .sort((a, b) => a.startedAt - b.startedAt || a.id.localeCompare(b.id))
}

/** The attachment already open to this agent there, or null. */
export function attachedTo(
  lanes: readonly LaneRecord[],
  machine: string,
  task: string,
): AttachedInfo | null {
  return attachedFrom(lanes).find((one) => one.machine === machine && one.task === task) ?? null
}

/** The lane id the next attachment to a machine gets: the lowest number no live lane has. */
export function nextAttached(machine: string, lanes: readonly LaneRecord[]): string {
  const taken = new Set(lanes.filter((lane) => lane.alive).map((lane) => lane.id))
  for (let n = 1; ; n++) {
    const id = `${ATTACHED}/${machine}/${n}`
    if (!taken.has(id)) return id
  }
}
