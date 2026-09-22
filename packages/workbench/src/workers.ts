import { randomUUID } from 'node:crypto'
import {
  type Approval,
  type ApprovalSettings,
  type Caution,
  decideApproval,
  modelDetail,
  modelIdentity,
  type SandboxKind,
  type TaskId,
  type ThinkingLevel,
  type Tier,
  withCaution,
} from '@tade/core'
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
} from '@tade/harnesses-core'
import { type AgentTurns, agentTurns, noReporter, type Reporter } from '@tade/telemetry'
import type { EventLog } from './events.ts'
import { adapterParts } from './harnesses.ts'

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
  /** The harness it runs in — `harness@account` for an account's — the default one unless said. */
  harness?: string
  /** The account it runs as, when not its harness's own sign-in. */
  account?: string
  /** How hard it thinks from its first turn; the harness's default unless said. */
  thinking?: ThinkingLevel
  /** Pictures to send with the opening prompt. */
  images?: readonly WorkerImage[]
}

/** An agent running one of Tade's extension tools. */
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
  /** Where Tade's own trouble goes, and what times its agents' turns. */
  report?: Reporter
  /**
   * The checks rule, asked about a call the policy would otherwise let
   * through: a push with nothing green behind it comes back refused, with
   * what is missing. Absent means no rule, which is what a window without a
   * config has.
   */
  checks?: (call: {
    task: string | null
    project: string | null
    worktree: string
    tool: string
    input: Readonly<Record<string, unknown>>
  }) => Promise<{ allow: true; note?: string } | { allow: false; reason: string }>
  /**
   * A second reading of a command the rules did not name, asked with the agent
   * held at it. It may only ever come back stricter, and it is given a
   * deadline by whoever answers it: nothing here waits on it twice, and a run
   * that goes away while it is being asked is answered as if nobody read it.
   * Absent means nobody reads them, which is what Tade does on its own.
   */
  caution?: (call: {
    task: string
    project: string
    worktree: string
    tool: string
    command: string
    input: Readonly<Record<string, unknown>>
    decided: { tier: Tier; rule: string; reason: string }
    signal: AbortSignal
  }) => Promise<{ caution: Caution | null; problems: readonly string[] }>
}

interface RunState {
  handle: WorkerHandle
  /** The harness this run is in, which answers everything said to it. */
  adapter: WorkerAdapter
  task: TaskId
  worktree: string
  /**
   * Which sign-in and provider this run is on. Kept beside the adapter because
   * an adapter is made per account and does not carry either in its id — and
   * the Spend page's harness, account and provider facets are folds over what
   * the journal was told, so a fact not written down at the time is a facet
   * that can only ever say *not recorded* about the work already done.
   */
  facts: { harness: string; account: string | null; provider: string | null }
  /**
   * The model it last said it was on, by its own name — so `run_model` is
   * written when that changes and not once a turn. Null until anybody has
   * said, which is what a run started with no model asked for looks like.
   */
  model: string | null
  stop: () => void
}

/**
 * What an agent has been doing lately, as the window watched it happen.
 *
 * Kept in memory and nowhere else, like a lane's screen: it is a reading, and
 * a stale one is worse than none. The journal holds what was *decided* about a
 * tool call; what an agent did inside a turn is the shape of the turn, and
 * writing every step of it down would be the log becoming the transcript.
 */
export interface Doing {
  at: number
  tool: string
  /** What it was about, short and the same every time it is the same call. */
  about: string
  /** Whether it worked; null while it is still running. */
  ok: boolean | null
}

/** How a turn ended, as its harness said. */
export interface TurnEnd {
  at: number
  status: 'ok' | 'error' | 'aborted'
}

/** How much of one agent's recent doing is kept: enough to see a loop in it. */
const KEPT_DOING = 40
const KEPT_TURNS = 12

/**
 * What a tool call was about, in one line that is the same every time the same
 * call is made — which is what makes a repeat countable without reading it.
 */
export function aboutToolCall(input: unknown): string {
  const said = (input ?? {}) as Record<string, unknown>
  for (const key of ['command', 'script', 'cmd', 'path', 'file_path', 'filePath', 'file']) {
    const value = said[key]
    if (typeof value === 'string' && value.length > 0) return short(value)
  }
  const pattern = said.pattern ?? said.query
  if (typeof pattern === 'string' && pattern.length > 0) return short(pattern)
  return short(JSON.stringify(clipped(input)))
}

function short(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > 160 ? `${flat.slice(0, 159)}…` : flat
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
  /** By harness, and by `harness@account` for an account other than a harness's own. */
  private readonly adapters: Record<string, WorkerAdapter>
  private readonly log: EventLog
  private readonly approvals: ApprovalSettings
  private readonly onTitle: WorkerSupervisorOptions['onTitle']
  private readonly onExtensionCall: WorkerSupervisorOptions['onExtensionCall']
  private readonly checks: WorkerSupervisorOptions['checks']
  private readonly askCaution: WorkerSupervisorOptions['caution']
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
   * By run: the last things each agent did, and how its last turns ended.
   * Bounded, because a window is open for days and an agent that is fine is
   * the ordinary case: what is kept is what a loop would show up in.
   */
  private readonly doing = new Map<string, { did: Doing[]; ends: TurnEnd[] }>()
  /** Calls still running, so an answer can find what it answers. */
  private readonly calls = new Map<string, Doing>()
  /**
   * Hard-tier requests you have already refused, per run. Asking again for the
   * same thing is refused without troubling you; asking for something else is
   * new information and gets a fresh hearing.
   */
  private readonly refused = new Map<string, Set<string>>()
  /**
   * A second reading in flight, per run: an agent that has gone is not worth
   * finishing a reading about, and whatever is answering is told to stop.
   */
  private readonly reading = new Map<string, Set<AbortController>>()
  /**
   * What went wrong asking for a second reading, per run, said once. A gate
   * that has stopped reading must be said — and saying it at every command an
   * agent runs is how people learn to scroll past it.
   */
  private readonly saidAbout = new Map<string, Set<string>>()

  /** Each agent's turn while it is in it, as the work of a model. */
  private readonly timing: AgentTurns

  constructor(opts: WorkerSupervisorOptions) {
    this.adapter = opts.adapter
    this.adapters = { [opts.adapter.id]: opts.adapter, ...opts.adapters }
    this.log = opts.log
    this.approvals = opts.approvals
    this.onTitle = opts.onTitle
    this.onExtensionCall = opts.onExtensionCall
    this.checks = opts.checks
    this.askCaution = opts.caution
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
      this.runs.set(run, {
        handle,
        adapter,
        task: request.task,
        worktree: request.cwd,
        facts: factsOf(request, adapter.id),
        model: modelAsked(request),
        stop,
      })
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
    const facts = factsOf(request, adapter.id)
    this.runs.set(run, {
      handle,
      adapter,
      task: request.task,
      worktree,
      facts,
      model: modelAsked(request),
      stop,
    })
    await this.log.append({
      type: 'run_started',
      task: request.task,
      run,
      detail: {
        cwd: request.cwd,
        adapter: adapter.id,
        // The model by its own name, and the spelling that reaches it again
        // where they differ — written exactly as `usage` and `run_model`
        // write it, because a run timed under one spelling and priced under
        // another is one agent drawn as two models that never ran together.
        // Nothing at all when nothing was asked for: pi picks by what you are
        // signed in to, and what it picked arrives as `run_model`.
        ...modelDetail(request.model?.id),
        // Which sign-in and which provider, beside which harness: three rows
        // that are one model reached three ways are only ever told apart by
        // these, and a model id is not one of them — `anthropic/claude-opus-5`
        // through OpenRouter is a real route, and reading the provider out of
        // the name would file it under Anthropic and be sure about it.
        account: facts.account,
        provider: facts.provider,
        approvals: this.approvals.mode,
      },
    })
    return handle
  }

  list(): WorkerHandle[] {
    return [...this.runs.values()].map((r) => ({ ...r.handle, harness: r.adapter.id }))
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

  /**
   * Answer runs of another account too: an adapter made for it once somebody
   * starts an agent on it, under `harness@account`.
   */
  add(key: string, adapter: WorkerAdapter): void {
    this.adapters[key] = adapter
  }

  /** A harness's adapter by id; the default one when none is named. */
  private harness(id: string | undefined): WorkerAdapter {
    if (!id) return this.adapter
    const adapter = this.adapters[id]
    if (!adapter)
      throw new Error(`no harness called ${id}: Tade runs ${Object.keys(this.adapters).join(', ')}`)
    return adapter
  }

  /** The adapter a run is in: what it was started with, or the default for one we never saw start. */
  adapterOf(run: string): WorkerAdapter {
    return this.runs.get(run)?.adapter ?? this.adapter
  }

  /** Drop everything held on behalf of a run: it is not coming back. */
  private forget(run: RunId): void {
    for (const key of [...this.pendingApprovals.keys()]) {
      if (key.startsWith(`${run}:`)) this.pendingApprovals.delete(key)
    }
    this.refused.delete(run)
    for (const controller of this.reading.get(run) ?? []) controller.abort()
    this.reading.delete(run)
    this.saidAbout.delete(run)
    this.timing.gone(run)
    this.doing.delete(run)
    for (const key of [...this.calls.keys()]) if (key.startsWith(`${run}:`)) this.calls.delete(key)
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
      case 'turn_done': {
        const kept = this.kept(run)
        kept.ends.push({ at: signal.at, status: signal.status })
        if (kept.ends.length > KEPT_TURNS) kept.ends.shift()
        this.timing.done(run, { status: signal.status, at: signal.at })
        await this.log.append({ type: 'turn_done', task, run, detail: { status: signal.status } })
        return
      }
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
        // And this is where a run that was started with no model asked for
        // finally has one: before its first turn, and before anything it does
        // could ever have cost money.
        await this.noteModel(run, state, signal.model)
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
        // Before anything is awaited: the turn this belongs to ends in the
        // signal after it, and a span that has already closed takes no tokens.
        this.timing.usage(run, signal)
        // A harness that says what a turn cost without ever having said what
        // it opened on still says which model it is billing for, so the model
        // is written down here too — once, and again only if it changes.
        await this.noteModel(run, state, signal.model)
        // What the turn cost, as the harness priced it. The journal is where
        // spend is read back from, so it goes in whether or not anyone asked.
        await this.log.append({
          type: 'usage',
          task,
          run,
          detail: {
            ...modelDetail(signal.model),
            input: signal.input,
            output: signal.output,
            cacheRead: signal.cacheRead,
            cacheWrite: signal.cacheWrite,
            tokens: signal.tokens,
            usd: signal.usd,
            // Whether that money was priced or guessed, as the harness itself
            // declares it: pi prices every turn against its own catalog,
            // Claude Code can only estimate. Written down beside the figure
            // rather than worked out when it is read, because which harness a
            // run was in is a fact about the run, and adding an exact dollar
            // to an estimated one without saying so is how a total nobody can
            // defend gets onto a dashboard.
            priced: this.adapterOf(run).capabilities.spend.usd,
            // And which harness, sign-in and provider spent it. The same
            // reasoning: a fact about the run, written down beside the figure
            // rather than worked out from a name when somebody reads it.
            ...factsDetail(this.runs.get(run)?.facts),
          },
        })
        return
      // Timed, not written down: what an agent did inside a turn is the shape
      // of the turn, and the journal keeps what was decided about it instead.
      case 'tool_call':
        this.timing.tool(run, { callId: signal.callId, tool: signal.tool, at: signal.at })
        this.noteDoing(run, signal)
        return
      case 'tool_result':
        this.timing.toolDone(run, { callId: signal.callId, ok: signal.ok, at: signal.at })
        this.noteDone(run, signal)
        return
      default:
        // Streamed messages are noise in the journal; tool calls are recorded
        // when they are decided.
        return
    }
  }

  /**
   * What each agent has been doing lately, by task: the last tools it ran and
   * how its last turns ended. For a watch that reads whether an agent is
   * getting anywhere — nothing here decides anything, and nothing here is
   * written down.
   */
  doingByTask(): { task: string; run: string; did: Doing[]; ends: TurnEnd[] }[] {
    const out: { task: string; run: string; did: Doing[]; ends: TurnEnd[] }[] = []
    for (const [run, state] of this.runs) {
      const kept = this.doing.get(run)
      if (!kept) continue
      out.push({ task: state.task, run, did: [...kept.did], ends: [...kept.ends] })
    }
    return out
  }

  /** What is kept about one run, made the first time it does anything. */
  private kept(run: string): { did: Doing[]; ends: TurnEnd[] } {
    const already = this.doing.get(run)
    if (already) return already
    const fresh = { did: [] as Doing[], ends: [] as TurnEnd[] }
    this.doing.set(run, fresh)
    return fresh
  }

  private noteDoing(run: RunId, signal: Extract<WorkerSignal, { type: 'tool_call' }>): void {
    const kept = this.kept(run)
    kept.did.push({
      at: signal.at,
      tool: signal.tool,
      about: aboutToolCall(signal.input),
      ok: null,
    })
    if (kept.did.length > KEPT_DOING) kept.did.shift()
    this.calls.set(`${run}:${signal.callId}`, kept.did[kept.did.length - 1] as Doing)
  }

  private noteDone(run: RunId, signal: Extract<WorkerSignal, { type: 'tool_result' }>): void {
    const key = `${run}:${signal.callId}`
    const did = this.calls.get(key)
    this.calls.delete(key)
    if (did) did.ok = signal.ok
  }

  /**
   * What an agent last said it is running on. Kept in memory, not the journal:
   * it is a reading, like a lane's screen, and a stale one is worse than none.
   */
  vitals(task: string): RunVitals | null {
    return this.vitalsByTask.get(task) ?? null
  }

  /**
   * What a run turned out to be on, written down the first time its harness
   * says so and again whenever it changes.
   *
   * `run_started` can only record what was *asked* for, and a route that asks
   * for nothing — pi picks by what you are signed in to — leaves it with
   * nothing to record: 86 of the 161 runs in the journal this was written from
   * named no model, and every hour they ran was time attributed to nothing.
   * Compared by the model's own name rather than by the spelling, so a harness
   * answering `claude-opus-5` to a route that asked for
   * `anthropic/claude-opus-5` is the same model and writes no line.
   */
  private async noteModel(
    run: RunId,
    state: RunState | undefined,
    said: string | null,
  ): Promise<void> {
    if (!state) return
    const { name } = modelIdentity(said)
    if (!name || name === state.model) return
    state.model = name
    await this.log.append({
      type: 'run_model',
      task: state.task,
      run,
      detail: modelDetail(said),
    })
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
      result = { ok: false, text: 'Tade has no extension tools to run here' }
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
    // Written down: one of Tade's own tools called by an agent is an act with
    // a who and a why — how an override is read back out of the journal long
    // after the window closed — and a tool that failed is news either way.
    await this.log.append({
      type: 'tool_call',
      task: state?.task ?? null,
      run,
      detail: {
        tool: signal.tool,
        input: clipped(signal.input),
        caller: 'agent',
        ...(result.ok ? {} : { problem: result.text.slice(0, 300) }),
      },
    })
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
    const decided = decideApproval(
      {
        tool: signal.tool,
        input: signal.input,
        worktree: state?.worktree ?? null,
        // What the tool does is its harness's to say: tool names are not ours.
        effect: (state?.adapter ?? this.adapter).effectOf(signal.tool),
      },
      this.approvals,
    )
    // Read a second time, where somebody offered to: the rules above are a
    // list of patterns, and what nobody wrote a pattern for is exactly what
    // this is for. It can only come back stricter.
    const second = await this.readAgain(run, task, signal, state, decided)
    const approval = second.approval
    const noted = second.caution
      ? {
          caution: {
            by: second.caution.by,
            ...(second.caution.version ? { version: second.caution.version } : {}),
          },
        }
      : {}

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
      // The policy would let it through; the checks rule is asked last,
      // because a push with nothing green behind it is the one thing the
      // policy has no opinion about.
      const checked = this.checks
        ? await this.checks({
            task,
            project: task ? (task.split('/')[0] ?? null) : null,
            worktree: state?.worktree ?? '',
            tool: signal.tool,
            input: signal.input as Record<string, unknown>,
          }).catch(() => ({ allow: true as const }))
        : { allow: true as const }
      if (!checked.allow) {
        await this.adapterOf(run).decide(run, signal.requestId, {
          allow: false,
          reason: checked.reason,
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
            rule: 'checks',
            reason: checked.reason,
          },
        })
        return
      }
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
          ...noted,
          // A red check that was overruled or only told about is still
          // recorded red: nothing rewrites a run because somebody pushed.
          ...('note' in checked && checked.note ? { checks: checked.note } : {}),
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
        ...noted,
      },
    })
  }

  /**
   * What somebody else makes of a command Tade's own rules let through — or
   * would only ask one word about.
   *
   * Asked about commands and nothing else: a read is a read, and a write
   * inside an agent's own worktree is the work. Never asked about something
   * already at `hard`, which is as cautious as there is. What comes back may
   * only raise the tier (`withCaution`), so every way this can fail — nobody
   * offering to read, an answer too late, a reading that threw, a run that
   * went away mid-question — is Tade's own answer, unchanged.
   */
  private async readAgain(
    run: RunId,
    task: TaskId | null,
    signal: Extract<WorkerSignal, { type: 'permission_request' }>,
    state: RunState | undefined,
    decided: Approval,
  ): Promise<{ approval: Approval; caution: Caution | null }> {
    // Nothing to read about, or nothing to read it against: a run whose task
    // and worktree we have lost is one nothing can be said about safely.
    if (!this.askCaution || decided.tier === 'hard') return { approval: decided, caution: null }
    if (!task || !state?.worktree) return { approval: decided, caution: null }
    const input = (signal.input ?? {}) as Record<string, unknown>
    const command = ['command', 'script', 'cmd']
      .map((key) => input[key])
      .find((value): value is string => typeof value === 'string' && value.length > 0)
    if (command === undefined) return { approval: decided, caution: null }

    const controller = new AbortController()
    const inFlight = this.reading.get(run) ?? new Set<AbortController>()
    inFlight.add(controller)
    this.reading.set(run, inFlight)
    try {
      const read = await this.askCaution({
        task,
        project: task.split('/')[0] ?? '',
        worktree: state.worktree,
        tool: signal.tool,
        command,
        input,
        decided: { tier: decided.tier, rule: decided.rule, reason: decided.reason },
        signal: controller.signal,
      })
      for (const problem of read.problems) await this.sayOnce(run, task, problem)
      return {
        approval: withCaution(decided, read.caution, this.approvals),
        caution: read.caution,
      }
    } catch (err) {
      await this.sayOnce(run, task, err instanceof Error ? err.message : String(err))
      return { approval: decided, caution: null }
    } finally {
      inFlight.delete(controller)
    }
  }

  /**
   * A gate that has stopped reading, written down the first time it happens in
   * a run. Not at every command: the same sentence under every line an agent
   * runs is one nobody reads twice.
   */
  private async sayOnce(run: RunId, task: TaskId | null, problem: string): Promise<void> {
    const said = this.saidAbout.get(run) ?? new Set<string>()
    if (said.has(problem)) return
    said.add(problem)
    this.saidAbout.set(run, said)
    await this.log.append({
      type: 'warning',
      task,
      run,
      detail: { message: `nothing read this agent's commands a second time: ${problem}` },
    })
  }

  private require(run: RunId): RunState {
    const state = this.runs.get(run)
    if (!state) throw new WorkerNotFoundError(run)
    return state
  }
}

/**
 * What a tool was called with, small enough to keep: the journal holds the
 * shape of what happened, never a body of text somebody pasted into it.
 */
export function clipped(input: unknown): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value.length > 300 ? `${value.slice(0, 300)}…` : value
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value
    else if (Array.isArray(value))
      out[key] = value.slice(0, 20).map((one) => String(one).slice(0, 100))
  }
  return out
}

/**
 * What makes two requests the same request. A different command is new
 * information and gets asked about again; the identical one does not.
 */
function signatureOf(tool: string, summary: string): string {
  return `${tool}\u0000${summary}`
}

/**
 * Which harness, sign-in and provider a run is on, read off what it was asked
 * for. `harness` arrives as the key its adapter is filed under — the harness
 * alone, or `harness@account` — so the two halves are taken back apart rather
 * than trusted to arrive separately.
 */
function factsOf(request: StartRunRequest, fallback: string): RunState['facts'] {
  const parts = adapterParts(request.harness ?? '')
  return {
    harness: parts.harness || fallback,
    account: request.account ?? parts.account,
    provider: request.model?.provider ?? null,
  }
}

/**
 * The model a run was asked to start on, by its own name — what `run_started`
 * records, and so what a `run_model` has to differ from to be worth writing.
 */
function modelAsked(request: StartRunRequest): string | null {
  return modelIdentity(request.model?.id).name || null
}

/** The run's facts as journal detail, leaving out what nobody recorded. */
function factsDetail(facts: RunState['facts'] | undefined): Record<string, unknown> {
  if (!facts) return {}
  return {
    ...(facts.harness ? { harness: facts.harness } : {}),
    ...(facts.account ? { account: facts.account } : {}),
    ...(facts.provider ? { provider: facts.provider } : {}),
  }
}
