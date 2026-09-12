import { join } from 'node:path'
import {
  type Component,
  ProcessTerminal,
  type Terminal,
  TuiAltScreen,
  type TuiInputListenerResult,
} from '@earendil-works/pi-tui'
import type { Config, LaneId } from '@wilco/core'
import type { DaemonClient } from '@wilco/daemon/client'
import { Speaker, VoiceSurface } from '@wilco/surface-voice'
import { appKey } from './keys.ts'
import { knownTasks, Live } from './live.ts'
import {
  type AppState,
  addTurn,
  focusBy,
  initialState,
  keyAction,
  noteTyping,
  notice,
  onEvent,
  setDictation,
  setListening,
  setQuestion,
  withTasks,
} from './model.ts'
import { renderApp } from './view.ts'

// The window: every project down the side, the agent you are watching in the
// middle, the orchestrator along the bottom.
//
// This file only wires things together. What it should show is in `model.ts`,
// how it looks is in `view.ts`, and where the facts come from is in `live.ts`,
// so all three can be tested without a terminal.

/** How often a lane's screen is re-read. */
const FRAME_MS = 250

/** Backspace, and what some terminals send instead. */
const BACKSPACE = /^(\x7f|\b)$/

class Window implements Component {
  private readonly frame: () => { state: AppState; screen: string; height: number }

  constructor(frame: () => { state: AppState; screen: string; height: number }) {
    this.frame = frame
  }

  render(width: number): string[] {
    const { state, screen, height } = this.frame()
    return renderApp(state, { width, height, screen })
  }

  invalidate(): void {
    // Nothing is cached: every frame is drawn from the state as it is.
  }
}

export interface AppOptions {
  client: DaemonClient
  config: Config
  /** Wilco's state directory, where generated earcons are kept. */
  home: string
  cwd?: string
  terminal?: Terminal
  speaker?: Speaker
  now?: () => number
  frameMs?: number
}

export class App {
  private readonly opts: AppOptions
  private readonly terminal: Terminal
  private readonly tui: TuiAltScreen
  private state: AppState = initialState()
  private screen = ''
  private live: Live | null = null
  private voice: VoiceSurface | null = null
  private timer: NodeJS.Timeout | null = null
  private release: (() => void) | null = null
  private stopped = false
  private settle: () => void = () => {}
  private readonly closed: Promise<void>

  private constructor(opts: AppOptions) {
    this.opts = opts
    this.terminal = opts.terminal ?? new ProcessTerminal()
    this.tui = new TuiAltScreen(this.terminal)
    this.closed = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  static async start(opts: AppOptions): Promise<App> {
    const app = new App(opts)
    await app.begin()
    return app
  }

  /** Resolves when the window has been closed. */
  wait(): Promise<void> {
    return this.closed
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.release?.()
    this.tui.stop()
    await this.voice?.stop()
    await this.live?.stop()
    this.settle()
  }

  private async begin(): Promise<void> {
    // Held as a local as well as a field: the surface below closes over it, so
    // it never has to wonder whether there is one.
    const live = await Live.start({
      client: this.opts.client,
      config: this.opts.config,
      home: this.opts.home,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      onTasks: (tasks) => {
        this.state = withTasks(this.state, tasks)
        this.draw()
      },
      onEvent: (event) => {
        this.state = onEvent(this.state, event, this.now())
        this.draw()
      },
      onWarning: (message) => {
        this.state = notice(this.state, message)
        this.draw()
      },
    })
    this.live = live

    this.voice = await VoiceSurface.start({
      daemon: this.opts.client,
      speaker:
        this.opts.speaker ?? (await Speaker.create({ soundDir: join(this.opts.home, 'sounds') })),
      vocabulary: async () => vocabulary(live.tasks),
      status: async (scope) => this.describe(scope),
      worktreeOf: async (task) => live.worktreeOf(task),
      tasks: async () => knownTasks(live.tasks),
      history: async () => live.history,
      ...(this.opts.now ? { now: this.opts.now } : {}),
      // Typing at an agent is what mutes speech for that task.
      focusedTask: () => ({ task: this.state.focused, lastInputAt: this.state.lastInputAt }),
      onTurn: (turn) => {
        this.state = addTurn(this.state, turn)
        this.state = setQuestion(this.state, this.voice?.awaiting ?? null)
        this.draw()
      },
    })

    this.tui.addChild(
      new Window(() => ({
        state: this.state,
        screen: this.screen,
        height: Math.max(6, this.terminal.rows),
      })),
    )
    this.release = this.tui.addInputListener((data) => this.onInput(data))
    this.tui.start()
    this.timer = setInterval(() => void this.tick(), this.opts.frameMs ?? FRAME_MS)
    this.timer.unref?.()
    await this.tick()
  }

  /**
   * Every keystroke lands here first. The shell claims the few it needs and
   * everything else is typed into the agent you are watching, so an agent's
   * own keybindings keep working.
   */
  private onInput(data: string): TuiInputListenerResult {
    if (this.stopped) return undefined
    const kitty = kittyActive(this.terminal)
    const key = appKey(data, { kitty, listening: this.state.listening })
    const action = key ? keyAction(key, this.state) : { kind: 'none' as const }

    switch (action.kind) {
      case 'focus-next':
        this.state = focusBy(this.state, 1)
        this.draw()
        return { consume: true }
      case 'focus-previous':
        this.state = focusBy(this.state, -1)
        this.draw()
        return { consume: true }
      case 'talk-start':
        this.state = setListening(setDictation(this.state, ''), true)
        this.draw()
        return { consume: true }
      case 'talk-stop':
        this.submit()
        return { consume: true }
      case 'approve':
        void this.decide(true)
        return { consume: true }
      case 'deny':
        void this.decide(false)
        return { consume: true }
      case 'help':
        this.state = notice(
          this.state,
          'tab switches · ctrl+space talks · a/d answers · ctrl+c quits',
        )
        this.draw()
        return { consume: true }
      case 'quit':
        void this.stop()
        return { consume: true }
      default:
        break
    }

    // Dictating: the line is being typed, not the agent.
    if (this.state.dictation !== null) {
      this.type(data)
      return { consume: true }
    }
    this.toLane(data)
    return undefined
  }

  /** Edit the dictation line. Enter sends it, as holding the key again would. */
  private type(data: string): void {
    if (data === '\r' || data === '\n') {
      this.submit()
      return
    }
    const current = this.state.dictation ?? ''
    if (BACKSPACE.test(data)) {
      this.state = setDictation(this.state, current.slice(0, -1))
    } else if (data === '\x1b') {
      // Escape abandons it rather than sending half a sentence.
      this.state = setListening(setDictation(this.state, null), false)
    } else if (!data.startsWith('\x1b')) {
      this.state = setDictation(this.state, current + data)
    }
    this.draw()
  }

  /** Hand what was said to the surface, which works out who you meant. */
  private submit(): void {
    const said = (this.state.dictation ?? '').trim()
    this.state = setListening(setDictation(this.state, null), false)
    this.draw()
    if (said === '' || !this.voice) return
    void this.voice
      .handle(said)
      .then(() => {
        this.state = setQuestion(this.state, this.voice?.awaiting ?? null)
        this.draw()
      })
      .catch((err: unknown) => {
        this.state = notice(this.state, err instanceof Error ? err.message : String(err))
        this.draw()
      })
  }

  /** Type into the agent you are watching, and hold focus while you do. */
  private toLane(data: string): void {
    const pane = this.state.panes.find((p) => p.task === this.state.focused)
    this.state = noteTyping(this.state, this.now())
    if (!pane?.lane) return
    void this.opts.client.write(pane.lane as LaneId, data).catch(() => {})
  }

  /** Answer what the focused agent is waiting on. */
  private async decide(allow: boolean): Promise<void> {
    const task = this.state.focused
    if (!task) return
    try {
      const [pending] = await this.opts.client.pendingApprovals(task)
      if (!pending) return
      await this.opts.client.decideApproval(pending.run, pending.requestId, {
        allow,
        ...(allow ? {} : { reason: 'denied from the window' }),
      })
      this.state = notice(this.state, `${allow ? 'approved' : 'denied'}: ${pending.summary}`)
    } catch (err) {
      this.state = notice(this.state, err instanceof Error ? err.message : String(err))
    }
    this.draw()
  }

  /** Re-read the focused lane's screen. */
  private async tick(): Promise<void> {
    if (this.stopped) return
    const pane = this.state.panes.find((p) => p.task === this.state.focused)
    const screen = await (this.live?.capture(pane?.lane ?? null, this.terminal.rows) ?? '')
    if (screen !== this.screen) {
      this.screen = screen
      this.draw()
    }
  }

  private describe(scope: string | null): string {
    const tasks = this.live?.tasks ?? []
    const wanted = scope
      ? tasks.filter((t) => t.task === scope || t.task.startsWith(`${scope}/`))
      : tasks
    if (wanted.length === 0) return scope ? `nothing going on in ${scope}.` : 'nothing going on.'
    const blocked = wanted.filter((t) => t.waiting || t.state === 'blocked').length
    const working = wanted.filter((t) => t.state === 'working').length
    const parts = [`${wanted.length} task${wanted.length === 1 ? '' : 's'}`]
    if (working > 0) parts.push(`${working} working`)
    parts.push(blocked > 0 ? `${blocked} waiting on you` : 'nothing blocked')
    return `${parts.join(', ')}.`
  }

  private draw(): void {
    if (!this.stopped) this.tui.requestRender()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

function vocabulary(tasks: readonly { task: string }[]): { tasks: string[]; projects: string[] } {
  const projects = new Set<string>()
  for (const task of tasks) projects.add(task.task.split('/')[0] ?? task.task)
  return { tasks: tasks.map((t) => t.task), projects: [...projects] }
}

/** Only some terminals report key releases, which is what holding a key needs. */
function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}
