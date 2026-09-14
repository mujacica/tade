import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentSignal, Lane, LivenessProbe, TaskId, TurnState } from '@wilco/core'
import type { WorkerHandle } from '@wilco/harnesses-core'
import { LaneRecord } from './registry.ts'
import type { PendingApproval } from './workers.ts'

// Turns what Wilco is holding — lanes it opened, agents it supervises — into
// the liveness signals `wilco status` derives task state from.

export function laneSignal(lane: LaneRecord, turn: TurnState = 'unknown'): AgentSignal {
  return {
    source: 'lane',
    provider: basename(lane.spec.command),
    sessionId: lane.id,
    alive: lane.alive,
    lastActivityAt: lane.lastOutputAt ?? lane.startedAt,
    // A PTY lane cannot tell a running turn from a finished one — its screen
    // changes either way — so what the agent itself said decides, when it has.
    turn: lane.alive ? turn : 'idle',
    pendingPermissions: [],
    consecutiveFailures: 0,
    exitCode: lane.exitCode,
  }
}

/**
 * A supervised run. Approvals waiting on a human become pending permissions,
 * which is what turns a task `blocked` instead of leaving it looking busy.
 */
export function runSignal(
  handle: WorkerHandle,
  pending: PendingApproval[],
  turn: TurnState = 'unknown',
): AgentSignal {
  const waiting = pending.filter((p) => p.run === handle.run)
  return {
    source: 'run',
    provider: 'pi',
    sessionId: handle.run,
    alive: true,
    lastActivityAt: waiting[0]?.at ?? handle.startedAt,
    turn,
    pendingPermissions: waiting.map((p) => p.summary),
    consecutiveFailures: 0,
    exitCode: null,
  }
}

/** What a workbench can tell us about who is working. */
export interface RunningWork {
  lanes(task?: string): LaneRecord[]
  runs(): WorkerHandle[]
  pendingApprovals(task?: string): PendingApproval[]
  /** Whether a run is in the middle of a turn, as its agent said. */
  turnOf?(run: string): TurnState
}

export function livenessFrom(work: RunningWork): LivenessProbe {
  return {
    async lanes(task: TaskId): Promise<AgentSignal[]> {
      // Status never throws, so neither does this.
      const lanes = safely(() => work.lanes(task), [] as LaneRecord[])
      const runs = safely(() => work.runs(), [] as WorkerHandle[])
      const pending = safely(() => work.pendingApprovals(task), [] as PendingApproval[])
      // An agent's lane and its run are one agent: its id names both.
      const turn = (run: string) => safely(() => work.turnOf?.(run) ?? 'unknown', 'unknown')
      return [
        ...lanes.filter((l) => l.kind === 'agent').map((l) => laneSignal(l, turn(l.id))),
        ...runs.filter((r) => r.task === task).map((r) => runSignal(r, pending, turn(r.run))),
      ]
    },

    async records(task: TaskId): Promise<Lane[]> {
      return safely(() => work.lanes(task), [] as LaneRecord[]).map(asLane)
    },
  }
}

/**
 * Liveness for someone who is not holding the workbench — `wilco status` in
 * another terminal while the window is open.
 *
 * It reads the registry file and checks the pids, which is a different
 * question from the one `reconcile` asks and so takes different evidence: this
 * wants to know whether an agent is working, not whether we could drive it if
 * we tried. A running pid answers the first and not the second.
 */
export async function laneLivenessFromFile(home: string): Promise<LivenessProbe> {
  const lanes = await readLanes(join(home, 'lanes.json'))
  const live = lanes.map((lane) =>
    lane.alive && running(lane.pid) ? lane : { ...lane, alive: false },
  )
  const of = (task: TaskId) => live.filter((l) => l.task === task)
  return {
    async lanes(task: TaskId): Promise<AgentSignal[]> {
      return of(task)
        .filter((l) => l.kind === 'agent')
        .map((lane) => laneSignal(lane))
    },
    async records(task: TaskId): Promise<Lane[]> {
      return of(task).map(asLane)
    },
  }
}

function asLane(lane: LaneRecord): Lane {
  return {
    id: lane.id,
    kind: lane.kind,
    alive: lane.alive,
    pid: lane.pid,
    lastOutputAt: lane.lastOutputAt,
    // The escape hatch that works whatever the driver is.
    attach: `wilco attach ${lane.id}`,
  }
}

async function readLanes(path: string): Promise<LaneRecord[]> {
  try {
    const raw = JSON.parse(await readFile(path, 'utf8')) as { lanes?: unknown }
    // A registry file we cannot read is an empty one: status degrades, never
    // throws, and a half-written file is not worth a stack trace.
    return LaneRecord.array().safeParse(raw.lanes).data ?? []
  } catch {
    return []
  }
}

function running(pid: number | null): boolean {
  if (pid === null) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function safely<T>(call: () => T, fallback: T): T {
  try {
    return call()
  } catch {
    return fallback
  }
}
