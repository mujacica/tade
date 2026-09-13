import type { AgentSignal, Lane, TaskId } from './model.ts'

// Liveness of lanes Wilco itself started. The daemon's lane registry is the
// only thing that knows them; without a daemon there are simply no lanes, and
// status falls back to git plus adopted sessions.

export interface LivenessProbe {
  lanes(task: TaskId): Promise<AgentSignal[]>
  /**
   * The lanes themselves, which status reports so you know what to attach to.
   * Optional because without a daemon there are none to report.
   */
  records?(task: TaskId): Promise<Lane[]>
}

export const noLanes: LivenessProbe = {
  async lanes() {
    return []
  },
}
