import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  type Component,
  ProcessTerminal,
  type Terminal,
  TuiAltScreen,
  type TuiInputListenerResult,
} from '@earendil-works/pi-tui'
import {
  type Config,
  DEFAULT_ATTENTION,
  describeWork,
  type LaneId,
  needsReflection,
  parseQuietHours,
  reflectionPrompt,
} from '@wilco/core'
import {
  type AudioClip,
  type Recorder,
  type Recording,
  type Transcriber,
  VoiceSurface,
} from '@wilco/voice-core'
import { Speaker } from '@wilco/voice-tts'
import type { Workbench } from '@wilco/workbench'
import { appKey } from './keys.ts'
import { asRemembered, type LayoutPrefs, type RememberedWindow } from './layout.ts'
import { knownTasks, Live } from './live.ts'
import type { TaskSnapshot } from './model.ts'
import {
  type AppState,
  addTurn,
  focusBy,
  focusTask,
  initialState,
  keyAction,
  matchActions,
  noteTyping,
  notice,
  onEvent,
  setDictation,
  setHeld,
  setListening,
  setQuestion,
  withTasks,
} from './model.ts'
import { initialRouter, pending, type RouterState, route } from './router.ts'
import { runScreen, ScreenCancelled, type Ui } from './screen.ts'
import { addProject, editSettings } from './settings.ts'
import { renderApp } from './view.ts'

// The window: every project down the side, the agent you are watching in the
// middle, the orchestrator along the bottom.
//
// This file only wires things together. What it should show is in `model.ts`,
// how it looks is in `view.ts`, and where the facts come from is in `live.ts`,
// so all three can be tested without a terminal.

/** How often a lane's screen is re-read. */
const FRAME_MS = 250

/** A stuck key must not record until the disk is full. */
const MAX_SPEECH_MS = 120_000

/** Backspace, and what some terminals send instead. */
const BACKSPACE = /^(\x7f|\b)$/

const HELP = 'tab moves · / lists commands · ctrl+space talks · ctrl+c quits'

/** A printable key, which is somebody starting to type rather than a shortcut. */
function printable(data: string): boolean {
  return data.length === 1 && data >= ' ' && data !== '\x7f'
}

/** A short, filesystem-safe name from what somebody said they wanted done. */
function slugify(intent: string): string {
  const words = intent
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
  return words.split('-').slice(0, 3).join('-') || 'task'
}

class Window implements Component {
  private readonly frame: () => {
    state: AppState
    screen: string
    height: number
    layout: LayoutPrefs
  }

  constructor(frame: Window['frame']) {
    this.frame = frame
  }

  render(width: number): string[] {
    const { state, screen, height, layout } = this.frame()
    return renderApp(state, { width, height, screen, layout })
  }

  invalidate(): void {
    // Nothing is cached: every frame is drawn from the state as it is.
  }
}

export interface AppOptions {
  client: Workbench
  config: Config
  /** Wilco's state directory, where generated earcons are kept. */
  home: string
  cwd?: string
  terminal?: Terminal
  speaker?: Speaker
  /** Push-to-talk becomes speech when both of these are given. */
  transcriber?: Transcriber
  recorder?: Recorder
  /**
   * Where anything the grammar does not recognise goes. Without it, free text
   * gets "I didn't catch that", which is a poor answer to a real question.
   */
  thinker?: { ask(text: string): Promise<string> }
  now?: () => number
  frameMs?: number
}

export class App {
  private readonly opts: AppOptions
  private readonly terminal: Terminal
  private readonly tui: TuiAltScreen
  private state: AppState = initialState()
  private screen = ''
  private recording: Recording | null = null
  /** Where you were last time, applied once the tasks are known. */
  private remembered: RememberedWindow | null = null
  private restored = false
  /** Tasks being looked back at right now, so two polls cannot double up. */
  private readonly reflecting = new Set<string>()
  /** Another screen has the terminal, so this window must not draw over it. */
  private borrowed = false
  private router: RouterState = initialRouter()
  /** Which agent the router's half-typed line belongs to. */
  private routerFor: string | null = null
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
    this.remember()
    this.release?.()
    this.tui.stop()
    // Leave the terminal as it was found. The alternate screen is restored by
    // the TUI, but whatever was painted before it goes back is a half-window
    // stranded in your scrollback.
    this.terminal.clearScreen()
    await this.voice?.stop()
    await this.live?.stop()
    this.settle()
  }

  /** Where the window writes down what it wants back next time. */
  private get memoryFile(): string {
    return join(this.opts.home, 'window.json')
  }

  private recall(): RememberedWindow | null {
    try {
      return asRemembered(JSON.parse(readFileSync(this.memoryFile, 'utf8')))
    } catch {
      // Never opened before, or a file we cannot read. Neither is a problem.
      return null
    }
  }

  private remember(): void {
    try {
      const kept: RememberedWindow = { focused: this.state.focused }
      writeFileSync(this.memoryFile, `${JSON.stringify(kept, null, 2)}\n`)
    } catch {
      // Coming back to the same pane is a convenience, not a reason to fail
      // on the way out.
    }
  }

  /** Sizes from the config. The terminal has the last word on all of them. */
  private layout(): LayoutPrefs {
    const window = this.opts.config.surfaces.window
    return {
      ...(window.sidebar_width ? { sidebarWidth: window.sidebar_width } : {}),
      ...(window.strip_height ? { stripHeight: window.strip_height } : {}),
    }
  }

  private async begin(): Promise<void> {
    this.remembered = this.recall()
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
        // Focus can only be restored once there are panes to restore it to,
        // and only the first time: after that it is wherever you moved to.
        if (!this.restored && this.remembered?.focused) {
          this.state = focusTask(this.state, this.remembered.focused)
          this.restored = this.state.panes.length > 0
        }
        void this.reflect(tasks)
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

    const attention = this.opts.config.surfaces.voice.attention
    this.voice = await VoiceSurface.start({
      wilco: this.opts.client,
      // Yours, where it is a matter of taste. Everything else about what is
      // worth interrupting you for is the engine's, and not a setting.
      settings: {
        ...DEFAULT_ATTENTION.voice,
        ...(attention.budget === undefined ? {} : { budget: attention.budget }),
        quiet: parseQuietHours(attention.quiet) ?? DEFAULT_ATTENTION.voice.quiet,
      },
      speaker:
        this.opts.speaker ?? (await Speaker.create({ soundDir: join(this.opts.home, 'sounds') })),
      vocabulary: async () => vocabulary(live.tasks),
      status: async (scope) => this.describe(scope),
      worktreeOf: async (task) => live.worktreeOf(task),
      show: async (task) => this.show(task),
      openSettings: async () => this.openSettings(),
      tasks: async () => knownTasks(live.tasks),
      history: async () => live.history,
      ...(this.opts.thinker
        ? { ask: (text: string) => this.opts.thinker?.ask(text) ?? Promise.resolve('') }
        : {}),
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
        layout: this.layout(),
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
        void this.talkStart()
        return { consume: true }
      case 'talk-stop':
        void this.talkStop()
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
    // Nothing focused means the orchestrator is, and it is a thing you type
    // at: a window with no agents used to swallow every keystroke.
    if (this.state.focused === null && printable(data)) {
      this.state = setDictation(this.state, data)
      this.draw()
      return { consume: true }
    }
    this.toLane(data)
    return undefined
  }

  /**
   * Push-to-talk. Speech where it is configured and working, the typed line
   * everywhere else — both end up at `say`, so nothing downstream knows or
   * cares which one you used.
   */
  private async talkStart(): Promise<void> {
    const recorder = this.opts.recorder
    if (!recorder) {
      this.state = setListening(setDictation(this.state, ''), true)
      this.draw()
      return
    }
    try {
      this.recording = await recorder.start({ maxMs: MAX_SPEECH_MS })
      this.state = setListening(notice(this.state, 'listening'), true)
    } catch (err) {
      // Say why, once, then fall back to typing rather than swallowing it.
      this.state = setListening(setDictation(notice(this.state, why(err)), ''), true)
    }
    this.draw()
  }

  private async talkStop(): Promise<void> {
    const recording = this.recording
    const transcriber = this.opts.transcriber
    this.recording = null
    if (!recording || !transcriber) {
      this.submit()
      return
    }

    this.state = setListening(notice(this.state, 'transcribing'), false)
    this.draw()
    let clip: AudioClip | null = null
    try {
      clip = await recording.stop()
      // Task and project names are the words a general model gets wrong.
      const words = vocabulary(this.live?.tasks ?? [])
      const heard = await transcriber.transcribe(clip, {
        vocabulary: [...words.tasks, ...words.projects],
      })
      this.state = notice(this.state, heard.text ? null : 'nothing heard')
      this.draw()
      this.say(heard.text)
    } catch (err) {
      this.state = notice(this.state, why(err))
      this.draw()
    } finally {
      if (clip) rmSync(clip.path, { force: true })
    }
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
    // A command is carried out here; anything else is a sentence for Wilco.
    if (said.startsWith('/')) {
      void this.act(said)
      return
    }
    this.say(said)
  }

  /**
   * Carry out a slash command.
   *
   * The ones that need more than a word borrow the whole terminal for a moment
   * — the same screen the settings use — because a form squeezed into three
   * rows of a strip is worse than one that has room.
   */
  private async act(said: string): Promise<void> {
    const [chosen] = matchActions(this.state, said)
    if (!chosen) {
      this.state = notice(this.state, `no command like ${said}`)
      this.draw()
      return
    }
    if (!chosen.ready) {
      this.state = notice(this.state, chosen.about)
      this.draw()
      return
    }
    switch (chosen.name) {
      case '/quit':
        void this.stop()
        return
      case '/help':
        this.state = notice(this.state, HELP)
        this.draw()
        return
      case '/open': {
        const task = await this.pick(
          'Which task?',
          this.state.panes.map((pane) => pane.task),
        )
        if (task) this.state = focusTask(this.state, task)
        this.draw()
        return
      }
      default:
        await this.onScreen(chosen.name)
    }
  }

  /** Ask, on a screen of its own, and put the window back afterwards. */
  private async onScreen(command: string): Promise<void> {
    if (this.borrowed) return
    this.borrowed = true
    this.tui.stop()
    try {
      await runScreen(
        { title: command, context: [join(this.opts.home, 'config.yaml')], terminal: this.terminal },
        async (ui) => {
          try {
            const done = await this.runCommand(command, ui)
            if (done) this.state = notice(this.state, done)
          } catch (err) {
            // Shown here and waited on, rather than thrown out to a window
            // that is about to redraw over it: an explanation that leaves with
            // the screen is an explanation nobody read.
            if (err instanceof ScreenCancelled) throw err
            await ui.pause(`  ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      )
    } catch (err) {
      // ctrl+c closes the form, not Wilco.
      if (!(err instanceof ScreenCancelled)) {
        this.state = notice(this.state, err instanceof Error ? err.message : String(err))
      }
    } finally {
      this.borrowed = false
      this.tui.start()
      this.draw()
    }
  }

  /** One short list, on a screen, because three rows is not enough to choose in. */
  private async pick(question: string, options: string[]): Promise<string | null> {
    let picked: string | null = null
    await this.onScreenWith(async (ui) => {
      const at = await ui.choose(question, options)
      picked = options[at] ?? null
    })
    return picked
  }

  private async onScreenWith(flow: (ui: Ui) => Promise<void>): Promise<void> {
    if (this.borrowed) return
    this.borrowed = true
    this.tui.stop()
    try {
      await runScreen({ title: 'Wilco', terminal: this.terminal }, flow)
    } catch (err) {
      if (!(err instanceof ScreenCancelled)) {
        this.state = notice(this.state, err instanceof Error ? err.message : String(err))
      }
    } finally {
      this.borrowed = false
      this.tui.start()
      this.draw()
    }
  }

  /** Everything addressed to Wilco arrives here, however it was said. */
  private say(said: string): void {
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

    // A half-typed line belongs to the prompt it was started at, so switching
    // agents abandons it rather than carrying it across.
    if (this.routerFor !== this.state.focused) {
      this.router = initialRouter()
      this.routerFor = this.state.focused
    }

    // A line beginning "wilco " is addressed to Wilco, not to the agent.
    const routed = route(this.router, data)
    this.router = routed.state
    this.state = setHeld(this.state, pending(this.router))

    if (routed.toLane !== '' && pane?.lane) {
      void this.opts.client.write(pane.lane as LaneId, routed.toLane).catch(() => {})
    }
    if (routed.toWilco !== null) this.say(routed.toWilco)
    this.draw()
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

  /**
   * Put a task in front of you.
   *
   * Two things, because there are two kinds of window. The pane is always
   * moved — that is this window's own business and works under every driver.
   * Raising the *terminal's* window is the driver's, and only some can: the
   * capability says which, never the driver's name, and when it cannot the
   * answer says where to look instead of pretending.
   */
  private async show(task: string): Promise<string> {
    const known = this.state.panes.some((pane) => pane.task === task)
    if (!known) return `I don't have a pane for ${task}.`
    this.state = focusTask(this.state, task)
    this.draw()

    const lane = `${task}/agent` as LaneId
    if (!this.opts.client.driver.capabilities.focus) return `Showing ${task}.`
    try {
      await this.opts.client.focusLane(lane)
      return `Showing ${task}.`
    } catch {
      // The lane may not exist, or the terminal may have moved on. The pane
      // moved either way, which is the part this window can promise.
      return `Showing ${task}.`
    }
  }

  /**
   * Look back at tasks that have finished.
   *
   * Nothing was ever prompting the orchestrator to notice a lesson; a tool it
   * may call whenever it likes is one it calls to be helpful rather than when
   * it has learned something. A finished task is the one moment there is
   * something to learn from, and the journal remembers which have been looked
   * at, so nothing is reflected on twice.
   *
   * Quiet by design: it proposes, and what it proposes waits for you in
   * `wilco skills` and the next brief. Nothing is said out loud.
   */
  private async reflect(tasks: readonly TaskSnapshot[]): Promise<void> {
    const thinker = this.opts.thinker
    if (!thinker || !this.opts.config.orchestrator.reflect) return
    const finished = needsReflection(
      tasks.map((task) => ({ task: task.task, state: task.state })),
      this.live?.events ?? [],
    ).filter((task) => !this.reflecting.has(task))

    for (const task of finished) {
      this.reflecting.add(task)
      // Recorded before asking, not after: an ask that fails or is interrupted
      // must not make Wilco ask again about the same task every two seconds.
      await this.opts.client.log
        .append({ type: 'reflected', task, detail: { by: 'orchestrator' } })
        .catch(() => {})
      await thinker.ask(reflectionPrompt(task)).catch(() => '')
    }
  }

  /**
   * Hand the terminal to the settings screen, then take it back.
   *
   * Needing to close Wilco to change a Wilco setting is how people end up with
   * a second terminal open forever. The window stops drawing while the other
   * screen has the keyboard — two things drawing at once is the bug this whole
   * design exists to avoid — and starts again where it left off.
   */
  private async openSettings(): Promise<string> {
    if (this.borrowed) return 'Settings are already open.'
    this.borrowed = true
    this.tui.stop()
    try {
      await runScreen(
        {
          title: 'Settings',
          context: [join(this.opts.home, 'config.yaml')],
          terminal: this.terminal,
        },
        (ui) => editSettings(ui, join(this.opts.home, 'config.yaml')),
      )
    } catch (err) {
      // ctrl+c closes the settings, not Wilco.
      if (!(err instanceof ScreenCancelled)) {
        this.state = notice(this.state, err instanceof Error ? err.message : String(err))
      }
    } finally {
      this.borrowed = false
      this.tui.start()
      this.draw()
    }
    return 'Settings closed. Changes apply next time Wilco starts.'
  }

  /** What each command actually does, once it has a screen to ask on. */
  private async runCommand(command: string, ui: Ui): Promise<string> {
    const path = join(this.opts.home, 'config.yaml')
    switch (command) {
      case '/settings':
        await editSettings(ui, path)
        return 'settings closed — changes apply next time Wilco starts'
      case '/project': {
        const root = resolve(await ui.ask('repository path', this.opts.cwd ?? process.cwd()))
        if (!existsSync(join(root, '.git'))) throw new Error(`${root} is not a git repository`)
        const fallback = basename(root)
          .toLowerCase()
          .replace(/[^a-z0-9-]+/g, '-')
        const name = await ui.ask('call it what?', fallback)
        addProject(path, name, root)
        return `added ${name} → ${root}, from the next time Wilco starts`
      }
      case '/task': {
        const projects = Object.keys(this.opts.config.projects)
        if (projects.length === 0) throw new Error('no projects yet — /project adds one')
        const project = projects[await ui.choose('Which project?', projects)] ?? projects[0]
        const intent = await ui.ask('what needs doing? (in your own words)')
        if (!intent || !project) return ''
        const slug = slugify(intent)
        const task = await this.opts.client.createTask({ project, slug, intent })
        ui.say(`  ${task.id} → ${task.worktree}`)
        if (!(await ui.confirm('start an agent on it now?', true))) return `${task.id} created`
        await this.opts.client.startAgent({ task: task.id, cwd: task.worktree, prompt: intent })
        return `${task.id} created, and an agent is on it`
      }
      case '/agent': {
        const tasks = this.state.panes.map((pane) => pane.task)
        const task = tasks[await ui.choose('Which task?', tasks)]
        if (!task) return ''
        const worktree = this.live?.worktreeOf(task)
        if (!worktree) throw new Error(`I do not know where ${task} lives`)
        const prompt = await ui.ask('what should it do first?')
        await this.opts.client.startAgent({ task: task as never, cwd: worktree, prompt })
        return `an agent is working on ${task}`
      }
      case '/stop': {
        const running = this.state.panes.filter((pane) => pane.lane !== null).map((p) => p.task)
        const task = running[await ui.choose('Stop which agent?', running)]
        if (!task) return ''
        await this.opts.client.stopAgent(task)
        return `${task} stopped — the task and its worktree stay`
      }
      default:
        return ''
    }
  }

  private describe(scope: string | null): string {
    const live = this.live
    const tasks = live?.tasks ?? []
    // Asked about one agent, answer with what it has been doing. Asked about
    // everything, answer with the shape of it: an account of nine tasks at
    // once is unusable, spoken or read.
    if (live && scope && tasks.some((task) => task.task === scope)) {
      return describeWork(live.workOn(scope), this.now())
    }
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
    if (!this.stopped && !this.borrowed) this.tui.requestRender()
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

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Only some terminals report key releases, which is what holding a key needs. */
function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}
