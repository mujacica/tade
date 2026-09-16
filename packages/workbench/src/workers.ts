import { randomUUID } from 'node:crypto'
import {
  type ApprovalSettings,
  decideApproval,
  type SandboxKind,
  type TaskId,
  type ThinkingLevel,
  type Tier,
} from '@wilco/core'
import {
  type PermissionDecision,
  PermissionNotPendingError,
  type RunId,
  type WorkerAdapter,
  type WorkerExtras,
  type WorkerHandle,
  type WorkerImage,
  type WorkerModel,
  WorkerNotFoundError,
  type WorkerSignal,
} from '@wilco/harnesses-core'
import { type AgentTurns, agentTurns, noReporter, type Reporter } from '@wilco/telemetry'
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
  /** What extensions add to it: instructions, tools, harness-native pieces. */
  extras?: WorkerExtras
  /** The harness it runs in; the default one unless said. */
  harness?: string
  /** How hard it thinks from its first turn; the harness's default unless said. */
  thinking?: ThinkingLevel
  /** Pictures to send with the opening prompt. */
  images?: readonly WorkerImage[]
}

/** An agent running one of Wilco's extension tools. */
export interface ExtensionCall {
  run: RunId
  task: TaskId
  /** Where it works, which is where the tool works on its behalf. */
  cwd: string
  tool: string
  input: Record<string, unknown>
  callId: string
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
  /** The adapter for the default harness. */
  adapter: WorkerAdapter
  /** Every harness's adapter, by id, for agents on another one. */
  adapters?: Readonly<Record<string, WorkerAdapter>>
  log: EventLog
  approvals: ApprovalSettings
  /** An agent said what its work is called. */
  onTitle?: (task: TaskId, worktree: string, title: string, named: boolean) => void
  /**
   * An agent called an extension tool. Whatever this answers — or the reason
   * it threw — goes back to the agent as the tool's result.
   */
  onExtensionCall?: (call: ExtensionCall) => Promise<string>
  /** Where Wilco's own trouble goes, and what times its agents' turns. */
  report?: Reporter
}

interface RunState {
  handle: WorkerHandle
  /** The harness this run is in, which answers everything said to it. */
  adapter: WorkerAdapter
  task: TaskId
  worktree: string
  stop: () => void
}

/** What an agent is running on right now, as it last said. Never journalled. */
export interface RunVitals {
  model: string | null
  /** How hard it is thinking, as the harness took the level it was given. */
  thinking: string | null
  contextTokens: number | null
  contextPercent: number | null
}

export class WorkerSupervisor {
  private readonly adapter: WorkerAdapter
  private readonly adapters: Readonly<Record<string, WorkerAdapter>>
  private readonly log: EventLog
  private readonly approvals: ApprovalSettings
  private readonly onTitle: WorkerSupervisorOptions['onTitle']
  private readonly onExtensionCall: WorkerSupervisorOptions['onExtensionCall']
  private readonly runs = new Map<string, RunState>()
  private readonly pendingApprovals = new Map<string, PendingApproval>()
  /** By task: what each agent last said about its model and context. */
  private readonly vitalsByTask = new Map<string, RunVitals>()
  /**
   * By run: whether the agent is in the middle of a turn, as it said. A lane
   * cannot tell — its screen changes either way — and an agent whose turn is
   * over looks, from outside, exactly like one that is thinking.
   */
  private readonly turns = new Map<string, 'running' | 'idle'>()
  /**
   * Hard-tier requests you have already refused, per run. Asking again for the
   * same thing is refused without troubling you; asking for something else is
   * new information and gets a fresh hearing.
   */
  private readonly refused = new Map<string, Set<string>>()

  /** Each agent's turn while it is in it, as the work of a model. */
  private readonly timing: AgentTurns

  constructor(opts: WorkerSupervisorOptions) {
    this.adapter = opts.adapter
    this.adapters = { [opts.adapter.id]: opts.adapter, ...opts.adapters }
    this.log = opts.log
    this.approvals = opts.approvals
    this.onTitle = opts.onTitle
    this.onExtensionCall = opts.onExtensionCall
    this.timing = agentTurns(opts.report ?? noReporter())
  }

  /**
   * Take charge of an agent that is about to start in a lane: open its channel,
   * subscribe, and record that it began. The lane itself is opened by whoever
   * called this, with `adapter.launchSpec()` — placing the process is the
   * driver's business, and supervising it is ours.
   */
  /**
   * Take charge of an agent that was already working when we opened.
   *
   * The same supervision, minus the claim that it started now: it did not, and
   * the journal already says when it did. Its extension is dialling for this
   * socket on a timer, so this is what lets an agent adopted from a closed
   * window be gated and steered again rather than only typed at.
   */
  async resume(request: StartRunRequest): Promise<WorkerHandle | null> {
    const run = request.run ?? ''
    if (!run || this.runs.has(run)) return null
    const adapter = this.harness(request.harness)
    const stop = adapter.onSignal(run, (signal) => {
      void this.onSignal(run, signal)
    })
    try {
      const handle = await adapter.supervise({
        run,
        task: request.task,
        cwd: request.cwd,
        prompt: '',
      })
      this.runs.set(run, { handle, adapter, task: request.task, worktree: request.cwd, stop })
      return handle
    } catch {
      // A channel we cannot open means an agent we cannot gate. It carries on
      // working either way, and the journal catches up from the session file.
      stop()
      return null
    }
  }

  async start(request: StartRunRequest): Promise<WorkerHandle> {
    const run = request.run ?? `r_${randomUUID().slice(0, 8)}`
    if (this.runs.has(run)) throw new Error(`run already exists: ${run}`)
    const worktree = request.worktree ?? request.cwd

    const adapter = this.harness(request.harness)
    // Subscribe before starting: the first signals arrive during start().
    const stop = adapter.onSignal(run, (signal) => {
      void this.onSignal(run, signal)
    })
    let handle: WorkerHandle
    try {
      handle = await adapter.supervise({
        run,
        task: request.task,
        cwd: request.cwd,
        prompt: request.prompt,
        ...(request.model ? { model: request.model } : {}),
        ...(request.thinking ? { thinking: request.thinking } : {}),
        ...(request.extras ? { extras: request.extras } : {}),
        ...(request.images ? { images: request.images } : {}),
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
    this.runs.set(run, { handle, adapter, task: request.task, worktree, stop })
    await this.log.append({
      type: 'run_started',
      task: request.task,
      run,
      detail: {
        cwd: request.cwd,
        adapter: adapter.id,
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
    await this.adapterOf(run).steer(run, message)
  }

  async queue(run: RunId, message: string): Promise<void> {
    this.require(run)
    await this.adapterOf(run).queue(run, message)
  }

  async setModel(run: RunId, model: WorkerModel): Promise<void> {
    this.require(run)
    await this.adapterOf(run).setModel(run, model)
  }

  async setThinking(run: RunId, level: ThinkingLevel): Promise<void> {
    this.require(run)
    await this.adapterOf(run).setThinking(run, level)
  }

  async name(run: RunId, title: string): Promise<void> {
    this.require(run)
    await this.adapterOf(run).name(run, title)
  }

  async prompt(run: RunId, message: string): Promise<void> {
    this.require(run)
    await this.adapterOf(run).prompt(run, message)
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
    await this.adapterOf(run).decide(run, requestId, decision)
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
    await this.adapterOf(run).abort(run)
  }

  async stop(run: RunId): Promise<void> {
    const state = this.runs.get(run)
    if (!state) return
    // A refusal is scoped to the run it was given in, so this drops that too.
    this.forget(run)
    await this.adapterOf(run).stop(run)
    await this.log.append({ type: 'run_exited', task: state.task, run, detail: { stopped: true } })
  }

  /**
   * An agent's process ended without anyone stopping it: a crash, `/quit`, a
   * lane closed from outside. An agent in a lane cannot say so itself — its
   * channel dies with it — so whoever watches the lane reports it here.
   * Nothing to do for a run already stopped or never seen.
   */
  async gone(run: RunId, code: number | null): Promise<void> {
    const state = this.runs.get(run)
    if (!state) return
    await this.ended(run, state.task, code)
  }

  private async ended(run: RunId, task: TaskId | null, code: number | null): Promise<void> {
    // An agent that has gone is waiting for nothing. Left in the list it would
    // count against `max_parallel` for ever and refuse its own restart; its
    // approvals would sit there looking like something needs you, keeping the
    // task `blocked` against an agent that cannot act on a yes.
    const adapter = this.adapterOf(run)
    this.forget(run)
    if (task) this.vitalsByTask.delete(task)
    // The harness holds the run too, and would refuse to supervise it again.
    // Its process is already gone, so stopping it only lets go.
    await adapter.stop(run).catch(() => {})
    await this.log.append({ type: 'run_exited', task, run, detail: { code } })
  }

  /** Close the window: let go of every agent, ending none of them. */
  async detach(): Promise<void> {
    for (const run of this.runs.values()) run.stop()
    this.runs.clear()
    this.turns.clear()
    this.pendingApprovals.clear()
    for (const adapter of Object.values(this.adapters)) await adapter.detach()
  }

  async shutdown(): Promise<void> {
    for (const run of [...this.runs.keys()]) await this.stop(run)
    for (const adapter of Object.values(this.adapters)) await adapter.shutdown()
  }

  /** A harness's adapter by id; the default one when none is named. */
  private harness(id: string | undefined): WorkerAdapter {
    if (!id) return this.adapter
    const adapter = this.adapters[id]
    if (!adapter)
      throw new Error(
        `no harness called ${id}: Wilco runs ${Object.keys(this.adapters).join(', ')}`,
      )
    return adapter
  }

  /** The adapter a run is in: what it was started with, or the default for one we never saw start. */
  private adapterOf(run: string): WorkerAdapter {
    return this.runs.get(run)?.adapter ?? this.adapter
  }

  /** Drop everything held on behalf of a run: it is not coming back. */
  private forget(run: RunId): void {
    for (const key of [...this.pendingApprovals.keys()]) {
      if (key.startsWith(`${run}:`)) this.pendingApprovals.delete(key)
    }
    this.refused.delete(run)
    this.timing.gone(run)
    const state = this.runs.get(run)
    state?.stop()
    this.runs.delete(run)
    this.turns.delete(run)
  }

  /** Whether an agent is in the middle of a turn: unknown until it has said. */
  turnOf(run: string): 'running' | 'idle' | 'unknown' {
    return this.turns.get(run) ?? 'unknown'
  }

  private async onSignal(run: RunId, signal: WorkerSignal): Promise<void> {
    const state = this.runs.get(run)
    const task = state?.task ?? null
    switch (signal.type) {
      case 'permission_request':
        await this.onPermissionRequest(run, signal, state)
        return
      case 'turn_done':
        this.timing.done(run, { status: signal.status, at: signal.at })
        await this.log.append({ type: 'turn_done', task, run, detail: { status: signal.status } })
        return
      case 'failed':
        await this.log.append({ type: 'failed', task, run, detail: { error: signal.error } })
        return
      case 'exited':
        await this.ended(run, task, signal.code)
        return
      case 'turn_started':
        this.turns.set(run, 'running')
        if (task) {
          this.timing.started(run, {
            task,
            model: this.vitalsByTask.get(task)?.model ?? null,
            harness: state?.adapter.id,
            at: signal.at,
          })
        }
        return
      case 'done':
        await this.log.append({
          type: 'task_done',
          task,
          run,
          detail: { by: 'agent', summary: signal.summary },
        })
        return
      case 'idle':
        this.turns.set(run, 'idle')
        return
      case 'started':
        // A session just opened has nothing in flight until it is given
        // something. A model changed mid-turn says `started` too, and must not
        // end the turn it happened in.
        if (!this.turns.has(run)) this.turns.set(run, 'idle')
        if (task) this.noteVitals(task, signal)
        return
      case 'context':
        if (task) this.noteVitals(task, signal)
        return
      case 'titled':
        if (state) this.onTitle?.(state.task, state.worktree, signal.title, signal.named)
        return
      case 'extension_call':
        await this.answerExtensionCall(run, signal, state)
        return
      case 'usage':
        if (task && signal.model) this.noteVitals(task, { type: 'started', model: signal.model })
        this.timing.usage(run, signal)
        // What the turn cost, as the harness priced it. The journal is where
        // spend is read back from, so it goes in whether or not anyone asked.
        await this.log.append({
          type: 'usage',
          task,
          run,
          detail: {
            model: signal.model,
            input: signal.input,
            output: signal.output,
            cacheRead: signal.cacheRead,
            cacheWrite: signal.cacheWrite,
            tokens: signal.tokens,
            usd: signal.usd,
          },
        })
        return
      // Timed, not written down: what an agent did inside a turn is the shape
      // of the turn, and the journal keeps what was decided about it instead.
      case 'tool_call':
        this.timing.tool(run, { callId: signal.callId, tool: signal.tool, at: signal.at })
        return
      case 'tool_result':
        this.timing.toolDone(run, { callId: signal.callId, ok: signal.ok, at: signal.at })
        return
      default:
        // Streamed messages are noise in the journal; tool calls are recorded
        // when they are decided.
        return
    }
  }

  /**
   * What an agent last said it is running on. Kept in memory, not the journal:
   * it is a reading, like a lane's screen, and a stale one is worse than none.
   */
  vitals(task: string): RunVitals | null {
    return this.vitalsByTask.get(task) ?? null
  }

  private noteVitals(
    task: string,
    signal:
      | { type: 'started'; model: string | null; thinking?: string | null }
      | { type: 'context'; tokens: number | null; percent: number | null },
  ): void {
    const was = this.vitalsByTask.get(task) ?? {
      model: null,
      thinking: null,
      contextTokens: null,
      contextPercent: null,
    }
    this.vitalsByTask.set(
      task,
      signal.type === 'started'
        ? { ...was, model: signal.model ?? was.model, thinking: signal.thinking ?? was.thinking }
        : { ...was, contextTokens: signal.tokens, contextPercent: signal.percent },
    )
  }

  /** Run the tool an agent asked for, and give it the answer whatever happens. */
  private async answerExtensionCall(
    run: RunId,
    signal: Extract<WorkerSignal, { type: 'extension_call' }>,
    state: RunState | undefined,
  ): Promise<void> {
    let result: { ok: boolean; text: string }
    if (!this.onExtensionCall || !state) {
      result = { ok: false, text: 'Wilco has no extension tools to run here' }
    } else {
      try {
        const text = await this.onExtensionCall({
          run,
          task: state.task,
          cwd: state.worktree,
          tool: signal.tool,
          input: signal.input,
          callId: signal.callId,
        })
        result = { ok: true, text }
      } catch (err) {
        result = { ok: false, text: err instanceof Error ? err.message : String(err) }
      }
    }
    await this.adapterOf(run)
      .answer(run, signal.callId, result)
      .catch(() => {})
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
      await this.adapterOf(run).decide(run, signal.requestId, {
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
      await this.adapterOf(run).decide(run, signal.requestId, { allow: true })
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
