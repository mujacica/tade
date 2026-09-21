import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import {
  getKeybindings,
  ProcessTerminal,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
} from '@earendil-works/pi-tui'
import {
  type Config,
  DEFAULT_ATTENTION,
  expandHome,
  HARNESS_CHOICES,
  type LaneId,
  loadConfig,
  orchestratorRoute,
  parseQuietHours,
  planStandings,
  resolveRoute,
  THINKING_LEVELS,
} from '@tade/core'
import type { ExtensionWorkbench } from '@tade/extensions-core'
import { git } from '@tade/status'
import { VoiceSurface } from '@tade/voice-core'
import { Speaker } from '@tade/voice-tts'
import type { Frame } from './frame.ts'
import { agentEnded, eventNews } from './inbox.ts'
import { keyCaps } from './keys.ts'
import { resolveLayout } from './layout.ts'
import { knownTasks, Live } from './live.ts'
import {
  type AppState,
  activeTerminal,
  addTurn,
  doneTasks,
  focusTask,
  initialState,
  markOf,
  matchActions,
  nextWaiting,
  notice,
  ORCHESTRATOR_TAB,
  onEvent,
  parseCommand,
  projects,
  QUEUE_FILTERS,
  removeAttachment,
  selectProject,
  setQuestion,
  shownName,
  showPlan,
  showTerminal,
  splitPane,
  swapSplit,
  terminalSplitShown,
  toggleDone,
  turnSplit,
  unsplitPane,
  withProjects,
  withTasks,
  withTerminals,
} from './model.ts'
import { extensionViewPanel } from './panels/extensions/setup.ts'
import { extensionsPanel } from './panels/extensions/state.ts'
import {
  accountMenuItems,
  branchMenuItems,
  changeMenuItems,
  fileMenuItems,
  harnessMenuItems,
  imageMenuItems,
  laneMenuItems,
  type MenuSubject,
  menuItems,
  menuPanel,
  noteMenuItems,
  queueMenuItems,
  scheduleMenuItems,
  terminalMenuItems,
  thinkingMenuItems,
} from './panels/menu/state.ts'
import { priceSaid } from './panels/models/state.ts'
import type { PanelOutcome } from './panels/outcome.ts'
import {
  nameFrom,
  type OpenProjectPanel,
  type OpenRow,
  type OpenRowView,
  openProjectPanel,
} from './panels/project/state.ts'
import {
  ACCOUNTS,
  accountActions,
  type Choice,
  settingsPanel,
  UPDATES,
  updateActions,
} from './panels/settings/state.ts'
import {
  closeDonePanel,
  noteHeadlinePanel,
  type PromptPanel,
  promptPanel,
} from './panels/small/state.ts'
import { spendPanel } from './panels/spend/state.ts'
import type { Panel, PanelInputs } from './panels.ts'
import {
  ago,
  branchOf,
  browsing,
  initialise,
  isPath,
  isRepo,
  listFolders,
  noteRecent,
  readRecents,
  recentProjects,
} from './projects.ts'
import { addProject } from './settings.ts'
import { PLAIN, pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { spendView as spendViewOf } from './spend.ts'
import { transcriptLines } from './transcript-view.ts'
import { Agents } from './wire/agents.ts'
import { Checks } from './wire/checks.ts'
import {
  type AppOptions,
  type Thinker,
  type Wiring,
  type WorkerImageFile,
  whenShort,
  why,
} from './wire/context.ts'
import { Extensions } from './wire/extensions.ts'
import { Files } from './wire/files.ts'
import { Images, imagesTitle } from './wire/images.ts'
import { Keyboard } from './wire/keyboard.ts'
import { Lanes } from './wire/lanes.ts'
import { Machine } from './wire/machine.ts'
import { Mouse } from './wire/mouse.ts'
import { Notes } from './wire/notes.ts'
import { Orchestrator } from './wire/orchestrator.ts'
import { Queue, type QueueTools } from './wire/queue.ts'
import { Schedules, scheduleIdOf } from './wire/schedules.ts'
import { Search } from './wire/search.ts'
import { Settings } from './wire/settings.ts'
import { spokenLine, Voice, vocabulary } from './wire/voice.ts'
import { Window } from './wire/window.ts'

// The window: every project down the side, the agent you are watching in the
// middle, the orchestrator along the bottom.
//
// This file only wires things together. What it should show is in `model.ts`,
// how it looks is in `view.ts`, and where the facts come from is in `live.ts`,
// so all three can be tested without a terminal.

/** How often a lane's screen is re-read when nothing has said it changed. */
const FRAME_MS = 250

/** How soon after a lane prints something it is looked at again. */
const LOOK_SOON_MS = 8

/** How long a screen the terminal wiped on its own stays dark, at most. */
const REPAINT_MS = 2_000
/** How often extensions are asked what they keep in the status bar. */
const _STATUS_MS = 5_000
/**
 * A look at the tasks slower than this is worth knowing about: the window
 * looks every couple of seconds, so one this slow is already late for the next.
 */
const SLOW_LOOK_MS = 2_000

/** Backspace, and what some terminals send instead. */

const HELP =
  'tab moves · / lists commands · ctrl+space talks · esc stops · ctrl+c clears, then quits'

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
  /** When this window opened: the start of "This window" in the Spend panel. */
  private readonly openedAt = Date.now()
  /** A look at the lanes is under way, and whether another was asked for meanwhile. */
  private looking = false
  private lookAgain = false
  private soon: NodeJS.Timeout | null = null
  /** Providers the harness is signed in to, once read. */
  /** The Open project list for the last folder and query, and the branches found for its rows. */
  private openCache: { key: string; rows: OpenRow[]; browsing: string | null } | null = null
  private readonly branches = new Map<string, string | null>()
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
  /** Making an agent, opening one again, stopping it, and what you change about one. */
  private readonly agents: Agents
  /** The thing you talk to: what it is told, what it answers, and the screen it borrows. */
  private readonly orchestrator: Orchestrator
  /** The extensions, the servers brokered as extensions, and the page that says what each is for. */
  private readonly extensions: Extensions

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
    this.notes = new Notes(this.wire, { copy: (text) => this.copy(text) })
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
      quit: () => this.quit(),
      run: (action) => this.run(action),
    })
    this.window = new Window(this.wire, {
      setTitle: (title) => this.terminal.setTitle(title),
    })
    this.machine = new Machine(this.wire, {
      reload: () => this.reload(),
      terminalSize: () => {
        const layout = resolveLayout(this.window.layout(), {
          width: this.terminal.columns,
          height: Math.max(6, this.terminal.rows),
        })
        return {
          cols: layout.sidebarWidth + layout.mainWidth + 1,
          rows: Math.max(4, layout.stripHeight - 2),
        }
      },
      showTerminal: (id) => this.lanes.showTerminal(id),
      onScreenWith: (flow) => this.orchestrator.onScreenWith(flow),
      refreshModels: async () => {
        await this.agents.refreshModels()
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
    })
    this.images = new Images(this.wire, {
      menuItemsFor: (panel) => this.menuItemsFor(panel),
      soonTick: () => this.soonTick(),
      answering: () => this.orchestrator.attached(),
    })
    this.voice = new Voice(this.wire, {
      submit: () => this.keyboard.submit(),
      say: (said) => this.orchestrator.say(said),
      useConfig: (config) => this.useConfig(config),
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
      size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      kitty: () => kittyActive(this.terminal),
      skin: this.skin,
      stopped: () => this.stopped,
      stop: () => void this.stop(),
      panelInputs: () => this.panelInputs(),
      applyPanel: (outcome) => this.applyPanel(outcome),
      attachFromClipboard: () => void this.images.attachFromClipboard(),
      askWhereImagesGo: (paths) => this.images.askWhere(paths),
      talkStart: () => void this.voice.talkStart(),
      talkStop: () => void this.voice.talkStop(),
      decide: (allow) => void this.agents.decide(allow),
      openSearch: () => this.search.open(),
      run: (action) => void this.run(action),
      interrupt: () => void this.orchestrator.interrupt(),
      quit: () => this.quit(),
      soonTick: () => this.soonTick(),
      toLane: (data) => this.lanes.toLane(data),
      act: (said) => void this.act(said),
      say: (said) => this.orchestrator.say(said),
    })
    this.lanes = new Lanes(this.wire, {
      size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      layout: () => this.window.layout(),
      skin: this.skin,
      soonTick: () => this.soonTick(),
      say: (said) => this.orchestrator.say(said),
    })
    this.extensions = new Extensions(this.wire, {
      size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      skin: this.skin,
      useConfig: (config) => this.useConfig(config),
      dateOf: (at) => this.window.dateOf(at),
      anchored: (next) => this.anchored(next),
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
      useConfig: (config) => this.useConfig(config),
      credential: (provider) => this.machine.credential(provider),
      anchored: (next) => this.anchored(next),
    })
    this.agents = new Agents(this.wire, {
      size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      useConfig: (config) => this.useConfig(config),
      loadAccounts: () => this.machine.loadAccountViews(),
      prefill: (line) => this.keyboard.prefill(line),
      openDiff: (task, path) => this.files.openDiff(task, path),
      openPlace: (target) => this.files.openPlace(target),
      changeQueue: (task, change) => this.queue.change(task, change),
      chooseThinkerThinking: (level) => this.orchestrator.chooseThinking(level),
      thinkerModel: () => this.orchestrator.model(),
      copyToClipboard: (text) => copyText(text, (data) => this.terminal.write(data)),
    })
    this.files = new Files(this.wire, {
      size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      skin: this.skin,
      copy: (text) => this.copy(text),
      openSearch: (query) => this.search.open(query),
      onScreenWith: (flow) => this.orchestrator.onScreenWith(flow),
      paneSize: () => this.lanes.paneSize(),
      applyPanel: (outcome) => this.applyPanel(outcome),
    })
    this.mouse = new Mouse(this.wire, {
      stopped: () => this.stopped,
      borrowed: () => this.orchestrator.borrowed(),
      size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      write: (data) => this.terminal.write(data),
      pointerShapes: () => this.pointerShapes,
      layout: () => this.window.layout(),
      remember: () => this.window.remember(),
      panelInputs: () => this.panelInputs(),
      applyPanel: (outcome) => this.applyPanel(outcome),
      openMenu: (subject, at) => this.openMenu(subject, at),
      run: (action) => void this.run(action),
      reslice: (area) => this.lanes.reslice(area),
      soonTick: () => this.soonTick(),
      turnedInLane: (event) => this.lanes.turnedInLane(event),
      selectTo: (line, x, extend, drag) => this.keyboard.selectTo(line, x, extend, drag),
      selectedOnLine: () => this.keyboard.selectedText(),
      clickedOn: (line, x, clicks) => this.keyboard.clickedOn(line, x, clicks),
      fileLines: () => this.files.lines(),
      fileBody: (panel) => this.files.body(panel),
      copySelection: (text) => void this.copySelection(text),
      resolvePath: (path) => this.files.resolvePath(path),
      openFile: (path, line) => this.files.openFile(path, line),
      openLink: (url) => void this.files.openLink(url),
      openDiff: (task, path) => void this.files.openDiff(task, path),
      openNote: (note) => this.notes.open(note),
      openAgent: () => void this.agents.openAgent(),
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

  /** The items of an open menu, from what is true of its subject now. */
  private menuItemsFor(panel: Panel | null) {
    if (panel?.kind !== 'menu') return []
    const subject = panel.subject
    const focused = this.state.panes.find((p) => p.task === this.state.focused)
    const agent = focused?.lane != null
    switch (subject.kind) {
      case 'schedule': {
        const one = this.schedules.views().find((view) => view.id === subject.id)
        return one ? scheduleMenuItems(one) : []
      }
      case 'task': {
        const pane = this.state.panes.find((p) => p.task === subject.task)
        if (pane?.queued) return queueMenuItems(pane.queued)
        return pane
          ? menuItems(
              pane,
              this.live?.changes(subject.task).length ?? 0,
              this.agents.offersFor(subject.task) ?? undefined,
            )
          : []
      }
      case 'file': {
        const marks = this.live?.marksAt(this.files.hereOnDisk()) ?? {}
        return fileMenuItems({
          folder: subject.folder,
          open: this.state.expanded.includes(subject.path),
          changed:
            focused !== undefined &&
            (this.live?.changes(focused.task) ?? []).some((change) => change.path === subject.path),
          agent,
          platform: process.platform,
        }).map((item) =>
          // A file with uncommitted changes can always show them, agent or not.
          item.id === 'changes' && marks[subject.path] && focused
            ? { id: item.id, label: item.label }
            : item,
        )
      }
      case 'change': {
        const marks = this.live?.marksAt(this.files.hereOnDisk()) ?? {}
        return changeMenuItems({ uncommitted: marks[subject.path] !== undefined, agent })
      }
      case 'branch': {
        const branch = focused ? (this.live?.factsOf(focused.task)?.branch ?? '') : ''
        return branchMenuItems({ agent: focused !== undefined, name: branch })
      }
      case 'terminal':
        return terminalMenuItems(terminalSplitShown(this.state) !== null)
      case 'harness':
        return harnessMenuItems(HARNESS_CHOICES, subject.current)
      case 'account':
        return accountMenuItems(
          this.machine.accounts,
          this.agents.harnessShown(subject.task),
          subject.current,
        )
      case 'lane':
        return laneMenuItems(
          this.state.splits[subject.task]?.lane === subject.lane,
          this.state.panes.find((one) => one.task === subject.task)?.lane != null,
        )
      case 'images':
        return imageMenuItems({
          agents: this.state.panes
            .filter((pane) => pane.project === this.state.project)
            .map((pane) => ({
              task: pane.task,
              name: shownName(pane),
              running: pane.lane !== null,
              focused: pane.task === this.state.focused,
            })),
          terminal: activeTerminal(this.state),
        })
      case 'note':
        return noteMenuItems()
      case 'thinking':
        return thinkingMenuItems(subject.current, this.agents.offersFor(subject.task)?.levels)
    }
  }

  /**
   * Which provider a model is reached through: the one configured, or the one
   * the model's own id names, or — for a bare name like `claude-opus-5` — the
   * provider you have credentials for that offers it. The last is a reading of
   * the catalog, which is what the harness itself does with a bare name.
   */
  private providerOf(model: string | null, configured: string | null): string | null {
    if (configured) return configured
    if (!model) return null
    const exact = this.agents.models().find((known) => known.id === model)
    if (exact) return exact.provider
    const named = model.includes('/') ? (model.split('/')[0] ?? null) : null
    if (named && this.machine.paidBy(named)) return named
    const offering = this.agents.models().filter((known) => known.id.endsWith(`/${model}`))
    return (
      offering.find((known) => this.machine.paidBy(known.provider))?.provider ??
      offering[0]?.provider ??
      named
    )
  }

  /** What the open panel needs to draw that the window does not. */
  private panelFacts(live: Live, width: number): Frame['panel'] {
    const panel = this.state.panel
    if (!panel) return {}
    if (panel.kind === 'menu') return { items: this.menuItemsFor(panel) }
    if (panel.kind === 'model') {
      const pane = this.state.panes.find((one) => one.task === panel.for)
      return {
        models: this.agents.offeredModels(),
        modelTarget:
          panel.for === 'orchestrator' ? 'the orchestrator' : pane ? shownName(pane) : panel.for,
        currentModel:
          panel.for === 'orchestrator'
            ? this.orchestrator.model()
            : (live.vitals(panel.for)?.model ?? null),
      }
    }
    if (panel.kind === 'extension-setup') return { setup: this.extensions.setupFacts(panel) }
    if (panel.kind === 'extension-view') {
      const shown = this.extensions.shown()
      return {
        extensionView:
          shown?.name === panel.extension ? { title: shown.title, markdown: shown.markdown } : null,
      }
    }
    if (panel.kind === 'extensions') {
      return {
        written: this.extensions.writtenViews(),
        extensions: this.extensions.extensionViews(),
        harnessExtensions: this.extensions.harnessLoads(),
        servers: this.extensions.serverOffers(),
        extensionsRoot: tilde(expandHome(this.opts.config.orchestrator.extensions)),
      }
    }
    if (panel.kind === 'branch') return { branches: this.files.branches() }
    if (panel.kind === 'find') {
      return {
        found: this.lanes.findMatches().length,
        terminalName:
          this.state.terminals.find((one) => one.id === panel.terminal)?.name ?? 'terminal',
      }
    }
    if (panel.kind === 'confirm-remove') {
      const facts = live.factsOf(panel.task)
      return {
        changes: live.changes(panel.task),
        ahead: facts?.ahead ?? null,
        branch: facts?.branch ?? null,
        base: live.baseOf(panel.task),
      }
    }
    if (panel.kind === 'diff') return { diff: this.files.shownDiff() }
    if (panel.kind === 'search')
      return { entries: this.search.entries(), searching: this.search.searching }
    if (panel.kind === 'file') return { viewing: this.files.viewing(width) }
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
        settings: this.settings.rows(),
        accounts: this.machine.accounts,
        updates: this.machine.updates,
        updatesBusy: this.machine.updatesBusy,
        lanesSurvive: this.opts.client.driver.capabilities.detach,
        configPath: tilde(this.configPath),
        releases: kittyActive(this.terminal),
        budgetWarnings: 0,
      }
    }
    return {}
  }

  /** Models an agent can start on, as choices grouped by provider. */
  private get choices(): Choice[] {
    return this.agents.models().map((model) => {
      const price = priceSaid(model)
      return {
        value: model.id,
        label: model.id.split('/').slice(1).join('/') || model.id,
        group: model.provider,
        ...(price ? { note: price } : {}),
      }
    })
  }

  /** Everything the drawing needs that is not the app's own state. */
  private frameFor(live: Live, width: number): Frame {
    const focused = this.state.panes.find((pane) => pane.task === this.state.focused)
    const route = focused
      ? resolveRoute(this.opts.config, { project: focused.project })
      : orchestratorRoute(this.opts.config)
    const spend = live.spendToday()
    const ran = live.runtimeToday()
    const panel = this.state.panel
    // What the harnesses last said about their plans: read from what they
    // already hold, so this costs a few property reads on the window's beat
    // and never a request to anybody.
    const planSources = this.opts.client.planUsage()
    const plan = planStandings(planSources, this.now())
    const spendView =
      panel?.kind === 'spend'
        ? spendViewOf(live.spending, {
            window: panel.window,
            by: panel.by,
            now: this.now(),
            openedAt: this.openedAt,
            projects: projects(this.state),
            runs: live.runs,
            made: live.produced,
            plan: planSources,
            budgets: Object.fromEntries(
              Object.entries(this.opts.config.projects).map(([name, project]) => [
                name,
                project.budget,
              ]),
            ),
          })
        : null
    // The agent's worktree when one is in front of you, else the project itself.
    const configured = this.state.project ? this.opts.config.projects[this.state.project] : null
    const repo = configured ? expandHome(configured.root) : null
    const worktree = focused ? live.worktreeOf(focused.task) : null
    const facts = focused ? live.factsOf(focused.task) : null
    const model = live.vitals(this.state.focused)?.model ?? route.model ?? null
    const provider = this.providerOf(model, route.provider ?? null)
    return {
      width,
      height: Math.max(6, this.terminal.rows),
      ...this.lanes.facts(),
      layout: this.window.layout(),
      skin: this.skin,
      files: live.files(worktree ?? repo, this.state.expanded),
      fileMarks: live.marksAt(worktree ?? repo),
      where: repo
        ? {
            repo: tilde(repo),
            branch: facts?.branch ?? live.branchAt(repo),
            base: focused ? live.baseOf(focused.task) : null,
            // Only a worktree of its own is worth a line: one sharing the checkout works in `repo`.
            worktree: worktree && resolve(worktree) !== resolve(repo) ? tilde(worktree) : null,
            path: worktree ?? repo,
            shownPath: tilde(worktree ?? repo),
            links: facts?.links ?? [],
          }
        : null,
      changes: live.changes(this.state.focused),
      actions: this.state.focused ? this.checks.actionsFor(live, this.state.focused) : null,
      notes: live.notes(this.state.project),
      base: live.baseOf(this.state.focused),
      spend: {
        tokens: spend.total.tokens,
        usd: spend.total.usd,
        hasCost: spend.total.hasCost,
        byTask: spend.byTask,
        runtime: ran.total,
      },
      plan,
      route: {
        harness: this.state.focused ? this.agents.harnessShown(this.state.focused) : route.harness,
        model: route.model ?? null,
        thinking: route.thinking ?? null,
        provider,
        credential: this.machine.credential(provider),
      },
      vitals: live.vitals(this.state.focused),
      offers: this.state.focused ? this.agents.offersFor(this.state.focused) : null,
      spendView,
      panel: this.panelFacts(live, width),
      voice: {
        keys: keyCaps(this.opts.config.surfaces.voice.talk.key),
        available: this.opts.recorder !== undefined,
      },
      home: tilde(this.opts.home),
      linkers: this.extensions.knownLinks(),
      orchestratorModel: this.orchestrator.model(),
      orchestratorThinking: this.opts.config.orchestrator.thinking ?? null,
      orchestratorAccount: this.orchestrator.account(),
      orchestratorOffers: this.orchestrator.offers(),
      bindings: this.opts.config.surfaces.window.keys,
      muted: this.opts.config.surfaces.voice.muted,
      clipboardImage: this.images.offered,
      extensionsNeedYou: (this.opts.extensions?.list() ?? []).filter(
        (one) => one.state === 'needs setup' || one.state === 'broken',
      ).length,
      ...this.keyboard.input(width),
      statuses: this.extensions.strip(),
      lists: this.extensions.lists().map((section) => ({
        id: section.id,
        title: section.title,
        problem: section.problem,
        rows: section.rows.map((row) => ({
          section: section.id,
          id: row.id,
          title: row.title,
          ...(row.note ? { note: row.note } : {}),
          ...(row.marks ? { marks: row.marks } : {}),
          ...(row.links ? { links: row.links } : {}),
          ...(row.opens ? { opens: row.opens } : {}),
          ...(row.task ? { task: row.task } : {}),
        })),
      })),
      schedules: this.schedules.views(),
      clock: (at: number) => whenShort(at, this.now()),
      date: (at: number) => this.window.dateOf(at),
      now: this.now(),
    }
  }

  private async begin(): Promise<void> {
    const { sidebarWidth, stripHeight, order, hidingDone, folded, opened } =
      this.window.recall() ?? {}
    this.state = {
      ...this.state,
      sizes: { ...(sidebarWidth ? { sidebarWidth } : {}), ...(stripHeight ? { stripHeight } : {}) },
      order: order ?? {},
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
        void this.agents.learnHarnesses(tasks)
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
        openSettings: async () => this.openSettings(),
        brief: () => this.orchestrator.brief(),
        extension: (said) => this.extensions.heardByExtension(said),
        tasks: async () => knownTasks(live.tasks),
        history: async () => live.history,
        ask: (text: string) => this.orchestrator.ask(text),
        terminals: this.lanes.voiceTerminals(),
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
        (width) => ({ state: this.state, frame: this.frameFor(live, width) }),
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

  /** The actions buttons name. Each is exactly what its label says. */
  private async run(action: string): Promise<void> {
    const [verb, task] = action.split(':')
    if (verb === 'close-terminal' && task) {
      const closing = action.slice('close-terminal:'.length)
      await this.opts.client.closeTerminal(closing).catch((err) => {
        this.state = notice(this.state, why(err))
      })
      await this.live?.refresh()
      this.draw()
      return
    }
    if (task && verb?.startsWith('toast-')) {
      this.state = { ...this.state, toasts: this.state.toasts.filter((t) => t.task !== task) }
      if (verb === 'toast-show') this.state = focusTask(this.state, task)
      if (verb === 'toast-allow' || verb === 'toast-deny')
        await this.agents.decideFor(task, verb === 'toast-allow')
      this.draw()
      return
    }
    if (action.startsWith('model:')) {
      await this.agents.openModels(action.slice('model:'.length))
      return
    }
    if (action.startsWith('split:')) {
      // `split:<task>:swap|turn|close`
      const verb = action.slice(action.lastIndexOf(':') + 1)
      const task = action.slice('split:'.length, action.lastIndexOf(':'))
      this.state =
        verb === 'swap'
          ? swapSplit(this.state, task)
          : verb === 'turn'
            ? turnSplit(this.state, task)
            : unsplitPane(this.state, task)
      this.soonTick()
      this.draw()
      return
    }
    if (action.startsWith('terminal-split:')) {
      const verb = action.slice('terminal-split:'.length)
      const split = this.state.terminalSplit
      if (split && verb === 'swap' && this.state.bottom !== ORCHESTRATOR_TAB) {
        this.state = {
          ...this.state,
          bottom: split.lane,
          terminalSplit: { ...split, lane: this.state.bottom },
          splitFocus: !this.state.splitFocus,
        }
      } else if (split && verb === 'turn') {
        this.state = {
          ...this.state,
          terminalSplit: { ...split, direction: split.direction === 'beside' ? 'below' : 'beside' },
        }
      } else {
        this.state = { ...this.state, terminalSplit: null, splitFocus: false }
      }
      this.soonTick()
      this.draw()
      return
    }
    if (action.startsWith('close-lane:')) {
      const lane = action.slice('close-lane:'.length)
      await this.opts.client.closeLane(lane as LaneId).catch((err) => {
        this.state = notice(this.state, why(err))
      })
      await this.live?.refresh()
      this.draw()
      return
    }
    if (action.startsWith('close-task:')) {
      await this.agents.closeAgent(action.slice('close-task:'.length))
      return
    }
    if (action.startsWith('checks-adopt:')) {
      await this.checks.adopt(action.slice('checks-adopt:'.length))
      return
    }
    if (action.startsWith('check-log:')) {
      const [task, check] = action.slice('check-log:'.length).split('\u0000')
      if (task && check) await this.checks.show(task, check)
      return
    }
    if (action.startsWith('checks-run:')) {
      await this.checks.run(action.slice('checks-run:'.length))
      return
    }
    if (action.startsWith('list-row:')) {
      const [section, id] = action.slice('list-row:'.length).split('\u0000')
      await this.extensions.openListRow(section ?? '', id ?? '')
      return
    }
    const scheduling = /^schedule-(open|run|pause|resume|remove|rename):(.+)$/.exec(action)
    if (scheduling?.[1] && scheduling[2]) {
      await this.schedules.onSchedule(scheduling[2], scheduling[1])
      return
    }
    if (action === 'queue-plan') {
      this.state = showPlan(this.state)
      this.draw()
      return
    }
    if (action.startsWith('queue-filter:')) {
      const filter = QUEUE_FILTERS.find((one) => one === action.slice('queue-filter:'.length))
      if (filter) this.state = { ...this.state, queueFilter: filter, scroll: this.state.scroll }
      this.draw()
      return
    }
    // There is no pause-everything button: pausing is done to one piece of
    // work, beside its name. The whole queue can still be held from the
    // orchestrator (`tade_queue_change` with a project and no task).
    const queued = /^queue-(start|first|pause|resume|wait|remove):(.+)$/.exec(action)
    if (queued?.[1] && queued[2]) {
      await this.queue.change(queued[2], queued[1])
      return
    }
    if (action.startsWith('thinking:')) {
      const task = action.slice('thinking:'.length)
      const project = task.split('/')[0]
      // The orchestrator is not an agent: what it thinks at is its own
      // setting, and its control sits in the strip rather than on a pane.
      const orchestrator = task === ORCHESTRATOR_TAB
      const current = orchestrator
        ? (this.opts.config.orchestrator.thinking ?? null)
        : (this.live?.vitals(task)?.thinking ??
          resolveRoute(this.opts.config, project ? { project } : {}).thinking ??
          null)
      const menu = menuPanel({ kind: 'thinking', task, current }, 'Thinking', {
        // Below the control it belongs to: the pane's header, or the strip at
        // the foot of the window, where it is clamped back into view.
        row: orchestrator ? Math.max(0, this.terminal.rows - 2) : 3,
        col: Math.max(0, this.terminal.columns - 30),
      })
      // The keyboard starts on the level it is at.
      const index = Math.max(0, THINKING_LEVELS.indexOf((current ?? '') as never))
      this.state = { ...this.state, panel: { ...menu, index } }
      this.draw()
      return
    }
    if (action.startsWith('harness:')) {
      const task = action.slice('harness:'.length)
      const current = this.agents.harnessShown(task)
      this.state = {
        ...this.state,
        panel: menuPanel({ kind: 'harness', task, current }, 'Harness', {
          row: 3,
          col: Math.max(0, this.terminal.columns - 40),
        }),
      }
      this.draw()
      return
    }
    if (action.startsWith('ask:')) {
      this.orchestrator.say(action.slice('ask:'.length))
      return
    }
    if (action.startsWith('extension-view:')) {
      const name = action.slice('extension-view:'.length)
      this.state = { ...this.state, panel: extensionViewPanel(name) }
      this.draw()
      await this.extensions.refreshExtensionView(name)
      return
    }
    if (action.startsWith('extension:')) {
      const [, name, id] = action.split(':')
      await this.extensions.runExtension(name ?? '', id ?? '')
      return
    }
    if (action.startsWith('forget-note:')) {
      const [at, ...text] = action.slice('forget-note:'.length).split('\u0000')
      this.notes.forget({ at: at ?? '', text: text.join('\u0000') })
      return
    }
    if (action.startsWith('detach-image:')) {
      const path = action.slice('detach-image:'.length)
      this.state = removeAttachment(this.state, path)
      this.draw()
      return
    }
    switch (action) {
      case 'new-agent':
        await this.agents.newAgent('')
        return
      case 'toggle-done':
        this.state = toggleDone(this.state)
        // Written here and not only on the way out: the window you press this
        // in is the window you leave open for days, and one that was killed
        // rather than closed would forget it every time.
        this.window.remember()
        this.draw()
        return
      case 'close-done': {
        // Nothing finished is nothing to clean up: said, rather than an empty
        // question nobody can answer.
        const done = doneTasks(this.state)
        this.state =
          done.length === 0
            ? notice(this.state, 'no agent here has finished yet')
            : { ...this.state, panel: closeDonePanel(done.map((pane) => pane.task)) }
        this.draw()
        return
      }
      case 'search':
        this.search.open()
        return
      case 'mute':
        await this.voice.toggleMute()
        return
      case 'attach-clipboard':
        await this.images.attachFromClipboard()
        return
      case 'dismiss-clipboard':
        this.images.dismiss()
        return
      case 'keys':
        this.state = { ...this.state, panel: { kind: 'keys', busy: false } }
        this.draw()
        return
      case 'reload':
        this.reload()
        return
      case 'pane-end':
        this.state = { ...this.state, paneScroll: 0 }
        // Back to the newest line, and the text goes there with the bar: the
        // lines held may already reach it, and the look catches up if not.
        this.lanes.reslice('pane')
        this.soonTick()
        return
      case 'terminal-end':
        this.state = { ...this.state, terminalScroll: 0 }
        this.lanes.reslice('terminal')
        this.soonTick()
        return
      case 'transcript-end':
        this.state = { ...this.state, transcriptScroll: 0 }
        this.draw()
        return
      case 'extensions':
        await this.extensions.reread()
        {
          // It opens on the one that wants somebody — something to set up,
          // something broken — and on the first of them when nothing does.
          const views = this.extensions.extensionViews()
          const wants = views.find((one) => one.state === 'needs setup' || one.state === 'broken')
          this.state = {
            ...this.state,
            panel: extensionsPanel(wants?.name ?? views[0]?.name ?? null),
          }
        }
        this.draw()
        return
      case 'brief':
        await this.orchestrator.brief()
        return
      case 'open-project':
        this.openCache = null
        this.state = { ...this.state, panel: openProjectPanel(homedir()) }
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
        await this.files.openShell()
        return
      case 'next-waiting': {
        const next = nextWaiting(this.state)
        if (next) this.state = focusTask(this.state, next)
        this.draw()
        return
      }
      case 'approve':
        await this.agents.decide(true)
        return
      case 'deny':
        await this.agents.decide(false)
        return
      case 'open-agent': {
        // Queued work has no agent yet: starting it goes through the queue, so
        // what started it and why is written down.
        const pane = this.state.panes.find((one) => one.task === this.state.focused)
        if (pane?.queued) await this.queue.change(pane.task, 'start')
        else await this.agents.openAgent()
        return
      }
      case 'new-terminal':
        await this.lanes.openTerminal()
        return
      case 'find-terminal': {
        const terminal = activeTerminal(this.state)
        if (terminal) await this.lanes.openFind(terminal.id)
        return
      }
      case 'bottom-max':
        this.state = { ...this.state, bottomMode: this.state.bottomMode === 'max' ? 'open' : 'max' }
        this.draw()
        return
      case 'bottom-min':
        this.state = { ...this.state, bottomMode: this.state.bottomMode === 'min' ? 'open' : 'min' }
        this.draw()
        return
      case 'add-note':
        this.state = {
          ...this.state,
          panel: promptPanel(
            'note',
            'New note',
            `NOTE ABOUT ${(this.state.project ?? 'THIS PROJECT').toUpperCase()}`,
          ),
        }
        this.draw()
        return
      case 'copy-path': {
        const path = this.files.hereOnDisk()
        if (!path) return
        const copied = await copyText(path, (data) => this.terminal.write(data))
        this.state = notice(this.state, copied ? `copied ${path}` : path)
        this.draw()
        return
      }
      case 'open-path': {
        const path = this.files.hereOnDisk()
        if (path) await this.files.reveal(path, true)
        return
      }
      default:
        await this.act(action)
    }
  }

  private applyPanel(outcome: PanelOutcome): void {
    const before = this.state.panel
    this.state = { ...this.state, panel: outcome.panel }
    // A different file in the diff panel is a different diff to read.
    if (outcome.panel?.kind === 'diff') {
      const was = before?.kind === 'diff' ? before : null
      if (!was || was.file !== outcome.panel.file || was.task !== outcome.panel.task) {
        void this.files.loadDiff(outcome.panel.task, outcome.panel.files[outcome.panel.file] ?? '')
      }
    }
    if (outcome.panel?.kind === 'search') {
      this.search.lookInFiles()
      this.search.askWhatIsMeant()
    }
    // The Updates page reads the machine when it is opened, and asks the
    // network only when the button on it is pressed.
    if (outcome.panel?.kind === 'settings' && outcome.panel.category === UPDATES) {
      void this.machine.lookAtWhatIsInstalled()
    }
    this.draw()
    if (outcome.submit && outcome.panel) void this.submitPanel(outcome.panel, outcome.choice)
  }

  /** Carry a panel out, and either close it or say in it why not. */
  private async submitPanel(panel: Panel, choice?: string): Promise<void> {
    switch (panel.kind) {
      case 'menu':
        this.state = { ...this.state, panel: null }
        this.draw()
        await this.fromMenu(panel.subject, choice ?? '')
        return
      case 'model':
        await this.agents.chooseModel(panel, choice ?? '')
        return
      case 'extensions':
        await this.extensions.fromExtensions(panel, choice ?? '')
        return
      case 'extension-setup':
        await this.extensions.saveSetup(panel)
        return
      case 'prompt':
        await this.savePrompt(panel, choice)
        break
      case 'branch':
        await this.files.switchBranch(choice ?? '')
        break
      case 'confirm':
        await this.files.discard(panel.task, panel.path)
        break
      case 'confirm-remove':
        await this.agents.removeTask(panel)
        break
      case 'close-done':
        await this.agents.closeDone(panel)
        break
      case 'open-project':
        await this.openProject(panel)
        break
      case 'search':
        await this.search.from(choice ?? '')
        return
      case 'file':
        if (choice === 'editor') {
          this.state = { ...this.state, panel: null }
          await this.files.openPlace({
            path: panel.path,
            ...(panel.edit ? { line: panel.edit.row + 1, column: panel.edit.column + 1 } : {}),
            ...(!panel.edit && panel.line ? { line: panel.line } : {}),
          })
          return
        }
        if (choice === 'save') {
          await this.files.saveFile(panel)
          return
        }
        if (choice === 'copy-selection') {
          const text = this.mouse.fileSelectionText()
          if (text !== null && text !== '') await this.copySelection(text)
          return
        }
        if (choice === 'copy-path') {
          const copied = await copyText(panel.path, (data) => this.terminal.write(data))
          this.state = notice(this.state, copied ? `copied ${panel.path}` : panel.path)
        }
        break
      case 'keys':
        await this.openSettings('shortcuts')
        return
      case 'quit':
        if (choice === 'where') {
          await this.openSettings('agents')
          return
        }
        await this.stop()
        return
      case 'reload':
        await this.opts.reloadWindow?.()
        return
      case 'settings': {
        if (choice?.startsWith('write:')) {
          const [path, value] = choice.slice('write:'.length).split('\u0000')
          if (path !== undefined) await this.settings.save(panel, path, value ?? '')
          return
        }
        if (choice === 'open-file') {
          this.state = { ...this.state, panel: null }
          await this.files.openPlace({ path: this.configPath })
          return
        }
        if (choice?.startsWith('account:')) await this.machine.accountAction(choice)
        if (choice?.startsWith('updates:')) await this.machine.updateAction(choice)
        if (choice === 'mic-test') await this.voice.testMicrophone()
        return
      }
      case 'diff': {
        const path = panel.files[panel.file]
        if (!path) return
        if (choice === 'editor') {
          this.state = { ...this.state, panel: null }
          await this.files.openPlace({ path })
          return
        }
        if (choice === 'ask') await this.files.askAbout(panel.task, path)
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

  /**
   * Reload, asking first only when reloading would stop something: agents that
   * live inside this window and cannot be found again once it is gone.
   */
  private reload(): void {
    const capabilities = this.opts.client.driver.capabilities
    const running =
      this.state.panes.reduce((n, pane) => n + pane.lanes.length, 0) + this.state.terminals.length
    if (running > 0 && !capabilities.detach) {
      this.state = { ...this.state, panel: { kind: 'reload', field: 'cancel', busy: false } }
      this.draw()
      return
    }
    void this.opts.reloadWindow?.()
  }

  /** Something's menu, opened where you clicked, just below and to the left. */
  private openMenu(subject: MenuSubject, at: { x: number; y: number }): void {
    const base = subject.kind === 'task' ? focusTask(this.state, subject.task) : this.state
    const pane =
      subject.kind === 'task' ? this.state.panes.find((p) => p.task === subject.task) : null
    const focused = this.state.panes.find((p) => p.task === this.state.focused)
    const title =
      subject.kind === 'task'
        ? pane
          ? shownName(pane)
          : subject.task
        : subject.kind === 'branch'
          ? (focused
              ? this.live?.factsOf(focused.task)?.branch
              : this.live?.branchAt(this.files.hereOnDisk() ?? '')) || 'branch'
          : subject.kind === 'terminal'
            ? (this.state.terminals.find((one) => one.id === subject.id)?.name ?? 'terminal')
            : subject.kind === 'images'
              ? imagesTitle(subject.paths)
              : subject.kind === 'harness'
                ? 'Harness'
                : subject.kind === 'account'
                  ? 'Account'
                  : subject.kind === 'lane'
                    ? subject.name
                    : subject.kind === 'thinking'
                      ? 'Thinking'
                      : subject.kind === 'note'
                        ? 'Note'
                        : subject.kind === 'schedule'
                          ? (this.schedules.views().find((one) => one.id === subject.id)?.name ??
                            'Schedule')
                          : (subject.path.split('/').at(-1) ?? subject.path)
    this.state = {
      ...base,
      panel: menuPanel(subject, title, { row: at.y + 1, col: Math.max(0, at.x - 26) }),
    }
    this.draw()
  }

  /** What a menu item does. Each is exactly what it says. */
  private async fromMenu(subject: MenuSubject, item: string): Promise<void> {
    switch (subject.kind) {
      case 'schedule':
        return this.run(`${item}:${subject.id}`)
      case 'task':
        return this.agents.fromTaskMenu(subject.task, item)
      case 'file':
        return this.files.fromFileMenu(subject.path, subject.folder, item)
      case 'change':
        return this.files.fromChangeMenu(subject.task, subject.path, item)
      case 'branch':
        return this.files.fromBranchMenu(item)
      case 'terminal':
        return this.fromTerminalMenu(subject.id, item)
      case 'images':
        return this.images.give(subject.paths, item)
      case 'harness':
        return this.agents.chooseHarness(subject.task, item)
      case 'account':
        return this.agents.chooseAccount(subject.task, item)
      case 'lane':
        return this.fromLaneMenu(subject.task, subject.lane, subject.name, item)
      case 'note':
        return this.notes.fromMenu(subject, item)
      case 'thinking':
        return this.agents.chooseThinking(subject.task, item)
    }
  }

  /**
   * A note's own page: what it says, what it is about, who said it when — and
   * saving, copying or forgetting it from there. What is known about it is
   * read back out of memory, since the row it was clicked on carries only what
   * names it.
   */
  /** What a shell's menu does: rename it, show it beside or below the agent, or close it. */
  private async fromLaneMenu(
    task: string,
    lane: string,
    name: string,
    item: string,
  ): Promise<void> {
    switch (item) {
      case 'rename':
        this.state = {
          ...this.state,
          panel: { ...promptPanel('rename-lane', 'Rename shell', 'NAME', name), target: lane },
        }
        break
      case 'split-beside':
      case 'split-below':
        this.state = splitPane(this.state, task, lane, item === 'split-beside' ? 'beside' : 'below')
        this.soonTick()
        break
      case 'unsplit':
        this.state = unsplitPane(this.state, task)
        break
      case 'close':
        await this.opts.client.closeLane(lane as LaneId).catch((err) => {
          this.state = notice(this.state, why(err))
        })
        await this.live?.refresh()
        break
      default:
        break
    }
    this.draw()
  }

  /** Text selected by dragging over it, put on the clipboard. */
  private async copySelection(text: string): Promise<void> {
    const copied = await copyText(text, (data) => this.terminal.write(data))
    const lines = text.split('\n').length
    this.state = notice(
      this.state,
      copied
        ? `copied ${lines > 1 ? `${lines} lines` : `${text.length} characters`}`
        : 'could not copy',
    )
    this.draw()
  }

  private async copy(text: string): Promise<void> {
    const copied = await copyText(text, (data) => this.terminal.write(data))
    this.state = notice(this.state, copied ? `copied ${text}` : text)
    this.draw()
  }

  private async fromTerminalMenu(id: string, item: string): Promise<void> {
    const name = this.state.terminals.find((one) => one.id === id)?.name ?? 'terminal'
    switch (item) {
      case 'run':
        this.state = {
          ...showTerminal(this.state, id),
          panel: { ...promptPanel('run-command', `Run in ${name}`, 'COMMAND'), target: id },
        }
        break
      case 'find':
        await this.lanes.openFind(id)
        return
      case 'rename':
        this.state = {
          ...this.state,
          panel: { ...promptPanel('rename-terminal', 'Rename terminal', 'NAME', name), target: id },
        }
        break
      case 'clear':
        await this.opts.client.write(id as LaneId, 'clear\r').catch(() => {})
        break
      case 'split-beside':
      case 'split-below': {
        // A new terminal, beside or below this one, in the same project.
        const front = id
        const opened = await this.lanes.openTerminal()
        const created = this.state.bottom
        if (opened && created !== front) {
          this.state = {
            ...showTerminal(this.state, front),
            terminalSplit: {
              lane: created,
              direction: item === 'split-beside' ? 'beside' : 'below',
              ratio: 0.5,
            },
            splitFocus: true,
          }
        }
        break
      }
      case 'unsplit':
        this.state = { ...this.state, terminalSplit: null, splitFocus: false }
        break
      case 'close':
        await this.opts.client.closeTerminal(id).catch((err) => {
          this.state = notice(this.state, why(err))
        })
        await this.live?.refresh()
        break
      default:
        break
    }
    this.draw()
  }

  /** Carry out a one-line panel: keep a note, or make or rename a branch. */
  private async savePrompt(panel: PromptPanel, choice?: string): Promise<void> {
    const text = panel.text.trim()
    const fail = (error: string) => {
      this.state = { ...this.state, panel: { ...panel, busy: false, error } }
    }
    // A note's page offers what its menu does, and each does exactly the same
    // thing from either place.
    if (panel.note && (choice === 'copy' || choice === 'forget' || choice === 'headline')) {
      const note = {
        at: panel.note.at,
        text: (panel.target ?? '').split('\u0000').slice(1).join('\u0000'),
      }
      if (choice === 'copy') {
        await this.copy(note.text)
        return
      }
      if (choice === 'headline') {
        this.state = { ...this.state, panel: noteHeadlinePanel(panel.note, note.text) }
        this.draw()
        return
      }
      this.state = { ...this.state, panel: null }
      this.notes.forget(note)
      return
    }
    try {
      if (panel.purpose === 'rename-agent' && panel.target) {
        const worktree = this.live?.worktreeOf(panel.target)
        if (!worktree) throw new Error(`I do not know where ${panel.target} works`)
        const title = await this.opts.client.renameAgent({
          task: panel.target,
          worktree,
          title: text,
        })
        await this.live?.refresh()
        this.state = notice(
          { ...this.state, panel: null },
          `${panel.target} is now called ${title}`,
        )
        return
      }
      if (panel.purpose === 'account-name' && panel.target) {
        const [harness = '', kind = 'subscription'] = panel.target.split('\u0000')
        const name = text.trim().toLowerCase()
        await this.opts.client.addAccount({
          name,
          harness,
          kind: kind === 'api-key' ? 'api-key' : 'subscription',
        })
        // Straight on to what makes it usable: its key, or its own sign-in.
        if (kind === 'api-key') {
          this.state = {
            ...this.state,
            panel: { ...promptPanel('account-key', `${name}'s API key`, 'KEY'), target: name },
          }
          return
        }
        this.state = { ...this.state, panel: settingsPanel(ACCOUNTS) }
        await this.machine.signInto(harness, name)
        await this.machine.loadAccountViews()
        return
      }
      if (panel.purpose === 'account-key' && panel.target) {
        const where = this.opts.client.saveAccountKey(panel.target, text)
        this.state = {
          ...this.state,
          panel: {
            ...settingsPanel(ACCOUNTS),
            saved: `${panel.target}'s key is kept in ${where}.`,
          },
        }
        await this.machine.loadAccountViews()
        return
      }
      if (panel.purpose === 'rename-schedule' && panel.target) {
        const kept = await this.opts.client.changeSchedule({
          id: panel.target,
          change: 'rename',
          name: text,
          by: 'you',
        })
        this.state = notice({ ...this.state, panel: null }, `now called ${kept?.name ?? text}`)
        return
      }
      if (panel.purpose === 'rename-lane' && panel.target) {
        await this.opts.client.setTitle(panel.target as LaneId, text)
        await this.live?.refresh()
        this.state = notice({ ...this.state, panel: null }, `renamed to ${text}`)
        return
      }
      if (panel.purpose === 'rename-terminal' && panel.target) {
        await this.opts.client.renameTerminal(panel.target, text)
        await this.live?.refresh()
        this.state = notice({ ...this.state, panel: null }, `renamed to ${text}`)
        return
      }
      if (panel.purpose === 'run-command' && panel.target) {
        await this.opts.client.runInTerminal(panel.target, text)
        this.state = { ...showTerminal(this.state, panel.target), panel: null }
        return
      }
      if (panel.purpose === 'note') {
        const scope = panel.everywhere ? null : this.state.project
        this.opts.client.remember(text, scope, 'window')
        this.state = notice({ ...this.state, panel: null }, 'noted')
        return
      }
      if (panel.purpose === 'note-headline') {
        const [when = '', ...said] = (panel.target ?? '').split('\u0000')
        const was = this.opts.client
          .recallAll()
          .find((one) => one.at === when && one.text === said.join('\u0000'))
        if (!was) return fail('That note is not there any more.')
        // Said again with the headline it is read by, and the old line taken
        // back: the words are handed over exactly as they were kept.
        this.opts.client.remember(was.text, was.scope, 'window', text)
        this.opts.client.forget({ at: was.at, text: was.text }, 'window')
        this.state = notice({ ...this.state, panel: null }, 'noted')
        return
      }
      if (panel.purpose === 'edit-note') {
        const [at = '', ...said] = (panel.target ?? '').split('\u0000')
        const was = this.opts.client
          .recallAll()
          .find((one) => one.at === at && one.text === said.join('\u0000'))
        if (!was) return fail('That note is not there any more.')
        if (was.text !== text) {
          // Said again in its new words, about what it was about, and the old
          // words taken back. The headline it was given goes with it: it says
          // what the note is for, which changing its wording does not.
          this.opts.client.remember(text, was.scope, 'window', was.summary ?? null)
          this.opts.client.forget({ at: was.at, text: was.text }, 'window')
        }
        this.state = notice({ ...this.state, panel: null }, 'noted')
        return
      }
      const here = this.files.hereOnDisk()
      if (!here) return fail('There is no checkout here to make a branch in.')
      if (panel.purpose === 'new-branch') {
        const out = await git(here, ['switch', '-c', text])
        if (!out.ok) return fail(out.stderr.split('\n')[0] ?? 'git would not make it')
        this.state = notice({ ...this.state, panel: null }, `on ${text}`)
        return
      }
      const focused = this.state.panes.find((p) => p.task === this.state.focused)
      if (!focused) return fail('Open the agent whose branch this is.')
      const current = this.live?.factsOf(focused.task)?.branch ?? ''
      const root = this.opts.config.projects[focused.project]?.root
      if (!current) {
        if (!root) return fail('I cannot find the project this agent belongs to.')
        const made = await this.opts.client.nameTask({
          task: focused.task,
          root: expandHome(root),
          worktree: here,
          title: text,
        })
        this.state = notice({ ...this.state, panel: null }, `on ${made}`)
      } else {
        const name = text.startsWith('tade/') ? text : `tade/${text}`
        const out = await git(here, ['branch', '-m', current, name])
        if (!out.ok) return fail(out.stderr.split('\n')[0] ?? 'git would not rename it')
        this.state = notice({ ...this.state, panel: null }, `renamed to ${name}`)
      }
      await this.live?.refresh()
    } catch (err) {
      fail(why(err))
    }
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
      case '/new':
        await this.agents.newAgent(rest)
        return
      case '/stop':
        await this.agents.stopAgent(rest)
        return
      case '/open': {
        const task = this.agents.findTask(rest)
        if (!task) {
          this.state = notice(
            this.state,
            rest ? `no agent like ${rest}` : 'which agent? /open name',
          )
          this.keyboard.prefill('/open ')
          return
        }
        this.state = focusTask(this.state, task)
        this.draw()
        return
      }
      default:
        await this.orchestrator.onScreen(chosen.name)
    }
  }

  /** Re-read the focused lane's screen. */
  /**
   * Look again, one look at a time. Looks overlapping could finish out of
   * order, and a slow one finishing last would put back the screen the fast
   * one had just replaced: a line blinking between two states, text from one
   * frame interleaved with the next. Asked again while looking, it looks once
   * more when it is done.
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
      void this.tick()
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
    const working =
      this.state.transcript.thinking !== null ||
      this.state.transcript.entries.some(
        (entry) => entry.kind === 'tool' && entry.state === 'running',
      ) ||
      this.state.panes.some(
        (pane) => pane.project === this.state.project && markOf(pane) === 'working',
      )
    if (paneScreen || terminal || this.state.talkingSince !== null || working) this.draw()
  }

  /**
   * Scrolled back, the lines you are reading stay where they are while new
   * ones arrive below: the distance from the bottom grows by what was added.
   */
  private anchored(next: AppState): AppState {
    const before = this.state
    if (next.transcriptScroll === 0 || next.transcript === before.transcript) return next
    const count = (transcript: AppState['transcript']) =>
      transcriptLines(transcript, this.terminal.columns, PLAIN, { hover: null, pressed: null }, 0)
        .length
    const grown = count(next.transcript) - count(before.transcript)
    return { ...next, transcriptScroll: Math.max(0, next.transcriptScroll + grown) }
  }

  /**
   * Look at the lane again in a moment: long enough to take a burst of output
   * in one look, short enough that what you typed is on screen before you
   * notice it was not. Reading waits for the emulator to finish parsing, so a
   * look this soon is never a look at half of it.
   */
  private soonTick(): void {
    if (this.soon || this.stopped) return
    this.soon = setTimeout(() => {
      this.soon = null
      void this.tick()
    }, LOOK_SOON_MS)
  }

  /** Start whatever queued work is ready, and say what is held. */
  advanceQueue(): Promise<string[]> {
    return this.queue.advance()
  }

  /** What the orchestrator's queue tools do, answered from this window. */
  queueTools(): QueueTools {
    return this.queue.tools()
  }

  /**
   * Hand the terminal to the settings screen, then take it back.
   *
   * Needing to close Tade to change a Tade setting is how people end up with
   * a second terminal open forever. The window stops drawing while the other
   * screen has the keyboard — two things drawing at once is the bug this whole
   * design exists to avoid — and starts again where it left off.
   */
  private openSettings(category = 'agents'): Promise<string> {
    return this.settings.open(category)
  }

  /**
   * The Open project list: the folder being looked in and the folders in it,
   * then the recent projects. Typing narrows both; a typed path looks in that
   * path instead. Read from disk once per folder and query, not once per frame.
   */
  private openRowsFor(panel: OpenProjectPanel): OpenRowView[] {
    const key = `${panel.dir}\u0000${panel.query}`
    if (this.openCache?.key !== key) {
      const path = isPath(panel.query)
      const words = path ? [] : panel.query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      const matches = (text: string) => words.every((word) => text.toLowerCase().includes(word))
      const { dir, prefix } = path
        ? browsing(panel.query, panel.dir)
        : { dir: panel.dir, prefix: '' }
      const folders = listFolders(dir, prefix, 500)
        .filter((folder) => matches(folder.name))
        .map((folder) => ({
          kind: 'folder' as const,
          name: folder.name,
          path: folder.path,
          git: folder.git !== null,
        }))
      const here = {
        kind: 'here' as const,
        name: basename(dir) || dir,
        path: dir,
        git: isRepo(dir),
      }
      const recent = recentProjects(readRecents(this.opts.home), this.opts.config.projects)
        .filter((entry) => matches(`${entry.name} ${entry.root}`))
        .slice(0, 12)
        .map((entry) => ({
          kind: 'recent' as const,
          name: entry.name,
          path: expandHome(entry.root),
          git: true,
        }))
      this.openCache = { key, rows: [here, ...folders, ...recent], browsing: dir }
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
   * Open what was chosen: go to a project Tade knows, or add a folder as one —
   * making it a repository first if it is not, and you said to.
   */
  private async openProject(panel: OpenProjectPanel): Promise<void> {
    const chosen = this.openRowsFor(panel)[panel.index]?.row
    const fail = (error: string) => {
      this.state = { ...this.state, panel: { ...panel, busy: false, error } }
    }
    if (!chosen) return fail('Choose a folder, or a recent project.')
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
          return fail('Tade needs git to start work here. Tick git init, or choose another folder.')
        await initialise(chosen.path)
      }
      addProject(this.configPath, name, tilde(chosen.path))
      const loaded = await loadConfig(this.configPath)
      if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
      this.useConfig(loaded.config)
      noteRecent(this.opts.home, name, tilde(chosen.path), this.now())
      this.state = withProjects(this.state, Object.keys(loaded.config.projects))
      this.state = notice({ ...selectProject(this.state, name), panel: null }, `opened ${name}`)
      await this.live?.refresh()
      this.agents.ensureAgent(name)
    } catch (err) {
      fail(why(err))
    }
  }

  /** What panels need to know that they do not hold. */
  private panelInputs(): PanelInputs {
    const panel = this.state.panel
    // The file's own lines, and only while they are the file the panel is on:
    // a caret counts columns in them, and in the wrong file it would land
    // somewhere nobody pointed at.
    const file = panel?.kind === 'file' ? this.files.body(panel) : null
    return {
      entries: this.search.entries(),
      lines:
        this.state.panel?.kind === 'extension-view'
          ? this.extensions.extensionViewLines()
          : this.files.lines(),
      text: this.files.textAt(panel),
      ...(file ? { body: file.rows, columns: file.columns } : {}),
      branches: this.files.branches(),
      found: this.lanes.findMatches().length,
      rows:
        this.state.panel?.kind === 'open-project'
          ? this.openRowsFor(this.state.panel).map((view) => view.row)
          : [],
      choices: this.choices,
      items: this.menuItemsFor(this.state.panel),
      extensions: this.extensions.extensionViews(),
      written: this.state.panel?.kind === 'extensions' ? this.extensions.writtenViews() : [],
      harnessExtensions: this.extensions.harnessLoads(),
      servers: this.extensions.serverOffers(),
      scrollable: this.extensions.extensionRoom().body,
      listRoom: this.extensions.extensionRoom().listRoom,
      setupFields:
        this.state.panel?.kind === 'extension-setup'
          ? (this.extensions.setupFacts(this.state.panel)?.fields ?? [])
          : [],
      models:
        this.state.panel?.kind === 'model' ? this.agents.offeredModels() : this.agents.models(),
      settings: this.settings.rows(),
      accountActions: accountActions(this.machine.accounts),
      updateActions: updateActions(this.machine.updates, this.machine.updatesBusy),
    }
  }

  private get configPath(): string {
    return this.settings.path
  }

  private useConfig(config: Config): void {
    this.settings.use(config)
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

  private now(): number {
    return this.opts.now?.() ?? Date.now()
  }
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
      const child = spawn(tool[0] as string, tool.slice(1), {
        stdio: ['pipe', 'ignore', 'ignore'],
        detached: true,
      })
      child.once('error', () => resolve(false))
      child.once('exit', (code) => resolve(code === 0))
      // A clipboard tool that exits before it reads leaves us writing to a
      // closed pipe, and an unhandled 'error' on a stream takes the window
      // down. Whether it copied is its exit code's to say.
      child.stdin?.on('error', () => {})
      child.stdin?.end(text)
    })
    if (copied) return true
  }
  write(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`)
  return true
}

/** A schedule the orchestrator asks for: what, when, and what it does each time. */

/** Only some terminals report key releases, which is what holding a key needs. */
function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
}

/** A menu's title for pictures: who gets this one, or these. */
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
