import { basename } from 'node:path'
import type { AgentSignal, LivenessProbe, TaskId, WorkerHandle } from '@wilco/core'
import { DaemonClient } from './client.ts'
import { socketPath } from './protocol.ts'
import type { LaneRecord } from './registry.ts'
import type { PendingApproval } from './workers.ts'

// Turns what the daemon knows — lanes it opened and agents it supervises —
// into the liveness signals `wilco status` derives task state from.

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

/**
 * A supervised run. Approvals waiting on a human become pending permissions,
 * which is what turns a task `blocked` instead of leaving it looking busy.
 */
export function runSignal(handle: WorkerHandle, pending: PendingApproval[]): AgentSignal {
  const waiting = pending.filter((p) => p.run === handle.run)
  return {
    source: 'run',
    provider: 'pi',
    sessionId: handle.run,
    alive: true,
    lastActivityAt: waiting[0]?.at ?? handle.startedAt,
    turn: 'unknown',
    pendingPermissions: waiting.map((p) => p.summary),
    consecutiveFailures: 0,
    exitCode: null,
  }
}

export function livenessFrom(client: DaemonClient): LivenessProbe {
  return {
    async lanes(task: TaskId): Promise<AgentSignal[]> {
      // Status must never fail because the daemon is mid-restart. A request on
      // a disposed connection can throw synchronously as well as reject, so
      // both are swallowed here.
      const [lanes, runs, pending] = await Promise.all([
        safely(() => client.lanes(task), [] as LaneRecord[]),
        safely(() => client.runs(), [] as WorkerHandle[]),
        safely(() => client.pendingApprovals(task), [] as PendingApproval[]),
      ])
      return [
        ...lanes.filter((l) => l.kind === 'agent').map(laneSignal),
        ...runs.filter((r) => r.task === task).map((r) => runSignal(r, pending)),
      ]
    },
  }
}

async function safely<T>(call: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await call()
  } catch {
    return fallback
  }
}

/**
 * Connect to the daemon for liveness, or return null when none is running.
 * Callers must `close()` what they get.
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
