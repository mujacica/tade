import { join } from 'node:path'
import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import { type Arming, attentionFor, closeBy, titlesOf, type Unclosed } from '@tade/core'
import type { ExtensionWorkbench } from '@tade/extensions-core'
import { VoiceSurface } from '@tade/voice-core'
import { Speaker } from '@tade/voice-tts'
import { agentEnded, eventNews } from './inbox.ts'
import { freeViewportKeys } from './keys.ts'
import { knownTasks, Live } from './live.ts'
import {
  type AppState,
  addTurn,
  focusTask,
  initialState,
  notice,
  onEvent,
  setQuestion,
  withProjects,
  withTasks,
  withTerminals,
} from './model.ts'
import { FRAME_MS } from './pace.ts'
import { pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { Router } from './wire/actions.ts'
import { Agents } from './wire/agents.ts'
import { Awake, caffeineHold } from './wire/awake.ts'
import { Checks } from './wire/checks.ts'
import { Comments } from './wire/comments.ts'
import {
  type AppOptions,
  copySaying,
  copySpanSaying,
  copyText,
  type Subject,
  type Thinker,
  type Wiring,
  type WorkerImageFile,
  wiringFor,
} from './wire/context.ts'
import { Earlier } from './wire/earlier.ts'
import { Evaluations } from './wire/evaluations.ts'
import { Extensions } from './wire/extensions.ts'
import { Files } from './wire/files.ts'
import { frameOf } from './wire/frame.ts'
import { tellNow } from './wire/handed.ts'
import { Images } from './wire/images.ts'
import { Intake } from './wire/intake.ts'
import { Keyboard } from './wire/keyboard.ts'
import { Landing } from './wire/landing.ts'
import { Lanes } from './wire/lanes.ts'
import { Looks, slowLook } from './wire/looks.ts'
import { Machine } from './wire/machine.ts'
import { Mouse } from './wire/mouse.ts'
import { Notes } from './wire/notes.ts'
import { Orchestrator } from './wire/orchestrator.ts'
import { kittyActive, Repaint, repaintScreen, type Screen, screenFor } from './wire/paint.ts'
import { Projects, type ProjectTools } from './wire/projects.ts'
import { Queue, type QueueTools } from './wire/queue.ts'
import { type Remotes, type RemoteTools, remotesFor } from './wire/remotes.ts'
import { Routes } from './wire/routes.ts'
import { Schedules, type WatchTools } from './wire/schedules.ts'
import { Search } from './wire/search.ts'
import { Settings, type SettingTools } from './wire/settings.ts'
import { Spend } from './wire/spend.ts'
import { Updates, type UpdateTools } from './wire/updates.ts'
import { spokenLine, Voice, vocabulary } from './wire/voice.ts'
import { Away } from './wire/web.ts'
import { talkingThrough } from './wire/web-asking.ts'
import { Window } from './wire/window.ts'

// The window: every project down the side, the agent you are watching in the
// middle, the orchestrator along the bottom.
//
// This file only wires things together. What it should show is in `model.ts`,
// how it looks is in `view.ts`, and where the facts come from is in `live.ts`,
// so all three can be tested without a terminal.

// `Thinker`, `WorkerImageFile` and `AppOptions` live in `wire/context.ts` beside the
// `Wiring` every subject is handed first, re-exported so nothing outside has to know.
export type { AppOptions, Thinker, WorkerImageFile } from './wire/context.ts'

/** How long the window's own closes may take, of the second quitting has (`quitting.ts`). */
const STOP_MS = 300

export class App {
  private readonly opts: AppOptions
  private readonly terminal: Terminal
  private readonly tui: Screen
  private state: AppState = initialState()
  private readonly skin: Skin = skinFor(process.env, process.stdout.isTTY === true)
  private readonly pointerShapes = pointerShapes(process.env)
  /** When the lanes are looked at, one look at a time. */
  private readonly looks: Looks
  private live: Live | null = null
  private timer: NodeJS.Timeout | null = null
  private readonly repaint = new Repaint()
  private release: (() => void) | null = null
  private stopped = false
  private settle: (late: Unclosed[]) => void = () => {}
  private readonly closed: Promise<Unclosed[]>
  /** What every subject is handed: built once, over `this`, so each reads the state as it is now. */
  private readonly wire: Wiring
  /** Reading a note, copying it, taking it back. */
  private readonly notes: Notes
  /** Running a task's checks, reading what one printed, saying which run here. */
  private readonly checks: Checks
  /** Push-to-talk, what is said back, and the mute that is now. */
  private readonly voice: Voice
  /** The away view: who may read Tade from off this machine, while this window is open. */
  private readonly away: Away
  /** Other machines' Tades this one is an owner of, linked while this window is open. */
  private readonly remotes: Remotes
  /** The anti-sleep hold, while Tade is open and no longer. */
  private readonly awake: Awake
  /** Pictures, and the clipboard they usually arrive on. */
  private readonly images: Images
  /** The Settings page, and the one path a setting is written by. */
  private readonly settings: Settings
  /** Who the agents run as, and the terminal a command is watched in. */
  private readonly machine: Machine
  /** What Tade runs and whether it is current: the Updates page, the check, the chip, the run. */
  private readonly updates: Updates
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
  private readonly comments: Comments
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
  private readonly earlier: Earlier
  /** Where an action, a menu, a panel and a command land. */
  private readonly router: Router
  /**
   * Every subject, in the order their answers are folded together.
   *
   * The order decides nothing today — no two of them answer for the same field — and it is written
   * down so that if two ever did, the answer would at least be the same one every time. `mouse` is
   * not in it: it answers no question the frame or the router asks, it only turns what happened on
   * the screen into one of them.
   */
  private readonly intake: Intake
  private readonly subjects: readonly Subject[]

  private constructor(opts: AppOptions) {
    this.opts = opts
    this.wire = wiringFor(opts, {
      state: () => this.state,
      put: (next) => {
        this.state = next
      },
      live: () => this.live,
      now: () => this.now(),
      layout: () => this.window.layout(),
      draw: () => this.draw(),
      typed: () => this.looks.typed(),
    })
    this.looks = new Looks({
      look: () => this.look(),
      stopped: () => this.stopped,
      owe: () => this.tui.oweEcho(),
      slow: (startedAt) => slowLook(this.opts, this.state.panes.length, startedAt),
    })
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
      orchestrator: () => this.orchestrator,
      advanceQueue: () => void this.advanceQueue(),
      twins: (project) => this.remotes.watchTwins(project),
    })
    this.intake = new Intake(this.wire, { advanceQueue: () => void this.advanceQueue() })
    this.search = new Search(this.wire, {
      settings: () => this.settings.rows(),
      openFile: (path, line) => this.files.openFile(path, line),
      openFind: (id, query, index) => this.lanes.openFind(id, query, index),
      clicked: (target) => this.mouse.clicked(target),
      decide: (allow) => this.agents.decide(allow),
      stopAgent: (task) => this.agents.stopAgent(task),
      openChange: (task, path) => this.files.openChange(task, path),
      openSettings: (category) => this.settings.open(category),
      showTerminal: (id) => this.lanes.showTerminal(id),
      quit: () => this.window.quit(),
      run: (action) => this.router.run(action),
      machines: () => this.remotes.machines(),
    })
    this.window = new Window(this.wire, {
      setTitle: (title) => this.terminal.setTitle(title),
      stop: () => this.stop(),
      news: () => this.tui.requestNews(),
    })
    this.machine = new Machine(this.wire, {
      reload: () => this.window.reload(),
      terminalSize: () => this.lanes.terminalSize(),
      showTerminal: (id) => this.lanes.showTerminal(id),
      onScreenWith: (flow) => this.orchestrator.onScreenWith(flow),
      refreshModels: () => this.routes.refreshModels(),
    })
    this.updates = new Updates(this.wire, {
      reload: () => this.window.reload(),
      reloadStops: () => this.window.reloadStops(),
      terminal: (name) => this.machine.watched(name),
      news: (said) => this.orchestrator.note(said),
    })
    this.settings = new Settings(this.wire, {
      loadAccounts: () => void this.machine.loadAccountViews(),
      refreshModels: () => this.routes.refreshModels(),
      lookAtWhatIsInstalled: () => void this.updates.lookAtWhatIsInstalled(),
      tellThinking: (level) => this.orchestrator.tellThinking(level),
      setupChanged: () => this.extensions.forgetSetup(),
      silence: () => {
        this.orchestrator.stopSpeaking()
        void this.voice.silence()
      },
      accountAction: (choice) => this.machine.accountAction(choice),
      remoteAction: (choice) => this.remotes.action(choice, this.projects),
      updateAction: (choice) => this.updates.action(choice),
      testMicrophone: () => this.voice.testMicrophone(),
      openFile: (path) => this.files.openPlace({ path }),
      copy: (text) => copyText(text, (data) => this.terminal.write(data)),
      releases: () => kittyActive(this.terminal),
      holdSleep: () => this.awake.apply(),
      away: () => this.away,
    })
    this.awake = new Awake(
      this.wire,
      { keep: (on) => this.settings.writeKey('agents.keep_awake', on || undefined, String(!on)) },
      opts.hold ?? caffeineHold(),
    )
    this.images = new Images(this.wire, {
      soonTick: () => this.looks.soonTick(),
      answering: () => this.orchestrator.attached(),
    })
    this.away = new Away(this.wire, {
      decided: (allow) => this.agents.decide(allow),
      news: (said) => this.orchestrator.note(said),
      // The conversation, through the one subject that holds it: `Talking` is
      // five methods, so what a route can reach is that list and not `say`.
      talk: talkingThrough(() => this.orchestrator),
      // The queue's own rule, so a device approving work that came from
      // outside meets the same grant, plan and source checks a start does.
      stands: (row) => this.queue.standsFor(row),
      // The factory floor, as the inbox subject already folds it: no page starts work.
      factory: () => this.intake.factory(),
      // A file edit writes no journal line, so the fold is told.
      saved: () => this.intake.markStale(),
      // The one door a setting is written by: the key nothing types, and a change from away.
      settings: this.settings,
      // Stopping and closing from away, through the keyboard's own two doors.
      lifecycle: { agents: () => this.agents, projects: () => this.projects },
      copy: (text) => copyText(text, (data) => this.terminal.write(data)),
    })
    this.remotes = remotesFor(this.wire, {
      orchestrator: () => this.orchestrator,
      files: () => this.files,
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
      writeKey: (key, value, was) => this.settings.writeKey(key, value, was),
      orchestrator: () => this.orchestrator,
    })
    this.terminal = opts.terminal ?? new ProcessTerminal()
    // Mouse reporting is on by default, which is what makes the window
    // clickable: events arrive at the component with coordinates local to it.
    // It asks for focus reports too, which `watch` reads; a resize is a look at once.
    this.repaint.watch(this.terminal, () => void this.looks.tick())
    this.tui = screenFor(this.terminal)
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
      fromClipboard: (picture, type) => void this.images.paste(picture, type),
      askWhereImagesGo: (paths) => this.images.askWhere(paths),
      talkStart: () => void this.voice.talkStart(),
      talkStop: () => void this.voice.talkStop(),
      // The away view first, because letting a device in is the same act in
      // the same vocabulary and its question has a sixty-second deadline on
      // it; with nothing asking it hands the keys straight to the agents.
      decide: (allow) => void this.away.decide(allow),
      openSearch: () => this.search.open(),
      run: (action) => void this.router.run(action),
      interrupt: () => void (this.remotes.interrupt() || this.orchestrator.interrupt()),
      quit: () => this.window.quit(),
      soonTick: () => this.looks.soonTick(),
      settle: () => this.mouse.settle(),
      toLane: (data) => this.lanes.toLane(data),
      act: (said) => void this.router.act(said),
      say: (said) => this.remotes.say(said) || this.orchestrator.say(said),
    })
    this.lanes = new Lanes(this.wire, {
      size: () => this.room(),
      skin: this.skin,
      soonTick: () => this.looks.soonTick(),
      printed: () => this.looks.printed(),
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
      watches: this.schedules,
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
      credentialProblem: (provider) => this.machine.credentialProblem(provider),
      machines: () => this.remotes.machines(),
      nobodyHere: () => this.away.nobodyHere(),
    })
    this.agents = new Agents(this.wire, {
      useConfig: (config) => this.settings.use(config),
      prefill: (line) => this.keyboard.prefill(line),
      openChange: (task, path) => this.files.openChange(task, path),
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
      comment: (panel, choice) => this.comments.submit(panel, choice),
      there: (machine, task, path) => this.remotes.mirrored()?.diff(machine, task, path) ?? null,
    })
    this.comments = new Comments(this.wire, {
      shown: () => this.files.shown(),
      ask: (words, about) => this.orchestrator.ask(words, about),
      listening: () => this.orchestrator.started,
      remember: (words) => this.keyboard.remember(words),
      steerThere: (machine, task, said) => this.remotes.steer(machine, task, said),
    })
    this.mouse = new Mouse(this.wire, {
      stopped: () => this.stopped,
      borrowed: () => this.orchestrator.borrowed(),
      size: () => this.room(),
      write: (data) => this.terminal.write(data),
      pointerShapes: () => this.pointerShapes,
      remember: () => this.window.remember(),
      panelInputs: () => this.router.panelInputs(),
      applyPanel: (outcome) => this.router.applyPanel(outcome),
      openMenu: (subject, at) => this.router.openMenu(subject, at),
      run: (action, from) => void this.router.run(action, from),
      reslice: (area) => this.lanes.reslice(area),
      soonTick: () => this.looks.soonTick(),
      turnedInLane: (event) => this.lanes.turnedInLane(event),
      sideways: () => this.tui.turnedSideways(),
      selectTo: (line, x, extend, drag) => this.keyboard.selectTo(line, x, extend, drag),
      selectedOnLine: () => this.keyboard.selectedText(),
      clickedOn: (line, x, clicks) => this.keyboard.clickedOn(line, x, clicks),
      fileLines: () => this.files.lines(),
      fileBody: (panel) => this.files.body(panel),
      copySelection: (text) => copySpanSaying(this.wire, text, (data) => this.terminal.write(data)),
      resolvePath: (path) => this.files.resolvePath(path),
      openFile: (path, line) => this.files.openFile(path, line),
      openLink: (url) => void this.files.openLink(url),
      openChange: (task, path) => void this.files.openChange(task, path),
      openNote: (note) => this.notes.open(note),
      openAgent: () => void this.agents.openAgent(),
    })
    this.projects = new Projects(this.wire, {
      useConfig: (loaded) => this.settings.use(loaded),
      changeSetting: (req) => this.settings.change(req),
      writeSetting: (path, value) => this.settings.write(path, value),
      openSettings: (page, find, project) => this.settings.open(page, find, project),
      rememberWindow: () => this.window.remember(),
    })
    this.earlier = new Earlier(this.wire)
    this.subjects = [
      this.window,
      this.lanes,
      this.keyboard,
      this.files,
      this.agents,
      this.routes,
      this.checks,
      new Spend(this.wire),
      new Landing(this.wire, this.remotes),
      new Evaluations(this.wire),
      this.notes,
      this.schedules,
      this.queue,
      this.intake,
      this.orchestrator,
      this.comments,
      this.earlier,
      this.extensions,
      this.search,
      this.settings,
      this.machine,
      this.updates,
      this.remotes,
      this.projects,
      this.voice,
      this.awake,
      this.images,
      this.away,
    ]
    this.router = new Router(this.wire, {
      subjects: () => this.subjects,
      stop: () => this.stop(),
      openSettings: (category) => this.settings.open(category),
      onScreen: (name) => this.orchestrator.onScreen(name),
      loadDiff: (task, path) => this.files.loadDiff(task, path),
      loadFileDiff: (path) => this.files.loadFileDiff(null, path),
      loadExtensionView: (panel) => this.extensions.refreshExtensionView(panel.extension, panel),
      searchOpened: () => this.search.opened(),
      lookAtWhatIsInstalled: () => void this.updates.lookAtWhatIsInstalled(),
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
   * Said out loud in the strip rather than silently: until this happens, a sentence Tade's own
   * grammar does not recognise has nowhere to go, and knowing when that changed is the
   * difference between waiting and retyping.
   */
  attachThinker(thinker: Thinker): void {
    this.orchestrator.attach(thinker)
  }

  /**
   * Write down the model the orchestrator ended up on when none was chosen, so it stays on it.
   * Otherwise the harness's default decides every start: whatever an agent last switched to.
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
   * The orchestrator could not be started, said where you would have waited for it — not
   * swallowed, which left a window that never answered anything and gave no reason.
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

  /** Resolves when the window has been closed, with what it gave up waiting for or could not close. */
  wait(): Promise<Unclosed[]> {
    return this.closed
  }

  /** Whether the window is closing or closed, however that began. */
  get closing(): boolean {
    return this.stopped
  }

  /** What goes with the prompt of an agent the orchestrator starts: what you attached (`Images`). */
  handOff(task: string): Promise<{ note: string; images: WorkerImageFile[] }> {
    return this.images.handOff(task)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.window.stopTurning()
    this.looks.stop()
    this.mouse.letGo()
    this.lanes.stopWatching()
    this.images.stop()
    // The machine goes back to sleeping as it did, here rather than anywhere
    // later: the hold is Tade's for exactly as long as Tade is open.
    this.awake.release()
    this.window.remember()
    this.release?.()
    if (this.pointerShapes) this.terminal.write(pointerSequence('default'))
    this.tui.stop()
    // Leave the terminal as it was found. The alternate screen is restored by the TUI, but whatever
    // was painted before it goes back is a half-window stranded in your scrollback.
    this.terminal.clearScreen()
    // Side by side, by one moment: a listener or a look that never answers is
    // named on the way out, never what keeps the prompt from coming back.
    const late = await closeBy(
      [
        { name: 'the voice', close: () => this.voice.stop() },
        { name: 'the away view', close: () => this.away.stop() },
        { name: 'the remote links', close: () => this.remotes.stop() },
        { name: 'the status look', close: () => this.live?.stop() },
      ],
      Date.now() + STOP_MS,
    )
    this.settle(late)
  }

  private async begin(): Promise<void> {
    this.window.restoreView()
    // Read once, in the background: nothing waits on the catalog but the list.
    void this.machine.loadAccounts()
    // What the last window found about updates, so the strip says it at once.
    void this.updates.recall()
    // Every project, before any of them has a task: an empty one is still a
    // tab you can be standing in when you start work.
    const config = this.opts.config
    this.state = withProjects(this.state, Object.keys(config.projects), titlesOf(config))
    // A local as well as a field: what the surface below closes over is never a maybe.
    const live = await Live.start({
      client: this.opts.client,
      config: this.opts.config,
      home: this.opts.home,
      tadeHome: this.opts.home,
      ...(this.opts.cwd ? { cwd: this.opts.cwd } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
      openedAt: this.wire.openedAt,
      status: this.opts.status,
      onTasks: (tasks, moved) => {
        this.state = withTasks(this.state, tasks)
        // Focus can only be restored once there are panes to restore it to,
        // and only the first time: after that it is wherever you moved to.
        this.window.restoreFocus()
        this.orchestrator.noteTasks(tasks)
        void this.routes.learnHarnesses(tasks)
        void this.queue.recordRulesMet()
        void this.checks.beat()
        void this.schedules.runDue().then(() => this.advanceQueue())
        void this.orchestrator.reflect(tasks)
        this.away.beat()
        this.remotes.beat()
        this.updates.beat()
        void this.settings.fold(() => this.extensions.reloadExtensions())
        if (moved) this.draw() // a beat that found what the last did is not news
      },
      onEvent: (event) => {
        this.state = onEvent(this.state, event, this.now())
        // A document handed over, or what an agent left, is told now (or kept
        // as news where it cannot be: `tellNow`); everything else waits as news.
        const told = tellNow(this.wire, this.orchestrator, event)
        const heard = told ? null : eventNews(event)
        if (heard) this.orchestrator.note(heard)
        // An agent that is gone, however it went: told rather than discovered
        // by the orchestrator steering something that is not there any more.
        const ended = agentEnded(event)
        if (ended) this.orchestrator.noteEnded(ended)
        if (event.type === 'run_started' && event.task) this.orchestrator.noteStarted(event.task)
        this.tui.requestNews(event.urgency === 'blocking')
      },
      onWarning: (message) => {
        this.state = notice(this.state, message, this.now())
        this.draw()
      },
      onChange: () => this.draw(),
      onDue: () => this.looks.soonTick(),
      onWork: (task) => void this.agents.nameAgent(task),
      onTerminals: (terminals) => {
        this.state = withTerminals(this.state, terminals)
        this.draw()
      },
      asked: () => ({ elsewhere: this.remotes.mirrored()?.elsewhere() ?? {} }),
    })
    this.live = live
    this.extensions.readLinkers()
    this.extensions.watchExtensions()
    void live.looked.then(() => this.agents.reopenLost())
    // Whatever the config says about sleep, made true of the machine.
    this.awake.apply()
    // Only where a person turned it on: off, nothing is constructed and no socket exists.
    await this.away.open()

    const attention = this.opts.config.surfaces.voice.attention
    this.voice.use(
      await VoiceSurface.start({
        tade: this.opts.client,
        // Yours, where it is a matter of taste. Everything else about what is worth interrupting
        // you for is the engine's, and not a setting — and the overlay is `attentionFor`'s, so the
        // phone reads the same quiet hours and the same budget out of the same two keys.
        settings: attentionFor('voice', attention),
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
        (width) => {
          const frame = frameOf(
            this.subjects,
            { width, height: Math.max(6, this.terminal.rows), skin: this.skin },
            this.state.panel,
          )
          // The spinner's own clock, wound by what this frame shows turning.
          this.window.drew(frame)
          return { state: this.state, frame }
        },
        () => this.now(),
      ),
    )
    this.release = this.tui.addInputListener((data) => this.keyboard.onInput(data))
    this.opts.takingScreen?.()
    this.tui.start()
    void Promise.all([this.keyboard.load(), this.earlier.load()])
    this.timer = setInterval(() => void this.looks.tick(), this.opts.frameMs ?? FRAME_MS)
    this.timer.unref?.()
    await this.looks.tick()
  }

  /** Read the lanes in front and draw what changed: what `Looks` runs, one at a time. */
  private async look(): Promise<void> {
    if (this.stopped) return
    this.agents.beats()
    this.agents.reopenStopped()
    this.extensions.askExtensions()
    this.images.look()
    this.intake.look()
    this.live?.lookAgain()
    if (!this.stopped && !this.orchestrator.borrowed() && this.repaint.dueAt(this.now()))
      repaintScreen(this.tui, this.terminal)
    const at = await this.lanes.fitPane()
    this.window.titleHere()
    // Side by side, and drawn once: neither screen waits behind the other's read.
    const [paneScreen, terminal] = await Promise.all([
      this.lanes.readPane(at),
      this.lanes.captureTerminal(),
    ])
    // News: a lane drew something new, the microphone's clock, or a spinner turned.
    if (paneScreen || terminal || this.state.talkingSince !== null || this.window.turned())
      this.draw()
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

  /** What the orchestrator's watch tools do, answered from this window. */
  watchTools(): WatchTools {
    return this.schedules.tools()
  }

  /** What the orchestrator's update and reload tools do, from this window. */
  updateTools(): UpdateTools {
    return this.updates.tools()
  }

  /** What the `ToolHost` asks at every call. `Away.arming` has the argument. */
  awayTools(): Arming {
    return this.away.arming()
  }

  /** What the orchestrator's `tade_remote_tell` does, over this window's links. */
  readonly remoteTools = (): RemoteTools => this.remotes.tools()

  private draw(): void {
    if (!this.stopped && !this.orchestrator.borrowed()) this.tui.requestRender()
  }

  /** How big the terminal is, which is how big everything drawn in it may be. */
  private room(): { columns: number; rows: number } {
    return { columns: this.terminal.columns, rows: this.terminal.rows }
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
}
