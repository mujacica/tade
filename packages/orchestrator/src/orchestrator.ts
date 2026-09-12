import { fileURLToPath } from 'node:url'
import type { Config, Unsubscribe, WorkerModel } from '@wilco/core'
import { orchestratorRoute } from '@wilco/core'
import { PiAdapter } from '@wilco/harness-pi'

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
  /** Daemon socket the tools talk to. */
  socket: string
  /** Where the orchestrator's own session files live. */
  runDir: string
  /** Working directory for the session. */
  cwd?: string
  config?: Config
  model?: WorkerModel
  /** Extra pi arguments. Tests use this to inject a scripted model. */
  args?: string[]
  env?: NodeJS.ProcessEnv
}

export class Orchestrator {
  private readonly adapter: PiAdapter
  private readonly messageListeners = new Set<(text: string) => void>()
  private readonly toolListeners = new Set<(tool: string) => void>()
  private readonly idleListeners = new Set<() => void>()

  private constructor(adapter: PiAdapter) {
    this.adapter = adapter
  }

  static async start(opts: OrchestratorOptions): Promise<Orchestrator> {
    const route = opts.config ? orchestratorRoute(opts.config) : null
    const model =
      opts.model ??
      (route?.model
        ? { id: route.model, ...(route.provider ? { provider: route.provider } : {}) }
        : undefined)

    const adapter = new PiAdapter({
      runDir: opts.runDir,
      // Wilco's own interface: gating its tool calls on approval would mean
      // asking permission to answer "where are we".
      supervise: false,
      args: ['-e', TOOLS_EXTENSION, ...(opts.args ?? [])],
      env: {
        ...(opts.env ?? process.env),
        WILCO_SOCKET: opts.socket,
        WILCO_HOME: opts.home,
        WILCO_CLI: process.execPath,
        WILCO_CLI_ARGS: CLI_BIN,
      },
    })

    const orchestrator = new Orchestrator(adapter)
    adapter.onSignal(ORCHESTRATOR_RUN, (signal) => {
      if (signal.type === 'message') {
        for (const listener of orchestrator.messageListeners) listener(signal.text)
      } else if (signal.type === 'tool_call') {
        for (const listener of orchestrator.toolListeners) listener(signal.tool)
      } else if (signal.type === 'idle') {
        for (const listener of orchestrator.idleListeners) listener()
      }
    })

    await adapter.start({
      run: ORCHESTRATOR_RUN,
      task: ORCHESTRATOR_TASK,
      cwd: opts.cwd ?? process.cwd(),
      prompt: '',
      ...(model ? { model } : {}),
    })
    return orchestrator
  }

  /** Say something. Replies arrive through `onMessage`. */
  async ask(text: string): Promise<void> {
    await this.adapter.prompt(ORCHESTRATOR_RUN, text)
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

  /** Fires when it has finished and is waiting on you. */
  onIdle(listener: () => void): Unsubscribe {
    this.idleListeners.add(listener)
    return () => this.idleListeners.delete(listener)
  }

  async stop(): Promise<void> {
    await this.adapter.shutdown()
  }
}
