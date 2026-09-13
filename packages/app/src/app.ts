import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import {
  type Component,
  isKeyRelease,
  ProcessTerminal,
  parseKey,
  type Terminal,
  TuiAltScreen,
  type TuiInputListenerResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
} from '@earendil-works/pi-tui'
import {
  type Config,
  DEFAULT_ATTENTION,
  describeWork,
  expandHome,
  type LaneId,
  needsReflection,
  orchestratorRoute,
  parseQuietHours,
  reflectionPrompt,
  resolveRoute,
} from '@wilco/core'
import {
  type AudioClip,
  type Recorder,
  type Recording,
  slugify,
  type Transcriber,
  VoiceSurface,
} from '@wilco/voice-core'
import { Speaker } from '@wilco/voice-tts'
import type { Workbench } from '@wilco/workbench'
import { chooseEditor, launch, openerFor, openerForLink } from './editor.ts'
import { type Hit, hitAt, pressable, sameTarget, type Target } from './hits.ts'
import { appKey, TALK } from './keys.ts'
import { asRemembered, type LayoutPrefs, type RememberedWindow, resolveLayout } from './layout.ts'
import { knownTasks, Live } from './live.ts'
import type { TaskSnapshot } from './model.ts'
import {
  type AppState,
  addTurn,
  focusBy,
  focusedProject,
  focusTask,
  initialState,
  keyAction,
  laneShown,
  matchActions,
  nextWaiting,
  noteTyping,
  notice,
  onEvent,
  parseCommand,
  projects,
  selectProject,
  setDictation,
  setHeld,
  setListening,
  setQuestion,
  toggleSection,
  viewLane,
  whichProject,
  withProjects,
  withTasks,
} from './model.ts'
import {
  newTaskPanel,
  type Panel,
  type PanelOutcome,
  panelClick,
  panelFailed,
  panelKey,
  spendPanel,
} from './panels.ts'
import { initialRouter, pending, type RouterState, route } from './router.ts'
import { runScreen, ScreenCancelled, type Ui } from './screen.ts'
import { addProject, editSettings } from './settings.ts'
import { pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { spendView as spendViewOf } from './spend.ts'
import { draw, type Frame } from './view.ts'

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

/** What the pointer did, reduced to what the window cares about. */
export type PointerEvent =
  | { kind: 'move'; target: Target | null }
  | { kind: 'press'; target: Target | null }
  | { kind: 'release' }
  | { kind: 'click'; target: Target; button: 'left' | 'right' }

class Window implements Component {
  private readonly frame: (width: number) => { state: AppState; frame: Frame }
  private readonly onPointer: (event: PointerEvent) => boolean
  private hits: readonly Hit[] = []

  constructor(frame: Window['frame'], onPointer: (event: PointerEvent) => boolean) {
    this.frame = frame
    this.onPointer = onPointer
  }

  render(width: number): string[] {
    const { state, frame } = this.frame(width)
    const drawn = draw(state, frame)
    this.hits = drawn.hits
    return drawn.rows
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const target = hitAt(this.hits, event.x, event.y)
    switch (event.type) {
      case 'move':
      case 'drag':
        return { handled: true, render: this.onPointer({ kind: 'move', target }) }
      case 'press':
        if (event.button !== 'left') return undefined
        return { handled: target !== null, render: this.onPointer({ kind: 'press', target }) }
      case 'release':
        return { handled: true, render: this.onPointer({ kind: 'release' }) }
      case 'click':
        if (!target || (event.button !== 'left' && event.button !== 'right')) return undefined
        this.onPointer({ kind: 'click', target, button: event.button })
        return { handled: true }
      default:
        return undefined
    }
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
  /**
   * Where free text goes, once there is something to send it to.
   *
   * Settable, because the orchestrator is a model in another process and can
   * take a few seconds to come up. The window opens without waiting for it:
   * an empty terminal while something else starts is the worst first second
   * Wilco could have, and everything except free text works meanwhile.
   */
  private thinker: AppOptions['thinker'] | null = null
  private readonly skin: Skin = skinFor(process.env, process.stdout.isTTY === true)
  private readonly pointerShapes = pointerShapes(process.env)
  /** The size each lane was last made, so resizing happens once per change. */
  private readonly fitted = new Map<string, string>()
  private titled = ''
  /** When this window opened: the start of "This window" in the Spend panel. */
  private readonly openedAt = Date.now()
  /** Tasks whose agent is being opened right now. */
  private readonly opening = new Set<string>()
  private screen = ''
  private recording: Recording | null = null
  private metering: NodeJS.Timeout | null = null
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
    this.thinker = opts.thinker ?? null
    this.terminal = opts.terminal ?? new ProcessTerminal()
    // Mouse reporting is on by default, which is what makes the window
    // clickable: events arrive at the component with coordinates local to it.
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

  /**
   * Hand the window the orchestrator, once it has started.
   *
   * Said out loud in the strip rather than silently: until this happens, a
   * sentence Wilco's own grammar does not recognise has nowhere to go, and
   * knowing when that changed is the difference between waiting and retyping.
   */
  attachThinker(thinker: NonNullable<AppOptions['thinker']>): void {
    this.thinker = thinker
    this.state = notice(this.state, 'orchestrator ready')
    this.draw()
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
    if (this.pointerShapes) this.terminal.write(pointerSequence('default'))
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

  /** Everything the drawing needs that is not the app's own state. */
  private frameFor(live: Live, width: number): Frame {
    const focused = this.state.panes.find((pane) => pane.task === this.state.focused)
    const route = focused
      ? resolveRoute(this.opts.config, { project: focused.project })
      : orchestratorRoute(this.opts.config)
    const spend = live.spendToday()
    const panel = this.state.panel
    const spendView =
      panel?.kind === 'spend'
        ? spendViewOf(live.spending, {
            window: panel.window,
            by: panel.by,
            now: this.now(),
            openedAt: this.openedAt,
            projects: projects(this.state),
            budgets: Object.fromEntries(
              Object.entries(this.opts.config.projects).map(([name, project]) => [
                name,
                project.budget,
              ]),
            ),
          })
        : null
    return {
      width,
      height: Math.max(6, this.terminal.rows),
      screen: this.screen,
      layout: this.layout(),
      skin: this.skin,
      files: live.files(this.state.focused),
      changes: live.changes(this.state.focused),
      notes: live.notes(this.state.project),
      base: live.baseOf(this.state.focused),
      spend: {
        tokens: spend.total.tokens,
        usd: spend.total.usd,
        hasCost: spend.total.hasCost,
        byTask: spend.byTask,
      },
      route: {
        harness: route.harness,
        model: route.model ?? null,
        provider: route.provider ?? null,
      },
      voice: { keys: TALK.split('+'), available: this.opts.recorder !== undefined },
      home: tilde(this.opts.home),
      now: this.now(),
    }
  }

  /**
   * The pointer moved, pressed, let go or clicked. Returns whether anything
   * visible changed, so moving across empty space costs no redraw.
   */
  private pointer(event: PointerEvent): boolean {
    if (this.stopped || this.borrowed) return false
    switch (event.kind) {
      case 'move': {
        if (sameTarget(this.state.hover, event.target)) return false
        const was = pressable(this.state.hover)
        this.state = { ...this.state, hover: event.target }
        const now = pressable(event.target)
        // A hand over what can be pressed, where the terminal can show one.
        if (was !== now && this.pointerShapes) {
          this.terminal.write(pointerSequence(now ? 'pointer' : 'default'))
        }
        return true
      }
      case 'press':
        if (!pressable(event.target)) return false
        this.state = { ...this.state, pressed: event.target }
        return true
      case 'release':
        if (this.state.pressed === null) return false
        this.state = { ...this.state, pressed: null }
        return true
      case 'click':
        this.state = { ...this.state, pressed: null }
        this.clicked(event.target, event.button)
        return true
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
    // Every project, before any of them has a task: an empty one is still a
    // tab you can be standing in when you start work.
    this.state = withProjects(this.state, Object.keys(this.opts.config.projects))
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
      onChange: () => this.draw(),
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
      ask: (text: string) => this.ask(text),
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
      new Window(
        (width) => ({ state: this.state, frame: this.frameFor(live, width) }),
        (event) => this.pointer(event),
      ),
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
    // A panel has the keyboard while it is open: nothing typed into a form
    // should reach an agent. ctrl+c still closes Wilco, as it does everywhere.
    if (this.state.panel) {
      const key = parseKey(data)
      if (key === 'ctrl+c') {
        void this.stop()
        return { consume: true }
      }
      if (isKeyRelease(data)) return { consume: true }
      this.applyPanel(panelKey(this.state.panel, key, data))
      return { consume: true }
    }
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
   * Something was clicked.
   *
   * Every target is something you could also have typed or said, which is the
   * point: the mouse is a shortcut into the same actions, never a second way of
   * driving Wilco that behaves differently. Nothing here types a command for
   * you to finish — what needs more than a click opens a panel.
   */
  private clicked(target: Target, button: 'left' | 'right' = 'left'): void {
    if (this.state.panel) {
      this.clickPanel(target)
      return
    }
    switch (target.kind) {
      case 'task': {
        this.state = focusTask(this.state, target.task)
        const pane = this.state.panes.find((p) => p.task === target.task)
        // Clicking a task opens it. Resuming a session sends nothing to the
        // model, so this costs nothing until you type — which is what makes it
        // safe for a click, and not for tab, which passes over tasks on the
        // way to another.
        if (pane && !pane.lane && pane.state !== 'parked') void this.newAgent('')
        break
      }
      case 'lane':
        this.state = viewLane(this.state, target.task, target.lane)
        break
      case 'task-menu':
        // The menu itself comes with the rest of the panels; until then the
        // task is at least put in front of you.
        this.state = focusTask(this.state, target.task)
        break
      case 'project':
        this.state = selectProject(this.state, target.project)
        break
      case 'section':
        this.state = toggleSection(this.state, target.section)
        break
      case 'orchestrator':
        this.state = { ...this.state, focused: null, chose: true }
        if (this.state.dictation === null) this.state = setDictation(this.state, '')
        break
      case 'file':
      case 'place':
        void this.openPlace(target)
        return
      case 'link':
        void this.openLink(target.url)
        return
      case 'action':
        void this.run(target.name)
        return
      default:
        break
    }
    void button
    this.draw()
  }

  /** The actions buttons name. Each is exactly what its label says. */
  private async run(action: string): Promise<void> {
    switch (action) {
      case 'new-task':
        this.openNewTask()
        return
      case 'open-project':
        await this.onScreen('/project')
        return
      case 'settings':
      case 'voice':
        await this.openSettings()
        return
      case 'spend':
        this.state = { ...this.state, panel: spendPanel() }
        this.draw()
        return
      case 'new-shell':
        await this.openShell()
        return
      case 'next-waiting': {
        const next = nextWaiting(this.state)
        if (next) this.state = focusTask(this.state, next)
        this.draw()
        return
      }
      case 'approve':
        await this.decide(true)
        return
      case 'deny':
        await this.decide(false)
        return
      case 'open-agent':
        await this.newAgent('')
        return
      default:
        await this.act(action)
    }
  }

  /**
   * Open a file you clicked, in your editor, at the line if there is one.
   * Relative paths are the agent's, so they resolve in its worktree.
   */
  private async openPlace(target: { path: string; line?: number; column?: number }): Promise<void> {
    const focused = this.state.panes.find((pane) => pane.task === this.state.focused)
    const root =
      (focused && this.live?.worktreeOf(focused.task)) ??
      (this.state.project ? this.opts.config.projects[this.state.project]?.root : undefined) ??
      this.opts.cwd ??
      process.cwd()
    const file = isAbsolute(target.path) ? target.path : resolve(expandHome(root), target.path)
    const { editor } = chooseEditor(this.opts.config.surfaces.window.editor, process.env)
    const opener = openerFor(
      editor,
      {
        file,
        ...(target.line ? { line: target.line } : {}),
        ...(target.column ? { column: target.column } : {}),
      },
      process.env,
    )
    const where = `${basename(file)}${target.line ? `:${target.line}` : ''}`
    if (opener.kind === 'terminal') {
      // A terminal editor gets a terminal: this one, for as long as you are in
      // it, with the window put back when you quit — never two programs reading
      // one keyboard.
      await this.onScreenWith(async (ui) => {
        await ui.run(`${opener.command} ${where}`, opener.command, opener.args)
      })
      return
    }
    try {
      await launch(opener)
      this.state = notice(
        this.state,
        `opened ${where} in ${editor === 'system' ? 'its app' : editor}`,
      )
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  private async openLink(url: string): Promise<void> {
    try {
      const opener = openerForLink(url)
      if (opener.kind === 'detached') await launch(opener)
      this.state = notice(this.state, `opened ${url}`)
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  /** Borrow the terminal for a flow on the shared screen, then put the window back. */
  private async onScreenWith(flow: (ui: Ui) => Promise<void>): Promise<void> {
    if (this.borrowed) return
    this.borrowed = true
    this.tui.stop()
    try {
      await runScreen({ title: 'Wilco', terminal: this.terminal }, flow)
    } catch (err) {
      if (!(err instanceof ScreenCancelled)) {
        this.state = notice(this.state, why(err))
      }
    } finally {
      this.borrowed = false
      this.tui.start()
      this.draw()
    }
  }

  /**
   * A shell in the task's worktree, as a tab beside its agent: the place to
   * run the tests yourself, or look at what it did, without leaving the task.
   */
  private async openShell(): Promise<void> {
    const pane = this.state.panes.find((p) => p.task === this.state.focused)
    const worktree = pane ? this.live?.worktreeOf(pane.task) : null
    if (!pane || !worktree) {
      this.state = notice(this.state, 'open a task first: a shell starts in its worktree')
      this.draw()
      return
    }
    const taken = new Set(pane.lanes.map((lane) => lane.id))
    let id = `${pane.task}/shell`
    for (let n = 2; taken.has(id); n++) id = `${pane.task}/shell-${n}`
    const size = this.paneSize()
    try {
      await this.opts.client.spawn({
        id: id as LaneId,
        task: pane.task as never,
        kind: 'shell',
        cwd: worktree,
        command: process.env.SHELL ?? '/bin/sh',
        args: ['-l'],
        cols: size.cols,
        rows: size.rows,
        title: `${pane.name} shell`,
      })
      await this.live?.refresh()
      this.state = viewLane(this.state, pane.task, id)
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  private openNewTask(): void {
    const names = projects(this.state)
    this.state = { ...this.state, panel: newTaskPanel(names, this.state.project) }
    this.draw()
  }

  private clickPanel(target: Target): void {
    const panel = this.state.panel
    if (!panel) return
    if (target.kind === 'dismiss') {
      this.state = { ...this.state, panel: panel.busy ? panel : null }
    } else if (target.kind === 'control') {
      this.applyPanel(panelClick(panel, target.id))
      return
    }
    this.draw()
  }

  private applyPanel(outcome: PanelOutcome): void {
    this.state = { ...this.state, panel: outcome.panel }
    this.draw()
    if (outcome.submit && outcome.panel) void this.submitPanel(outcome.panel)
  }

  /** Carry a panel out, and either close it or say in it why not. */
  private async submitPanel(panel: Panel): Promise<void> {
    if (panel.kind !== 'new-task' || !panel.project) return
    try {
      const id = await this.startTask(panel.project, panel.intent.trim(), panel.start)
      this.state = { ...this.state, panel: null }
      this.state = focusTask(this.state, id)
    } catch (err) {
      this.state = { ...this.state, panel: panelFailed(panel, why(err)) }
    }
    this.draw()
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
    this.state = { ...this.state, talkingSince: this.now() }
    try {
      this.recording = await recorder.start({ maxMs: MAX_SPEECH_MS })
      this.state = { ...setListening(this.state, true), levels: [] }
      this.listenTo(this.recording)
    } catch (err) {
      // Say why, once, then fall back to typing rather than swallowing it.
      this.state = setListening(setDictation(notice(this.state, why(err)), ''), true)
    }
    this.draw()
  }

  /** Sample how loud the microphone is hearing you, for the meter. */
  private listenTo(recording: Recording): void {
    if (!recording.level) return
    this.metering = setInterval(() => {
      const level = recording.level?.() ?? 0
      this.state = { ...this.state, levels: [...this.state.levels, level].slice(-64) }
      this.draw()
    }, 100)
    this.metering.unref?.()
  }

  private async talkStop(): Promise<void> {
    const recording = this.recording
    const transcriber = this.opts.transcriber
    this.recording = null
    if (this.metering) clearInterval(this.metering)
    this.metering = null
    this.state = { ...this.state, levels: [] }
    if (!recording || !transcriber) {
      this.submit()
      return
    }

    this.state = { ...setListening(this.state, false), talkingSince: null, hearing: true }
    this.draw()
    let clip: AudioClip | null = null
    try {
      clip = await recording.stop()
      // Task and project names are the words a general model gets wrong.
      const words = vocabulary(this.live?.tasks ?? [])
      const heard = await transcriber.transcribe(clip, {
        vocabulary: [...words.tasks, ...words.projects],
      })
      this.state = { ...notice(this.state, heard.text ? null : 'nothing heard'), hearing: false }
      this.draw()
      this.say(heard.text)
    } catch (err) {
      this.state = { ...notice(this.state, why(err)), hearing: false, talkingSince: null }
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
   * Work happens in the window. Starting a task used to throw the whole screen
   * away for a form, which is a strange thing for a window whose entire job is
   * to show you what is running: you said what you wanted, so it is done, and
   * what you get back is the agent working on it. Only the two commands that
   * edit configuration — which is neither urgent nor about a task — borrow the
   * terminal, because a YAML editor does not fit in three rows.
   */
  private async act(said: string): Promise<void> {
    const { name, rest } = parseCommand(said)
    const [chosen] = matchActions(this.state, name)
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
      case '/task':
        await this.newTask(rest)
        return
      case '/agent':
        await this.newAgent(rest)
        return
      case '/stop':
        await this.stopAgent(rest)
        return
      case '/open': {
        const task = this.findTask(rest)
        if (!task) {
          this.state = notice(this.state, rest ? `no task like ${rest}` : 'which task? /open name')
          this.prefill('/open ')
          return
        }
        this.state = focusTask(this.state, task)
        this.draw()
        return
      }
      default:
        await this.onScreen(chosen.name)
    }
  }

  /**
   * Start work: a branch, a worktree, an agent in it, and your eyes on it.
   *
   * The project is the one you are looking at unless you name another, so the
   * common case — watching a project, wanting another thing done in it — is
   * one sentence with no questions asked back.
   */
  private async newTask(said: string): Promise<void> {
    const projects = Object.keys(this.opts.config.projects)
    if (projects.length === 0) {
      this.state = notice(this.state, 'no projects yet — /project adds one')
      this.draw()
      return
    }
    const { project, intent } = whichProject(said, projects, focusedProject(this.state))
    if (!project) {
      this.state = notice(this.state, `which project? ${projects.join(' · ')}`)
      this.prefill('/task ')
      return
    }
    if (intent === '') {
      this.state = notice(this.state, `${project}: /task what needs doing`)
      this.prefill('/task ')
      return
    }

    this.state = notice(this.state, `starting ${project} · ${slugify(intent)}…`)
    this.draw()
    try {
      const id = await this.startTask(project, intent, true)
      this.state = focusTask(notice(this.state, `${id} — an agent is on it`), id)
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  /**
   * A branch, a worktree, and — unless you said not to — an agent in it. The
   * pane is refreshed before anything tries to focus it, because a pane you
   * cannot see yet cannot take focus.
   */
  private async startTask(project: string, intent: string, start: boolean): Promise<string> {
    const task = await this.opts.client.createTask({ project, slug: slugify(intent), intent })
    if (start) {
      await this.opts.client.startAgent({ task: task.id, cwd: task.worktree, prompt: intent })
    }
    await this.live?.refresh()
    return task.id
  }

  /** Another agent on the task in front of you, or on one you name. */
  private async newAgent(said: string): Promise<void> {
    const { name, rest } = parseCommand(said)
    const named = this.findTask(name)
    const task = named ?? this.state.focused
    const prompt = named ? rest : said
    if (!task) {
      this.state = notice(this.state, 'which task? /agent name what it should do')
      this.prefill('/agent ')
      return
    }
    const worktree = this.live?.worktreeOf(task)
    if (!worktree) {
      this.state = notice(this.state, `I do not know where ${task} lives`)
      this.draw()
      return
    }
    // Two clicks before the first agent has registered must not start two.
    if (this.opening.has(task)) return
    this.opening.add(task)
    try {
      await this.opts.client.startAgent({ task: task as never, cwd: worktree, prompt })
      await this.live?.refresh()
      const said = prompt ? `an agent is working on ${task}` : `opened ${task} where it left off`
      this.state = focusTask(notice(this.state, said), task)
    } catch (err) {
      this.state = notice(this.state, why(err))
    } finally {
      this.opening.delete(task)
    }
    this.draw()
  }

  /** Stop the agent you are watching, or the one you name. The task stays. */
  private async stopAgent(said: string): Promise<void> {
    const task = this.findTask(said) ?? this.state.focused
    if (!task) {
      this.state = notice(this.state, 'which agent? /stop name')
      this.prefill('/stop ')
      return
    }
    try {
      await this.opts.client.stopAgent(task)
      await this.live?.refresh()
      this.state = notice(this.state, `${task} stopped — the task and its worktree stay`)
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  /** The task somebody meant by a word or two of its name. */
  private findTask(said: string): string | null {
    const want = said.trim().toLowerCase()
    if (want === '') return null
    const tasks = this.state.panes.map((pane) => pane.task)
    return (
      tasks.find((task) => task.toLowerCase() === want) ??
      tasks.find((task) => task.toLowerCase().includes(want)) ??
      null
    )
  }

  /** Put a half-written command back on the line, ready to be finished. */
  private prefill(line: string): void {
    this.state = setDictation(this.state, line)
    this.draw()
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

  /** Free text, which only the orchestrator can answer. */
  private async ask(text: string): Promise<string> {
    if (!this.thinker) return 'The orchestrator is still starting.'
    return this.thinker.ask(text)
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

    const lane = pane ? laneShown(this.state, pane) : null
    if (routed.toLane !== '' && lane) {
      void this.opts.client.write(lane as LaneId, routed.toLane).catch(() => {})
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
    const lane = pane ? laneShown(this.state, pane) : null
    const size = this.paneSize()
    if (lane) await this.fitLane(lane, size)
    this.title(pane ? `${pane.project} › ${pane.name}` : null)
    const screen = await (this.live?.capture(lane, size.rows, this.skin.colour) ?? '')
    if (screen !== this.screen || this.state.talkingSince !== null) {
      this.screen = screen
      this.draw()
    }
  }

  /** The agent's part of the window: the pane, less its title and rule. */
  private paneSize(): { cols: number; rows: number } {
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    return { cols: Math.max(20, layout.mainWidth), rows: Math.max(4, layout.bodyHeight - 2) }
  }

  /**
   * Make the lane the size of the pane it is drawn in.
   *
   * An agent draws for the terminal it thinks it has. Drawn into a pane of a
   * different size, its own layout wraps and clips in all the wrong places —
   * so the pane decides, once per size, not every frame.
   */
  private async fitLane(lane: string, size: { cols: number; rows: number }): Promise<void> {
    const want = `${size.cols}x${size.rows}`
    if (this.fitted.get(lane) === want) return
    this.fitted.set(lane, want)
    await this.opts.client.resize(lane as LaneId, size.cols, size.rows).catch(() => {
      // A lane that just ended cannot be resized; the next tick will not ask.
    })
  }

  /** The terminal window's own title says which task you are in. */
  private title(where: string | null): void {
    const title = where ? `wilco · ${where}` : 'wilco'
    if (title === this.titled) return
    this.titled = title
    this.terminal.setTitle(title)
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
    const thinker = this.thinker
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

/** A path the way you would type it. */
function tilde(path: string): string {
  const home = process.env.HOME
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Only some terminals report key releases, which is what holding a key needs. */
function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}
