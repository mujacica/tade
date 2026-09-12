import { randomUUID } from 'node:crypto'
import {
  type ApprovalSettings,
  decideApproval,
  type PermissionDecision,
  PermissionNotPendingError,
  type RunId,
  type SandboxKind,
  type TaskId,
  type Tier,
  type WorkerAdapter,
  type WorkerHandle,
  type WorkerModel,
  WorkerNotFoundError,
  type WorkerSignal,
} from '@wilco/core'
import type { EventLog } from './events.ts'

// Runs agents and decides what they may do. Every tool call arrives here held;
// the approval policy answers it, and the log records what happened either
// way — including in bypass mode, where nothing is ever held up but the
// journal still knows a force push went through.

export interface StartRunRequest {
  task: TaskId
  cwd: string
  prompt: string
  run?: RunId
  model?: WorkerModel
  /**
   * Boundary for policy decisions: writes inside are routine, outside are not.
   * Defaults to `cwd`, which is the task's worktree in normal use.
   */
  worktree?: string
  /**
   * How to contain the worker. Comes from the task's route; `none` unless the
   * config asks for one.
   */
  sandbox?: SandboxKind
}

export interface PendingApproval {
  run: RunId
  task: TaskId
  requestId: string
  tool: string
  /** Exact enough to read back before approving. */
  summary: string
  tier: Tier
  rule: string
  reason: string
  at: number
}

export interface WorkerSupervisorOptions {
  adapter: WorkerAdapter
  log: EventLog
  approvals: ApprovalSettings
}

interface RunState {
  handle: WorkerHandle
  task: TaskId
  worktree: string
  stop: () => void
}

export class WorkerSupervisor {
  private readonly adapter: WorkerAdapter
  private readonly log: EventLog
  private readonly approvals: ApprovalSettings
  private readonly runs = new Map<string, RunState>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  /**
   * Hard-tier requests you have already refused, per run. Asking again for the
   * same thing is refused without troubling you; asking for something else is
   * new information and gets a fresh hearing.
   */
  private readonly refused = new Map<string, Set<string>>()

  constructor(opts: WorkerSupervisorOptions) {
    this.adapter = opts.adapter
    this.log = opts.log
    this.approvals = opts.approvals
  }

  async start(request: StartRunRequest): Promise<WorkerHandle> {
    const run = request.run ?? `r_${randomUUID().slice(0, 8)}`
    if (this.runs.has(run)) throw new Error(`run already exists: ${run}`)
    const worktree = request.worktree ?? request.cwd

    // Subscribe before starting: the first signals arrive during start().
    const stop = this.adapter.onSignal(run, (signal) => {
      void this.onSignal(run, signal)
    })
    let handle: WorkerHandle
    try {
      handle = await this.adapter.start({
        run,
        task: request.task,
        cwd: request.cwd,
        prompt: request.prompt,
        ...(request.model ? { model: request.model } : {}),
        // The worktree is both the policy boundary and the sandbox boundary:
        // the one place a worker is meant to be changing anything.
        ...(request.sandbox && request.sandbox !== 'none'
          ? { sandbox: { kind: request.sandbox, worktree } }
          : {}),
      })
    } catch (err) {
      stop()
      throw err
    }
    this.runs.set(run, { handle, task: request.task, worktree, stop })
    await this.log.append({
      type: 'run_started',
      task: request.task,
      run,
      detail: {
        cwd: request.cwd,
        adapter: this.adapter.id,
        model: request.model?.id ?? null,
        approvals: this.approvals.mode,
      },
    })
    return handle
  }

  list(): WorkerHandle[] {
    return [...this.runs.values()].map((r) => ({ ...r.handle }))
  }

  /** Approvals waiting on a human, newest last. */
  pending(task?: TaskId): PendingApproval[] {
    const all = [...this.pendingApprovals.values()]
    return (task ? all.filter((p) => p.task === task) : all).sort((a, b) => a.at - b.at)
  }

  async steer(run: RunId, message: string): Promise<void> {
    this.require(run)
    await this.adapter.steer(run, message)
  }

  async queue(run: RunId, message: string): Promise<void> {
    this.require(run)
    await this.adapter.queue(run, message)
  }

  async prompt(run: RunId, message: string): Promise<void> {
    this.require(run)
    await this.adapter.prompt(run, message)
  }

  /** Answer an approval a human was asked for. */
  async decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void> {
    const key = `${run}:${requestId}`
    const approval = this.pendingApprovals.get(key)
    if (!approval) throw new PermissionNotPendingError(requestId)
    this.pendingApprovals.delete(key)
    if (!decision.allow && approval.tier === 'hard') {
      const already = this.refused.get(run) ?? new Set<string>()
      already.add(signatureOf(approval.tool, approval.summary))
      this.refused.set(run, already)
    }
    await this.adapter.decide(run, requestId, decision)
    await this.log.append({
      type: decision.allow ? 'permission_granted' : 'permission_denied',
      task: approval.task,
      run,
      detail: {
        requestId,
        tool: approval.tool,
        summary: approval.summary,
        tier: approval.tier,
        rule: approval.rule,
        reason: decision.reason ?? '',
        // The ledger keeps what you said, not a paraphrase of it.
        said: decision.said ?? '',
      },
    })
  }

  async abort(run: RunId): Promise<void> {
    this.require(run)
    await this.adapter.abort(run)
  }

  async stop(run: RunId): Promise<void> {
    const state = this.runs.get(run)
    if (!state) return
    state.stop()
    this.runs.delete(run)
    for (const key of [...this.pendingApprovals.keys()]) {
      if (key.startsWith(`${run}:`)) this.pendingApprovals.delete(key)
    }
    // A refusal is scoped to the run it was given in.
    this.refused.delete(run)
    await this.adapter.stop(run)
    await this.log.append({ type: 'run_exited', task: state.task, run, detail: { stopped: true } })
  }

  async shutdown(): Promise<void> {
    for (const run of [...this.runs.keys()]) await this.stop(run)
    await this.adapter.shutdown()
  }

  private async onSignal(run: RunId, signal: WorkerSignal): Promise<void> {
    const state = this.runs.get(run)
    const task = state?.task ?? null
    switch (signal.type) {
      case 'permission_request':
        await this.onPermissionRequest(run, signal, state)
        return
      case 'turn_done':
        await this.log.append({ type: 'turn_done', task, run, detail: { status: signal.status } })
        return
      case 'failed':
        await this.log.append({ type: 'failed', task, run, detail: { error: signal.error } })
        return
      case 'exited':
        await this.log.append({ type: 'run_exited', task, run, detail: { code: signal.code } })
        return
      default:
        // Turn starts, streamed messages and tool results are noise in the
        // journal; tool calls are recorded when they are decided.
        return
    }
  }

  private async onPermissionRequest(
    run: RunId,
    signal: Extract<WorkerSignal, { type: 'permission_request' }>,
    state: RunState | undefined,
  ): Promise<void> {
    const task = state?.task ?? null
    const approval = decideApproval(
      { tool: signal.tool, input: signal.input, worktree: state?.worktree ?? null },
      this.approvals,
    )

    // Refused once in this run, refused again without asking. A "no" you have
    // to repeat every time the agent retries is not really a no — and being
    // asked the same destructive question four times is how people start
    // saying yes to make it stop.
    if (
      approval.tier === 'hard' &&
      this.refused.get(run)?.has(signatureOf(signal.tool, signal.summary))
    ) {
      await this.adapter.decide(run, signal.requestId, {
        allow: false,
        reason: 'already refused in this run',
      })
      await this.log.append({
        type: 'permission_denied',
        task,
        run,
        detail: {
          requestId: signal.requestId,
          tool: signal.tool,
          summary: signal.summary,
          tier: approval.tier,
          rule: approval.rule,
          reason: 'already refused in this run',
          repeated: true,
        },
      })
      return
    }

    if (approval.decision === 'allow') {
      await this.adapter.decide(run, signal.requestId, { allow: true })
      await this.log.append({
        type: 'tool_call',
        task,
        run,
        // A destructive command that ran without asking is still worth seeing
        // later, so it is logged above the routine noise.
        urgency: approval.tier === 'hard' ? 'notable' : 'routine',
        detail: {
          tool: signal.tool,
          summary: signal.summary,
          tier: approval.tier,
          rule: approval.rule,
          approved: 'automatically',
        },
      })
      return
    }

    const pending: PendingApproval = {
      run,
      task: task ?? '',
      requestId: signal.requestId,
      tool: signal.tool,
      summary: signal.summary,
      tier: approval.tier,
      rule: approval.rule,
      reason: approval.reason,
      at: signal.at,
    }
    this.pendingApprovals.set(`${run}:${signal.requestId}`, pending)
    await this.log.append({
      type: 'permission_request',
      task,
      run,
      detail: {
        requestId: signal.requestId,
        tool: signal.tool,
        summary: signal.summary,
        tier: approval.tier,
        rule: approval.rule,
        reason: approval.reason,
      },
    })
  }

  private require(run: RunId): RunState {
    const state = this.runs.get(run)
    if (!state) throw new WorkerNotFoundError(run)
    return state
  }
}

/**
 * What makes two requests the same request. A different command is new
 * information and gets asked about again; the identical one does not.
 */
function signatureOf(tool: string, summary: string): string {
  return `${tool} ${summary}`
}
