import { join } from 'node:path'
import {
  getKeybindings,
  ProcessTerminal,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
} from '@earendil-works/pi-tui'
import { DEFAULT_ATTENTION, parseQuietHours } from '@tade/core'
import type { ExtensionWorkbench } from '@tade/extensions-core'
import { VoiceSurface } from '@tade/voice-core'
import { Speaker } from '@tade/voice-tts'
import { agentEnded, eventNews } from './inbox.ts'
import { knownTasks, Live } from './live.ts'
import {
  type AppState,
  addTurn,
  anythingWorking,
  focusTask,
  initialState,
  notice,
  onEvent,
  setQuestion,
  withProjects,
  withTasks,
  withTerminals,
} from './model.ts'
import { FRAME_MS, lookWait, REPAINT_MS, SLOW_LOOK_MS } from './pace.ts'
import { pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { Router } from './wire/actions.ts'
import { Agents } from './wire/agents.ts'
import { Checks } from './wire/checks.ts'
import {
  type AppOptions,
  copySaying,
  copySpanSaying,
  copyText,
  type Subject,
  type Thinker,
  type Wiring,
  type WorkerImageFile,
  why,
} from './wire/context.ts'
import { Extensions } from './wire/extensions.ts'
import { Files } from './wire/files.ts'
import { frameOf } from './wire/frame.ts'
import { Images } from './wire/images.ts'
import { Keyboard } from './wire/keyboard.ts'
import { Lanes } from './wire/lanes.ts'
import { Machine } from './wire/machine.ts'
import { Mouse } from './wire/mouse.ts'
import { Notes } from './wire/notes.ts'
import { Orchestrator } from './wire/orchestrator.ts'
import { Projects, type ProjectTools } from './wire/projects.ts'
import { Queue, type QueueTools } from './wire/queue.ts'
import { Routes } from './wire/routes.ts'
import { Schedules, scheduleIdOf } from './wire/schedules.ts'
import { Search } from './wire/search.ts'
import { Settings, type SettingTools } from './wire/settings.ts'
import { Spend } from './wire/spend.ts'
import { spokenLine, Voice, vocabulary } from './wire/voice.ts'
import { Window } from './wire/window.ts'

// The window: every project down the side, the agent you are watching in the
// middle, the orchestrator along the bottom.
//
// This file only wires things together. What it should show is in `model.ts`,
// how it looks is in `view.ts`, and where the facts come from is in `live.ts`,
// so all three can be tested without a terminal.

// `Thinker`, `WorkerImageFile` and `AppOptions` live in `wire/context.ts`,
// with the `Wiring` the subjects are handed: what the window was opened with
// is the first thing every one of them reaches for. Re-exported here so
// nothing outside the package has to know that they moved.
export type { AppOptions, Thinker, WorkerImageFile } from './wire/context.ts'

export class App {
  private readonly opts: AppOptions
  private readonly terminal: Terminal
  private readonly tui: TuiAltScreen
  private state: AppState = initialState()
  private readonly skin: Skin = skinFor(process.env, process.stdout.isTTY === true)
  private readonly pointerShapes = pointerShapes(process.env)
  /** A look at the lanes is under way, and whether another was asked for meanwhile. */
  private looking = false
  private lookAgain = false
  private soon: NodeJS.Timeout | null = null
  /** When the last look started, by the real clock, as `tick` times one. */
  private lookedAt = 0
  private live: Live | null = null
  private timer: NodeJS.Timeout | null = null
  /** When the whole screen was last written over itself. */
  private repaintedAt = 0
  private release: (() => void) | null = null
  private stopped = false
  private settle: () => void = () => {}
  private readonly closed: Promise<void>
  /**
   * What the subjects are handed: the five names every one of them needs, and
   * nothing else. Built once, over `this`, so a subject reads the state as it
   * is now rather than as it was when it was made.
   */
  private readonly wire: Wiring
  /** Reading a note, copying it, taking it back. */
  private readonly notes: Notes
  /** Adopting a project's checks, running a task's, reading what one printed. */
  private readonly checks: Checks
  /** Push-to-talk, what is said back, and the mute that is now. */
  private readonly voice: Voice
  /** Pictures, and the clipboard they usually arrive on. */
  private readonly images: Images
  /** The Settings page, and the one path a setting is written by. */
  private readonly settings: Settings
  /** What is installed here, what is current, and who the agents run as. */
  private readonly machine: Machine
  /** Where you were, how big it all is, and what the title says. */
  private readonly window: Window
  /** What `ctrl+k` finds, inside files and out, and where a result goes. */
  private readonly search: Search
  /** What is due, what a watch found, and what one run of either does. */
  private readonly schedules: Schedules
  /** Queued work: what is ready, what is held, and what starts it. */
  private readonly queue: Queue
  /** Where a keystroke goes, the line you type on, and what was said before. */
  private readonly keyboard: Keyboard
  /** What the pointer did, and what it landed on. */
  private readonly mouse: Mouse
  /** The two screens in front of you, the terminals they are, and what is typed into them. */
  private readonly lanes: Lanes
  /** The file you have open, the diff beside it, and the branch underneath. */
  private readonly files: Files
  /** Making an agent, opening one again, stopping it, taking it away. */
  private readonly agents: Agents
  /** What an agent runs on: its harness, its account, its model, how hard it thinks. */
  private readonly routes: Routes
  /** The thing you talk to: what it is told, what it answers, and the screen it borrows. */
  private readonly orchestrator: Orchestrator
  /** The extensions, the servers brokered as extensions, and the page that says what each is for. */
  private readonly extensions: Extensions
  /** The folder you are looking in, and the projects Tade already knows. */
  private readonly projects: Projects
  /** What the agents cost, and what a subscription has used up. */
  private readonly spend: Spend
  /** Where an action, a menu, a panel and a command land. */
  private readonly router: Router
  /**
   * Every subject, in the order their answers are folded together.
   *
   * The order decides nothing today — no two of them answer for the same field
   * — and it is written down so that if two ever did, the answer would at
   * least be the same one every time. `mouse` is not in it: it answers no
   * question the frame or the router asks, it only turns what happened on the
   * screen into one of them.
   */
  private readonly subjects: readonly Subject[]

  private constructor(opts: AppOptions) {
    // Named rather than `this`, because a getter inside an object literal has
    // a `this` of its own: the window has to be closed over for the two fields
    // that change to be read as they are at every look.
    const app = this
    this.opts = opts
    this.wire = {
      get opts() {
        return opts
      },
      get state() {
        return app.state
      },
      put: (next) => {
        app.state = next
      },
      get live() {
        return app.live
      },
      now: () => app.now(),
      draw: () => app.draw(),
      note: (err) => {
        app.state = notice(app.state, why(err))
      },
    }
    this.notes = new Notes(this.wire, {
      copy: (text) => copySaying(this.wire, text, (data) => this.terminal.write(data)),
    })
    this.queue = new Queue(this.wire, {
      news: (said) => this.orchestrator.note(said),
      tell: (text) => this.orchestrator.tell(text),
      schedules: {
        views: () => this.schedules.views(),
        set: (req) => this.schedules.set(req),
        runNow: (id, asked) => this.schedules.runNow(id, asked),
      },
    })
    this.schedules = new Schedules(this.wire, {
      news: (said) => this.orchestrator.note(said),
      tell: (text) => this.orchestrator.tell(text),
      advanceQueue: () => void this.advanceQueue(),
    })
    this.search = new Search(this.wire, {
      settings: () => this.settings.rows(),
      openFile: (path, line) => this.files.openFile(path, line),
      openFind: (id, query, index) => this.lanes.openFind(id, query, index),
      clicked: (target) => this.mouse.clicked(target),
      decide: (allow) => this.agents.decide(allow),
      stopAgent: (task) => this.agents.stopAgent(task),
      openDiff: (task, path) => this.files.openDiff(task, path),
      openSettings: (category) => this.settings.open(category),
      showTerminal: (id) => this.lanes.showTerminal(id),
      quit: () => this.window.quit(),
      run: (action) => this.router.run(action),
    })
    this.window = new Window(this.wire, {
      setTitle: (title) => this.terminal.setTitle(title),
      stop: () => this.stop(),
    })
    this.machine = new Machine(this.wire, {
      reload: () => this.window.reload(),
      terminalSize: () => this.lanes.terminalSize(),
      showTerminal: (id) => this.lanes.showTerminal(id),
      onScreenWith: (flow) => this.orchestrator.onScreenWith(flow),
      refreshModels: async () => {
        await this.routes.refreshModels()
      },
    })
    this.settings = new Settings(this.wire, {
      loadAccounts: () => void this.machine.loadAccountViews(),
      lookAtWhatIsInstalled: () => void this.machine.lookAtWhatIsInstalled(),
      tellThinking: (level) => this.orchestrator.tellThinking(level),
      setupChanged: () => this.extensions.forgetSetup(),
      silence: () => {
        this.orchestrator.stopSpeaking()
        void this.voice.silence()
      },
      accountAction: (choice) => this.machine.accountAction(choice),
      updateAction: (choice) => this.machine.updateAction(choice),
      testMicrophone: () => this.voice.testMicrophone(),
      openFile: (path) => this.files.openPlace({ path }),
      copy: (text) => copyText(text, (data) => this.terminal.write(data)),
      releases: () => kittyActive(this.terminal),
    })
    this.images = new Images(this.wire, {
      soonTick: () => this.soonTick(),
      answering: () => this.orchestrator.attached(),
    })
    this.voice = new Voice(this.wire, {
      submit: () => this.keyboard.submit(),
      say: (said) => this.orchestrator.say(said),
      useConfig: (config) => this.settings.use(config),
      openTerminal: (name) => this.lanes.openTerminal(name),
      showTerminal: (id) => this.lanes.showTerminal(id),
      openFind: (id, query) => this.lanes.openFind(id, query),
    })
    this.checks = new Checks(this.wire, {
      sections: () => this.extensions.lists(),
      callId: () => this.extensions.callId(),
    })
    this.terminal = opts.terminal ?? new ProcessTerminal()
    // Mouse reporting is on by default, which is what makes the window
    // clickable: events arrive at the component with coordinates local to it.
    this.tui = new TuiAltScreen(this.terminal)
    freeViewportKeys()
    this.keyboard = new Keyboard(this.wire, {
      tui: this.tui,
      size: () => this.room(),
      kitty: () => kittyActive(this.terminal),
      skin: this.skin,
      stopped: () => this.stopped,
      stop: () => void this.stop(),
      panelInputs: () => this.router.panelInputs(),
      applyPanel: (outcome) => this.router.applyPanel(outcome),
      attachFromClipboard: () => void this.images.attachFromClipboard(),
      askWhereImagesGo: (paths) => this.images.askWhere(paths),
      talkStart: () => void this.voice.talkStart(),
      talkStop: () => void this.voice.talkStop(),
      decide: (allow) => void this.agents.decide(allow),
      openSearch: () => this.search.open(),
      run: (action) => void this.router.run(action),
      interrupt: () => void this.orchestrator.interrupt(),
      quit: () => this.window.quit(),
      soonTick: () => this.soonTick(),
      toLane: (data) => this.lanes.toLane(data),
      act: (said) => void this.router.act(said),
      say: (said) => this.orchestrator.say(said),
    })
    this.lanes = new Lanes(this.wire, {
      size: () => this.room(),
      layout: () => this.window.layout(),
      skin: this.skin,
      soonTick: () => this.soonTick(),
      say: (said) => this.orchestrator.say(said),
    })
    this.extensions = new Extensions(this.wire, {
      size: () => this.room(),
      skin: this.skin,
      useConfig: (config) => this.settings.use(config),
      dateOf: (at) => this.window.dateOf(at),
      anchored: (next) => this.orchestrator.anchored(next),
      openPlace: (target) => this.files.openPlace(target),
      openLink: (url) => this.files.openLink(url),
      reveal: (path, folder) => this.files.reveal(path, folder),
      watchCommand: (kind, line) => this.machine.watchCommand(kind, line),
      setSchedule: (req) => this.schedules.set(req),
      scheduleNamed: (name) => this.schedules.views().find((one) => one.id === scheduleIdOf(name)),
      scheduledElsewhere: (name, project) =>
        this.opts.client
          .schedules()
          .some((one) => one.id === scheduleIdOf(name) && one.project !== project),
      spoken: (text) => spokenLine(text),
    })
    this.orchestrator = new Orchestrator(this.wire, {
      terminal: this.terminal,
      suspend: () => this.tui.stop(),
      resume: () => this.tui.start(),
      voice: {
        ready: () => this.voice.ready,
        awaiting: () => this.voice.awaiting,
        handle: (said) => this.voice.handle(said),
        speakChunk: (text) => this.voice.speakChunk(text),
        speakMessage: (text) => this.voice.speakMessage(text),
        flushSpeech: () => this.voice.flushSpeech(),
      },
      remember: (said) => this.keyboard.remember(said),
      useConfig: (config) => this.settings.use(config),
      credential: (provider) => this.machine.credential(provider),
    })
    this.agents = new Agents(this.wire, {
      useConfig: (config) => this.settings.use(config),
      prefill: (line) => this.keyboard.prefill(line),
      openDiff: (task, path) => this.files.openDiff(task, path),
      openPlace: (target) => this.files.openPlace(target),
      changeQueue: (task, change) => this.queue.change(task, change),
      copyToClipboard: (text) => copyText(text, (data) => this.terminal.write(data)),
      offersFor: (task) => this.routes.offersFor(task),
      openModels: (task) => this.routes.openModels(task),
      openAccount: (task) => this.routes.openAccount(task),
    })
    this.routes = new Routes(this.wire, {
      size: () => this.room(),
      useConfig: (config) => this.settings.use(config),
      loadAccounts: () => this.machine.loadAccountViews(),
      chooseThinkerThinking: (level) => this.orchestrator.chooseThinking(level),
      thinkerModel: () => this.orchestrator.model(),
      credential: (provider) => this.machine.credential(provider),
      paidBy: (provider) => this.machine.paidBy(provider),
      accounts: () => this.machine.accounts,
    })
    this.files = new Files(this.wire, {
      size: () => this.room(),
      skin: this.skin,
      copy: (text) => copySaying(this.wire, text, (data) => this.terminal.write(data)),
      openSearch: (query) => this.search.open(query),
      onScreenWith: (flow) => this.orchestrator.onScreenWith(flow),
      paneSize: () => this.lanes.paneSize(),
      applyPanel: (outcome) => this.router.applyPanel(outcome),
      selectedInFile: () => this.mouse.fileSelectionText(),
      copySelection: (text) => copySpanSaying(this.wire, text, (data) => this.terminal.write(data)),
    })
    this.mouse = new Mouse(this.wire, {
      stopped: () => this.stopped,
      borrowed: () => this.orchestrator.borrowed(),
      size: () => this.room(),
      write: (data) => this.terminal.write(data),
      pointerShapes: () => this.pointerShapes,
      layout: () => this.window.layout(),
      remember: () => this.window.remember(),
      panelInputs: () => this.router.panelInputs(),
      applyPanel: (outcome) => this.router.applyPanel(outcome),
      openMenu: (subject, at) => this.router.openMenu(subject, at),
      run: (action) => void this.router.run(action),
      reslice: (area) => this.lanes.reslice(area),
      soonTick: () => this.soonTick(),
      turnedInLane: (event) => this.lanes.turnedInLane(event),
      selectTo: (line, x, extend, drag) => this.keyboard.selectTo(line, x, extend, drag),
      selectedOnLine: () => this.keyboard.selectedText(),
      clickedOn: (line, x, clicks) => this.keyboard.clickedOn(line, x, clicks),
      fileLines: () => this.files.lines(),
      fileBody: (panel) => this.files.body(panel),
      copySelection: (text) =>
        void copySpanSaying(this.wire, text, (data) => this.terminal.write(data)),
      resolvePath: (path) => this.files.resolvePath(path),
      openFile: (path, line) => this.files.openFile(path, line),
      openLink: (url) => void this.files.openLink(url),
      openDiff: (task, path) => void this.files.openDiff(task, path),
      openNote: (note) => this.notes.open(note),
      openAgent: () => void this.agents.openAgent(),
    })
    this.projects = new Projects(this.wire, {
      useConfig: (config) => this.settings.use(config),
      ensureAgent: (project) => this.agents.ensureAgent(project),
    })
    this.spend = new Spend(this.wire)
    this.subjects = [
      this.window,
      this.lanes,
      this.keyboard,
      this.files,
      this.agents,
      this.routes,
      this.checks,
      this.spend,
      this.notes,
      this.schedules,
      this.queue,
      this.orchestrator,
      this.extensions,
      this.search,
      this.settings,
      this.machine,
      this.projects,
      this.voice,
      this.images,
    ]
    this.router = new Router(this.wire, {
      subjects: () => this.subjects,
      stop: () => this.stop(),
      openSettings: (category) => this.settings.open(category),
      onScreen: (name) => this.orchestrator.onScreen(name),
      loadDiff: (task, path) => this.files.loadDiff(task, path),
      searchOpened: () => this.search.opened(),
      lookAtWhatIsInstalled: () => void this.machine.lookAtWhatIsInstalled(),
    })
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
   * sentence Tade's own grammar does not recognise has nowhere to go, and
   * knowing when that changed is the difference between waiting and retyping.
   */
  attachThinker(thinker: Thinker): void {
    this.orchestrator.attach(thinker)
  }

  /**
   * Write down the model the orchestrator ended up on when none was chosen,
   * so it stays on it. Otherwise the harness's default decides every start,
   * and that default is whatever an agent last switched to.
   */
  keepThinkerModel(model: { provider?: string; id: string }): void {
    this.orchestrator.keepModel(model)
  }

  /**
   * The orchestrator switched its own model, because it was asked to: kept for
   * the next start and shown on its tab, without restarting what it is doing.
   */
  thinkerMovedTo(model: { provider: string; id: string }): void {
    this.orchestrator.movedTo(model)
  }

  /**
   * The orchestrator could not be started, said where you would have waited
   * for it — not swallowed, which left a window that never answered anything
   * and gave no reason.
   */
  thinkerFailed(reason: string): void {
    this.orchestrator.failed(reason)
  }

  /** What extensions may ask of this window, once it exists to be asked. */
  useExtensionWorkbench(workbench: ExtensionWorkbench): void {
    this.opts.extensionWorkbench = workbench
  }

  /** Put a terminal in front, once the window knows about it. For whoever opened it elsewhere. */
  showTerminal(id: string): Promise<void> {
    return this.lanes.showTerminal(id)
  }

  /** Put an agent in front of you: one an extension just started, say. */
  showTask(task: string): void {
    void this.live?.refresh().then(() => {
      this.state = focusTask(this.state, task)
      this.draw()
    })
  }

  /** Resolves when the window has been closed. */
  wait(): Promise<void> {
    return this.closed
  }

  /**
   * What goes with the prompt of an agent the orchestrator starts while
   * answering you: the files you attached, copied where it works.
   */
  handOff(cwd: string): Promise<{ note: string; images: WorkerImageFile[] }> {
    return this.images.handOff(cwd)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.mouse.stopDraggingFile()
    this.lanes.stopWatching()
    this.window.remember()
    this.release?.()
    if (this.pointerShapes) this.terminal.write(pointerSequence('default'))
    this.tui.stop()
    // Leave the terminal as it was found. The alternate screen is restored by
    // the TUI, but whatever was painted before it goes back is a half-window
    // stranded in your scrollback.
    this.terminal.clearScreen()
    await this.voice.stop()
    await this.live?.stop()
    this.settle()
  }

  private async begin(): Promise<void> {
    const { sidebarWidth, stripHeight, order, spots, hidingDone, folded, opened } =
      this.window.recall() ?? {}
    this.state = {
      ...this.state,
      sizes: { ...(sidebarWidth ? { sidebarWidth } : {}), ...(stripHeight ? { stripHeight } : {}) },
      order: order ?? {},
      // Where you were in each project, so coming back to one tomorrow is the
      // same as coming back to it a second after leaving. Whatever it names
      // may have gone since; `standingIn` is what checks that, at the tab.
      spots: spots ?? {},
      // Here rather than on the first tasks: the view you left is what the
      // first frame draws, so a list you hid the finished agents in never
      // flashes them and then takes them away again.
      hidingDone: hidingDone ?? this.state.hidingDone,
      folded: folded ?? this.state.folded,
      opened: opened ?? this.state.opened,
    }
    // Read once, in the background: nothing waits on the catalog but the list.
    void this.machine.loadAccounts()
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
        this.window.restoreFocus()
        this.orchestrator.noteTasks(tasks)
        void this.routes.learnHarnesses(tasks)
        void this.queue.recordRulesMet()
        void this.schedules.runDue().then(() => this.advanceQueue())
        void this.orchestrator.reflect(tasks)
        this.draw()
      },
      onEvent: (event) => {
        this.state = onEvent(this.state, event, this.now())
        const heard = eventNews(event)
        if (heard) this.orchestrator.note(heard)
        // An agent that is gone, however it went: told rather than discovered
        // by the orchestrator steering something that is not there any more.
        const ended = agentEnded(event)
        if (ended) this.orchestrator.noteEnded(ended)
        if (event.type === 'run_started' && event.task) this.orchestrator.noteStarted(event.task)
        this.draw()
      },
      onWarning: (message) => {
        this.state = notice(this.state, message)
        this.draw()
      },
      onChange: () => this.draw(),
      onWork: (task) => void this.agents.nameAgent(task),
      onTerminals: (terminals) => {
        this.state = withTerminals(this.state, terminals)
        this.draw()
      },
    })
    this.live = live
    this.extensions.readLinkers()
    this.extensions.watchExtensions()
    this.agents.reopenLost()

    const attention = this.opts.config.surfaces.voice.attention
    this.voice.use(
      await VoiceSurface.start({
        tade: this.opts.client,
        // Yours, where it is a matter of taste. Everything else about what is
        // worth interrupting you for is the engine's, and not a setting.
        settings: {
          ...DEFAULT_ATTENTION.voice,
          ...(attention.budget === undefined ? {} : { budget: attention.budget }),
          quiet: parseQuietHours(attention.quiet) ?? DEFAULT_ATTENTION.voice.quiet,
        },
        speaker: this.voice.muteable(
          this.opts.speaker ?? (await Speaker.create({ soundDir: join(this.opts.home, 'sounds') })),
        ),
        vocabulary: async () => vocabulary(live.tasks),
        status: async (scope) => this.orchestrator.describe(scope),
        worktreeOf: async (task) => live.worktreeOf(task),
        show: async (task) => this.orchestrator.show(task),
        openSettings: async () => this.settings.open(),
        brief: () => this.orchestrator.brief(),
        extension: (said) => this.extensions.heardByExtension(said),
        tasks: async () => knownTasks(live.tasks),
        history: async () => live.history,
        ask: (text: string) => this.orchestrator.ask(text),
        terminals: this.voice.terminals(),
        ...(this.opts.now ? { now: this.opts.now } : {}),
        // Typing at an agent is what mutes speech for that task.
        focusedTask: () => ({ task: this.state.focused, lastInputAt: this.state.lastInputAt }),
        onTurn: (turn) => {
          this.state = addTurn(this.state, turn)
          this.state = setQuestion(this.state, this.voice.awaiting)
          this.draw()
        },
      }),
    )

    this.tui.addChild(
      this.mouse.component(
        (width) => ({
          state: this.state,
          frame: frameOf(
            this.subjects,
            { width, height: Math.max(6, this.terminal.rows), skin: this.skin },
            this.state.panel,
          ),
        }),
        () => this.now(),
      ),
    )
    this.release = this.tui.addInputListener((data) => this.keyboard.onInput(data))
    this.tui.start()
    void this.keyboard.load()
    this.timer = setInterval(() => void this.tick(), this.opts.frameMs ?? FRAME_MS)
    this.timer.unref?.()
    await this.tick()
  }

  /**
   * Look again, one look at a time. Looks overlapping could finish out of
   * order, and a slow one finishing last would put back the screen the fast
   * one had just replaced: a line blinking, text from one frame interleaved
   * with the next. Asked again while looking, it asks the way everything else
   * asks — starting one here was a look the instant the last ended, no delay.
   */
  private async tick(): Promise<void> {
    if (this.stopped) return
    if (this.looking) {
      this.lookAgain = true
      return
    }
    this.looking = true
    // Timed by the clock, not the app's: how long a look really took is the
    // question, and a test's clock stands still.
    const started = Date.now()
    this.lookedAt = started
    try {
      await this.look()
    } finally {
      this.looking = false
      // Only the ones worth asking about: a look is meant to be cheap, and one
      // slower than the time between two is Tade getting in its own way.
      const took = Date.now() - started
      if (took > SLOW_LOOK_MS) {
        this.opts.report
          ?.doing({
            name: 'a look at the tasks',
            op: 'tade.look',
            startedAt: started,
            attributes: {
              'tade.tasks': this.state.panes.length,
              'tade.agents': this.opts.client.runs().length,
              'tade.projects': Object.keys(this.opts.config.projects).length,
            },
          })
          .end()
      }
    }
    if (this.lookAgain) {
      this.lookAgain = false
      this.soonTick()
    }
  }

  private async look(): Promise<void> {
    if (this.stopped) return
    this.agents.reopenStopped()
    this.extensions.askExtensions()
    this.images.look()
    if (this.now() - this.repaintedAt >= REPAINT_MS) {
      this.repaintedAt = this.now()
      this.repaint()
    }
    const at = await this.lanes.fitPane()
    this.window.titleHere()
    const paneScreen = await this.lanes.readPane(at)
    const terminal = await this.lanes.captureTerminal()
    // While the orchestrator or an agent down the side works, its spinner is news every frame.
    if (paneScreen || terminal || this.state.talkingSince !== null || anythingWorking(this.state))
      this.draw()
  }

  /**
   * Look at the lane again in a moment: long enough to take a burst of output
   * in one look, short enough that what you typed is on screen before you
   * notice it was not. Reading waits for the emulator to finish parsing, so a
   * look this soon is never a look at half of it.
   */
  private soonTick(): void {
    if (this.soon || this.stopped) return
    this.soon = setTimeout(
      () => {
        this.soon = null
        void this.tick()
      },
      lookWait(Date.now() - this.lookedAt),
    )
  }

  /** Start whatever queued work is ready, and say what is held. */
  advanceQueue(): Promise<string[]> {
    return this.queue.advance()
  }

  /** What the orchestrator's queue tools do, answered from this window. */
  queueTools(): QueueTools {
    return this.queue.tools()
  }

  /** What the orchestrator's settings and project tools do, from this window. */
  configTools(): SettingTools & ProjectTools {
    return { ...this.settings.tools(), ...this.projects.tools() }
  }

  private draw(): void {
    if (!this.stopped && !this.orchestrator.borrowed()) this.tui.requestRender()
  }

  /**
   * Write the whole screen again, over itself.
   *
   * The terminal can wipe it without telling us: ⌘K is "clear" in Terminal.app,
   * iTerm2 and VS Code, and never reaches Tade at all. Rendering only sends
   * what changed, so a wiped screen stayed dark until something moved. Every
   * row is written in place — no clear first, so on a screen that was not
   * wiped nothing visibly happens.
   */
  private repaint(): void {
    if (this.stopped || this.orchestrator.borrowed()) return
    const shown = (this.tui as unknown as { previousScreen?: unknown }).previousScreen
    if (!Array.isArray(shown) || shown.length === 0) return
    let buffer = '\x1b[?2026h\x1b7'
    shown.forEach((line, row) => {
      if (typeof line === 'string') buffer += `\x1b[${row + 1};1H${line}`
    })
    this.terminal.write(`${buffer}\x1b8\x1b[?2026l`)
  }

  /** How big the terminal is, which is how big everything drawn in it may be. */
  private room(): { columns: number; rows: number } {
    return { columns: this.terminal.columns, rows: this.terminal.rows }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}

/** Only some terminals report key releases, which is what holding a key needs. */
function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}

/**
 * The alternate screen claims page up and down, home and end, ctrl+up and
 * down and ctrl+shift+f to scroll and search a viewport of its own — before
 * any listener sees them. Tade
 * draws exactly one screen and never scrolls one, so those keys belong to the
 * panel that is open or the agent you are typing at.
 */
export function freeViewportKeys(): void {
  const bindings = getKeybindings()
  const freed: Record<string, never[]> = {}
  for (const id of Object.keys(TUI_KEYBINDINGS)) {
    if (id.startsWith('tui.altScreen.')) freed[id] = []
  }
  bindings.setUserBindings({ ...bindings.getUserBindings(), ...freed })
}
