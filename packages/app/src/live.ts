import {
  type Config,
  historyFrom,
  type KnownTask,
  type WilcoEvent,
  type WorkHistory,
  type Workspace,
} from '@wilco/core'
import type { DaemonClient } from '@wilco/daemon/client'
import { livenessFrom } from '@wilco/daemon/lane-liveness'
import type { LaneRecord } from '@wilco/daemon/registry'
import type { PendingApproval } from '@wilco/daemon/workers'
import { collectStatus } from '@wilco/probes'
import type { TaskSnapshot } from './model.ts'

// Where the app gets its facts.
//
// Status is a query, so this polls rather than keeping its own idea of the
// world, and the journal it accumulates is what lets the resolver answer
// "which one did you mean".

/** How much journal to keep for working out what recently moved. */
const JOURNAL = 500

/**
 * Fold what status, the lane registry and the approval queue each know into
 * the one shape the window draws. Pure, because this mapping is the part that
 * decides what you see.
 */
export function snapshotsFrom(
  workspace: Workspace,
  pending: readonly PendingApproval[],
  lanes: readonly LaneRecord[],
): TaskSnapshot[] {
  const snapshots: TaskSnapshot[] = []
  for (const project of workspace.projects) {
    for (const task of project.tasks) {
      const lane =
        lanes.find(
          (record) => record.task === task.id && record.kind === 'agent' && record.alive,
        ) ?? lanes.find((record) => record.task === task.id && record.alive)
      snapshots.push({
        task: task.id,
        state: task.state,
        lane: lane?.id ?? null,
        waiting: pending.some((approval) => approval.task === task.id),
      })
    }
  }
  return snapshots.sort((a, b) => a.task.localeCompare(b.task))
}

/** The same tasks, as the resolver wants them. */
export function knownTasks(snapshots: readonly TaskSnapshot[]): KnownTask[] {
  return snapshots.map((snapshot) => ({
    id: snapshot.task,
    project: snapshot.task.split('/')[0] ?? snapshot.task,
    state: snapshot.state,
  }))
}

export interface LiveOptions {
  client: DaemonClient
  config: Config
  /** $HOME, for finding agent sessions started outside Wilco. */
  home: string
  cwd?: string
  pollMs?: number
  now?: () => number
  onTasks?: (tasks: TaskSnapshot[]) => void
  onEvent?: (event: WilcoEvent) => void
  onWarning?: (message: string) => void
}

export class Live {
  private readonly opts: LiveOptions
  private readonly journal: WilcoEvent[] = []
  private snapshots: TaskSnapshot[] = []
  /** Where each task lives on disk, which is what parking one needs. */
  private readonly worktrees = new Map<string, string>()
  private timer: NodeJS.Timeout | null = null
  private refreshing: Promise<void> | null = null

  private constructor(opts: LiveOptions) {
    this.opts = opts
  }

  static async start(opts: LiveOptions): Promise<Live> {
    const live = new Live(opts)
    // Recent history first, so "park it" works the moment the window opens.
    const past = await opts.client.events({ limit: JOURNAL }).catch(() => [])
    live.journal.push(...past)
    await opts.client.subscribe((event) => live.record(event))
    await live.refresh()
    live.timer = setInterval(() => void live.refresh(), opts.pollMs ?? 2_000)
    live.timer.unref?.()
    return live
  }

  get tasks(): TaskSnapshot[] {
    return this.snapshots
  }

  get history(): WorkHistory {
    return historyFrom(this.journal, this.now())
  }

  /** Where a task lives on disk, once status has seen it. */
  worktreeOf(task: string): string | null {
    return this.worktrees.get(task) ?? null
  }

  /** A rendered snapshot of a lane's screen, or nothing if it has none. */
  async capture(lane: string | null, lines: number): Promise<string> {
    if (!lane) return ''
    try {
      return await this.opts.client.capture(lane as never, lines)
    } catch {
      // A lane that just exited is not an error worth showing.
      return ''
    }
  }

  /** Ask everything again. Never throws: the window must keep drawing. */
  async refresh(): Promise<void> {
    this.refreshing ??= this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async doRefresh(): Promise<void> {
    try {
      const [workspace, pending, lanes] = await Promise.all([
        collectStatus({
          config: this.opts.config,
          now: this.now(),
          home: this.opts.home,
          pr: false,
          ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
          liveness: livenessFrom(this.opts.client),
        }),
        this.opts.client.pendingApprovals().catch(() => []),
        this.opts.client.lanes().catch(() => []),
      ])
      for (const warning of workspace.warnings) this.opts.onWarning?.(warning)
      for (const project of workspace.projects) {
        for (const task of project.tasks) this.worktrees.set(task.id, task.worktree)
      }
      this.snapshots = snapshotsFrom(workspace, pending, lanes)
      this.opts.onTasks?.(this.snapshots)
    } catch (err) {
      this.opts.onWarning?.(err instanceof Error ? err.message : String(err))
    }
  }

  private record(event: WilcoEvent): void {
    this.journal.push(event)
    if (this.journal.length > JOURNAL) this.journal.splice(0, this.journal.length - JOURNAL)
    this.opts.onEvent?.(event)
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
