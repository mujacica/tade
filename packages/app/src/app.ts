import { spawn } from 'node:child_process'
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
  loadConfig,
  needsReflection,
  orchestratorRoute,
  parseQuietHours,
  parseSetting,
  reflectionPrompt,
  resolveRoute,
  settingsOf,
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
import { type ParsedDiff, parseDiff } from './diff.ts'
import { chooseEditor, launch, openerFor, openerForLink } from './editor.ts'
import { type Hit, hitAt, pressable, sameTarget, type Target } from './hits.ts'
import { appKey, checkTalkKey, keyCaps } from './keys.ts'
import { asRemembered, type LayoutPrefs, type RememberedWindow, resolveLayout } from './layout.ts'
import { knownTasks, Live } from './live.ts'
import type { TaskSnapshot } from './model.ts'
import {
  type AppState,
  addTurn,
  focusBy,
  focusedProject,
  focusTask,
  glyph,
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
import type { OpenRowView } from './panel-view.ts'
import {
  type Choice,
  type ConfirmRemovePanel,
  confirmRemovePanel,
  diffPanel,
  menuItems,
  menuPanel,
  nameFrom,
  newTaskPanel,
  type OpenProjectPanel,
  type OpenRow,
  openProjectPanel,
  type PaletteEntry,
  type Panel,
  type PanelInputs,
  type PanelOutcome,
  palettePanel,
  panelClick,
  panelFailed,
  panelKey,
  type SettingsPanel,
  settingsPanel,
  spendPanel,
} from './panels.ts'
import {
  ago,
  branchOf,
  browsing,
  initialise,
  isPath,
  listFolders,
  noteRecent,
  readRecents,
  recentProjects,
} from './projects.ts'
import { initialRouter, pending, type RouterState, route } from './router.ts'
import { runScreen, ScreenCancelled, type Ui } from './screen.ts'
import { addProject, editSettings, writeSetting } from './settings.ts'
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
  | { kind: 'click'; target: Target; button: 'left' | 'right'; x: number; y: number }

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
        this.onPointer({ kind: 'click', target, button: event.button, x: event.x, y: event.y })
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
  /**
   * The models an agent can be started on, from the harness's own catalog.
   * Passed in, so the window does not have to know which harness it is.
   */
  models?: () => Promise<{ id: string; provider: string; name: string }[]>
  /** Providers the harness is signed in to. */
  accounts?: () => Promise<string[]>
  /** The command that runs the harness interactively, for signing in. */
  signIn?: () => { command: string; args: string[] }
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
  /** The diff the diff panel is showing, once git has answered. */
  private diff: ParsedDiff | null = null
  /** The models an agent can be started on, once they have been read. */
  private models: { id: string; provider: string; name: string }[] = []
  /** Providers the harness is signed in to, once read. */
  private accounts: string[] = []
  /** The Open project list for the last query, and the branches found for its rows. */
  private openCache: { query: string; rows: OpenRow[]; browsing: string | null } | null = null
  private readonly branches = new Map<string, string | null>()
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

  /** The items of an open task menu, from what is true of the task now. */
  private menuItemsFor(panel: Panel | null) {
    if (panel?.kind !== 'menu') return []
    const pane = this.state.panes.find((p) => p.task === panel.task)
    return pane ? menuItems(pane, this.live?.changes(panel.task).length ?? 0) : []
  }

  /** What the open panel needs to draw that the window does not. */
  private panelFacts(live: Live): Frame['panel'] {
    const panel = this.state.panel
    if (!panel) return {}
    if (panel.kind === 'menu') return { items: this.menuItemsFor(panel) }
    if (panel.kind === 'confirm-remove') {
      const facts = live.factsOf(panel.task)
      return {
        changes: live.changes(panel.task),
        ahead: facts?.ahead ?? null,
        branch: facts?.branch ?? null,
        base: live.baseOf(panel.task),
      }
    }
    if (panel.kind === 'diff') return { diff: this.diff }
    if (panel.kind === 'new-task') return { choices: this.choices }
    if (panel.kind === 'palette') return { entries: this.paletteEntries() }
    if (panel.kind === 'keys') {
      const talk = this.opts.config.surfaces.voice.talk
      return { talkKey: talk.key, talkMode: talk.mode, releases: kittyActive(this.terminal) }
    }
    if (panel.kind === 'open-project') {
      return { openRows: this.openRowsFor(panel), browsing: this.openCache?.browsing ?? null }
    }
    if (panel.kind === 'settings') {
      return {
        choices: this.choices,
        settings: settingsOf(this.opts.config),
        accounts: this.accounts,
        configPath: tilde(this.configPath),
        releases: kittyActive(this.terminal),
        budgetWarnings: 0,
      }
    }
    return {}
  }

  /** Models an agent can start on, as choices grouped by provider. */
  private get choices(): Choice[] {
    return this.models.map((model) => ({
      value: model.id,
      label: model.id.split('/').slice(1).join('/') || model.id,
      group: model.provider,
    }))
  }

  /**
   * The speaker, as the settings have it now: with spoken replies off, the
   * sounds still play and the words still appear, but nothing is said.
   */
  private muteable(speaker: Speaker): Speaker {
    return new Proxy(speaker, {
      get: (target, name, receiver) => {
        if (name === 'speak' && !this.opts.config.surfaces.voice.speak) return async () => {}
        const value = Reflect.get(target, name, receiver)
        return typeof value === 'function' ? value.bind(target) : value
      },
    })
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
      voice: {
        keys: keyCaps(this.opts.config.surfaces.voice.talk.key),
        available: this.opts.recorder !== undefined,
      },
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
        this.clicked(event.target, event.button, { x: event.x, y: event.y })
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
    // Read once, in the background: nothing waits on the catalog but the list.
    void this.loadAccounts()
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
      speaker: this.muteable(
        this.opts.speaker ?? (await Speaker.create({ soundDir: join(this.opts.home, 'sounds') })),
      ),
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
        // Pressed again at the question, it is the answer: close anyway.
        void this.stop()
        return { consume: true }
      }
      // Releases are protocol noise to a form — except while choosing a key,
      // where the key is all that matters and a release is not a key.
      if (isKeyRelease(data)) return { consume: true }
      this.applyPanel(panelKey(this.state.panel, key, data, this.panelInputs()))
      return { consume: true }
    }
    const kitty = kittyActive(this.terminal)
    const talk = this.opts.config.surfaces.voice.talk
    const key = appKey(data, {
      kitty,
      listening: this.state.listening,
      talk: talk.key,
      toggle: talk.mode === 'toggle',
    })
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
      case 'palette':
        this.state = { ...this.state, panel: palettePanel() }
        this.draw()
        return { consume: true }
      case 'quit':
        this.quit()
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
  private clicked(
    target: Target,
    button: 'left' | 'right' = 'left',
    at: { x: number; y: number } = { x: 0, y: 0 },
  ): void {
    if (this.state.panel) {
      this.clickPanel(target)
      return
    }
    // A right-click on a task is its menu, as it is on anything else you own.
    if (button === 'right' && (target.kind === 'task' || target.kind === 'task-menu')) {
      this.openMenu(target.task, at)
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
        this.openMenu(target.task, at)
        return
      case 'change':
        void this.openDiff(target.task, target.path)
        return
      case 'project': {
        this.state = selectProject(this.state, target.project)
        const root = this.opts.config.projects[target.project]?.root
        if (root) noteRecent(this.opts.home, target.project, root, this.now())
        break
      }
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
    this.draw()
  }

  /** The actions buttons name. Each is exactly what its label says. */
  private async run(action: string): Promise<void> {
    const [verb, task] = action.split(':')
    if (task && verb?.startsWith('toast-')) {
      this.state = { ...this.state, toasts: this.state.toasts.filter((t) => t.task !== task) }
      if (verb === 'toast-show') this.state = focusTask(this.state, task)
      if (verb === 'toast-allow' || verb === 'toast-deny')
        await this.decideFor(task, verb === 'toast-allow')
      this.draw()
      return
    }
    switch (action) {
      case 'new-task':
        this.openNewTask()
        return
      case 'open-project':
        this.openCache = null
        this.state = { ...this.state, panel: openProjectPanel() }
        this.draw()
        return
      case 'settings':
        await this.openSettings()
        return
      case 'voice':
        await this.openSettings('voice')
        return
      case 'budgets':
        await this.openSettings('budgets')
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
      this.applyPanel(panelClick(panel, target.id, this.panelInputs()))
      return
    } else if (target.kind === 'action') {
      // A link inside a panel leads somewhere else: the panel gives way to it.
      this.state = { ...this.state, panel: null }
      void this.run(target.name)
      return
    }
    this.draw()
  }

  private applyPanel(outcome: PanelOutcome): void {
    const before = this.state.panel
    this.state = { ...this.state, panel: outcome.panel }
    // A different file in the diff panel is a different diff to read.
    if (outcome.panel?.kind === 'diff') {
      const was = before?.kind === 'diff' ? before : null
      if (!was || was.file !== outcome.panel.file || was.task !== outcome.panel.task) {
        void this.loadDiff(outcome.panel.task, outcome.panel.files[outcome.panel.file] ?? '')
      }
    }
    this.draw()
    if (outcome.submit && outcome.panel) void this.submitPanel(outcome.panel, outcome.choice)
  }

  /** Carry a panel out, and either close it or say in it why not. */
  private async submitPanel(panel: Panel, choice?: string): Promise<void> {
    switch (panel.kind) {
      case 'new-task': {
        if (!panel.project) return
        try {
          const id = await this.startTask(
            panel.project,
            panel.intent.trim(),
            panel.start,
            panel.model,
          )
          this.state = { ...this.state, panel: null }
          this.state = focusTask(this.state, id)
        } catch (err) {
          this.state = { ...this.state, panel: panelFailed(panel, why(err)) }
        }
        break
      }
      case 'menu':
        this.state = { ...this.state, panel: null }
        this.draw()
        await this.fromMenu(panel.task, choice ?? '')
        return
      case 'confirm-remove':
        await this.removeTask(panel)
        break
      case 'open-project':
        await this.openProject(panel)
        break
      case 'palette':
        await this.fromPalette(choice ?? '')
        return
      case 'keys':
        await this.openSettings('keys')
        return
      case 'quit':
        if (choice === 'where') {
          await this.openSettings('agents')
          return
        }
        await this.stop()
        return
      case 'settings': {
        if (choice?.startsWith('write:')) {
          const [path, value] = choice.slice('write:'.length).split('\u0000')
          if (path !== undefined) await this.saveSetting(panel, path, value ?? '')
          return
        }
        if (choice === 'open-file') {
          this.state = { ...this.state, panel: null }
          await this.openPlace({ path: this.configPath })
          return
        }
        if (choice === 'sign-in') await this.signIn()
        if (choice === 'mic-test') await this.testMicrophone()
        return
      }
      case 'diff': {
        const path = panel.files[panel.file]
        if (!path) return
        if (choice === 'editor') {
          this.state = { ...this.state, panel: null }
          await this.openPlace({ path })
          return
        }
        if (choice === 'ask') await this.askAbout(panel.task, path)
        break
      }
      default:
        return
    }
    this.draw()
  }

  /**
   * Close, asking first only when closing would stop something: agents that
   * live inside this window and cannot be found again once it is gone.
   */
  private quit(): void {
    const capabilities = this.opts.client.driver.capabilities
    const running = this.state.panes.reduce((n, pane) => n + pane.lanes.length, 0)
    if (running > 0 && !capabilities.detach) {
      this.state = { ...this.state, panel: { kind: 'quit', field: 'cancel', busy: false } }
      this.draw()
      return
    }
    void this.stop()
  }

  /** Everything the palette can go to, what needs you first. */
  private paletteEntries(): PaletteEntry[] {
    const entries: PaletteEntry[] = []
    const panes = [...this.state.panes].sort((a, b) => Number(b.waiting) - Number(a.waiting))
    const toneOf = (pane: (typeof panes)[number]): PaletteEntry['tone'] =>
      pane.waiting || pane.state === 'blocked'
        ? 'waiting'
        : pane.state === 'failed'
          ? 'bad'
          : pane.state === 'review'
            ? 'done'
            : pane.state === 'working'
              ? 'busy'
              : 'hint'
    for (const pane of panes) {
      entries.push({
        id: `task:${pane.task}`,
        label: pane.project === this.state.project ? pane.name : pane.task,
        kind: `task in ${pane.project}`,
        mark: glyph(pane),
        tone: toneOf(pane),
        ...(pane.waiting ? { note: 'waiting on you' } : {}),
      })
    }
    for (const pane of panes) {
      if (pane.approval) {
        entries.push({
          id: `approve:${pane.task}`,
          label: `Allow once: ${pane.approval.summary}`,
          kind: 'approval',
          mark: '▸',
          tone: 'waiting',
        })
      }
    }
    for (const pane of panes) {
      if (pane.lane)
        entries.push({
          id: `stop:${pane.task}`,
          label: `Stop ${pane.name}`,
          kind: 'agent',
          mark: '■',
        })
      entries.push({
        id: `changes:${pane.task}`,
        label: `Show the changes in ${pane.name}`,
        kind: 'task',
        mark: '±',
      })
    }
    for (const project of projects(this.state)) {
      entries.push({ id: `project:${project}`, label: project, kind: 'project', mark: '◇' })
    }
    for (const [id, label] of [
      ['new-task', 'New task'],
      ['open-project', 'Open project'],
      ['spend', 'Spend'],
      ['settings', 'Settings'],
      ['keys', 'Keys'],
      ['quit', 'Quit'],
    ] as const) {
      entries.push({ id: `run:${id}`, label, kind: 'action', mark: '›' })
    }
    for (const group of settingsOf(this.opts.config)) {
      for (const setting of group.settings) {
        entries.push({
          id: `setting:${group.id}`,
          label: `Settings › ${group.title} › ${setting.title}`,
          kind: 'setting',
          mark: '◇',
        })
      }
    }
    return entries
  }

  /** Where a palette entry goes. */
  private async fromPalette(id: string): Promise<void> {
    const [verb, ...rest] = id.split(':')
    const arg = rest.join(':')
    this.state = { ...this.state, panel: null }
    switch (verb) {
      case 'task':
        this.clicked({ kind: 'task', task: arg })
        return
      case 'approve':
        this.state = focusTask(this.state, arg)
        await this.decide(true)
        return
      case 'stop':
        await this.stopAgent(arg)
        return
      case 'changes': {
        const first = this.live?.changes(arg)[0]
        if (first) await this.openDiff(arg, first.path)
        else this.state = notice(this.state, `${arg} has not changed anything yet`)
        break
      }
      case 'project':
        this.clicked({ kind: 'project', project: arg })
        return
      case 'setting':
        await this.openSettings(arg)
        return
      case 'run':
        if (arg === 'keys') this.state = { ...this.state, panel: { kind: 'keys', busy: false } }
        else if (arg === 'quit') this.quit()
        else await this.run(arg)
        break
      default:
        break
    }
    this.draw()
  }

  /** A task's menu, opened where you clicked, just below and to the left. */
  private openMenu(task: string, at: { x: number; y: number }): void {
    this.state = {
      ...focusTask(this.state, task),
      panel: menuPanel(task, { row: at.y + 1, col: Math.max(0, at.x - 26) }),
    }
    this.draw()
  }

  /** What a menu item does. Each is exactly what it says. */
  private async fromMenu(task: string, item: string): Promise<void> {
    const facts = this.live?.factsOf(task)
    const worktree = this.live?.worktreeOf(task)
    switch (item) {
      case 'open': {
        this.state = focusTask(this.state, task)
        const pane = this.state.panes.find((p) => p.task === task)
        if (pane && !pane.lane) await this.newAgent('')
        break
      }
      case 'start':
        this.state = focusTask(this.state, task)
        await this.newAgent('')
        break
      case 'stop':
        await this.stopAgent(task)
        break
      case 'changes': {
        const first = this.live?.changes(task)[0]
        if (first) await this.openDiff(task, first.path)
        return
      }
      case 'editor':
        if (worktree) await this.openPlace({ path: worktree })
        return
      case 'copy-branch':
        if (facts) {
          const copied = await copyText(facts.branch, (data) => this.terminal.write(data))
          this.state = notice(this.state, copied ? `copied ${facts.branch}` : facts.branch)
        }
        break
      case 'park': {
        if (!worktree) break
        const pane = this.state.panes.find((p) => p.task === task)
        const parked = pane?.state !== 'parked'
        try {
          await this.opts.client.parkTask(worktree, parked)
          await this.live?.refresh()
          this.state = notice(this.state, parked ? `parked ${task}` : `picked ${task} up again`)
        } catch (err) {
          this.state = notice(this.state, why(err))
        }
        break
      }
      case 'remove':
        this.state = { ...this.state, panel: confirmRemovePanel(task) }
        break
      default:
        break
    }
    this.draw()
  }

  private async removeTask(panel: ConfirmRemovePanel): Promise<void> {
    const facts = this.live?.factsOf(panel.task)
    const worktree = this.live?.worktreeOf(panel.task)
    const root = facts ? this.opts.config.projects[facts.project]?.root : undefined
    if (!facts || !worktree || !root) {
      this.state = {
        ...this.state,
        panel: { ...panel, busy: false, error: 'I cannot find where this task lives.' },
      }
      return
    }
    try {
      // Its agent first: a worktree cannot go out from under a process using it.
      await this.opts.client.stopAgent(panel.task).catch(() => {})
      const result = await this.opts.client.removeTask({
        root: expandHome(root),
        worktree,
        branch: facts.branch,
        force: true,
      })
      if (!result.removed) {
        this.state = { ...this.state, panel: { ...panel, busy: false, error: result.reason } }
        return
      }
      await this.live?.refresh()
      this.state = notice({ ...this.state, panel: null }, `removed ${panel.task}`)
    } catch (err) {
      this.state = { ...this.state, panel: { ...panel, busy: false, error: why(err) } }
    }
  }

  /** The diff panel, on a changed file, with every other changed file a step away. */
  private async openDiff(task: string, path: string): Promise<void> {
    const files = (this.live?.changes(task) ?? []).map((change) => change.path)
    const at = Math.max(0, files.indexOf(path))
    this.applyPanel({
      panel: diffPanel(task, files.length > 0 ? files : [path], at),
      submit: false,
    })
  }

  private async loadDiff(task: string, path: string): Promise<void> {
    this.diff = null
    this.draw()
    const text = await this.live?.diffOf(task, path).catch(() => null)
    const panel = this.state.panel
    // Only if the panel is still on that file: a slow git must not draw an old diff.
    if (panel?.kind === 'diff' && panel.task === task && panel.files[panel.file] === path) {
      this.diff = text ? parseDiff(text) : parseDiff('')
      this.draw()
    }
  }

  /**
   * Put a question about a file in front of the agent, unsent. Typed into its
   * prompt, not submitted: asking costs money, so you are the one who presses
   * enter.
   */
  private async askAbout(task: string, path: string): Promise<void> {
    const pane = this.state.panes.find((p) => p.task === task)
    this.state = { ...focusTask(this.state, task), panel: null }
    if (!pane?.lane) {
      this.state = notice(this.state, `open ${task}'s agent first, then ask`)
      return
    }
    this.state = viewLane(this.state, task, pane.lane)
    await this.opts.client
      .write(pane.lane as LaneId, new TextEncoder().encode(`Look at ${path}: `))
      .catch(() => {})
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
  private async startTask(
    project: string,
    intent: string,
    start: boolean,
    model: string | null = null,
  ): Promise<string> {
    const task = await this.opts.client.createTask({ project, slug: slugify(intent), intent })
    if (start) {
      const [provider, ...rest] = model?.split('/') ?? []
      const chosen =
        model && rest.length > 0
          ? { provider: provider as string, id: rest.join('/') }
          : model
            ? { id: model }
            : null
      await this.opts.client.startAgent({
        task: task.id,
        cwd: task.worktree,
        prompt: intent,
        ...(chosen ? { model: chosen } : {}),
      })
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
    await this.decideFor(task, allow)
  }

  /** Answer what one agent is waiting on, wherever you are looking. */
  private async decideFor(task: string, allow: boolean): Promise<void> {
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
  private async openSettings(category = 'agents'): Promise<string> {
    this.state = { ...this.state, panel: settingsPanel(category) }
    this.draw()
    return 'Settings are open.'
  }

  /**
   * The Open project list for what is typed: recent projects for a name,
   * folders for a path. Read from disk once per query, not once per frame.
   */
  private openRowsFor(panel: OpenProjectPanel): OpenRowView[] {
    if (this.openCache?.query !== panel.query) {
      const cwd = this.opts.cwd ?? process.cwd()
      const path = isPath(panel.query)
      // Recent projects stay in view while you browse: going back to one is
      // the commonest reason to open this at all.
      const words = path ? [] : panel.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const recent = recentProjects(readRecents(this.opts.home), this.opts.config.projects)
        .filter((entry) =>
          words.every((word) => `${entry.name} ${entry.root}`.toLowerCase().includes(word)),
        )
        .slice(0, path ? 5 : 12)
        .map((entry) => ({
          kind: 'recent' as const,
          name: entry.name,
          path: expandHome(entry.root),
          git: true,
        }))
      if (path) {
        const { dir, prefix } = browsing(panel.query, cwd)
        const folders = listFolders(dir, prefix).map((folder) => ({
          kind: 'folder' as const,
          name: folder.name,
          path: folder.path,
          git: folder.git !== null,
        }))
        this.openCache = { query: panel.query, rows: [...recent, ...folders], browsing: tilde(dir) }
      } else {
        this.openCache = { query: panel.query, rows: recent, browsing: null }
      }
      for (const row of this.openCache.rows) {
        if (row.git && !this.branches.has(row.path)) {
          this.branches.set(row.path, null)
          void branchOf(row.path).then((branch) => {
            this.branches.set(row.path, branch)
            this.draw()
          })
        }
      }
    }
    const recents = readRecents(this.opts.home)
    return this.openCache.rows.map((row) => ({
      row,
      branch: this.branches.get(row.path) ?? null,
      tasks:
        row.kind === 'recent'
          ? this.state.panes.filter((pane) => pane.project === row.name).length
          : 0,
      when:
        row.kind === 'recent'
          ? ago(recents.find((entry) => entry.name === row.name)?.at ?? 0, this.now())
          : null,
    }))
  }

  /**
   * Open what was chosen: go to a project Wilco knows, or add a folder as one —
   * making it a repository first if it is not, and you said to.
   */
  private async openProject(panel: OpenProjectPanel): Promise<void> {
    const chosen = this.openRowsFor(panel)[panel.index]?.row
    const fail = (error: string) => {
      this.state = { ...this.state, panel: { ...panel, busy: false, error } }
    }
    if (!chosen) return fail('Choose a project, or type a path to a folder.')
    if (chosen.kind === 'recent') {
      this.state = { ...selectProject(this.state, chosen.name), panel: null }
      noteRecent(this.opts.home, chosen.name, chosen.path, this.now())
      return
    }
    const name = panel.name ?? nameFrom(chosen.path)
    if (!/^[a-z0-9][a-z0-9-]*$/.test(name))
      return fail('A name is lowercase letters, digits and dashes.')
    if (this.opts.config.projects[name])
      return fail(`There is already a project called ${name}. Choose another name.`)
    try {
      if (!chosen.git) {
        if (!panel.init)
          return fail(
            'Wilco needs git to start work here. Tick git init, or choose another folder.',
          )
        await initialise(chosen.path)
      }
      addProject(this.configPath, name, tilde(chosen.path))
      const loaded = await loadConfig(this.configPath)
      if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
      this.opts.config = loaded.config
      this.live?.useConfig(loaded.config)
      noteRecent(this.opts.home, name, tilde(chosen.path), this.now())
      this.state = withProjects(this.state, Object.keys(loaded.config.projects))
      this.state = notice({ ...selectProject(this.state, name), panel: null }, `opened ${name}`)
    } catch (err) {
      fail(why(err))
    }
  }

  /** What panels need to know that they do not hold. */
  private panelInputs(): PanelInputs {
    return {
      entries: this.state.panel?.kind === 'palette' ? this.paletteEntries() : [],
      rows:
        this.state.panel?.kind === 'open-project'
          ? this.openRowsFor(this.state.panel).map((view) => view.row)
          : [],
      choices: this.choices,
      items: this.menuItemsFor(this.state.panel),
      settings: settingsOf(this.opts.config),
      accounts: this.accounts.length,
    }
  }

  private get configPath(): string {
    return join(this.opts.home, 'config.yaml')
  }

  /**
   * Write one setting, read the config back, and use it. A value the schema
   * refuses is put back as it was, with the reason in the panel — never left
   * in a file Wilco will not open next time.
   */
  private async saveSetting(panel: SettingsPanel, path: string, value: string): Promise<void> {
    const setting = settingsOf(this.opts.config)
      .flatMap((group) => group.settings)
      .find((one) => one.path === path)
    const before = readFileSync(this.configPath, 'utf8')
    try {
      if (setting?.type.kind === 'key') {
        const check = checkTalkKey(value)
        if (!check.ok) throw new Error(check.reason)
      }
      if (path === 'orchestrator.model') {
        // Chosen as provider/id; stored as the two keys the orchestrator reads.
        const [provider, ...rest] = value.split('/')
        writeSetting(
          this.configPath,
          'orchestrator.provider',
          rest.length > 0 ? provider : undefined,
        )
        writeSetting(
          this.configPath,
          'orchestrator.model',
          rest.length > 0 ? rest.join('/') : value || undefined,
        )
      } else {
        const typed = setting ? parseSetting(setting, value) : value
        if (value !== '' && typed === undefined)
          throw new Error(`${setting?.title ?? path} needs a number above zero.`)
        writeSetting(this.configPath, path, typed)
      }
      const loaded = await loadConfig(this.configPath)
      if (!loaded.ok) {
        writeFileSync(this.configPath, before)
        throw new Error(loaded.issues[0]?.message ?? 'the config would not load with that')
      }
      this.opts.config = loaded.config
      const said =
        setting?.live === false
          ? `Saved. ${setting.title} applies when Wilco next starts.`
          : 'Saved. It applies now.'
      this.state = { ...this.state, panel: { ...panel, saved: said, error: null } }
    } catch (err) {
      this.state = { ...this.state, panel: { ...panel, saved: null, error: why(err) } }
    }
    this.draw()
  }

  /**
   * Sign in to a provider: pi's own sign-in, in a terminal inside this one, and
   * the list read again afterwards.
   */
  private async signIn(): Promise<void> {
    const command = this.opts.signIn?.()
    if (!command) {
      this.state = notice(this.state, 'run pi and type /login to sign in')
      this.draw()
      return
    }
    await this.onScreenWith(async (ui) => {
      ui.say('  Type /login, choose a provider, and follow pi. ctrl+] comes back here.')
      await ui.run('pi', command.command, command.args)
    })
    await this.loadAccounts()
  }

  /**
   * Listen for three seconds and show what is heard. Nothing is kept: the
   * point is to find out whether this terminal may use the microphone at all,
   * before the first time it matters.
   */
  private async testMicrophone(): Promise<void> {
    const recorder = this.opts.recorder
    const finish = (saved: string | null, error: string | null) => {
      const panel = this.state.panel
      if (panel?.kind === 'settings') {
        this.state = { ...this.state, panel: { ...panel, testing: false, saved, error } }
      }
      this.draw()
    }
    if (!recorder) {
      finish(null, 'No recorder is set up. Speech to text needs one: ffmpeg, on most machines.')
      return
    }
    try {
      const recording = await recorder.start({ maxMs: 5_000 })
      this.state = { ...this.state, levels: [] }
      this.listenTo(recording)
      await new Promise((resolve) => setTimeout(resolve, 3_000))
      if (this.metering) clearInterval(this.metering)
      this.metering = null
      await recording.cancel()
      const loudest = Math.max(0, ...this.state.levels)
      finish(
        loudest > 0.08 ? 'Heard you. The microphone works.' : null,
        loudest > 0.08
          ? null
          : 'Nothing heard. Check that your terminal is allowed to use the microphone.',
      )
    } catch (err) {
      finish(null, why(err))
    }
  }

  private async loadAccounts(): Promise<void> {
    this.accounts = (await this.opts.accounts?.().catch(() => [])) ?? []
    this.models = (await this.opts.models?.().catch(() => [])) ?? this.models
    this.draw()
  }

  /** What each command actually does, once it has a screen to ask on. */
  private async runCommand(command: string, ui: Ui): Promise<string> {
    const path = join(this.opts.home, 'config.yaml')
    switch (command) {
      case '/settings':
        await editSettings(ui, path)
        return 'settings closed'
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

/**
 * Put text on the clipboard. The system's own tool where there is one, since
 * Terminal.app ignores the escape sequence; the sequence everywhere else.
 */
async function copyText(text: string, write: (data: string) => void): Promise<boolean> {
  const tool =
    process.platform === 'darwin'
      ? ['pbcopy']
      : process.env.WAYLAND_DISPLAY
        ? ['wl-copy']
        : process.env.DISPLAY
          ? ['xclip', '-selection', 'clipboard']
          : null
  if (tool) {
    const copied = await new Promise<boolean>((resolve) => {
      const child = spawn(tool[0] as string, tool.slice(1), { stdio: ['pipe', 'ignore', 'ignore'] })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
      child.stdin?.end(text)
    })
    if (copied) return true
  }
  write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  return true
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Only some terminals report key releases, which is what holding a key needs. */
function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}
