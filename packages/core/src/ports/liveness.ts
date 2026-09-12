import type { AgentSignal, TaskId } from '../model.ts'

// Liveness of lanes Wilco itself started. The daemon's lane registry is the
// only thing that knows them; without a daemon there are simply no lanes, and
// status falls back to git plus adopted sessions.

export interface LivenessProbe {
  lanes(task: TaskId): Promise<AgentSignal[]>
}

export const noLanes: LivenessProbe = {
  async lanes() {
    return []
  },
}
