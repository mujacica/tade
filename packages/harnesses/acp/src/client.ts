import { type ChildProcess, spawn } from 'node:child_process'
import { keptResult, type WorkerSignal } from '@tade/harnesses-core'
import type { z } from 'zod'
import {
  AGENT,
  type AgentInfo,
  type AuthMethod,
  agentInfoOf,
  CLIENT,
  type ConfigOption,
  configOptionsOf,
  ERRORS,
  type McpServer,
  PROTOCOL_VERSION,
  permissionAnswer,
  permissionAskOf,
  type StopReason,
  stopReasonOf,
  type ToolCall,
  updateOf,
} from './protocol.ts'
import { append, type RecordLine } from './record.ts'
import { Peer, rpcError } from './rpc.ts'

// One ACP agent, driven from Tade's lane: Tade's side of the protocol.
//
// It starts the agent, opens or comes back to its session, sends what it is
// told one turn at a time, answers the agent's permission requests through
// whatever gate it is handed, writes the conversation down (`record.ts`), and
// says everything that happens twice over — as Tade's own signals, for the
// window, and as what the lane draws. It knows nothing of terminals or
// sockets: `lane.ts` wires those in, and a test wires in nothing.

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

/** A signal as the client says it: the run and the moment are the lane's to add. */
export type Said = DistributiveOmit<z.input<typeof WorkerSignal>, 'run' | 'at'>

/** What the lane draws, beside the signals: what was sent, and the lane's own words. */
export type Drawn =
  | { kind: 'you'; text: string }
  | { kind: 'note'; text: string }
  | { kind: 'problem'; text: string }

export interface ClientOptions {
  command: string
  args: readonly string[]
  cwd: string
  env: NodeJS.ProcessEnv
  /** Which agent this is, as Tade names it: what the record and a model's provider say. */
  agent: string
  /** Where the conversation is written down. */
  record: string
  /** The session to come back to, from the record; null starts a new one. */
  resume: string | null
  /** The model within the agent to be on, where one was chosen. */
  model: string | null
  /** Said ahead of the first thing sent in a new session: what Tade tells every agent. */
  instructions: string
  mcpServers: readonly McpServer[]
  signal: (said: Said) => void
  draw: (drawn: Drawn) => void
  /**
   * Whether a tool call the agent asked about may run. Under `policy` this is
   * Tade's gate, and a person may be asked; under `bypass` it is yes.
   */
  gate: (ask: { requestId: string; tool: string; input: unknown; summary: string }) => Promise<{
    allow: boolean
    reason: string
  }>
  /**
   * Sign in the way the agent asks to in a terminal: run it with these
   * arguments where a person can answer it, and say whether it finished well.
   * Absent where there is no terminal to do it in.
   */
  signInHere?: (method: Extract<AuthMethod, { type: 'terminal' }>) => Promise<boolean>
  now?: () => number
}

/** How long the agent may take to say hello before it is given up on. */
const HELLO_MS = 60_000

export class AcpClient {
  private child: ChildProcess | null = null
  private peer: Peer | null = null
  private info: AgentInfo | null = null
  private session: string | null = null
  private options: ConfigOption[] = []
  private model: string | null
  private stderr = ''
  private busy = false
  private aborting = false
  private told = false
  private readonly queued: string[] = []
  /** What it is saying right now, until something else happens. */
  private saying = ''
  /** Tools that started and have not answered, so each answer is said once. */
  private readonly running = new Map<string, string>()
  /** Permission requests waiting on a decision, answered `cancelled` if the turn is stopped. */
  private readonly asking = new Set<(allow: boolean | null) => void>()
  private cost: number | null = null
  /** A session being loaded replays itself as updates, which the lane already has from its record. */
  private replaying = false
  private exited = false
  private asks = 0
  private readonly now: () => number

  private readonly opts: ClientOptions

  constructor(opts: ClientOptions) {
    this.opts = opts
    this.model = opts.model
    this.now = opts.now ?? Date.now
  }

  /** Whether a turn is running. */
  get working(): boolean {
    return this.busy
  }

  get sessionId(): string | null {
    return this.session
  }

  /** The model it is on, as Tade names one: `agent/model`, or `agent/default`. */
  get modelName(): string {
    return `${this.opts.agent}/${this.model ?? this.current('model') ?? 'default'}`
  }

  /**
   * Start the agent and open its session. Resolves once it can be sent
   * something; throws, having said why (`failed`), when it cannot.
   */
  async start(): Promise<void> {
    const child = spawn(this.opts.command, [...this.opts.args], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-4000)
    })
    const gone = new Promise<never>((_, reject) => {
      child.once('error', (err) => {
        this.exited = true
        reject(new Error(`${this.opts.command} could not be started: ${err.message}`))
      })
      child.once('exit', (code, signal) => {
        this.exited = true
        this.peer?.close('the agent exited')
        this.settle(null)
        this.signal({ type: 'exited', code: code ?? (signal ? 128 : null) })
        reject(new Error(this.whyGone(code)))
      })
    })
    gone.catch(() => {})
    this.peer = new Peer({
      input: child.stdout as NonNullable<typeof child.stdout>,
      output: child.stdin as NonNullable<typeof child.stdin>,
      onRequest: (method, params) => this.onRequest(method, params),
      onNotification: (method, params) => this.onNotification(method, params),
      onWarning: (message) => this.opts.draw({ kind: 'note', text: message }),
    })
    child.stdin?.on('error', () => {})
    try {
      await Promise.race([
        this.hello(),
        gone,
        timeout(HELLO_MS, 'the agent did not answer initialize'),
      ])
    } catch (err) {
      const reason = (err as Error).message
      this.signal({ type: 'failed', error: reason })
      this.opts.draw({ kind: 'problem', text: reason })
      this.stop()
      throw err
    }
  }

  private async hello(): Promise<void> {
    const peer = this.peer as Peer
    const said = await peer.request(AGENT.initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        // The agent reads and writes files and runs commands itself, where
        // it is: Tade lends it no editor and no terminal.
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false,
        auth: { terminal: this.opts.signInHere !== undefined },
      },
      clientInfo: { name: 'tade', title: 'Tade', version: '1' },
    })
    const info = agentInfoOf(said)
    if (!info) throw new Error('the agent answered initialize in a shape ACP does not have')
    if (info.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `the agent speaks ACP version ${info.protocolVersion}, and Tade speaks version ${PROTOCOL_VERSION}`,
      )
    }
    this.info = info
    await this.open()
    this.signal({ type: 'started', sessionId: this.session, model: this.modelName, thinking: null })
    await this.applyModel()
    // Whatever arrived while the session was opening goes now.
    const next = this.queued.shift()
    if (next !== undefined) void this.turn(next)
    else this.signal({ type: 'idle' })
  }

  /** Come back to the session the record names, where the agent can; otherwise start one. */
  private async open(): Promise<void> {
    const peer = this.peer as Peer
    const info = this.info as AgentInfo
    const servers = this.opts.mcpServers.filter((one) => !('type' in one) || info.mcpHttp)
    const base = { cwd: this.opts.cwd, mcpServers: servers }
    const resume = this.opts.resume
    if (resume && (info.resumeSession || info.loadSession)) {
      try {
        // Resume where it can: load replays the whole conversation as
        // updates, which the lane already has from its own record.
        const method = info.resumeSession ? AGENT.resumeSession : AGENT.loadSession
        this.replaying = true
        const said = await this.withSignIn(() =>
          peer.request(method, { ...base, sessionId: resume }),
        )
        this.session = resume
        this.options =
          configOptionsOf((said as { configOptions?: unknown } | null)?.configOptions) ?? []
        this.told = true
        this.write({
          type: 'session',
          at: this.now(),
          agent: this.opts.agent,
          sessionId: resume,
          resumed: true,
        })
        this.opts.draw({
          kind: 'note',
          text: `carried on the conversation it was having (${resume})`,
        })
        return
      } catch (err) {
        this.opts.draw({
          kind: 'problem',
          text: `could not come back to its conversation (${(err as Error).message}), so it starts a new one`,
        })
      } finally {
        this.replaying = false
      }
    } else if (resume) {
      this.opts.draw({
        kind: 'problem',
        text: 'this agent cannot come back to a conversation over ACP, so it starts a new one',
      })
    }
    const said = (await this.withSignIn(() => peer.request(AGENT.newSession, base))) as {
      sessionId?: unknown
      configOptions?: unknown
    } | null
    if (typeof said?.sessionId !== 'string') {
      throw new Error('the agent opened a session and did not say which')
    }
    this.session = said.sessionId
    this.options = configOptionsOf(said.configOptions) ?? []
    this.write({
      type: 'session',
      at: this.now(),
      agent: this.opts.agent,
      sessionId: said.sessionId,
      resumed: false,
    })
  }

  /** Ask; and if the agent says it needs signing in first, sign in its way and ask once more. */
  private async withSignIn<T>(ask: () => Promise<T>): Promise<T> {
    try {
      return await ask()
    } catch (err) {
      if ((err as { code?: unknown }).code !== ERRORS.authRequired) throw err
      const methods = this.info?.authMethods ?? []
      const here = methods.find((one) => one.type === 'terminal')
      const theirs = methods.find((one) => one.type === 'agent')
      if (here && here.type === 'terminal' && this.opts.signInHere) {
        this.opts.draw({ kind: 'note', text: `it asks to be signed in first: ${here.name}` })
        if (!(await this.opts.signInHere(here)))
          throw new Error(`signing in (${here.name}) did not finish`)
      } else if (theirs) {
        this.opts.draw({ kind: 'note', text: `it asks to be signed in first: ${theirs.name}` })
        await (this.peer as Peer).request(AGENT.authenticate, { methodId: theirs.id })
      } else {
        throw new Error(
          `it needs signing in, and offers no way Tade can do it: ${(err as Error).message}`,
        )
      }
      return ask()
    }
  }

  /** What a select option of this category is set to now. */
  private current(category: string): string | null {
    return this.optionFor(category)?.current ?? null
  }

  private optionFor(category: string): ConfigOption | null {
    return (
      this.options.find((one) => one.category === category) ??
      this.options.find((one) => one.id === category) ??
      null
    )
  }

  /** Put the session on the model chosen for it, where the agent offers that choice. */
  private async applyModel(): Promise<void> {
    const wanted = this.model
    if (!wanted || wanted === 'default') return
    const option = this.optionFor('model')
    if (!option) {
      this.model = null
      this.problem(
        `it offers no choice of model over ACP, so it runs on its own rather than ${wanted}`,
      )
      return
    }
    const value = option.values.find(
      (one) => one.value === wanted || one.name.toLowerCase() === wanted.toLowerCase(),
    )
    if (!value) {
      this.model = null
      this.problem(
        `it offers no model called ${wanted} (it has ${option.values.map((one) => one.value).join(', ') || 'none'}), so it stays on ${option.current}`,
      )
      return
    }
    if (option.current === value.value) return
    try {
      const said = (await (this.peer as Peer).request(AGENT.setConfigOption, {
        sessionId: this.session,
        configId: option.id,
        value: value.value,
      })) as { configOptions?: unknown } | null
      this.options = configOptionsOf(said?.configOptions) ?? this.options
      this.model = value.value
      this.write({ type: 'model', at: this.now(), model: value.value })
      this.signal({
        type: 'started',
        sessionId: this.session,
        model: this.modelName,
        thinking: null,
      })
    } catch (err) {
      this.problem(`it would not change model to ${wanted}: ${(err as Error).message}`)
    }
  }

  /** Change the model from the next turn on, for this conversation only. */
  async setModel(model: string): Promise<void> {
    this.model = model
    await this.applyModel()
  }

  /**
   * Send it something. A turn already running finishes first — ACP has no
   * way into a turn once it is under way — so what arrives then is held and
   * sent the moment it ends, and the lane says so.
   */
  send(text: string): void {
    if (!text.trim()) return
    if (this.busy || !this.session) {
      this.queued.push(text)
      this.opts.draw({
        kind: 'note',
        text: this.busy ? 'held until this turn ends' : 'held until its session is open',
      })
      return
    }
    void this.turn(text)
  }

  private async turn(text: string): Promise<void> {
    this.busy = true
    this.aborting = false
    this.opts.draw({ kind: 'you', text })
    this.signal({ type: 'turn_started' })
    this.write({ type: 'sent', at: this.now(), text })
    const prompt = [
      // Said once per conversation, ahead of the first thing it is sent:
      // ACP has no instructions of a client's own beside the agent's.
      ...(!this.told && this.opts.instructions.trim()
        ? [{ type: 'text', text: this.opts.instructions }]
        : []),
      { type: 'text', text },
    ]
    this.told = true
    let stop: StopReason | null = null
    let error: string | null = null
    try {
      stop = stopReasonOf(
        await (this.peer as Peer).request(AGENT.prompt, { sessionId: this.session, prompt }),
      )
      if (!stop) error = 'the agent ended the turn without saying why'
    } catch (err) {
      error = (err as Error).message
    }
    this.flush()
    // Whatever was still running when the turn ended never said how it went.
    for (const [id, tool] of this.running) {
      this.signal({
        type: 'tool_result',
        callId: id,
        ok: false,
        summary: `${tool}: the turn ended first`,
      })
    }
    this.running.clear()
    const status: 'ok' | 'error' | 'aborted' =
      stop === 'cancelled' || (this.aborting && error !== null)
        ? 'aborted'
        : stop === 'end_turn'
          ? 'ok'
          : 'error'
    const reason =
      error ??
      (stop === 'refusal'
        ? 'the agent refused to go on'
        : stop === 'max_tokens'
          ? 'the agent ran out of room to answer in'
          : stop === 'max_turn_requests'
            ? 'the agent reached the most requests it makes in one turn'
            : undefined)
    this.write({
      type: 'turn',
      at: this.now(),
      stop: stop ?? 'error',
      ...(reason ? { reason } : {}),
    })
    this.signal({ type: 'turn_done', status, ...(status === 'error' && reason ? { reason } : {}) })
    if (status === 'error' && reason) this.opts.draw({ kind: 'problem', text: reason })
    if (status === 'aborted') this.opts.draw({ kind: 'note', text: 'stopped' })
    this.busy = false
    const next = this.queued.shift()
    if (next !== undefined && !this.exited) {
      void this.turn(next)
      return
    }
    this.signal({ type: 'idle' })
  }

  /** Stop the turn that is running, leaving the agent and its conversation. */
  cancel(): void {
    if (!this.busy || !this.session) return
    this.aborting = true
    this.queued.length = 0
    this.peer?.notify(AGENT.cancel, { sessionId: this.session })
    // The protocol's own rule: a question still waiting is answered cancelled.
    this.settle(null)
  }

  /** End the agent. */
  stop(): void {
    this.peer?.close('the lane is closing')
    this.settle(null)
    if (this.child && !this.exited) this.child.kill('SIGTERM')
  }

  private settle(allow: boolean | null): void {
    for (const answer of [...this.asking]) answer(allow)
    this.asking.clear()
  }

  private signal(said: Said): void {
    this.opts.signal(said)
  }

  private problem(text: string): void {
    this.signal({ type: 'problem', text })
    this.opts.draw({ kind: 'problem', text })
  }

  private write(line: RecordLine): void {
    try {
      append(this.opts.record, line)
    } catch (err) {
      // The conversation goes on; what is lost is the record of it, and that is said.
      this.opts.draw({
        kind: 'problem',
        text: `could not write the conversation down: ${(err as Error).message}`,
      })
    }
  }

  private whyGone(code: number | null): string {
    const said = this.stderr.trim().split('\n').slice(-6).join('\n')
    return said
      ? `${this.opts.command} exited (${code ?? 'killed'}): ${said}`
      : `${this.opts.command} exited (${code ?? 'killed'}) before it said anything`
  }

  /** Whatever it was saying is finished: said whole, and written down. */
  private flush(): void {
    if (!this.saying) return
    const text = this.saying
    this.saying = ''
    this.signal({ type: 'message', text })
    this.write({ type: 'reply', at: this.now(), text })
  }

  private onNotification(method: string, params: unknown): void {
    if (method !== CLIENT.update || this.replaying) return
    const read = updateOf(params)
    if (!read || read.sessionId !== this.session) return
    const { update } = read
    switch (update.kind) {
      case 'said':
        this.saying += update.text
        this.signal({ type: 'message_delta', text: update.text })
        return
      case 'config':
        this.options = update.options
        return
      case 'thought':
      case 'you':
      case 'plan':
        // Its thinking, an echo of what was sent and its plan are the
        // agent's own to draw; the record and the window keep what it said.
        return
      case 'tool':
        this.flush()
        this.toolStarted(update.call)
        return
      case 'tool_update':
        if (!this.running.has(update.call.id) && update.call.status !== null) {
          // An update for a call it never announced is still a call.
          if (update.call.status === 'pending' || update.call.status === 'in_progress') {
            this.toolStarted(update.call)
            return
          }
        }
        this.toolUpdated(update.call)
        return
      case 'titled':
        this.signal({ type: 'titled', title: update.title, named: false })
        return
      case 'usage': {
        this.signal({
          type: 'context',
          tokens: update.used,
          percent: update.size > 0 ? Math.round((update.used / update.size) * 1000) / 10 : null,
        })
        this.write({
          type: 'usage',
          at: this.now(),
          sessionId: read.sessionId,
          used: update.used,
          size: update.size,
          cost: update.cost,
        })
        const usd = update.cost?.currency.toUpperCase() === 'USD' ? update.cost.amount : null
        if (usd !== null) {
          const delta = usd - (this.cost ?? 0)
          this.cost = usd
          if (delta > 0) this.signal({ type: 'usage', model: this.modelName, usd: delta })
        }
        return
      }
      case 'notice':
        if (update.severity === 'error' || update.severity === 'warning') this.problem(update.title)
        else this.opts.draw({ kind: 'note', text: update.title })
        return
      case 'compaction':
        if (update.status === 'failed')
          this.problem(
            `compacting its conversation failed: ${update.error ?? 'it did not say why'}`,
          )
        return
    }
  }

  private toolStarted(call: ToolCall): void {
    const tool = toolOf(call)
    this.running.set(call.id, call.title ?? tool)
    this.signal({
      type: 'tool_call',
      callId: call.id,
      tool,
      input: inputOf(call),
      ...(writes(call).length > 0 ? { writes: writes(call) } : {}),
    })
    this.write({
      type: 'tool',
      at: this.now(),
      id: call.id,
      tool,
      title: call.title ?? tool,
      input: inputOf(call),
    })
    if (call.status === 'completed' || call.status === 'failed') this.toolUpdated(call)
  }

  private toolUpdated(call: ToolCall): void {
    if (call.status !== 'completed' && call.status !== 'failed') return
    const title = this.running.get(call.id)
    if (title === undefined) return
    this.running.delete(call.id)
    const ok = call.status === 'completed'
    const summary = call.output.trim().slice(0, 2000)
    this.signal({ type: 'tool_result', callId: call.id, ok, summary })
    this.write({
      type: 'tool_result',
      at: this.now(),
      id: call.id,
      ok,
      result: keptResult(call.output),
    })
  }

  private async onRequest(method: string, params: unknown): Promise<unknown> {
    if (method !== CLIENT.requestPermission) {
      throw rpcError(ERRORS.methodNotFound, `Tade does not offer ${method}`)
    }
    const ask = permissionAskOf(params)
    if (!ask) throw rpcError(-32602, 'a permission request in a shape ACP does not have')
    if (this.aborting) return permissionAnswer(ask.options, false)
    this.flush()
    const tool = toolOf(ask.call)
    const requestId = `${ask.call.id}#${++this.asks}`
    const summary = summaryOf(ask.call)
    // Answered by the gate, or by the turn being stopped — whichever is first.
    let answer: (allow: boolean | null) => void = () => {}
    const allow = await new Promise<boolean | null>((resolve) => {
      answer = resolve
      this.asking.add(resolve)
      this.opts
        .gate({ requestId, tool, input: inputOf(ask.call), summary })
        .then((decided) => {
          if (!decided.allow && decided.reason) {
            this.opts.draw({ kind: 'note', text: `not allowed: ${summary} (${decided.reason})` })
          }
          resolve(decided.allow)
        })
        .catch((err: unknown) => {
          this.opts.draw({
            kind: 'problem',
            text: `not allowed: ${summary} (${(err as Error).message})`,
          })
          resolve(false)
        })
    })
    this.asking.delete(answer)
    if (allow === null) return { outcome: { outcome: 'cancelled' } }
    return permissionAnswer(ask.options, allow)
  }
}

/**
 * What a tool is called, for the policy and for whoever reads the journal:
 * ACP's own kind — `read`, `edit`, `execute`, … — which every agent uses for
 * its own tools, rather than each agent's private names for them.
 */
export function toolOf(call: ToolCall): string {
  return call.kind ?? 'other'
}

/**
 * What a call was given, in the words the policy reads — `command` and `path`
 * — with the agent's own input beside them, untouched.
 */
export function inputOf(call: ToolCall): Record<string, unknown> {
  const raw = (
    typeof call.rawInput === 'object' && call.rawInput !== null ? call.rawInput : {}
  ) as Record<string, unknown>
  const command = commandIn(raw)
  const path =
    call.paths[0] ??
    (['path', 'file_path', 'filePath', 'file']
      .map((key) => raw[key])
      .find((v) => typeof v === 'string') as string | undefined)
  return {
    ...(call.title ? { title: call.title } : {}),
    ...(command && call.kind === 'execute' ? { command } : {}),
    ...(path ? { path } : {}),
    ...(call.rawInput !== undefined ? { input: call.rawInput } : {}),
  }
}

function commandIn(raw: Record<string, unknown>): string | null {
  for (const key of ['command', 'cmd', 'script']) {
    const value = raw[key]
    if (typeof value === 'string' && value) return value
    if (Array.isArray(value) && value.length > 0) return value.map(String).join(' ')
  }
  return null
}

/** The files a call writes, as the agent said: what a conflict forecast reads. */
function writes(call: ToolCall): string[] {
  return call.kind === 'edit' || call.kind === 'delete' || call.kind === 'move' ? call.paths : []
}

/** One line, exact enough to read back before approving: the command itself, where there is one. */
export function summaryOf(call: ToolCall): string {
  const input = inputOf(call)
  if (typeof input.command === 'string') return input.command
  const title = call.title ?? toolOf(call)
  return call.paths.length > 0 && !title.includes(call.paths[0] as string)
    ? `${title}: ${call.paths.join(', ')}`
    : title
}

function timeout(ms: number, why: string): Promise<never> {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(why)), ms)
    timer.unref?.()
  })
}
