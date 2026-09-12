import { basename } from 'node:path'
import type { AgentSignal, LivenessProbe, TaskId } from '@wilco/core'
import { DaemonClient } from './client.ts'
import { socketPath } from './protocol.ts'
import type { LaneRecord } from './registry.ts'

// Turns the daemon's lane registry into liveness signals for `wilco status`.

export function laneSignal(lane: LaneRecord): AgentSignal {
  return {
    source: 'lane',
    provider: basename(lane.spec.command),
    sessionId: lane.id,
    alive: lane.alive,
    lastActivityAt: lane.lastOutputAt ?? lane.startedAt,
    // A PTY lane cannot tell a running turn from a finished one; the agent
    // protocol adapter is what will know.
    turn: lane.alive ? 'unknown' : 'idle',
    pendingPermissions: [],
    consecutiveFailures: 0,
    exitCode: lane.exitCode,
  }
}

export function livenessFrom(client: DaemonClient): LivenessProbe {
  return {
    async lanes(task: TaskId): Promise<AgentSignal[]> {
      try {
        const lanes = await client.lanes(task)
        return lanes.filter((l) => l.kind === 'agent').map(laneSignal)
      } catch {
        return []
      }
    },
  }
}

/**
 * Connect to the daemon for lane liveness, or return null when none is
 * running. Callers must `close()` what they get.
 */
export async function laneLiveness(
  path = socketPath(),
): Promise<{ probe: LivenessProbe; close: () => Promise<void> } | null> {
  try {
    const client = await DaemonClient.connect(path)
    return { probe: livenessFrom(client), close: () => client.close() }
  } catch {
    return null
  }
}
