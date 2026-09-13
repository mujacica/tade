import { type ChildProcess, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sandboxed, type Unsubscribe } from '@wilco/core'
import {
  type PermissionDecision,
  type RunId,
  WORKER_ENV,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerHandle,
  type WorkerModel,
  WorkerNotFoundError,
  type WorkerSignal,
  type WorkerSignalListener,
  type WorkerSpec,
} from '@wilco/harnesses-core'
import { SignalChannel } from './channel.ts'

// Drives pi as a Wilco worker: pi runs the agent, Wilco supervises it through
// the extension channel. Model and provider are pi's business, which is how
// one adapter covers API keys, subscriptions and local models alike.

export const EXTENSION_PATH = fileURLToPath(new URL('./extension.ts', import.meta.url))

/**
 * The session a task's agent talks in, for the life of the task.
 *
 * Stable, because that is what makes reopening ordinary: pi creates a session
 * with this id the first time and continues it every time after, so nothing
 * has to decide whether this is a start or a resume.
 */
export function sessionIdFor(task: string): string {
  return `wilco-${task.replace(/[^a-zA-Z0-9-]+/g, '-')}`
}

/** The pi binary that ships with this package. */
export function piBinary(): string {
  // pi's exports map declares no `require` condition and does not expose
  // package.json, so neither require.resolve nor a subpath resolve works here.
  // Walk up for the installed package instead: correct under pnpm's layout and
  // identical whether we run under node or a test runner.
  const relative = join(
    'node_modules',
    '@earendil-works',
    'pi-coding-agent',
    'dist',
    'bundle',
    'cli.js',
  )
  let dir = fileURLToPath(new URL('.', import.meta.url))
  for (;;) {
    const cli = join(dir, relative)
    if (existsSync(cli)) return cli
    const parent = dirname(dir)
    if (parent === dir) {
      throw new Error('pi CLI not found: is @earendil-works/pi-coding-agent installed?')
    }
    dir = parent
  }
}

export interface PiAdapterOptions {
  /** Directory for per-run sockets and session files. */
  runDir: string
  /**
   * Load the supervision extension, so every tool call is held until Wilco
   * answers. True for workers. False for the orchestrator, which is Wilco's
   * own interface: gating its calls on an approval would mean asking
   * permission to answer "where are we".
   */
  supervise?: boolean
  /** Defaults to the bundled pi. */
  bin?: string
  /** Extra arguments appended to every launch. */
  args?: string[]
  /**
   * Whether this worker's tool calls are gated. Passed to the agent so it
   * knows what to do when Wilco goes away: carry on, or refuse.
   */
  approvals?: 'bypass' | 'policy'
  env?: NodeJS.ProcessEnv
  onWarning?: (message: string) => void
}

interface Run {
  handle: WorkerHandle
  child: ChildProcess
  /** Null when the run is not supervised. */
  channel: SignalChannel | null
  pendingRpc: Map<string, (response: RpcResponse) => void>
  streaming: boolean
  stdout: string
  rpcId: number
}

interface RpcResponse {
  type: 'response'
  command: string
  success: boolean
  error?: string
  data?: Record<string, unknown>
}

export class PiAdapter implements WorkerAdapter {
  readonly id = 'pi'
  readonly capabilities: WorkerCapabilities = {
    permissionGate: true,
    steer: true,
    modelSwitch: true,
    // This adapter runs pi headless; a visible lane is launched with
    // `laneLaunchSpec()` and supervised through the same channel.
    visibleUi: false,
    resume: true,
  }

  private readonly runs = new Map<string, Run>()
  // Keyed by run rather than held on the run itself, so a caller can subscribe
  // before `start()` returns: the first signals arrive while it is still running.
  private readonly listeners = new Map<string, Set<WorkerSignalListener>>()
  private readonly opts: Required<
    Omit<PiAdapterOptions, 'onWarning' | 'bin' | 'args' | 'env' | 'approvals'>
  > & {
    approvals: 'bypass' | 'policy'
    bin: string
    args: string[]
    env: NodeJS.ProcessEnv
    onWarning: (message: string) => void
  }

  constructor(opts: PiAdapterOptions) {
    this.opts = {
      runDir: opts.runDir,
      supervise: opts.supervise ?? true,
      approvals: opts.approvals ?? 'bypass',
      bin: opts.bin ?? piBinary(),
      args: opts.args ?? [],
      env: opts.env ?? process.env,
      onWarning: opts.onWarning ?? (() => {}),
    }
  }

  /**
   * How to run pi as itself, in a lane you can watch, rather than as a
   * machine-protocol child of ours.
   *
   * The session id is the whole point. pi's sessions are append-only and
   * survive being killed mid-turn — everything up to the kill is on disk, and
   * only the answer that never came back is missing — so naming the session
   * after the task means reopening is not a special case: the same command
   * line starts it the first time and continues it every time after.
   *
   * There is no `--session-dir` here on purpose. pi keeps sessions per working
   * directory, and every task has its own worktree, so they are already
   * partitioned by task — and leaving them where pi puts them means you can
   *`cd` into the worktree, run pi yourself, and be in the same conversation.
   */
  laneLaunchSpec(spec: WorkerSpec): {
    command: string
    args: string[]
    env: Record<string, string>
  } {
    const launch = sandboxed(
      {
        command: process.execPath,
        args: [
          this.opts.bin,
          ...this.modelArgs(spec.model),
          '--session-id',
          sessionIdFor(spec.task),
          '-e',
          EXTENSION_PATH,
          ...this.opts.args,
          // Last, so the opening instruction is not mistaken for a flag.
          ...(spec.prompt ? [spec.prompt] : []),
        ],
      },
      spec.sandbox ?? { kind: 'none', worktree: spec.cwd },
    )
    return { ...launch, env: this.runEnv(spec) }
  }

  async start(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    const socketPath = join(this.opts.runDir, `${spec.run}.sock`)

    const channel = this.opts.supervise
      ? await SignalChannel.listen({
          path: socketPath,
          run: spec.run,
          onSignal: (signal) => this.dispatch(spec.run, signal),
          onWarning: this.opts.onWarning,
        })
      : null

    // Contained if the route asked for it. The harness runs with whatever
    // permissions it was launched with, so this is the only thing between a
    // worker and the rest of the disk.
    const launch = sandboxed(
      {
        command: process.execPath,
        args: [
          this.opts.bin,
          '--mode',
          'rpc',
          ...this.modelArgs(spec.model),
          '--session-dir',
          join(this.opts.runDir, 'sessions'),
          ...(this.opts.supervise ? ['-e', EXTENSION_PATH] : []),
          ...this.opts.args,
        ],
      },
      spec.sandbox ?? { kind: 'none', worktree: spec.cwd },
    )

    const child = spawn(launch.command, launch.args, {
      cwd: spec.cwd,
      env: { ...this.runEnv(spec), ...spec.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    const run: Run = {
      handle: {
        run: spec.run,
        task: spec.task,
        sessionId: null,
        startedAt: Date.now(),
        lane: spec.lane ?? null,
      },
      child,
      channel,
      pendingRpc: new Map(),
      streaming: false,
      stdout: '',
      rpcId: 0,
    }
    this.runs.set(spec.run, run)

    child.stdout?.on('data', (chunk: Buffer) => this.readStdout(run, chunk))
    child.on('exit', (code) => {
      this.dispatch(spec.run, { type: 'exited', run: spec.run, at: Date.now(), code })
      void channel?.close()
    })

    const state = await this.rpc(run, { type: 'get_state' }).catch(() => null)
    const sessionId = state?.data?.sessionId
    if (typeof sessionId === 'string') run.handle.sessionId = sessionId

    if (spec.prompt.trim().length > 0) await this.prompt(spec.run, spec.prompt)
    return { ...run.handle }
  }

  async prompt(run: RunId, message: string): Promise<void> {
    const entry = this.require(run)
    // A prompt sent mid-turn is rejected unless it says how to arrive.
    const command = entry.streaming
      ? { type: 'prompt', message, streamingBehavior: 'steer' }
      : { type: 'prompt', message }
    await this.rpc(entry, command)
  }

  async steer(run: RunId, message: string): Promise<void> {
    const entry = this.require(run)
    if (entry.channel?.connected) {
      entry.channel.send({ type: 'steer', message })
      return
    }
    await this.rpc(entry, { type: 'steer', message })
  }

  async queue(run: RunId, message: string): Promise<void> {
    const entry = this.require(run)
    if (entry.channel?.connected) {
      entry.channel.send({ type: 'queue', message })
      return
    }
    await this.rpc(entry, { type: 'follow_up', message })
  }

  async decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void> {
    const entry = this.require(run)
    if (!entry.channel) throw new Error(`run ${run} is not supervised: nothing to decide`)
    entry.channel.send({
      type: 'decision',
      requestId,
      allow: decision.allow,
      reason: decision.reason ?? '',
    })
  }

  async setModel(run: RunId, model: WorkerModel): Promise<void> {
    const entry = this.require(run)
    await this.rpc(entry, {
      type: 'set_model',
      ...(model.provider ? { provider: model.provider } : {}),
      modelId: model.id,
    })
  }

  async abort(run: RunId): Promise<void> {
    const entry = this.require(run)
    await this.rpc(entry, { type: 'abort' }).catch(() => {})
  }

  async stop(run: RunId): Promise<void> {
    const entry = this.runs.get(run)
    if (!entry) return
    entry.channel?.send({ type: 'shutdown' })
    entry.child.kill()
    await entry.channel?.close()
    this.runs.delete(run)
  }

  onSignal(run: RunId, listener: WorkerSignalListener): Unsubscribe {
    let set = this.listeners.get(run)
    if (!set) {
      set = new Set()
      this.listeners.set(run, set)
    }
    set.add(listener)
    return () => set.delete(listener)
  }

  async list(): Promise<WorkerHandle[]> {
    return [...this.runs.values()].map((r) => ({ ...r.handle }))
  }

  async shutdown(): Promise<void> {
    for (const run of [...this.runs.keys()]) await this.stop(run)
  }

  private runEnv(spec: WorkerSpec): Record<string, string> {
    const env: Record<string, string> = {}
    for (const [key, value] of Object.entries(this.opts.env)) {
      if (typeof value === 'string') env[key] = value
    }
    env[WORKER_ENV.socket] = join(this.opts.runDir, `${spec.run}.sock`)
    // What the agent should do when we are not reachable. Declared at launch
    // rather than discovered later, so it can never change underneath a run.
    env[WORKER_ENV.approvals] = this.opts.approvals
    env[WORKER_ENV.run] = spec.run
    env[WORKER_ENV.task] = spec.task
    return env
  }

  private modelArgs(model: WorkerModel | undefined): string[] {
    if (!model) return []
    return model.provider
      ? ['--provider', model.provider, '--model', model.id]
      : ['--model', model.id]
  }

  private dispatch(run: RunId, signal: WorkerSignal): void {
    const entry = this.runs.get(run)
    if (!entry) return
    if (signal.type === 'turn_started') entry.streaming = true
    if (signal.type === 'turn_done' || signal.type === 'idle') entry.streaming = false
    for (const listener of this.listeners.get(run) ?? []) {
      try {
        listener(signal)
      } catch {
        // a broken listener must not stop the others
      }
    }
  }

  /** Strict LF framing: pi's own requirement, and JSON strings may contain U+2028. */
  private readStdout(run: Run, chunk: Buffer): void {
    run.stdout += chunk.toString('utf8')
    let index = run.stdout.indexOf('\n')
    while (index >= 0) {
      const line = run.stdout.slice(0, index).replace(/\r$/, '')
      run.stdout = run.stdout.slice(index + 1)
      if (line.trim()) this.readMessage(run, line)
      index = run.stdout.indexOf('\n')
    }
  }

  private readMessage(run: Run, line: string): void {
    let message: Record<string, unknown>
    try {
      message = JSON.parse(line) as Record<string, unknown>
    } catch {
      return
    }
    if (message.type === 'response' && typeof message.id === 'string') {
      const resolve = run.pendingRpc.get(message.id)
      run.pendingRpc.delete(message.id)
      resolve?.(message as unknown as RpcResponse)
      return
    }
    // What the agent actually said. The supervision extension carries
    // structure; only this stream carries text, and it arrives per completed
    // block rather than per token.
    if (message.type === 'message_update') {
      const event = message.assistantMessageEvent as { type?: string; content?: string } | undefined
      if (event?.type === 'text_end' && typeof event.content === 'string' && event.content) {
        this.dispatch(run.handle.run, {
          type: 'message',
          run: run.handle.run,
          at: Date.now(),
          text: event.content,
        })
      }
      return
    }

    // Tool activity. A supervised run learns this from the extension, which
    // sees calls *before* they run and can hold them; without one, stdout is
    // the only source, and an unsupervised orchestrator should not be blind to
    // what it is doing.
    if (!this.opts.supervise && message.type === 'tool_execution_start') {
      this.dispatch(run.handle.run, {
        type: 'tool_call',
        run: run.handle.run,
        at: Date.now(),
        callId: String(message.toolCallId ?? ''),
        tool: String(message.toolName ?? ''),
        input: message.args,
      })
      return
    }
    // Turn boundaries. Supervised runs get these from the extension; without
    // one, a caller waiting to speak again would otherwise never be told the
    // agent had finished.
    if (!this.opts.supervise && message.type === 'turn_end') {
      this.dispatch(run.handle.run, {
        type: 'turn_done',
        run: run.handle.run,
        at: Date.now(),
        status: 'ok',
      })
      return
    }
    if (!this.opts.supervise && message.type === 'agent_settled') {
      this.dispatch(run.handle.run, { type: 'idle', run: run.handle.run, at: Date.now() })
      return
    }
    if (!this.opts.supervise && message.type === 'tool_execution_end') {
      // The authoritative failure flag is on the result; the outer one reports
      // whether the execution itself blew up.
      const result = message.result as { isError?: boolean } | undefined
      this.dispatch(run.handle.run, {
        type: 'tool_result',
        run: run.handle.run,
        at: Date.now(),
        callId: String(message.toolCallId ?? ''),
        ok: !(result?.isError ?? message.isError ?? false),
        summary: String(message.toolName ?? ''),
      })
    }
  }

  private rpc(run: Run, command: Record<string, unknown>): Promise<RpcResponse> {
    const id = `w${++run.rpcId}`
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        run.pendingRpc.delete(id)
        reject(new Error(`pi did not answer ${String(command.type)}`))
      }, 15_000)
      timer.unref?.()
      run.pendingRpc.set(id, (response) => {
        clearTimeout(timer)
        if (response.success) resolve(response)
        else reject(new Error(response.error ?? `${response.command} failed`))
      })
      run.child.stdin?.write(`${JSON.stringify({ ...command, id })}\n`)
    })
  }

  private require(run: RunId): Run {
    const entry = this.runs.get(run)
    if (!entry) throw new WorkerNotFoundError(run)
    return entry
  }
}
