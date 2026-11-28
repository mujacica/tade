import { join } from 'node:path'
import { ProcessTerminal, type Terminal } from '@earendil-works/pi-tui'
import { type Arming, attentionFor, closeBy, hubOf, type Unclosed } from '@tade/core'
import type { ExtensionWorkbench } from '@tade/extensions-core'
import { VoiceSurface } from '@tade/voice-core'
import { Speaker } from '@tade/voice-tts'
import { surfaceOf, type WindowDoor } from '@tade/web'
import { runningVersion } from '@tade/workbench/programs'
import { type FaceCapabilities, ON_THIS_MACHINE } from './faces.ts'
import { Heart } from './heart.ts'
import type { Intent } from './keymap.ts'
import { freeViewportKeys } from './keys.ts'
import { knownTasks } from './live.ts'
import { type AppState, addTurn, focusTask, paneLane, setQuestion } from './model.ts'
import { FRAME_MS } from './pace.ts'
import { pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { Router } from './wire/actions.ts'
import type { MachineActs } from './wire/acts.ts'
import type { Agents } from './wire/agents.ts'
import { Awake, caffeineHold } from './wire/awake.ts'
import { Checks } from './wire/checks.ts'
import { Comments } from './wire/comments.ts'
import {
  type AppOptions,
  copySaying,
  copySpanSaying,
  copyText,
  notify,
  type Subject,
  type Thinker,
  type Wiring,
  type WorkerImageFile,
} from './wire/context.ts'
import type { ConversationPlace } from './wire/conversation.ts'
import type { Earlier } from './wire/earlier.ts'
import { Evaluations } from './wire/evaluations.ts'
import { Extensions } from './wire/extensions.ts'
import { FaceScreen } from './wire/face-screen.ts'
import { FarFaces } from './wire/far-faces.ts'
import { Files } from './wire/files.ts'
import { FleetJournals } from './wire/fleet-journals.ts'
import { FleetReload } from './wire/fleet-reload.ts'
import { frameOf } from './wire/frame.ts'
import { Images } from './wire/images.ts'
import type { Intake } from './wire/intake.ts'
import { type InventoryTools, settingsOpen } from './wire/inventory.ts'
import { Keyboard } from './wire/keyboard.ts'
import { Lanes } from './wire/lanes.ts'
import { Looks, slowLook } from './wire/looks.ts'
import { Machine } from './wire/machine.ts'
import { Mouse } from './wire/mouse.ts'
import { newWhereFor } from './wire/new-where.ts'
import { Notes } from './wire/notes.ts'
import type { Orchestrator } from './wire/orchestrator.ts'
import { kittyActive, Repaint, repaintScreen, type Screen, screenFor } from './wire/paint.ts'
import { Plans } from './wire/plans.ts'
import type { Projects, ProjectTools } from './wire/projects.ts'
import type { Queue, QueueTools } from './wire/queue.ts'
import { Races } from './wire/race-panel.ts'
import type { Remotes, RemoteTools } from './wire/remotes.ts'
import { Routes } from './wire/routes.ts'
import type { Schedules, WatchTools } from './wire/schedules.ts'
import { Screens } from './wire/screens.ts'
import { Search } from './wire/search.ts'
import type { Settings, SettingTools } from './wire/settings.ts'
import { Spend } from './wire/spend.ts'
import { Updates, type UpdateTools } from './wire/updates.ts'
import { spokenLine, Voice, vocabulary } from './wire/voice.ts'
import type { Away } from './wire/web.ts'
import { MACHINE } from './wire/web-panel.ts'
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
  /**
   * The part that runs with no screen — the beat, the queue, schedules and
   * watches, intake, the orchestrator, the away view and its notifications,
   * and the settings, projects and agents they act through — which this window
   * is a face over (`heart.ts`). It holds the state, and the window reads and
   * writes it through `state` below.
   */
  private readonly heart: Heart
  /** The terminal lent to a form, and the conversation kept where you were reading it. */
  private readonly screens: Screens
  private readonly skin: Skin = skinFor(process.env, process.stdout.isTTY === true)
  private readonly pointerShapes = pointerShapes(process.env)
  /** When the lanes are looked at, one look at a time. */
  private readonly looks: Looks
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
  /** Reload every machine this one is an owner of, then this window; and when one is due. */
  private readonly fleet: FleetReload
  /** Where you were, how big it all is, and what the title says. */
  private readonly window: Window
  /** What `ctrl+k` finds, inside files and out, and where a result goes. */
  private readonly search: Search
  private readonly plans: Plans
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
  /** The faces attached to this window's heart over other terminals (`attach`), until each goes. */
  private readonly faces = new Set<FaceScreen>()
  /**
   * The phones that draw their own copy of this window through the away
   * door's full view (§10 T3): a face each on the heart, sent state and never
   * a frame drawn, and the one act they send back carried out as that face.
   */
  private readonly far: FarFaces

  private constructor(opts: AppOptions) {
    this.opts = opts
    // The face's halves of everything the heart runs, each asked for when it
    // is needed: every subject named here is made below, after the heart.
    this.heart = new Heart(opts, {
      capabilities: ON_THIS_MACHINE,
      draw: () => this.paint(),
      typed: () => this.looks.typed(),
      layout: () => this.window.layout(),
      due: () => this.looks.soonTick(),
      twins: (project) => this.remotes.watchTwins(project),
      watchThere: (machine, project, watch) => this.remotes.watchThere(machine, project, watch),
      places: () => this.remotes.places(),
      asked: () => ({ elsewhere: this.remotes.mirrored()?.elsewhere() ?? {} }),
      sawTasks: (tasks) => {
        // Focus can only be restored once there are panes to restore it to,
        // and only the first time: after that it is wherever you moved to.
        this.window.restoreFocus()
        void this.routes.learnHarnesses(tasks)
      },
      beat: (_tasks, moved) => {
        // The links beat on the heart's own beat, before this.
        this.fleet.beat()
        this.updates.beat()
        this.far.beat()
        if (moved) this.draw() // a beat that found what the last did is not news
      },
      heard: (event) => this.tui.requestNews(event.urgency === 'blocking'),
      serversMoved: () => this.extensions.askAgain(),
      inventories: {
        remotes: () => this.remotes.inventories(),
        settingsOpen: () => settingsOpen(this.wire.state.panel),
      },
      settings: {
        loadAccounts: () => void this.machine.loadAccountViews(),
        refreshModels: () => this.routes.refreshModels(),
        lookAtWhatIsInstalled: () => void this.updates.lookAtWhatIsInstalled(),
        setupChanged: () => this.extensions.forgetSetup(),
        openSetup: (extension) => this.extensions.openSetup(extension),
        silence: () => void this.voice.silence(),
        accountAction: (choice) => this.machine.accountAction(choice),
        remoteAction: (choice) => this.remotes.action(choice, this.projects),
        updateAction: (choice) => this.updates.action(choice),
        testMicrophone: () => this.voice.testMicrophone(),
        openFile: (path) => this.files.openPlace({ path }),
        copy: (text) => this.toClipboard(text),
        releases: () => kittyActive(this.terminal),
        holdSleep: () => this.awake.apply(),
      },
      agents: {
        prefill: (line) => this.keyboard.prefill(line),
        openChanges: (task) => this.files.openChanges(task),
        openPlace: (target) => this.files.openPlace(target),
        copyToClipboard: (text) => this.toClipboard(text),
        routes: () => this.routes,
        handsOver: () => this.remotes.moved(),
        there: () => this.remotes.there(),
      },
      projects: { rememberWindow: () => this.window.remember() },
      orchestrator: {
        anchored: (next) => this.screens.anchored(next),
        voice: {
          ready: () => this.voice.ready,
          awaiting: () => this.voice.awaiting,
          handle: (said) => this.voice.handle(said),
          speakChunk: (text) => this.voice.speakChunk(text),
          speakMessage: (text) => this.voice.speakMessage(text),
          flushSpeech: () => this.voice.flushSpeech(),
        },
        remember: (said) => this.keyboard.remember(said),
        credentialProblem: (provider) => this.machine.credentialProblem(provider),
        machines: () => this.remotes.machines(),
      },
      away: {
        copy: (text) => this.toClipboard(text),
        // A restart from the person's own phone ends what this window would.
        reloadStops: () => this.window.reloadStops(),
        // And reloads every machine, as the strip's reload does.
        reloadAll: () => this.fleet.reload(),
        // The window itself, for a phone that draws its own copy of it.
        window: () => this.windowDoor(),
      },
      remotes: {
        screens: () => this.screens,
        files: () => this.files,
        copy: (text) => copySaying(this.wire, text, (data) => this.terminal.write(data)),
      },
    })
    this.wire = this.heart.wire
    this.looks = new Looks({
      look: () => this.look(),
      stopped: () => this.stopped,
      owe: () => this.tui.oweEcho(),
      slow: (startedAt) => slowLook(this.opts, this.state.panes.length, startedAt),
    })
    this.notes = new Notes(this.wire, {
      copy: (text) => copySaying(this.wire, text, (data) => this.terminal.write(data)),
    })
    // The heart's own, which the window draws and answers presses for.
    this.queue = this.heart.queue
    this.schedules = this.heart.schedules
    this.intake = this.heart.intake
    this.settings = this.heart.settings
    this.orchestrator = this.heart.orchestrator
    this.away = this.heart.away
    this.agents = this.heart.agents
    this.projects = this.heart.projects
    this.plans = new Plans(this.wire, { from: () => this.intake.factory().runFrom })
    this.search = new Search(this.wire, {
      settings: () => this.settings.rows(),
      openFile: (path, line) => this.files.openFile(path, line),
      openFind: (id, query, index) => this.lanes.openFind(id, query, index),
      clicked: (target) => this.mouse.clicked(target),
      decide: (allow) => this.agents.decide(allow),
      stopAgent: (task) => this.agents.stopAgent(task),
      openChanges: (task) => this.files.openChanges(task),
      openSettings: (category) => this.settings.open(category),
      showTerminal: (id) => this.lanes.showTerminal(id),
      quit: () => this.window.quit(),
      run: (action) => this.router.run(action),
      machines: () => this.remotes.machines(),
      plans: () => this.plans.rows(),
      fleet: new FleetJournals({
        home: this.wire.opts.home,
        now: () => this.wire.now(),
        idOf: (remote) => this.heart.feeds.syncedWith(remote)?.id ?? null,
        say: (said) => {
          this.wire.note(new Error(said))
          this.wire.draw()
        },
        draw: () => this.wire.draw(),
      }),
    })
    this.window = new Window(this.wire, {
      setTitle: (title) => this.terminal.setTitle(title),
      stop: () => this.stop(),
      news: () => this.tui.requestNews(),
      reloadAll: () => this.fleet.reload(),
    })
    this.machine = new Machine(this.wire, {
      reload: () => this.window.reload(),
      terminalSize: () => this.lanes.terminalSize(),
      showTerminal: (id) => this.lanes.showTerminal(id),
      onScreenWith: (flow) => this.screens.onScreenWith(flow),
      refreshModels: () => this.routes.refreshModels(),
      writeSetting: (path, value) => this.settings.write(path, value),
      signInThere: (machine) => this.remotes.signInOrchestrator(machine),
      restartOrchestrator: () => this.orchestrator.moveAccount(false),
      // Every machine's Accounts tab, through the heart's door, which the phone uses too.
      accountsThere: () => this.heart.accounts,
      // An account's own sign-in there, in a terminal over the link: the Remotes page's press.
      signInAccountThere: (machine, harness, account) =>
        this.remotes.action(`remote:sign-in:${machine}:${harness}:${account ?? ''}`),
    })
    this.updates = new Updates(this.wire, {
      reload: () => this.window.reload(),
      reloadNow: () => this.window.reloadNow(),
      fleetDue: () => this.fleet.due(),
      alsoReloads: () => this.remotes.inventories().map((one) => one.name),
      reloadStops: () => this.window.reloadStops(),
      arm: () => this.orchestrator.arm(),
      terminal: (name) => this.machine.watched(name),
      news: (said) => this.orchestrator.note(said),
      ownCode: () => ({
        changed: this.heart.ownCode.owed(),
        startedOn: this.heart.ownCode.startedOn(),
      }),
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
    this.remotes = this.heart.remotes
    this.fleet = new FleetReload({
      home: opts.home,
      names: () => this.remotes.inventories().map((one) => one.name),
      reach: (name) => this.remotes.reachFor(name),
      held: (name) => this.remotes.held().find((one) => one.remote === name) ?? null,
      answer: (name) => this.remotes.asked()?.held(name) ?? null,
      ask: async (name) => await this.remotes.asked()?.ask(name),
      hub: () => hubOf(this.wire.opts.config).hub?.name ?? null,
      oneWith: () => this.heart.conversation.oneWith(),
      here: () => this.heart.conversation.standing(),
      version: () => runningVersion(),
      hereName: MACHINE,
      onScreenWith: (flow) => this.screens.onScreenWith(flow),
      ...(opts.reloadWindow && { reloadHere: opts.reloadWindow }),
      say: (said) => {
        notify(this.wire, said)
        this.draw()
      },
      now: () => this.wire.now(),
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
    })
    this.terminal = opts.terminal ?? new ProcessTerminal()
    // Mouse reporting is on by default, which is what makes the window
    // clickable: events arrive at the component with coordinates local to it.
    // It asks for focus reports too, which `watch` reads; a resize is a look at once.
    this.repaint.watch(this.terminal, () => void this.looks.tick())
    this.tui = screenFor(this.terminal)
    this.screens = new Screens(this.wire, {
      terminal: this.terminal,
      suspend: () => this.tui.stop(),
      resume: () => this.tui.start(),
    })
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
      // The away view first, because its question has a sixty-second deadline
      // on it — opened on the device asking, never answering it unseen; with
      // nothing asking it hands the keys straight to the agents.
      decide: (allow) => void this.away.keyed(allow),
      openSearch: () => this.search.open(),
      run: (action) => void this.router.run(action),
      interrupt: () => void (this.remotes.interrupt() || this.orchestrator.interrupt()),
      quit: () => this.window.quit(),
      soonTick: () => this.looks.soonTick(),
      settle: () => this.mouse.settle(),
      reach: (area) => this.mouse.reach(area),
      toLane: (data, pasted) => this.lanes.toLane(data, pasted),
      litText: () => this.mouse.litText(),
      copy: (text) => copySpanSaying(this.wire, text, (data) => this.terminal.write(data)),
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
      size: () => this.faceRoom(),
      skin: this.skin,
      takeConfig: () => this.heart.takeConfig(),
      dateOf: (at) => this.window.dateOf(at),
      anchored: (next) => this.screens.anchored(next),
      openPlace: (target) => this.files.openPlace(target),
      openLink: (url) => this.files.openLink(url),
      reveal: (path, folder) => this.files.reveal(path, folder),
      watchCommand: (kind, line) => this.machine.watchCommand(kind, line),
      watches: this.schedules,
      spoken: (text) => spokenLine(text),
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
      there: () => this.remotes.there(),
    })
    this.files = new Files(this.wire, {
      size: () => this.faceRoom(),
      skin: this.skin,
      copy: (text) => copySaying(this.wire, text, (data) => this.terminal.write(data)),
      openSearch: (query) => this.search.open(query),
      onScreenWith: (flow) => this.screens.onScreenWith(flow),
      paneSize: () => this.lanes.paneSize(),
      applyPanel: (outcome) => this.router.applyPanel(outcome),
      selectedInFile: () => this.mouse.fileSelectionText(),
      copySelection: (text) => copySpanSaying(this.wire, text, (data) => this.terminal.write(data)),
      comment: (panel, choice) => this.comments.submit(panel, choice),
    })
    this.comments = new Comments(this.wire, {
      shown: () => this.files.shown(),
      ask: (words, about) => this.orchestrator.ask(words, about),
      listening: () => this.orchestrator.started,
      remember: (words) => this.keyboard.remember(words),
      steerThere: (machine, agent, said) => this.remotes.steerThere(machine, agent, said),
    })
    this.mouse = new Mouse(this.wire, {
      stopped: () => this.stopped,
      borrowed: () => this.screens.borrowed(),
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
      copySelection: (text) => copySpanSaying(this.wire, text, (data) => this.terminal.write(data)),
      resolvePath: (path) => this.files.resolvePath(path),
      openFile: (path, line) => this.files.openFile(path, line),
      openLink: (url) => void this.files.openLink(url),
      openChange: (task, path) => void this.files.openChange(task, path),
      openNote: (note) => this.notes.open(note),
      openAgent: () => void this.agents.openAgent(),
    })
    this.earlier = this.heart.earlier
    this.subjects = [
      this.window,
      this.lanes,
      this.keyboard,
      this.files,
      this.agents,
      this.routes,
      this.checks,
      new Spend(this.wire),
      this.plans,
      new Races(this.wire),
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
      newWhereFor(this.wire, {
        machines: () => this.remotes.machines(),
        newHere: () => this.agents.newAgent(''),
        lanes: () => this.lanes,
        acts: () => this.heart.acts,
        shellThere: (machine, project) => this.remotes.shellThere(machine, project),
        go: (place) => this.remotes.go(place),
      }),
      this.heart.inventory,
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
      onScreen: (name) => this.screens.onScreen(name),
      loadDiff: (task, path) => this.files.loadDiff(task, path),
      loadFileDiff: (path) => this.files.loadFileDiff(null, path),
      loadExtensionView: (panel) => this.extensions.refreshExtensionView(panel.extension, panel),
      searchOpened: () => this.search.opened(),
      lookAtWhatIsInstalled: () => void this.updates.lookAtWhatIsInstalled(),
    })
    this.far = new FarFaces({
      attach: (spec) => this.heart.attach(spec),
      subjects: () => this.subjects,
      skin: this.skin,
      // The doors this window's own keyboard reaches (`Keyboard`'s deps above),
      // so a phone's act is the same key pressed somewhere else.
      targets: () => ({
        run: (action) => void this.router.run(action),
        decide: (allow) => void this.away.keyed(allow),
        interrupt: () => void (this.remotes.interrupt() || this.orchestrator.interrupt()),
        openSearch: () => this.search.open(),
        talkStart: () => void this.voice.talkStart(),
        talkStop: () => void this.voice.talkStop(),
        quit: () => this.window.quit(),
        typeInto: (data, pasted) => this.keyboard.typeInto(data, pasted),
        act: (said) => void this.router.act(said),
        say: (said) => this.remotes.say(said) || this.orchestrator.say(said),
        applyPanel: (outcome) => this.router.applyPanel(outcome),
        // A press the phone could not answer itself: the window's own click,
        // as that phone's face — a link and a copy never come here, because
        // a phone does both on its own screen (`ON_A_PHONE`).
        click: (target, button, at) => this.mouse.clicked(target, button, at),
      }),
      send: (device, message) => this.away.window(device, message),
      front: () => paneLane(this.state),
      watch: (device, task) => this.away.watchLane(device, task),
      screen: (task) => this.away.laneScreen(task),
      scrub: (text) => this.away.scrub(text),
      keys: () => ({
        bindings: this.wire.opts.config.surfaces.window.keys,
        talk: this.wire.opts.config.surfaces.voice.talk.key,
      }),
      now: () => this.wire.now(),
    })
    this.closed = new Promise((resolve) => {
      this.settle = resolve
    })
  }

  /** The state, which is the heart's: read and written through it, as every subject does. */
  private get state(): AppState {
    return this.heart.state
  }

  private set state(next: AppState) {
    this.heart.put(next)
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
    this.heart.attachThinker(thinker)
  }

  /**
   * Write down the model the orchestrator ended up on when none was chosen, so it stays on it.
   * Otherwise the harness's default decides every start: whatever an agent last switched to.
   */
  keepThinkerModel(model: { provider?: string; id: string }): void {
    this.heart.keepThinkerModel(model)
  }

  /**
   * The orchestrator switched its own model, because it was asked to: kept for
   * the next start and shown on its tab, without restarting what it is doing.
   */
  thinkerMovedTo(model: { provider: string; id: string }, said = ''): void {
    this.heart.thinkerMovedTo(model, said)
  }

  /**
   * The orchestrator could not be started, said where you would have waited for it — not
   * swallowed, which left a window that never answered anything and gave no reason.
   */
  thinkerFailed(reason: string): void {
    this.heart.thinkerFailed(reason)
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
    void this.heart.live?.refresh().then(() => {
      this.state = focusTask(this.state, task)
      this.draw()
    })
  }

  /**
   * Another face over the heart this window beats: the window drawn again on
   * `terminal`, at its size and from its own place in the window, sharing every
   * fact with this one and doing on its machine only what `capabilities` says.
   * This window keeps drawing as it was. Keys typed there go nowhere yet.
   */
  attach(
    terminal: Terminal,
    face: { capabilities: FaceCapabilities; skin?: Skin },
  ): { readonly face: FaceScreen['face']; draw(): void; detach(): void } {
    if (this.stopped) throw new Error('the window has closed, so there is no heart to attach to')
    const screen = new FaceScreen({
      attach: (spec) => this.heart.attach(spec),
      subjects: () => this.subjects,
      terminal,
      skin: face.skin ?? this.skin,
      capabilities: face.capabilities,
    })
    this.faces.add(screen)
    return {
      face: screen.face,
      draw: () => screen.draw(),
      detach: () => {
        this.faces.delete(screen)
        screen.stop()
      },
    }
  }

  /**
   * The away door's half of the full view (`windowed.ts`): a phone's look and
   * its one act, reaching this window's phones (`FarFaces`). The listener is
   * handed it; a test drives a phone through it the same way.
   */
  windowDoor(): WindowDoor {
    return {
      unlocked: () => surfaceOf(this.wire.opts.config.surfaces.web).acting,
      look: (device, look) => this.far.look(device, look),
      act: (device, intent, own) => this.far.act(device, intent as Intent, own),
      leave: (device) => this.far.leave(device),
    }
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
    for (const face of this.faces) face.stop()
    this.faces.clear()
    this.far.stop()
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
        // The away view, the status look and the links: the heart's, named as the window named them.
        ...this.heart.closes(),
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
    // The beat, and everything the heart runs on it: the projects, then the
    // status look on its clock, each answer handed to this face as well; the
    // agents that were working opened again, and the away view where it is on.
    // A local as well as the heart's: what the surface below closes over is never a maybe.
    const live = await this.heart.begin()
    this.extensions.readLinkers()
    this.extensions.watchExtensions()
    // Whatever the config says about sleep, made true of the machine.
    this.awake.apply()

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
        // As this window's own face, always: pi-tui makes a frame a turn after
        // it was asked for, which may be a turn a phone's act started (`asOwn`).
        (width) =>
          this.heart.asOwn(() => {
            const frame = frameOf(
              this.subjects,
              { width, height: Math.max(6, this.terminal.rows), skin: this.skin },
              this.state.panel,
            )
            // The spinner's own clock, wound by what this frame shows turning.
            this.window.drew(frame)
            return { state: this.state, frame }
          }),
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
    this.heart.look()
    if (!this.stopped && !this.screens.borrowed() && this.repaint.dueAt(this.now()))
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
    return this.heart.advanceQueue()
  }

  /** What the orchestrator's queue tools do, answered from this window. */
  queueTools(): QueueTools {
    return this.heart.queueTools()
  }

  /** What the orchestrator's settings and project tools do, from this window. */
  configTools(): SettingTools & ProjectTools {
    return this.heart.configTools()
  }

  /** What the orchestrator's watch tools do, answered from this window. */
  watchTools(): WatchTools {
    return this.heart.watchTools()
  }

  /** What the orchestrator's update and reload tools do, from this window. */
  updateTools(): UpdateTools {
    return this.updates.tools()
  }

  /** What the `ToolHost` asks at every call. `Away.arming` has the argument. */
  awayTools(): Arming {
    return this.heart.awayTools()
  }

  /** What the orchestrator's `tade_machines` and `tade_env_move` do. */
  inventoryTools(): InventoryTools {
    return this.heart.inventoryTools()
  }

  /** What makes the orchestrator's conversation one on every machine, for whoever starts it. */
  conversationPlace(): ConversationPlace {
    return this.heart.conversationPlace()
  }

  /** Its tool calls run on another machine, and other machines' run here. */
  machineActs(): MachineActs {
    return this.heart.machineActs()
  }

  /** What the orchestrator's `tade_remote_tell` does, over this window's links. */
  readonly remoteTools = (): RemoteTools => this.remotes.tools()

  /** Ask every face for a frame: this window's, and each attached one (`Heart.draw`). */
  private draw(): void {
    this.heart.draw()
  }

  /** Ask this window's own terminal for a frame. */
  private paint(): void {
    if (!this.stopped && !this.screens.borrowed()) this.tui.requestRender()
  }

  /** How big the terminal is, which is how big everything drawn in it may be. */
  private room(): { columns: number; rows: number } {
    return { columns: this.terminal.columns, rows: this.terminal.rows }
  }

  /**
   * How big the face being served draws: a phone's size while one is served
   * (`Heart.room`), this terminal's otherwise. What a subject lays out to a
   * size inside a frame — a file's body, a diff's, the Extensions panel — is
   * asked this, so a phone's panel folds at the phone's width.
   */
  private faceRoom(): { columns: number; rows: number } {
    return this.heart.room() ?? this.room()
  }

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }

  /**
   * Put text on the clipboard without saying so — for the copies that say it
   * themselves (a setting, a task's branch, an away link) — through the same
   * `clipboard.write` the said ones use, so a suite never reaches pbcopy.
   */
  private toClipboard(text: string): Promise<boolean> {
    return (this.opts.clipboard?.write ?? copyText)(text, (data) => this.terminal.write(data))
  }
}
