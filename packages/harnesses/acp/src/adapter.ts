import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type RequiredProgram,
  runProgram,
  type ThinkingLevel,
  type ToolEffect,
  type Unsubscribe,
} from '@tade/core'
import {
  type AccountStatus,
  type HarnessModel,
  type HarnessProbe,
  type HarnessSpend,
  type HistoryAsk,
  type HistoryPage,
  type LaunchSpec,
  type ModelFound,
  type PermissionDecision,
  PermissionNotPendingError,
  type PlanLimits,
  type RunId,
  SignalChannel,
  type SignIn,
  WORKER_ENV,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerCommand,
  type WorkerHandle,
  type WorkerImage,
  type WorkerModel,
  WorkerNotFoundError,
  type WorkerSignal,
  type WorkerSignalListener,
  type WorkerSpec,
} from '@tade/harnesses-core'
import { ACP_AGENTS, type AcpAgent, agentNamed, programsOf } from './agents.ts'
import type { LaneLaunch } from './launch.ts'
import type { McpServer } from './protocol.ts'
import { conversationKey, historyOf, recordedIn, recordPath, spendOf } from './record.ts'

// Drives any agent that speaks the Agent Client Protocol as a Tade worker:
// Gemini CLI, opencode, goose, Copilot CLI, Kiro CLI, Cursor CLI, Qwen Code —
// whichever of `ACP_AGENTS` is on this machine.
//
// ACP is a protocol between an editor and an agent, so an ACP agent has no
// terminal of its own to put in a lane. What runs in the lane is Tade's
// (`lane.ts`): it starts the agent as its child, is the editor it speaks to,
// draws the conversation where the agent's terminal would be, and reports
// over the run's supervision socket like pi's extension does. So an ACP agent
// is still a lane — visible, typed into, outliving the window as far as its
// driver lets it — and nothing here is drawn by the window itself.
//
// Which agent a task runs is its model's provider: `gemini/default` is Gemini
// CLI on its own model, `opencode/anthropic/claude-sonnet-5` is opencode on
// that one. A conversation stays with the agent it started in.

export const LANE_PATH = fileURLToPath(new URL('./lane.ts', import.meta.url))
export const TOOLS_PATH = fileURLToPath(new URL('./tools.ts', import.meta.url))

/** The harness's name, as tasks, routes and the journal say it. */
export const ACP = 'acp'

export interface AcpAdapterOptions {
  /** Directory for per-run files, and where each conversation is written down. */
  runDir: string
  /** Where supervision sockets go; a short path, because a long one fails to bind. */
  socketDir?: string
  approvals?: 'bypass' | 'policy'
  /** The agents it may drive. Every configured one by default. */
  agents?: readonly AcpAgent[]
  env?: NodeJS.ProcessEnv
  onWarning?: (message: string) => void
}

interface Run {
  handle: WorkerHandle
  spec: WorkerSpec
  channel: SignalChannel
  /** What it said it is running on, once it has. */
  model: string | null
  turn: 'starting' | 'running' | 'idle'
  /** Permission requests it is held on, so a decision for one it is not is refused. */
  held: Set<string>
}

export class AcpAdapter implements WorkerAdapter {
  readonly id = ACP
  /** It routes: each agent reaches whatever provider it is pointed at, by its own sign-in. */
  readonly provider = null
  readonly capabilities: WorkerCapabilities = {
    permissionGate: false,
    // ACP has no way into a turn once it is under way: what is said waits for it.
    steer: 'idle',
    queue: 'live',
    abort: 'live',
    model: 'idle',
    thinking: 'none',
    thinkingLevels: [],
    rename: 'none',
    images: 'path',
    visibleUi: true,
    resume: false,
    // The lane says the model again on every session it comes back to.
    resumeKeeps: true,
    continues: false,
    done: true,
    nativeExtensions: false,
    skills: true,
    tools: true,
    mcp: true,
    headless: false,
    spend: { usd: 'estimate', tokens: false, limits: 'none' },
    accounts: false,
    compact: 'none',
    pins: false,
    why: {
      permissionGate:
        'is asked only about the calls the agent itself chooses to ask about over ACP — what it does without asking, Tade sees only once it is done',
      steer:
        'cannot be told anything in the middle of a turn over ACP, so what is said waits for the turn to end',
      model:
        'changes model between turns, and only to one the agent offers over ACP for that conversation; which agent it is never changes',
      models:
        'names an agent rather than a model: none of the agents it drives is installed here (gemini, opencode, goose, copilot, kiro-cli, cursor-agent, qwen)',
      thinking:
        'has no way to be told how hard to think that every ACP agent shares: each names its own levels, if it has any',
      rename: 'cannot rename a conversation over ACP: the agent names it itself',
      images: 'is shown a picture as a file it is told about, which every ACP agent can read',
      resume:
        'comes back to a conversation only where the agent offers session/load or session/resume over ACP; one that does not starts a new conversation, and its lane says so',
      continues:
        'cannot pick a turn back up over ACP: a turn that was cut off is over, and the next thing said starts a new one',
      nativeExtensions:
        'has no place for pi extensions: their tools and skills still reach the agent, their own code does not',
      headless:
        'runs only in a lane, where Tade draws its conversation: the thing you talk to needs a harness Tade can run as its own child',
      spend:
        'counts what an agent says its session cost, priced by the agent itself where it says so at all, and never the tokens behind it',
      limits:
        'has no plan of its own to report on: each agent keeps its own, and ACP does not carry it',
      accounts:
        'runs each agent as it is signed in on this machine: its accounts are the agent’s own, in its own folders',
      compact: 'leaves compacting to the agent itself: ACP has no way for a client to ask for it',
    },
  }

  readonly programs: readonly RequiredProgram[]
  private readonly agents: readonly AcpAgent[]
  private readonly runs = new Map<string, Run>()
  private readonly listeners = new Map<string, Set<WorkerSignalListener>>()
  private readonly opts: Required<Omit<AcpAdapterOptions, 'agents'>>

  constructor(opts: AcpAdapterOptions) {
    this.agents = opts.agents ?? ACP_AGENTS
    this.programs = programsOf(this.agents)
    this.opts = {
      runDir: opts.runDir,
      socketDir: opts.socketDir ?? opts.runDir,
      approvals: opts.approvals ?? 'bypass',
      env: opts.env ?? process.env,
      onWarning: opts.onWarning ?? (() => {}),
    }
  }

  /** Each agent's version, or null where it is not here. Asked of all of them at once. */
  private async here(): Promise<{ agent: AcpAgent; version: string | null; missing: boolean }[]> {
    return Promise.all(
      this.agents.map(async (agent) => {
        const said = await runProgram(agent.command, ['--version'], {
          timeoutMs: 10_000,
          env: this.opts.env,
        })
        return {
          agent,
          version:
            said.code === 0
              ? (/\d+\.\d+(\.\d+)?/.exec(said.stdout)?.[0] ?? said.stdout.trim())
              : null,
          missing: said.missing === true,
        }
      }),
    )
  }

  /** Whether any of its agents can run here: it needs one, not all. */
  async probe(): Promise<HarnessProbe> {
    const found = await this.here()
    const ready = found.filter((one) => one.version !== null)
    if (ready.length > 0) {
      return {
        ok: true,
        version: ready.map((one) => `${one.agent.id} ${one.version}`).join(', '),
        problems: [],
      }
    }
    return {
      ok: false,
      version: null,
      problems: [
        `none of the agents it drives is installed: ${this.agents.map((one) => one.command).join(', ')}`,
      ],
    }
  }

  /**
   * ACP's own tool kinds, which every agent sorts its tools into: the lane
   * names a tool by its kind, so the policy never learns an agent's names.
   */
  effectOf(tool: string): ToolEffect {
    switch (tool) {
      case 'read':
      case 'search':
      case 'think':
        return 'read'
      case 'edit':
      case 'delete':
      case 'move':
        return 'write'
      case 'execute':
        return 'exec'
      default:
        return 'other'
    }
  }

  conversationKey(task: string): string {
    return conversationKey(task)
  }

  async hasConversation(task: string, _cwd: string): Promise<boolean> {
    return (await recordedIn(this.recordOf(task))).sessionId !== null
  }

  async spent(task: string, _cwd: string): Promise<HarnessSpend> {
    return spendOf(await recordedIn(this.recordOf(task)))
  }

  history(task: string, _cwd: string, ask: HistoryAsk): Promise<HistoryPage> {
    return historyOf(this.recordOf(task), ask)
  }

  /**
   * One for each agent that is here, on its own model: which models an
   * agent offers it says only inside a session, and starting one to ask
   * would leave a conversation behind in it.
   */
  async models(): Promise<HarnessModel[]> {
    const found = await this.here()
    return found
      .filter((one) => one.version !== null)
      .map(({ agent }) => ({
        id: `${agent.id}/default`,
        provider: agent.id,
        name: `${agent.title}, on its own model`,
      }))
  }

  /**
   * "gemini", "OpenCode", "goose/anthropic/claude-sonnet-5": an agent by name,
   * on its own model or the one after the slash, which the agent accepts or
   * refuses when its session starts.
   */
  async resolveModel(said: string): Promise<ModelFound> {
    const words = said.trim()
    const slash = words.indexOf('/')
    const head = slash < 0 ? words : words.slice(0, slash)
    const agent = agentNamed(this.agents, head)
    if (!agent) {
      return {
        ok: false,
        reason: `the acp harness drives ${this.agents.map((one) => one.id).join(', ')}: which is "${said}"?`,
      }
    }
    const model = slash < 0 ? 'default' : words.slice(slash + 1).trim() || 'default'
    return { ok: true, provider: agent.id, id: model }
  }

  /**
   * Each agent signs in its own way, and says it needs to only when a session
   * starts — which the lane does in front of the person, in the agent's own
   * words. So there is nobody to be signed in as here.
   */
  async account(): Promise<AccountStatus> {
    return {
      signedIn: false,
      who: null,
      plan: null,
      method: null,
      problem:
        'each agent keeps its own sign-in, and asks for it in its lane when a session starts',
    }
  }

  signIn(): SignIn | null {
    return null
  }

  async signOut(): Promise<void> {
    throw new Error('each ACP agent signs out its own way, in its own terminal')
  }

  limits(): PlanLimits | null {
    return null
  }

  async askLimits(): Promise<PlanLimits | null> {
    return null
  }

  async prepareAccount(_share: boolean): Promise<void> {}

  async carryConversation(_task: string, _cwd: string, _to: WorkerAdapter): Promise<boolean> {
    return false
  }

  /**
   * Tade's lane program, handed what it needs in a file beside the run: the
   * same line every time, so it is safe to write down and launch again.
   */
  launchSpec(spec: WorkerSpec): LaunchSpec {
    const launch = this.launchFile(spec.run)
    const said: LaneLaunch = {
      record: this.recordOf(spec.task),
      agent: spec.model?.provider ? spec.model.provider : null,
      model: spec.model?.id && spec.model.id !== 'default' ? spec.model.id : null,
      agents: [...this.agents],
      instructions: contextFor(spec),
      mcpServers: this.mcpServers(spec),
    }
    mkdirSync(join(this.opts.runDir, 'acp'), { recursive: true, mode: 0o700 })
    writeFileSync(launch, `${JSON.stringify(said, null, 2)}\n`, { mode: 0o600 })
    return {
      command: process.execPath,
      args: [LANE_PATH, launch],
      env: this.runEnv(spec),
      ...(spec.prompt
        ? { opening: [promptWithImages(spec.prompt, spec.images, this.filesDir(spec.run))] }
        : {}),
    }
  }

  async supervise(spec: WorkerSpec): Promise<WorkerHandle> {
    if (this.runs.has(spec.run)) throw new Error(`run already started: ${spec.run}`)
    const channel = await SignalChannel.listen({
      path: runSocket(this.opts.socketDir, spec.run),
      run: spec.run,
      onSignal: (signal) => this.dispatch(spec.run, signal),
      onWarning: this.opts.onWarning,
    })
    const handle: WorkerHandle = {
      run: spec.run,
      task: spec.task,
      sessionId: null,
      startedAt: Date.now(),
      lane: spec.lane ?? null,
      harness: ACP,
    }
    this.runs.set(spec.run, {
      handle,
      spec,
      channel,
      model: spec.model?.provider ? `${spec.model.provider}/${spec.model.id}` : null,
      turn: 'starting',
      held: new Set(),
    })
    return { ...handle }
  }

  async start(_spec: WorkerSpec): Promise<WorkerHandle> {
    throw new Error(`the acp harness ${this.capabilities.why.headless}`)
  }

  async prompt(
    run: RunId,
    message: string,
    images: readonly WorkerImage[] = [],
    _opts: { whenBusy?: 'steer' | 'queue' } = {},
  ): Promise<void> {
    // Held by the lane until the turn ends either way: ACP has no steering.
    this.send(this.require(run), {
      type: 'queue',
      message: promptWithImages(message, images, this.filesDir(run)),
    })
  }

  async steer(run: RunId, message: string): Promise<void> {
    this.send(this.require(run), { type: 'steer', message })
  }

  async queue(run: RunId, message: string): Promise<void> {
    this.send(this.require(run), { type: 'queue', message })
  }

  async decide(run: RunId, requestId: string, decision: PermissionDecision): Promise<void> {
    const entry = this.require(run)
    if (!entry.held.delete(requestId)) throw new PermissionNotPendingError(requestId)
    this.send(entry, {
      type: 'decision',
      requestId,
      allow: decision.allow,
      reason: decision.reason ?? '',
    })
  }

  async answer(run: RunId, callId: string, result: { ok: boolean; text: string }): Promise<void> {
    const entry = this.require(run)
    if (!entry.channel.connected) return
    entry.channel.send({ type: 'extension_result', callId, ok: result.ok, text: result.text })
  }

  async setModel(run: RunId, model: WorkerModel): Promise<void> {
    const entry = this.require(run)
    const agent = entry.model?.split('/')[0]
    if (model.provider && agent && model.provider !== agent) {
      throw new Error(
        `a conversation stays with the agent it started in (${agent}), so it cannot move to ${model.provider}: start a new task there instead`,
      )
    }
    this.send(entry, { type: 'model', provider: model.provider ?? '', id: model.id })
  }

  async setThinking(run: RunId, _level: ThinkingLevel): Promise<void> {
    this.require(run)
    throw new Error(`the acp harness ${this.capabilities.why.thinking}`)
  }

  async modelOf(run: RunId): Promise<WorkerModel | null> {
    const said = this.require(run).model
    if (!said) return null
    const slash = said.indexOf('/')
    return slash < 0 ? { id: said } : { provider: said.slice(0, slash), id: said.slice(slash + 1) }
  }

  async name(run: RunId, _title: string): Promise<void> {
    this.require(run)
    throw new Error(`the acp harness ${this.capabilities.why.rename}`)
  }

  async abort(run: RunId): Promise<void> {
    this.send(this.require(run), { type: 'abort' })
  }

  async compact(run: RunId): Promise<void> {
    this.require(run)
    throw new Error(`the acp harness ${this.capabilities.why.compact}`)
  }

  async stop(run: RunId): Promise<void> {
    const entry = this.runs.get(run)
    if (!entry) return
    if (entry.channel.connected) entry.channel.send({ type: 'shutdown' })
    this.runs.delete(run)
    await entry.channel.close()
  }

  onSignal(run: RunId, listener: WorkerSignalListener): Unsubscribe {
    let set = this.listeners.get(run)
    if (!set) {
      set = new Set()
      this.listeners.set(run, set)
    }
    set.add(listener)
    return () => {
      this.listeners.get(run)?.delete(listener)
    }
  }

  async list(): Promise<WorkerHandle[]> {
    return [...this.runs.values()].map((entry) => ({ ...entry.handle }))
  }

  async detach(): Promise<void> {
    const runs = [...this.runs.values()]
    this.runs.clear()
    await Promise.all(runs.map((entry) => entry.channel.close()))
  }

  async shutdown(): Promise<void> {
    for (const entry of this.runs.values()) {
      if (entry.channel.connected) entry.channel.send({ type: 'shutdown' })
    }
    await this.detach()
  }

  private dispatch(run: RunId, signal: WorkerSignal): void {
    const entry = this.runs.get(run)
    if (entry) {
      switch (signal.type) {
        case 'started':
          entry.handle.sessionId = signal.sessionId
          entry.model = signal.model ?? entry.model
          break
        case 'turn_started':
          entry.turn = 'running'
          break
        case 'idle':
          entry.turn = 'idle'
          break
        case 'permission_request':
          entry.held.add(signal.requestId)
          break
        case 'permission_resolved':
          entry.held.delete(signal.requestId)
          break
        default:
          break
      }
    }
    for (const listener of this.listeners.get(run) ?? []) {
      try {
        listener(signal)
      } catch {
        // A broken listener must never take the channel down with it.
      }
    }
  }

  private send(entry: Run, command: WorkerCommand): void {
    if (!entry.channel.connected) {
      throw new Error(
        `${entry.spec.run} is not connected to Tade yet: its lane has not started, or has ended`,
      )
    }
    entry.channel.send(command)
  }

  private require(run: RunId): Run {
    const entry = this.runs.get(run)
    if (!entry) throw new WorkerNotFoundError(run)
    return entry
  }

  private recordOf(task: string): string {
    return recordPath(this.opts.runDir, task)
  }

  private launchFile(run: string): string {
    return join(this.opts.runDir, 'acp', `${hashOf(run)}.launch.json`)
  }

  private filesDir(run: string): string {
    return join(this.opts.runDir, 'acp', hashOf(run))
  }

  private runEnv(spec: WorkerSpec): Record<string, string> {
    return {
      ...(spec.env ?? {}),
      [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
      [WORKER_ENV.run]: spec.run,
      [WORKER_ENV.task]: spec.task,
      [WORKER_ENV.approvals]: this.opts.approvals,
      ...(spec.extras?.tools ? { [WORKER_ENV.tools]: spec.extras.tools } : {}),
      ...(spec.title ? { [WORKER_ENV.title]: spec.title } : {}),
    }
  }

  /**
   * The MCP servers its session is handed: Tade's own tools, and the ones
   * extensions gave it, read out of the files they were written to and said
   * again in ACP's words. Every ACP agent takes a server over stdio; one over
   * HTTP is passed on only where the agent says it takes one (the lane asks).
   */
  private mcpServers(spec: WorkerSpec): McpServer[] {
    const env = (values: Record<string, string>) =>
      Object.entries(values).map(([name, value]) => ({ name, value }))
    const servers: McpServer[] = [
      {
        name: 'tade',
        command: process.execPath,
        args: [TOOLS_PATH],
        env: env({
          [WORKER_ENV.socket]: runSocket(this.opts.socketDir, spec.run),
          [WORKER_ENV.run]: spec.run,
          [WORKER_ENV.task]: spec.task,
          ...(spec.extras?.tools ? { [WORKER_ENV.tools]: spec.extras.tools } : {}),
        }),
      },
    ]
    for (const file of spec.extras?.mcp ?? []) {
      servers.push(...serversIn(file, this.opts.onWarning).filter((one) => one.name !== 'tade'))
    }
    return servers
  }
}

function hashOf(run: string): string {
  return createHash('sha1').update(run).digest('hex').slice(0, 12)
}

/** Where a run's supervision socket is: derived from the run, so both ends agree untold. */
export function runSocket(dir: string, run: string): string {
  return join(dir, `acp-${hashOf(run)}.sock`)
}

/** MCP servers in the standard's own file (`{ "mcpServers": { … } }`), as ACP takes them. */
export function serversIn(file: string, warn: (message: string) => void): McpServer[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch (err) {
    warn(`could not read the MCP servers in ${file} for an ACP agent: ${(err as Error).message}`)
    return []
  }
  const said = (parsed as { mcpServers?: unknown } | null)?.mcpServers
  if (typeof said !== 'object' || said === null) return []
  const out: McpServer[] = []
  for (const [name, raw] of Object.entries(said as Record<string, unknown>)) {
    if (typeof raw !== 'object' || raw === null) continue
    const one = raw as Record<string, unknown>
    const pairs = (value: unknown) =>
      typeof value === 'object' && value !== null
        ? Object.entries(value as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === 'string')
            .map(([key, v]) => ({ name: key, value: v }))
        : []
    if (typeof one.command === 'string') {
      out.push({
        name,
        command: one.command,
        args: Array.isArray(one.args) ? one.args.map(String) : [],
        env: pairs(one.env),
      })
    } else if (typeof one.url === 'string') {
      out.push({ type: 'http', name, url: one.url, headers: pairs(one.headers) })
    } else {
      warn(`the MCP server ${name} in ${file} is said in a shape ACP has no place for`)
    }
  }
  return out
}

/**
 * What Tade's extensions give this agent, in words: their instructions, and
 * the skills they ship, named with where to read them — an ACP agent has no
 * place of its own a client can put a skill.
 */
export function contextFor(spec: WorkerSpec): string {
  const parts: string[] = []
  if (spec.extras?.instructions) parts.push(spec.extras.instructions.trim())
  const skills = spec.extras?.skills ?? []
  if (skills.length > 0) {
    parts.push(
      [
        '## Skills Tade gives you',
        'Read one before doing what it covers.',
        ...skills.map((dir) => `- ${skillName(dir)} (read ${join(dir, 'SKILL.md')})`),
      ].join('\n'),
    )
  }
  return parts.join('\n\n')
}

function skillName(dir: string): string {
  return dir.split('/').filter(Boolean).at(-1) ?? dir
}

/** Pictures, as files it is told about: the lane is handed text, and an agent reads a file it is pointed at. */
function promptWithImages(
  message: string,
  images: readonly WorkerImage[] | undefined,
  dir: string,
): string {
  if (!images || images.length === 0) return message
  const folder = join(dir, 'attachments')
  mkdirSync(folder, { recursive: true, mode: 0o700 })
  const paths = images.map((image, n) => {
    const extension = image.mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'png'
    const path = join(folder, `${Date.now()}-${n + 1}.${extension}`)
    writeFileSync(path, Buffer.from(image.data, 'base64'), { mode: 0o600 })
    return path
  })
  return `${message}\n\n${paths.map((path) => `[picture: ${path}]`).join('\n')}`
}
