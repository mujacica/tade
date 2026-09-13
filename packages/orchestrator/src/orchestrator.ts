import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Config, Note, SkillActivity, Unsubscribe } from '@wilco/core'
import { composePrompt, expandHome, livingSkills, orchestratorRoute } from '@wilco/core'
import type { WorkerImage, WorkerModel } from '@wilco/harnesses-core'
import { type AvailableModel, chooseModel, PiAdapter, usableModels } from '@wilco/harnesses-pi'
import { activeExtensions, activeSkills } from './extensions.ts'

/** Where approved lessons live, beside everything else Wilco keeps. */
function skillsRoot(opts: { home: string }): string {
  return join(opts.home, 'skills')
}

// The thing you talk to. An agent like any other, except that its tools are
// Wilco's own and nobody supervises it: it is the interface, not the work.

export const TOOLS_EXTENSION = fileURLToPath(new URL('./tools-extension.ts', import.meta.url))
/** The `wilco` CLI in a source checkout, which the status tool shells out to. */
const CLI_BIN = fileURLToPath(new URL('../../cli/src/bin.ts', import.meta.url))

export const ORCHESTRATOR_RUN = 'orchestrator'
export const ORCHESTRATOR_TASK = 'wilco/orchestrator'

export interface OrchestratorOptions {
  /** Wilco's state directory, passed through to the tools. */
  home: string
  /** The `ToolHost` socket its tools call back through. */
  socket: string
  /** Where the orchestrator's own session files live. */
  runDir: string
  /** Working directory for the session. */
  cwd?: string
  config?: Config
  /**
   * What you have told Wilco, for the prompt. Passed in rather than fetched so
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
  models?: () => Promise<AvailableModel[]>
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
  | { type: 'exited'; code: number | null }

export class Orchestrator {
  private readonly adapter: PiAdapter
  private readonly messageListeners = new Set<(text: string) => void>()
  private readonly toolListeners = new Set<(tool: string) => void>()
  private readonly idleListeners = new Set<() => void>()
  private readonly eventListeners = new Set<(event: OrchestratorEvent) => void>()
  /** Why it stopped, once it has: asking it anything after that cannot work. */
  private gone: string | null = null

  private constructor(adapter: PiAdapter) {
    this.adapter = adapter
  }

  static async start(opts: OrchestratorOptions): Promise<Orchestrator> {
    const route = opts.config ? orchestratorRoute(opts.config) : null
    // The exact model, chosen from what you are signed in to: a bare name the
    // harness finds under several providers makes it exit before it reads a
    // word, which looked like an orchestrator that never answered.
    const choice = opts.model
      ? null
      : chooseModel(route ?? {}, route?.model ? await (opts.models ?? usableModels)() : [])
    if (choice && !choice.ok) throw new Error(choice.reason)
    const model =
      opts.model ?? (choice?.ok ? { provider: choice.provider, id: choice.id } : undefined)

    // Wilco's own tools always load. The ones it wrote for itself load after
    // them, so a self-written tool can never shadow `status` or `approve`.
    const written = opts.safe
      ? []
      : activeExtensions(
          expandHome(opts.config?.orchestrator.extensions ?? join(opts.home, 'extensions')),
        )

    const adapter = new PiAdapter({
      runDir: opts.runDir,
      // Wilco's own interface: gating its tool calls on approval would mean
      // asking permission to answer "where are we".
      supervise: false,
      args: [
        '-e',
        TOOLS_EXTENSION,
        ...written.flatMap((path) => ['-e', path]),
        // Appended rather than replacing pi's own prompt: this says what Wilco
        // is and what is on this machine, not how to be a coding agent.
        ...(opts.config
          ? [
              '--append-system-prompt',
              composePrompt({
                config: opts.config,
                ...(opts.notes ? { notes: opts.notes } : {}),
                // Only the lessons that still apply: one about a project
                // nobody has touched in a month is noise in every prompt.
                skills: livingSkills(
                  activeSkills(skillsRoot(opts)),
                  opts.activity ?? { lastSeenAt: {}, known: Object.keys(opts.config.projects) },
                  opts.now ?? Date.now(),
                ),
              }),
            ]
          : []),
        ...(opts.args ?? []),
      ],
      env: {
        ...(opts.env ?? process.env),
        WILCO_SOCKET: opts.socket,
        WILCO_HOME: opts.home,
        // Where proposals are written, so the tools do not have to guess at
        // paths the config may have moved.
        WILCO_EXTENSIONS: expandHome(
          opts.config?.orchestrator.extensions ?? join(opts.home, 'extensions'),
        ),
        WILCO_SKILLS: skillsRoot(opts),
        WILCO_CLI: process.execPath,
        WILCO_CLI_ARGS: CLI_BIN,
      },
    })

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

  /** Why it is not running, or null while it is. */
  get stopped(): string | null {
    return this.gone
  }

  /** The model it is actually thinking with, as the harness reports it. */
  model(): Promise<WorkerModel | null> {
    return this.adapter.model(ORCHESTRATOR_RUN)
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
    const offMessage = this.onMessage((part) => parts.push(part))
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
      return parts.join(' ').trim()
    } finally {
      offMessage()
      offIdle()
    }
  }

  onMessage(listener: (text: string) => void): Unsubscribe {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
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
