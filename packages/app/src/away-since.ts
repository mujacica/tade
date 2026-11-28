import { type TadeEvent, typeNow } from '@tade/core'

// How long an agent has been in the state a phone sees it in, out of the
// journal: the moment of the newest line that moves an agent between working,
// its turn over, and not running — a run starting, a turn starting or ending,
// its run or its agent's lane going.
//
// **A fold, never a stopwatch**: nothing here notices a state change between
// two beats and remembers when, which a restart would forget and a second
// window would answer differently. It reads the lines `RuntimeFold` already
// reads whole (`RUNTIME_EVENTS`), so an agent that went idle before a busy
// afternoon still says since when.
//
// What it cannot see it does not guess: a task with no such line answers
// `null`, and the page draws its last move instead. The other two moments a
// state begins at are already held elsewhere and are put beside this one by
// the beat (`sinceOf`): an approval's own moment and the `task_done` line.

/** The lines a state begins at, as `typeNow` names them. */
export const SINCE_LINES: ReadonlySet<string> = new Set([
  'run_started',
  'turn_started',
  'turn_done',
  'run_exited',
  'lane_exited',
])

/** By task, the newest moment one of its agent's states began. */
export class StateSince {
  private readonly at = new Map<string, number>()

  add(event: Pick<TadeEvent, 'type' | 'task' | 'lane' | 'ts'>): void {
    if (!event.task || !SINCE_LINES.has(typeNow(event.type))) return
    // A shell beside the agent going is not the agent's state moving: only
    // its own lane, `<task>/agent`, counts.
    if (typeNow(event.type) === 'lane_exited' && event.lane !== `${event.task}/agent`) return
    const at = Date.parse(event.ts)
    if (!Number.isFinite(at)) return
    const was = this.at.get(event.task)
    if (was === undefined || at > was) this.at.set(event.task, at)
  }

  of(task: string): number | null {
    return this.at.get(task) ?? null
  }
}

/**
 * When a task's state began: the newest of what the journal's lines say, an
 * approval waiting since, and the journal saying it is finished. Null where
 * none says anything.
 */
export function sinceOf(
  lines: number | null,
  approvalAt: number | null,
  finishedAt: string | null,
): number | null {
  const done = finishedAt === null ? Number.NaN : Date.parse(finishedAt)
  const known = [lines, approvalAt, done].filter(
    (at): at is number => at !== null && Number.isFinite(at),
  )
  return known.length === 0 ? null : Math.max(...known)
}
