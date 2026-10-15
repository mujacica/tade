import type { Wrote } from './conflicts.ts'
import type { AgentSignal, Lane, TaskId } from './model.ts'

// Liveness of lanes Tade itself started. The lane registry is the only thing
// that knows them; with nothing running there are simply no lanes, and
// status falls back to git plus adopted sessions.

export interface LivenessProbe {
  lanes(task: TaskId): Promise<AgentSignal[]>
  /**
   * The lanes themselves, which status reports so you know what to attach to.
   * Optional because with nothing running there are none to report.
   */
  records?(task: TaskId): Promise<Lane[]>
  /**
   * The files its agent's harness said it wrote, as the window watched it:
   * how a shared checkout's uncommitted hunks are told apart (`hunksFrom`).
   */
  wrote?(task: TaskId): Promise<Wrote[]>
}

export const noLanes: LivenessProbe = {
  async lanes() {
    return []
  },
}

/**
 * What a probe would answer about every task it knows, read once and written
 * down as plain data.
 *
 * Status is collected in a process of its own, and the lanes are the window's:
 * the child cannot ask the registry, so the window asks it before the look and
 * sends the answers along. A task with no entry has no lanes, which is what
 * the probe would have said about it.
 */
export type LivenessTable = Record<
  string,
  { lanes: AgentSignal[]; records: Lane[]; wrote?: Wrote[] }
>

/** A probe that answers out of a table: the same answers, asked again. */
export function livenessOf(table: LivenessTable): LivenessProbe {
  // Own keys only: a task id is never `constructor`, but a table read off a
  // pipe is not the place to find out.
  const of = (task: TaskId) => (Object.hasOwn(table, task) ? table[task] : undefined)
  return {
    async lanes(task) {
      return of(task)?.lanes ?? []
    },
    async records(task) {
      return of(task)?.records ?? []
    },
    async wrote(task) {
      return of(task)?.wrote ?? []
    },
  }
}
