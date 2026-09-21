import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config, Note, SkillActivity, TadeEvent, ThinkingLevel, Unsubscribe } from '@tade/core'
import { composePrompt, expandHome, livingSkills, orchestratorRoute } from '@tade/core'
import {
  type HarnessModel,
  WORKER_ENV,
  type WorkerAdapter,
  type WorkerCapabilities,
  type WorkerExtras,
  type WorkerImage,
  type WorkerModel,
} from '@tade/harnesses-core'
import { sessionIdFor } from '@tade/harnesses-pi'
import { HARNESS_ADAPTERS } from '@tade/workbench/harnesses'
import { composeBriefing } from './briefing.ts'
import { activeSkills, enabledTools } from './extensions.ts'

/**
 * What Tade's own tools are told, whichever harness loads them: where to call
 * back to, where Tade keeps things, how to run the CLI that answers "where
 * are we" exactly as a person would see it, and which extension tools this
 * orchestrator was given.
 */
function toolEnv(opts: OrchestratorOptions): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(opts.env ?? process.env)) {
    if (typeof value === 'string') env[key] = value
  }
  env.TADE_SOCKET = opts.socket
  env.TADE_HOME = opts.home
  // Where extensions live, so the tools do not have to guess at paths the
  // config may have moved.
  env.TADE_EXTENSIONS = expandHome(
    opts.config?.orchestrator.extensions ?? join(opts.home, 'extensions'),
  )
  env.TADE_SKILLS = skillsRoot(opts)
  env.TADE_CLI = process.execPath
  env.TADE_CLI_ARGS = CLI_BIN
  // The extension tools listed for this run, said here rather than left to
  // whatever a harness happens to pass down to a server it spawns: pi's
  // adapter sets this from the same `extras`, and nobody promises Claude Code
  // hands its own environment to an MCP server, so an orchestrator on one
  // silently had fewer tools than an orchestrator on the other — a capability
  // difference nobody declared. Taken back out when there are none, because
  // Tade opened from inside an agent inherits that agent's list, and the
  // orchestrator's tools are not an agent's.
  if (opts.extensions?.extras.tools) env[WORKER_ENV.tools] = opts.extensions.extras.tools
  else delete env[WORKER_ENV.tools]
  return env
}

/**
 * An MCP server that serves Tade's own tools, written where the harness that
 * starts it can find it: the same tools pi loads as an extension, in the
 * terms a harness that speaks MCP takes them.
 *
 * Exported so a test can start exactly what a harness would start, from
 * exactly the bytes it would read.
 */
export function writeToolServer(opts: OrchestratorOptions): string {
  const path = join(opts.runDir, 'tade-tools.mcp.json')
  mkdirSync(opts.runDir, { recursive: true, mode: 0o700 })
  writeFileSync(
    path,
    `${JSON.stringify(
      {
        mcpServers: {
          tade: { type: 'stdio', command: process.execPath, args: [TOOLS_MCP], env: toolEnv(opts) },
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  )
  return path
}

/** Where approved lessons live, beside everything else Tade keeps. */
function skillsRoot(opts: { home: string }): string {
  return join(opts.home, 'skills')
}

// The thing you talk to. An agent like any other, except that its tools are
// Tade's own and nobody supervises it: it is the interface, not the work.

export const TOOLS_EXTENSION = fileURLToPath(new URL('./tools-extension.ts', import.meta.url))
/** The same tools, served over MCP to a harness that speaks it. */
export const TOOLS_MCP = fileURLToPath(new URL('./tools-mcp.ts', import.meta.url))
/** The `tade` CLI in a source checkout, which the status tool shells out to. */
const CLI_BIN = fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url))

export const ORCHESTRATOR_RUN = 'orchestrator'
export const ORCHESTRATOR_TASK = 'tade/orchestrator'
/**
 * The one conversation Tade has with you, for as long as this home exists.
 *
 * Named rather than generated, for the same reason an agent's session is:
 * pi creates a session with this id the first time and continues it every
 * time after, so closing Tade and opening it again is not a special case —
 * the same command line starts the conversation once and resumes it for ever.
 * A generated id was why reopening the window met someone who had never heard
 * of you.
 */
export const ORCHESTRATOR_SESSION = sessionIdFor(ORCHESTRATOR_TASK)

export interface OrchestratorOptions {
  /** Tade's state directory, passed through to the tools. */
  home: string
  /** The `ToolHost` socket its tools call back through. */
  socket: string
  /** Where the orchestrator's own session files live. */
  runDir: string
  /** Working directory for the session. */
  cwd?: string
  config?: Config
  /**
   * What you have told Tade, for the prompt. Passed in rather than fetched so
   * composing the prompt stays a pure function of facts.
   */
  notes?: readonly Note[]
  /**
   * What has happened lately, which decides which lessons still apply. Without
   * it nothing has happened anywhere, so every lesson about something in
   * particular is treated as quiet.
   */
  activity?: SkillActivity
  /** Supplied so the same facts always compose the same prompt. */
  now?: number
  model?: WorkerModel
  /** The models you can use, to settle which one a configured name means. Read from the harness unless given. */
  models?: () => Promise<HarnessModel[]>
  /**
   * What extensions add: the tools it may call (run by the window), what it is
   * told about them, and harness-native pieces they ship.
   */
  extensions?: { prompt: string; extras: WorkerExtras }
  /**
   * The journal, for the briefing it opens with: what happened while it was
   * not running, so a conversation that carries on knows the world moved.
   * Passed in rather than read here, so composing stays a pure function of
   * facts; without it the briefing is only what the queue says.
   */
  journal?: readonly TadeEvent[]
  /**
   * What is queued and scheduled, in the queue's own words — the same answer
   * `tade_queue` gives. Only a window has a queue, so only a window has this.
   */
  queue?: string
  /** Extra pi arguments. Tests use this to inject a scripted model. */
  args?: string[]
  env?: NodeJS.ProcessEnv
  /**
   * Start with none of the self-written extensions loaded. This is the way
   * back when one of them is what broke, so it must not depend on any of them.
   */
  safe?: boolean
  /**
   * What each of its own turns cost. The orchestrator is a model like any
   * agent, and spend that is not recorded is spend the window cannot show.
   */
  onUsage?: (usage: OrchestratorUsage) => void
  /** Something that went wrong but did not stop it: never swallowed. */
  onWarning?: (message: string) => void
}

export interface OrchestratorUsage {
  model: string | null
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  tokens: number
  usd: number
}

/**
 * Everything the orchestrator does that a person should be able to watch: what
 * it is saying as it says it, which tool it reached for with what, how that
 * went, and — the part that used to vanish — that it failed, and why.
 */
export type OrchestratorEvent =
  | { type: 'delta'; text: string }
  | { type: 'message'; text: string }
  | { type: 'tool'; id: string; tool: string; input: unknown }
  | { type: 'tool_done'; id: string; ok: boolean; text: string }
  | { type: 'idle' }
  | { type: 'failed'; reason: string }
  /** A turn the model could not finish — a refused request — while the harness keeps running. */
  | { type: 'error'; reason: string }
  | { type: 'exited'; code: number | null }

export class Orchestrator {
  private readonly adapter: WorkerAdapter
  private readonly messageListeners = new Set<(text: string) => void>()
  private readonly toolListeners = new Set<(tool: string) => void>()
  private readonly idleListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: OrchestratorEvent) => void>()
  private readonly errorListeners = new Set<(reason: string) => void>()
  /** Why it stopped, once it has: asking it anything after that cannot work. */
  private gone: string | null = null

  private constructor(adapter: WorkerAdapter) {
    this.adapter = adapter
  }

  /** What the harness it runs in can be asked to do: what a surface offers for it. */
  get capabilities(): WorkerCapabilities {
    return this.adapter.capabilities
  }

  static async start(opts: OrchestratorOptions): Promise<Orchestrator> {
    const route = opts.config ? orchestratorRoute(opts.config) : null
    const harness = route?.harness ?? 'pi'
    const make = HARNESS_ADAPTERS[harness]
    if (!make) {
      throw new Error(
        `no harness called ${harness}: Tade runs ${Object.keys(HARNESS_ADAPTERS).join(', ')}`,
      )
    }
    const adapter = make({
      runDir: opts.runDir,
      socketDir: opts.runDir,
      approvals: 'bypass',
      // Tade's own interface: gating its tool calls on an approval would mean
      // asking permission to answer "where are we".
      supervised: false,
      ...(opts.args ? { args: [...opts.args] } : {}),
    })
    // Drawn by Tade rather than drawing itself: a harness that cannot be run
    // that way can run agents, and says so rather than starting something
    // nobody can see.
    if (!adapter.capabilities.headless) {
      throw new Error(
        `${harness} ${adapter.capabilities.why.headless ?? 'cannot be the one you talk to'}: it runs agents`,
      )
    }
    // The exact model, settled before anything starts and among what this
    // harness offers: a name it cannot place makes it exit before it reads a
    // word, which looked like an orchestrator that never answered.
    const named = route?.model
      ? route.provider
        ? `${route.provider}/${route.model}`
        : route.model
      : null
    const found = opts.model || !named ? null : await adapter.resolveModel(named)
    if (found && !found.ok) throw new Error(found.reason)
    const model = opts.model ?? (found?.ok ? { provider: found.provider, id: found.id } : undefined)

    // Tade's own tools always load. The ones it wrote for itself load after
    // them, so a self-written tool can never shadow `status` or `approve` —
    // and only the ones somebody turned on load at all.
    const written = opts.safe
      ? []
      : enabledTools(
          expandHome(opts.config?.orchestrator.extensions ?? join(opts.home, 'extensions')),
          opts.config?.extensions ?? {},
        )

    // What it missed. The conversation comes back by itself; the world it was
    // talking about does not, so the journal is read back to it as of now.
    const briefing = composeBriefing({
      now: opts.now ?? Date.now(),
      events: opts.journal ?? [],
      ...(opts.queue ? { queue: opts.queue } : {}),
    })

    // What it is, and where things stood: one is true whenever it is read,
    // the other a snapshot with times on it, so they are said apart. Appended
    // to the harness's own instructions, never replacing them.
    const instructions = [
      opts.config
        ? composePrompt({
            config: opts.config,
            ...(opts.notes ? { notes: opts.notes } : {}),
            // Only the lessons that still apply: one about a project nobody
            // has touched in a month is noise in every prompt.
            skills: livingSkills(
              activeSkills(skillsRoot(opts)),
              opts.activity ?? { lastSeenAt: {}, known: Object.keys(opts.config.projects) },
              opts.now ?? Date.now(),
            ),
            ...(opts.extensions?.prompt ? { extensions: opts.extensions.prompt } : {}),
          })
        : '',
      briefing,
      opts.extensions?.extras.instructions ?? '',
    ]
      .filter(Boolean)
      .join('\n\n')

    // Tade's own tools, given to this harness the way it takes them: modules
    // it loads, or an MCP server it starts. Asked of the harness rather than
    // decided here, so a harness that speaks neither is told about, not
    // handed something it will ignore.
    const mine: WorkerExtras = { ...opts.extensions?.extras }
    if (adapter.capabilities.nativeExtensions) {
      // Tade's own load first, so a tool it wrote for itself can never shadow
      // `status` or `approve` — and only the ones somebody turned on load.
      mine.extensions = [TOOLS_EXTENSION, ...written, ...(mine.extensions ?? [])]
    } else if (adapter.capabilities.mcp) {
      mine.mcp = [...(mine.mcp ?? []), writeToolServer(opts)]
      if (written.length > 0) {
        opts.onWarning?.(
          `${harness} loads no extension modules, so the ${written.length} tool${written.length === 1 ? '' : 's'} Tade wrote for itself did not load`,
        )
      }
    } else {
      throw new Error(
        `${harness} cannot be given Tade's own tools: it takes neither an extension nor an MCP server`,
      )
    }
    if (instructions) mine.instructions = instructions

    const orchestrator = new Orchestrator(adapter)
    const emit = (event: OrchestratorEvent) => {
      for (const listener of orchestrator.eventListeners) listener(event)
    }
    adapter.onSignal(ORCHESTRATOR_RUN, (signal) => {
      if (signal.type === 'message') {
        for (const listener of orchestrator.messageListeners) listener(signal.text)
        emit({ type: 'message', text: signal.text })
      } else if (signal.type === 'message_delta') {
        emit({ type: 'delta', text: signal.text })
      } else if (signal.type === 'tool_call') {
        for (const listener of orchestrator.toolListeners) listener(signal.tool)
        emit({ type: 'tool', id: signal.callId, tool: signal.tool, input: signal.input })
      } else if (signal.type === 'tool_result') {
        emit({ type: 'tool_done', id: signal.callId, ok: signal.ok, text: signal.summary })
      } else if (
        (signal.type === 'turn_done' && signal.status === 'error') ||
        signal.type === 'problem'
      ) {
        const reason =
          signal.type === 'problem' ? signal.text : (signal.reason ?? 'the model returned an error')
        for (const listener of orchestrator.errorListeners) listener(reason)
        emit({ type: 'error', reason })
      } else if (signal.type === 'idle') {
        for (const listener of orchestrator.idleListeners) listener()
        emit({ type: 'idle' })
      } else if (signal.type === 'failed') {
        orchestrator.gone = signal.error
        emit({ type: 'failed', reason: signal.error })
      } else if (signal.type === 'exited') {
        orchestrator.gone ??=
          signal.code === 0 ? 'it stopped' : `it exited with code ${signal.code}`
        emit({ type: 'exited', code: signal.code })
        // Anyone waiting for it to finish a turn would wait forever.
        for (const listener of orchestrator.idleListeners) listener()
      } else if (signal.type === 'usage') {
        const { type: _type, run: _run, at: _at, ...usage } = signal
        opts.onUsage?.(usage)
      }
    })

    await adapter.start({
      run: ORCHESTRATOR_RUN,
      task: ORCHESTRATOR_TASK,
      cwd: opts.cwd ?? process.cwd(),
      prompt: '',
      ...(model ? { model } : {}),
      // How hard it thinks, from its first turn: chosen like an agent's, and
      // the harness's own default when nobody has.
      ...(route?.thinking ? { thinking: route.thinking } : {}),
      extras: mine,
      // What its tools need to find their way back to Tade, whichever harness
      // they are loaded into.
      env: toolEnv(opts),
    })
    // A harness that refused to start — a model it could not resolve, most
    // often — has already said why, and that is the answer to give.
    if (orchestrator.gone) throw new Error(orchestrator.gone)
    return orchestrator
  }

  /** Say something, with pictures if there are any. Replies arrive through `onMessage`. */
  async ask(text: string, images: readonly WorkerImage[] = []): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    await this.adapter.prompt(ORCHESTRATOR_RUN, text, images)
  }

  /**
   * Say something that is not an interruption: a turn of its own when it is
   * free, and after the turn it is on when it is not. What Tade tells it
   * unasked arrives this way, so it never cuts across what you asked.
   */
  async tell(text: string): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    await this.adapter.prompt(ORCHESTRATOR_RUN, text, [], { whenBusy: 'queue' })
  }

  /** What it could run on, as its own harness offers them. */
  models(): Promise<HarnessModel[]> {
    return this.adapter.models().catch(() => [])
  }

  /** A model said the way people say it, among its harness's. Throws what to ask. */
  async resolveModel(said: string): Promise<{ provider: string; id: string }> {
    const found = await this.adapter.resolveModel(said)
    if (!found.ok) throw new Error(found.reason)
    return { provider: found.provider, id: found.id }
  }

  /** Why it is not running, or null while it is. */
  get stopped(): string | null {
    return this.gone
  }

  /** The model it is actually thinking with, as the harness reports it. */
  model(): Promise<WorkerModel | null> {
    return this.adapter.modelOf(ORCHESTRATOR_RUN)
  }

  /**
   * How hard it thinks, from its next reply on. Asked of the process it is
   * already in — unlike a model, which it is restarted on — so the
   * conversation carries on mid-sentence.
   */
  async setThinking(level: ThinkingLevel): Promise<void> {
    if (this.gone) throw new Error(`The orchestrator is not running: ${this.gone}`)
    await this.adapter.setThinking(ORCHESTRATOR_RUN, level)
  }

  /**
   * Say something and wait for the answer, for surfaces that speak in turns.
   *
   * Bounded on purpose: a surface that waits forever on a thinking agent is a
   * surface that has hung, and saying so is better than looking broken.
   */
  async askFor(
    text: string,
    timeoutMs = 120_000,
    images: readonly WorkerImage[] = [],
  ): Promise<string> {
    const parts: string[] = []
    const errors: string[] = []
    const offMessage = this.onMessage((part) => parts.push(part))
    const offError = this.onError((reason) => errors.push(reason))
    let offIdle: Unsubscribe = () => {}
    const settled = new Promise<void>((resolve) => {
      offIdle = this.onIdle(resolve)
    })
    try {
      await this.ask(text, images)
      const timer = new Promise<'slow'>((resolve) => {
        const handle = setTimeout(() => resolve('slow'), timeoutMs)
        handle.unref?.()
      })
      if ((await Promise.race([settled.then(() => 'done' as const), timer])) === 'slow') {
        return parts.join(' ').trim() || 'Still thinking about that one.'
      }
      if (this.gone && parts.length === 0) return `The orchestrator stopped: ${this.gone}`
      if (parts.length === 0 && errors.length > 0) {
        return `The orchestrator could not answer: ${errors.at(-1)}`
      }
      return parts.join(' ').trim()
    } finally {
      offError()
      offMessage()
      offIdle()
    }
  }

  onMessage(listener: (text: string) => void): Unsubscribe {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  /** Fires when a turn ends in an error the model could not get past. */
  onError(listener: (reason: string) => void): Unsubscribe {
    this.errorListeners.add(listener)
    return () => this.errorListeners.delete(listener)
  }

  /** Which tool it reached for, so a surface can show its working. */
  onTool(listener: (tool: string) => void): Unsubscribe {
    this.toolListeners.add(listener)
    return () => this.toolListeners.delete(listener)
  }

  /** Everything it does, as it does it. */
  onEvent(listener: (event: OrchestratorEvent) => void): Unsubscribe {
    this.eventListeners.add(listener)
    return () => this.eventListeners.delete(listener)
  }

  /** Fires when it has finished and is waiting on you. */
  onIdle(listener: () => void): Unsubscribe {
    this.idleListeners.add(listener)
    return () => this.idleListeners.delete(listener)
  }

  async stop(): Promise<void> {
    await this.adapter.shutdown()
  }
}
