import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  getKeybindings,
  ProcessTerminal,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
} from '@earendil-works/pi-tui'
import {
  type Config,
  composeBrief,
  DEFAULT_ATTENTION,
  describeWork,
  expandHome,
  extensionEnabled,
  HARNESS_CHOICES,
  type LaneId,
  loadConfig,
  needsReflection,
  orchestratorRoute,
  parseQuietHours,
  planStandings,
  reflectionPrompt,
  resolveRoute,
  THINKING_LEVELS,
  type ThinkingLevel,
} from '@tade/core'
import {
  type ExtensionWorkbench,
  type SetupFieldView as HostSetupField,
  type ListSection,
  settingFrom,
} from '@tade/extensions-core'
import { git } from '@tade/status'
import { slugify, VoiceSurface } from '@tade/voice-core'
import { Speaker } from '@tade/voice-tts'
import type { Workbench } from '@tade/workbench'
import { type ParsedDiff, parseDiff } from './diff.ts'
import { chooseEditor, launch, openerFor, openerForLink } from './editor.ts'
import type { Frame } from './frame.ts'
import { readImage } from './images.ts'
import {
  addEnded,
  addNews,
  agentEnded,
  eventNews,
  type News,
  taskNews,
  unended,
  withNews,
} from './inbox.ts'
import { keyCaps } from './keys.ts'
import { resolveLayout } from './layout.ts'
import type { Linker } from './links.ts'
import { knownTasks, Live } from './live.ts'
import type { TaskSnapshot } from './model.ts'
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
  openSchedule,
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
  toggleFolder,
  turnSplit,
  unsplitPane,
  viewLane,
  whichProject,
  withProjects,
  withTasks,
  withTerminals,
  withTranscript,
} from './model.ts'
import type { PanelContext } from './panels/context.ts'
import {
  type ExtensionSetupPanel,
  extensionSetupPanel,
  extensionViewPanel,
} from './panels/extensions/setup.ts'
import {
  type ExtensionsPanel,
  type ExtensionView,
  extensionsPanel,
  type McpServerOffer,
  type McpServerShown,
  type McpServerView,
  toolSummary,
  type WrittenToolView,
} from './panels/extensions/state.ts'
import { extensionsScrollable } from './panels/extensions/view.ts'
import { type FilePanel, filePanel, savedFile } from './panels/file/state.ts'
import { fileBodySize, fileViewSize } from './panels/file/view.ts'
import {
  type AgentOffers,
  accountMenuItems,
  agentOffers,
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
import { type ModelChoice, type ModelPanel, modelPanel, priceSaid } from './panels/models/state.ts'
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
  type BranchRow,
  branchPanel,
  type CloseDonePanel,
  type ConfirmRemovePanel,
  closeDonePanel,
  confirmRemovePanel,
  diffPanel,
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
import { runScreen, ScreenCancelled, type Ui } from './screen.ts'
import { addProject, editSettings, writeSetting } from './settings.ts'
import { PLAIN, pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { spendView as spendViewOf } from './spend.ts'
import {
  fromThinker,
  interrupted,
  problem,
  ran,
  said,
  suggest,
  tadeDid,
  thinking,
  youSaid,
} from './transcript.ts'
import { transcriptLines } from './transcript-view.ts'
import {
  editedText,
  formattable,
  formattedLines,
  markdownLines,
  readForView,
  saveEdited,
  sourceLines,
  textLines,
  type ViewedFile,
} from './viewer.ts'
import { Checks } from './wire/checks.ts'
import {
  type AppOptions,
  clockOf,
  type Thinker,
  type Wiring,
  type WorkerImageFile,
  whenShort,
  why,
} from './wire/context.ts'
import { Images, imagesTitle } from './wire/images.ts'
import { Keyboard } from './wire/keyboard.ts'
import { Lanes } from './wire/lanes.ts'
import { Machine } from './wire/machine.ts'
import { Mouse } from './wire/mouse.ts'
import { Notes } from './wire/notes.ts'
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
const STATUS_MS = 5_000
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

/**
 * What is true of a row that is an MCP server and of nothing else.
 *
 * Only what was actually asked: a server that is off was never connected, so
 * it has no tools, no version and no "last asked" — and saying otherwise
 * would be the page inventing a connection nobody made.
 */
function serverFacts(server: McpServerShown | undefined): McpServerView | undefined {
  if (!server) return undefined
  return {
    name: server.name,
    how: server.how,
    on: server.on,
    decided: server.decided,
    install: server.install,
    note: server.note,
    asked: server.asked,
    dropped: server.dropped,
    fetches: server.fetches,
    theirs: Object.fromEntries(server.tools.map((tool) => [tool.name, tool.from])),
  }
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
   * Tade could have, and everything except free text works meanwhile.
   */
  private thinker: Thinker | null = null
  /** The pictures that went with what was said last, until the orchestrator is asked. */
  private sending: string[] = []
  /**
   * The files attached to what the orchestrator is answering, for the agents it
   * starts while it does. Only until it has answered: a picture belongs to the
   * message it came with, not to whatever is started next.
   */
  private answering: readonly string[] = []
  /** Text the extensions know how to open, asked once: working it out reads files. */
  private linkers: readonly Linker[] = []
  /** What each field of the setup panel offers, once looked up. */
  private setupChoices: Record<string, readonly string[]> = {}
  /** What the harness loads by itself, once asked. */
  private harnessPieces: { name: string; where: string }[] = []
  private readonly skin: Skin = skinFor(process.env, process.stdout.isTTY === true)
  private readonly pointerShapes = pointerShapes(process.env)
  /** When this window opened: the start of "This window" in the Spend panel. */
  private readonly openedAt = Date.now()
  /** Agents this window has opened again on its own, so it never does it twice. */
  private readonly reopened = new Set<string>()
  /** Tasks whose agent is being opened right now. */
  private readonly opening = new Set<string>()
  /** A new agent is being made. */
  private starting = false
  /** Projects this window has already opened an agent in on its own. */
  private readonly opened = new Set<string>()
  /** Agents whose branch is being named, so a slow git is not asked twice. */
  private readonly naming = new Set<string>()
  /** The project checkout's branches, for the Switch branch panel. */
  private branchRows: BranchRow[] = []
  private statuses: NonNullable<Frame['statuses']> = []
  /** The sections extensions keep in the sidebar, as they last answered. */
  private listSections: ListSection[] = []
  private statusedAt = Number.NEGATIVE_INFINITY
  private asking = false
  private speakingTurn = false
  /** A look at the lanes is under way, and whether another was asked for meanwhile. */
  private looking = false
  private lookAgain = false
  private extensionShown: { name: string; title: string; markdown: string; at: number } | null =
    null
  private soon: NodeJS.Timeout | null = null
  /** The diff the diff panel is showing, once git has answered. */
  private diff: ParsedDiff | null = null
  /** The file the viewer is showing, its coloured source, and its Markdown laid out at a width. */
  private viewed: {
    file: ViewedFile
    source: string[]
    /** The same lines uncoloured: what a find looks through and a caret counts in. */
    text: string[]
    formatted: { width: number; lines: string[] } | null
  } | null = null
  /** The models an agent can be started on, once they have been read. */
  private models: ModelChoice[] = []
  /**
   * The models the open picker offers, when it is for one agent: its
   * harness's, which are not the orchestrator's or another harness's.
   */
  private pickerModels: ModelChoice[] | null = null
  /** Providers the harness is signed in to, once read. */
  /** The Open project list for the last folder and query, and the branches found for its rows. */
  private openCache: { key: string; rows: OpenRow[]; browsing: string | null } | null = null
  private readonly branches = new Map<string, string | null>()
  /** Tasks being looked back at right now, so two polls cannot double up. */
  private readonly reflecting = new Set<string>()
  /** What happened that the orchestrator has not heard yet: it goes with the next thing said to it. */
  private news: News[] = []
  /** The tasks as last seen, so what changed between two looks is news. */
  private seenTasks: readonly TaskSnapshot[] | null = null
  /**
   * What each agent's harness lets a person ask of it, by task: learned as the
   * tasks refresh, so drawing never waits on it. Absent is "not known yet",
   * which offers everything, as the window always did.
   */
  private readonly offersByTask = new Map<string, AgentOffers>()
  /** Another screen has the terminal, so this window must not draw over it. */
  private borrowed = false
  private live: Live | null = null
  private timer: NodeJS.Timeout | null = null
  /** When the whole screen was last written over itself. */
  private repaintedAt = 0
  /** Extension actions you have run, for giving each its own line. */
  private ranCount = 0
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
      news: (said) => {
        this.news = addNews(this.news, said, this.now())
      },
      tell: (text) => this.tell(text),
      schedules: {
        views: () => this.schedules.views(),
        set: (req) => this.schedules.set(req),
        runNow: (id, asked) => this.schedules.runNow(id, asked),
      },
    })
    this.schedules = new Schedules(this.wire, {
      news: (said) => {
        this.news = addNews(this.news, said, this.now())
      },
      tell: (text) => this.tell(text),
      advanceQueue: () => void this.advanceQueue(),
    })
    this.search = new Search(this.wire, {
      settings: () => this.settings.rows(),
      openFile: (path, line) => this.openFile(path, line),
      openFind: (id, query, index) => this.lanes.openFind(id, query, index),
      clicked: (target) => this.mouse.clicked(target),
      decide: (allow) => this.decide(allow),
      stopAgent: (task) => this.stopAgent(task),
      openDiff: (task, path) => this.openDiff(task, path),
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
      onScreenWith: (flow) => this.onScreenWith(flow),
      refreshModels: async () => {
        this.models = (await this.opts.models?.().catch(() => [])) ?? this.models
      },
    })
    this.settings = new Settings(this.wire, {
      loadAccounts: () => void this.machine.loadAccountViews(),
      lookAtWhatIsInstalled: () => void this.machine.lookAtWhatIsInstalled(),
      tellThinking: (level) => this.tellThinkerThinking(level),
      setupChanged: () => this.setupShown.clear(),
      silence: () => {
        this.speakingTurn = false
        void this.voice.silence()
      },
    })
    this.images = new Images(this.wire, {
      menuItemsFor: (panel) => this.menuItemsFor(panel),
      soonTick: () => this.soonTick(),
      answering: () => this.answering,
    })
    this.voice = new Voice(this.wire, {
      submit: () => this.keyboard.submit(),
      say: (said) => this.say(said),
      useConfig: (config) => this.useConfig(config),
    })
    this.checks = new Checks(this.wire, {
      sections: () => this.listSections,
      callId: () => `you-${++this.ranCount}`,
    })
    if (opts.thinker) this.thinkWith(opts.thinker)
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
      decide: (allow) => void this.decide(allow),
      openSearch: () => this.search.open(),
      run: (action) => void this.run(action),
      interrupt: () => void this.interruptThinker(),
      quit: () => this.quit(),
      soonTick: () => this.soonTick(),
      toLane: (data) => this.lanes.toLane(data),
      act: (said) => void this.act(said),
      say: (said) => this.say(said),
    })
    this.lanes = new Lanes(this.wire, {
      size: () => ({ columns: this.terminal.columns, rows: this.terminal.rows }),
      layout: () => this.window.layout(),
      skin: this.skin,
      soonTick: () => this.soonTick(),
      say: (said) => this.say(said),
    })
    this.mouse = new Mouse(this.wire, {
      stopped: () => this.stopped,
      borrowed: () => this.borrowed,
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
      fileLines: () => this.fileLines(),
      fileBody: (panel) => this.fileBody(panel),
      copySelection: (text) => void this.copySelection(text),
      resolvePath: (path) => this.resolvePath(path),
      openFile: (path, line) => this.openFile(path, line),
      openLink: (url) => void this.openLink(url),
      openDiff: (task, path) => void this.openDiff(task, path),
      openNote: (note) => this.notes.open(note),
      openAgent: () => void this.openAgent(),
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
    this.thinkWith(thinker)
    this.state = notice(this.state, 'orchestrator ready')
    this.draw()
  }

  /** Take free text to this thinker, and show what it does as it does it. */
  private thinkWith(thinker: Thinker): void {
    this.thinker = thinker
    thinker.onEvent?.((event) => {
      // Said as it streams. The whole message follows its pieces, and only
      // closes them off: said again, every answer was heard twice at once.
      if (this.speakingTurn && event.type === 'delta' && event.text) {
        this.voice.speakChunk(event.text)
      } else if (this.speakingTurn && event.type === 'message' && event.text) {
        this.voice.speakMessage(event.text)
      }
      this.state = this.anchored(
        withTranscript(this.state, fromThinker(this.state.transcript, event, this.now())),
      )
      this.draw()
    })
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

  /**
   * Write down the model the orchestrator ended up on when none was chosen,
   * so it stays on it. Otherwise the harness's default decides every start,
   * and that default is whatever an agent last switched to.
   */
  keepThinkerModel(model: { provider?: string; id: string }): void {
    if (this.opts.config.orchestrator.model) return
    this.saveThinkerModel(model)
  }

  /**
   * The orchestrator switched its own model, because it was asked to: kept for
   * the next start and shown on its tab, without restarting what it is doing.
   */
  thinkerMovedTo(model: { provider: string; id: string }): void {
    this.saveThinkerModel(model)
    this.state = notice(this.state, `the orchestrator is now on ${model.provider}/${model.id}`)
    this.draw()
  }

  private saveThinkerModel(model: { provider?: string; id: string }): void {
    try {
      writeSetting(this.configPath, 'orchestrator.provider', model.provider)
      writeSetting(this.configPath, 'orchestrator.model', model.id)
      this.useConfig({
        ...this.opts.config,
        orchestrator: {
          ...this.opts.config.orchestrator,
          model: model.id,
          ...(model.provider ? { provider: model.provider } : {}),
        },
      })
    } catch {
      // Not writable: it still runs, only without the promise to stay put.
    }
  }

  /**
   * The orchestrator could not be started, said where you would have waited
   * for it — not swallowed, which left a window that never answered anything
   * and gave no reason.
   */
  thinkerFailed(reason: string): void {
    this.state = withTranscript(
      this.state,
      problem(this.state.transcript, `The orchestrator did not start: ${reason}`, this.now()),
    )
    this.state = notice(this.state, null)
    this.draw()
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
              this.offersByTask.get(subject.task),
            )
          : []
      }
      case 'file': {
        const marks = this.live?.marksAt(this.hereOnDisk()) ?? {}
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
        const marks = this.live?.marksAt(this.hereOnDisk()) ?? {}
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
          this.harnessShown(subject.task),
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
        return thinkingMenuItems(subject.current, this.offersByTask.get(subject.task)?.levels)
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
    const exact = this.models.find((known) => known.id === model)
    if (exact) return exact.provider
    const named = model.includes('/') ? (model.split('/')[0] ?? null) : null
    if (named && this.machine.paidBy(named)) return named
    const offering = this.models.filter((known) => known.id.endsWith(`/${model}`))
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
        models: this.pickerModels ?? this.models,
        modelTarget:
          panel.for === 'orchestrator' ? 'the orchestrator' : pane ? shownName(pane) : panel.for,
        currentModel:
          panel.for === 'orchestrator'
            ? this.thinkerModel()
            : (live.vitals(panel.for)?.model ?? null),
      }
    }
    if (panel.kind === 'extension-setup') return { setup: this.setupFacts(panel) }
    if (panel.kind === 'extension-view') {
      const shown = this.extensionShown
      return {
        extensionView:
          shown?.name === panel.extension ? { title: shown.title, markdown: shown.markdown } : null,
      }
    }
    if (panel.kind === 'extensions') {
      return {
        written: this.writtenViews(),
        extensions: this.extensionViews(),
        harnessExtensions: this.harnessPieces,
        servers: this.serverOffers(),
        extensionsRoot: tilde(expandHome(this.opts.config.orchestrator.extensions)),
      }
    }
    if (panel.kind === 'branch') return { branches: this.branchRows }
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
    if (panel.kind === 'diff') return { diff: this.diff }
    if (panel.kind === 'search')
      return { entries: this.search.entries(), searching: this.search.searching }
    if (panel.kind === 'file') return { viewing: this.viewingAt(width) }
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
    return this.models.map((model) => {
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
        harness: this.state.focused ? this.harnessShown(this.state.focused) : route.harness,
        model: route.model ?? null,
        thinking: route.thinking ?? null,
        provider,
        credential: this.machine.credential(provider),
      },
      vitals: live.vitals(this.state.focused),
      offers: this.state.focused ? (this.offersByTask.get(this.state.focused) ?? null) : null,
      spendView,
      panel: this.panelFacts(live, width),
      voice: {
        keys: keyCaps(this.opts.config.surfaces.voice.talk.key),
        available: this.opts.recorder !== undefined,
      },
      home: tilde(this.opts.home),
      linkers: this.linkers,
      orchestratorModel: this.thinkerModel(),
      orchestratorThinking: this.opts.config.orchestrator.thinking ?? null,
      orchestratorAccount: this.thinkerAccount(),
      orchestratorOffers: this.thinker?.offers ?? null,
      bindings: this.opts.config.surfaces.window.keys,
      muted: this.opts.config.surfaces.voice.muted,
      clipboardImage: this.images.offered,
      extensionsNeedYou: (this.opts.extensions?.list() ?? []).filter(
        (one) => one.state === 'needs setup' || one.state === 'broken',
      ).length,
      ...this.keyboard.input(width),
      statuses: this.statuses,
      lists: this.listSections.map((section) => ({
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
        if (this.seenTasks) {
          for (const text of taskNews(this.seenTasks, tasks)) {
            this.news = addNews(this.news, text, this.now())
          }
        }
        this.seenTasks = tasks
        void this.learnHarnesses(tasks)
        void this.queue.recordRulesMet()
        void this.schedules.runDue().then(() => this.advanceQueue())
        void this.reflect(tasks)
        this.draw()
      },
      onEvent: (event) => {
        this.state = onEvent(this.state, event, this.now())
        const heard = eventNews(event)
        if (heard) this.news = addNews(this.news, heard, this.now())
        // An agent that is gone, however it went: told rather than discovered
        // by the orchestrator steering something that is not there any more.
        const ended = agentEnded(event)
        if (ended) this.news = addEnded(this.news, ended, this.now())
        if (event.type === 'run_started' && event.task) this.news = unended(this.news, event.task)
        this.draw()
      },
      onWarning: (message) => {
        this.state = notice(this.state, message)
        this.draw()
      },
      onChange: () => this.draw(),
      onWork: (task) => void this.nameAgent(task),
      onTerminals: (terminals) => {
        this.state = withTerminals(this.state, terminals)
        this.draw()
      },
    })
    this.live = live
    this.linkers = this.opts.extensions?.linkers() ?? []
    this.watchExtensions()
    this.reopenLost()

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
        status: async (scope) => this.describe(scope),
        worktreeOf: async (task) => live.worktreeOf(task),
        show: async (task) => this.show(task),
        openSettings: async () => this.openSettings(),
        brief: () => this.brief(),
        extension: (said) => this.heardByExtension(said),
        tasks: async () => knownTasks(live.tasks),
        history: async () => live.history,
        ask: (text: string) => this.ask(text),
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
        await this.decideFor(task, verb === 'toast-allow')
      this.draw()
      return
    }
    if (action.startsWith('model:')) {
      await this.openModels(action.slice('model:'.length))
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
      await this.closeAgent(action.slice('close-task:'.length))
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
      await this.openListRow(section ?? '', id ?? '')
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
      const current = this.harnessShown(task)
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
      this.say(action.slice('ask:'.length))
      return
    }
    if (action.startsWith('extension-view:')) {
      const name = action.slice('extension-view:'.length)
      this.state = { ...this.state, panel: extensionViewPanel(name) }
      this.draw()
      await this.refreshExtensionView(name)
      return
    }
    if (action.startsWith('extension:')) {
      const [, name, id] = action.split(':')
      await this.runExtension(name ?? '', id ?? '')
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
        await this.newAgent('')
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
        this.harnessPieces = (await this.opts.harnessExtensions?.().catch(() => [])) ?? []
        this.readServers()
        // What each one can be given is asked once, on the way in, rather
        // than on every frame it is drawn.
        this.setupShown.clear()
        {
          // It opens on the one that wants somebody — something to set up,
          // something broken — and on the first of them when nothing does.
          const views = this.extensionViews()
          const wants = views.find((one) => one.state === 'needs setup' || one.state === 'broken')
          this.state = {
            ...this.state,
            panel: extensionsPanel(wants?.name ?? views[0]?.name ?? null),
          }
        }
        this.draw()
        return
      case 'brief':
        await this.brief()
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
      case 'open-agent': {
        // Queued work has no agent yet: starting it goes through the queue, so
        // what started it and why is written down.
        const pane = this.state.panes.find((one) => one.task === this.state.focused)
        if (pane?.queued) await this.queue.change(pane.task, 'start')
        else await this.openAgent()
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
        const path = this.hereOnDisk()
        if (!path) return
        const copied = await copyText(path, (data) => this.terminal.write(data))
        this.state = notice(this.state, copied ? `copied ${path}` : path)
        this.draw()
        return
      }
      case 'open-path': {
        const path = this.hereOnDisk()
        if (path) await this.reveal(path, true)
        return
      }
      default:
        await this.act(action)
    }
  }

  /**
   * Open a file you clicked, in your editor, at the line if there is one.
   * Relative paths are the agent's, so they resolve in its worktree.
   */
  private async openPlace(target: { path: string; line?: number; column?: number }): Promise<void> {
    const file = this.resolvePath(target.path)
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

  /**
   * Where a path someone clicked is: relative ones are the agent's, so they
   * resolve in its worktree, or in the project when no agent is in front of you.
   */
  private resolvePath(path: string): string {
    return isAbsolute(path)
      ? path
      : resolve(this.hereOnDisk() ?? this.opts.cwd ?? process.cwd(), path)
  }

  /** The folder you are looking at on disk: the focused agent's worktree, or the project's. */
  private hereOnDisk(): string | null {
    const focused = this.state.panes.find((pane) => pane.task === this.state.focused)
    const worktree = focused ? this.live?.worktreeOf(focused.task) : null
    if (worktree) return worktree
    const root = this.state.project
      ? this.opts.config.projects[this.state.project]?.root
      : undefined
    return root ? expandHome(root) : null
  }

  /** Read a file into the viewer, at a line if there is one. */
  private openFile(path: string, line: number | null = null): void {
    const file = readForView(path)
    this.viewed = {
      file,
      source: sourceLines(file, !this.skin.colour),
      text: textLines(file),
      formatted: null,
    }
    this.state = { ...this.state, panel: filePanel(path, line, formattable(file)) }
    this.draw()
  }

  /** What the viewer draws, with Markdown laid out for the width it has now. */
  private viewingAt(width: number): NonNullable<Frame['panel']>['viewing'] {
    const viewed = this.viewed
    if (!viewed) return null
    if (!formattable(viewed.file))
      return { file: viewed.file, source: viewed.source, text: viewed.text, formatted: null }
    const room = fileViewSize(width, this.terminal.rows).width - 4
    if (viewed.formatted?.width !== room) {
      viewed.formatted = {
        width: room,
        lines: formattedLines(viewed.file, room, !this.skin.colour),
      }
    }
    return {
      file: viewed.file,
      source: viewed.source,
      text: viewed.text,
      formatted: viewed.formatted.lines,
    }
  }

  /**
   * Write what was typed into the file back, and read it again — so what is on
   * screen is what is on disk, coloured as a whole file rather than line by
   * line, and the tree beside it shows git's new mark for it.
   *
   * A save that could not happen stays in the panel, with the file still open
   * and everything typed still in it.
   */
  private async saveFile(panel: FilePanel): Promise<void> {
    const viewed = this.viewed
    const edit = panel.edit
    if (!viewed || !edit || viewed.file.path !== panel.path) return
    try {
      const file = saveEdited(viewed.file, editedText(edit, viewed.file))
      this.viewed = {
        file,
        source: sourceLines(file, !this.skin.colour),
        text: textLines(file),
        formatted: null,
      }
      this.state = {
        ...this.state,
        panel: savedFile(panel, this.viewed.text, `Saved ${basename(panel.path)}.`),
      }
      this.draw()
      await this.live?.refresh()
    } catch (err) {
      this.state = { ...this.state, panel: { ...panel, said: why(err), warned: true } }
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
      await runScreen({ title: 'Tade', terminal: this.terminal }, flow)
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
      this.state = notice(this.state, 'open an agent first: a shell starts in its worktree')
      this.draw()
      return
    }
    const taken = new Set(pane.lanes.map((lane) => lane.id))
    let id = `${pane.task}/shell`
    for (let n = 2; taken.has(id); n++) id = `${pane.task}/shell-${n}`
    const size = this.lanes.paneSize()
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
        await this.chooseModel(panel, choice ?? '')
        return
      case 'extensions':
        await this.fromExtensions(panel, choice ?? '')
        return
      case 'extension-setup':
        await this.saveSetup(panel)
        return
      case 'prompt':
        await this.savePrompt(panel, choice)
        break
      case 'branch':
        await this.switchBranch(choice ?? '')
        break
      case 'confirm':
        await this.discard(panel.task, panel.path)
        break
      case 'confirm-remove':
        await this.removeTask(panel)
        break
      case 'close-done':
        await this.closeDone(panel)
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
          await this.openPlace({
            path: panel.path,
            ...(panel.edit ? { line: panel.edit.row + 1, column: panel.edit.column + 1 } : {}),
            ...(!panel.edit && panel.line ? { line: panel.line } : {}),
          })
          return
        }
        if (choice === 'save') {
          await this.saveFile(panel)
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
          await this.openPlace({ path: this.configPath })
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
              : this.live?.branchAt(this.hereOnDisk() ?? '')) || 'branch'
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
        return this.fromTaskMenu(subject.task, item)
      case 'file':
        return this.fromFileMenu(subject.path, subject.folder, item)
      case 'change':
        return this.fromChangeMenu(subject.task, subject.path, item)
      case 'branch':
        return this.fromBranchMenu(item)
      case 'terminal':
        return this.fromTerminalMenu(subject.id, item)
      case 'images':
        return this.images.give(subject.paths, item)
      case 'harness':
        return this.chooseHarness(subject.task, item)
      case 'account':
        return this.chooseAccount(subject.task, item)
      case 'lane':
        return this.fromLaneMenu(subject.task, subject.lane, subject.name, item)
      case 'note':
        return this.notes.fromMenu(subject, item)
      case 'thinking':
        return this.chooseThinking(subject.task, item)
    }
  }

  /** How hard an agent thinks from its next turn, and new agents from their first. */
  private async chooseThinking(task: string, level: string): Promise<void> {
    if (task === ORCHESTRATOR_TAB) return this.chooseThinkerThinking(level)
    try {
      const chosen = await this.opts.client.setAgentThinking(task, level)
      const loaded = await loadConfig(this.configPath)
      if (loaded.ok) this.useConfig(loaded.config)
      this.state = notice(
        this.state,
        `${task} thinks at ${chosen} from its next turn, and new agents start there`,
      )
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  /**
   * How hard the orchestrator thinks, from its next reply on. Written to the
   * config, like the model it is on, so it stays — but unlike the model it
   * needs no restart: the level is asked of the process it is already in, and
   * the conversation carries on.
   */
  private async chooseThinkerThinking(level: string): Promise<void> {
    const chosen = THINKING_LEVELS.find((one) => one === level.trim().toLowerCase())
    if (!chosen) {
      this.state = notice(this.state, `${level} is not a thinking level`)
      this.draw()
      return
    }
    try {
      writeSetting(this.configPath, 'orchestrator.thinking', chosen)
      const loaded = await loadConfig(this.configPath)
      if (loaded.ok) this.useConfig(loaded.config)
    } catch (err) {
      this.state = notice(this.state, why(err))
      this.draw()
      return
    }
    const trouble = await this.tellThinkerThinking(chosen)
    this.state = notice(
      this.state,
      trouble
        ? `the orchestrator will think at ${chosen} when it next starts: ${trouble}`
        : `the orchestrator thinks at ${chosen} from its next reply, and starts there`,
    )
    this.draw()
  }

  /**
   * Ask the orchestrator to think at a level now. Answers why it could not be
   * told — it is still starting, or stopped — rather than throwing: the level
   * is in the config either way, so the next start has it.
   */
  private async tellThinkerThinking(level: ThinkingLevel): Promise<string | null> {
    const move = this.thinker?.setThinking
    if (!this.thinker || !move) return 'it is not running yet'
    try {
      await move.call(this.thinker, level)
      return null
    } catch (err) {
      return why(err)
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

  /** The harness a task's agent is shown as running in: its own, else its route's. */
  private harnessShown(task: string): string {
    return (
      this.offersByTask.get(task)?.harness ??
      resolveRoute(this.opts.config, { project: task.split('/')[0] ?? '' }).harness
    )
  }

  /**
   * Learn what each task's harness offers, in the background: which harness
   * it is in and what it can be asked. Redrawn only when something changed.
   */
  private async learnHarnesses(tasks: readonly TaskSnapshot[]): Promise<void> {
    let changed = false
    for (const task of tasks) {
      if (await this.learnHarness(task.task)) changed = true
    }
    if (changed) this.draw()
  }

  private async learnHarness(task: string): Promise<boolean> {
    const worktree = this.live?.worktreeOf(task)
    if (!worktree) return false
    const known = await this.opts.client.agentHarness(task, worktree).catch(() => null)
    if (!known) return false
    const was = this.offersByTask.get(task)
    const now = agentOffers(known.harness, known.capabilities)
    if (was && JSON.stringify(was) === JSON.stringify(now)) return false
    this.offersByTask.set(task, now)
    return true
  }

  /**
   * Run an agent as another account of its harness, its conversation carried
   * along, starting it again there if it is running.
   */
  private async chooseAccount(task: string, account: string): Promise<void> {
    const worktree = this.live?.worktreeOf(task)
    if (!worktree) {
      this.state = notice(this.state, `I cannot find where ${task} works`)
      this.draw()
      return
    }
    try {
      const done = await this.opts.client.setAgentAccount({
        task,
        worktree,
        account: account || null,
      })
      const as = done.account ?? 'its own sign-in'
      this.state = notice(
        this.state,
        `${task} runs as ${as}${done.carried ? ', its conversation with it' : ''}${done.restarted ? ', started again there' : ' from its next start'}`,
      )
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    await this.machine.loadAccountViews()
    this.draw()
  }

  /** Run an agent in another harness, starting it again there if it is running. */
  private async chooseHarness(task: string, harness: string): Promise<void> {
    const worktree = this.live?.worktreeOf(task)
    if (!worktree) {
      this.state = notice(this.state, `I cannot find where ${task} works`)
      this.draw()
      return
    }
    try {
      const done = await this.opts.client.setAgentHarness({ task, worktree, harness })
      await this.learnHarness(task)
      this.state = notice(
        this.state,
        `${task} runs in ${done.harness}${done.restarted ? ', started again there' : ' from its next start'}`,
      )
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    await this.live?.refresh()
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

  private async fromFileMenu(path: string, folder: boolean, item: string): Promise<void> {
    const full = this.resolvePath(path)
    const focused = this.state.panes.find((p) => p.task === this.state.focused)
    switch (item) {
      case 'open':
        this.openFile(full)
        return
      case 'toggle':
        this.state = toggleFolder(this.state, path)
        break
      case 'search':
        this.search.open(`${path}/`)
        return
      case 'editor':
        await this.openPlace({ path: full })
        return
      case 'changes':
        if (focused) await this.openDiff(focused.task, path)
        return
      case 'ask':
        if (focused) await this.askAbout(focused.task, path)
        break
      case 'copy-path':
        await this.copy(full)
        return
      case 'copy-relative':
        await this.copy(path)
        return
      case 'reveal':
        await this.reveal(full, folder)
        return
      default:
        break
    }
    this.draw()
  }

  private async fromChangeMenu(task: string | null, path: string, item: string): Promise<void> {
    const full = this.resolvePath(path)
    switch (item) {
      case 'diff':
        if (task) await this.openDiff(task, path)
        return
      case 'open':
        this.openFile(full)
        return
      case 'editor':
        await this.openPlace({ path: full })
        return
      case 'ask':
        if (task) await this.askAbout(task, path)
        break
      case 'copy-path':
        await this.copy(full)
        return
      case 'discard':
        this.state = {
          ...this.state,
          panel: {
            kind: 'confirm',
            purpose: 'discard',
            task,
            path,
            field: 'keep',
            busy: false,
            error: null,
          },
        }
        break
      default:
        break
    }
    this.draw()
  }

  private async fromBranchMenu(item: string): Promise<void> {
    const focused = this.state.panes.find((p) => p.task === this.state.focused)
    const here = this.hereOnDisk()
    const branch = focused
      ? (this.live?.factsOf(focused.task)?.branch ?? '')
      : (this.live?.branchAt(here ?? '') ?? '')
    switch (item) {
      case 'switch': {
        this.branchRows = here ? await (this.live?.branchesOf(here) ?? []) : []
        this.state = { ...this.state, panel: branchPanel() }
        break
      }
      case 'new':
        this.state = {
          ...this.state,
          panel: promptPanel('new-branch', 'New branch', 'BRANCH NAME'),
        }
        break
      case 'rename':
        this.state = {
          ...this.state,
          panel: promptPanel(
            'rename-branch',
            branch ? 'Rename branch' : 'Name the branch',
            'BRANCH NAME',
            branch ? branch.replace(/^tade\//, '') : '',
          ),
        }
        break
      case 'pull': {
        if (!here) break
        const out = await git(here, ['pull', '--ff-only'], 60_000)
        this.state = notice(
          this.state,
          out.ok ? `pulled ${branch || 'the branch'}` : `pull failed: ${out.stderr.split('\n')[0]}`,
        )
        break
      }
      case 'copy':
        if (branch) await this.copy(branch)
        return
      case 'copy-path':
        if (here) await this.copy(here)
        return
      case 'changes': {
        if (!focused) break
        const first = this.live?.changes(focused.task)[0]
        if (first) await this.openDiff(focused.task, first.path)
        else this.state = notice(this.state, `${shownName(focused)} has not changed anything yet`)
        break
      }
      default:
        break
    }
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

  /** Reveal a file in the system's file manager. */
  private async reveal(path: string, folder: boolean): Promise<void> {
    try {
      if (process.platform === 'darwin') {
        await launch({ kind: 'detached', command: 'open', args: folder ? [path] : ['-R', path] })
      } else {
        await launch({
          kind: 'detached',
          command: 'xdg-open',
          args: [folder ? path : dirname(path)],
        })
      }
    } catch (err) {
      this.state = notice(this.state, why(err))
      this.draw()
    }
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
      const here = this.hereOnDisk()
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

  /** Switch the project's checkout to a branch, or to a new one. */
  private async switchBranch(choice: string): Promise<void> {
    const panel = this.state.panel
    const [verb, ...rest] = choice.split(':')
    const name = rest.join(':')
    const here = this.hereOnDisk()
    if (!here || !name || panel?.kind !== 'branch') return
    const out = await git(
      here,
      verb === 'create' ? ['switch', '-c', name] : ['switch', name],
      30_000,
    )
    if (!out.ok) {
      // Git's own words: an unstaged change in the way is a reason worth reading.
      this.state = {
        ...this.state,
        panel: { ...panel, busy: false, error: out.stderr.split('\n')[0] ?? 'git refused' },
      }
      return
    }
    this.state = notice({ ...this.state, panel: null }, `on ${name}`)
    await this.live?.refresh()
  }

  /** Throw away a file's uncommitted changes: back to the last commit, or gone if never committed. */
  private async discard(task: string | null, path: string): Promise<void> {
    const panel = this.state.panel
    const root = task ? this.live?.worktreeOf(task) : this.hereOnDisk()
    if (!root || panel?.kind !== 'confirm') return
    const marks = this.live?.marksAt(root) ?? {}
    const out =
      marks[path] === 'U'
        ? await git(root, ['clean', '-f', '--', path])
        : await git(root, ['restore', '--staged', '--worktree', '--source=HEAD', '--', path])
    if (!out.ok) {
      this.state = {
        ...this.state,
        panel: { ...panel, busy: false, error: out.stderr.split('\n')[0] ?? 'git refused' },
      }
      return
    }
    this.state = notice({ ...this.state, panel: null }, `discarded ${path}`)
  }

  private async fromTaskMenu(task: string, item: string): Promise<void> {
    const facts = this.live?.factsOf(task)
    const worktree = this.live?.worktreeOf(task)
    if (item.startsWith('queue-')) {
      await this.queue.change(task, item.slice('queue-'.length))
      return
    }
    switch (item) {
      case 'open': {
        this.state = focusTask(this.state, task)
        const pane = this.state.panes.find((p) => p.task === task)
        // Queued work opens as what it is: a plan, not an agent. Start now starts it.
        if (pane && !pane.queued && !pane.lane) await this.openAgent()
        break
      }
      case 'start':
        this.state = focusTask(this.state, task)
        await this.openAgent()
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
      case 'rename': {
        const pane = this.state.panes.find((p) => p.task === task)
        this.state = {
          ...this.state,
          panel: {
            ...promptPanel('rename-agent', 'Rename agent', 'NAME', pane ? shownName(pane) : ''),
            target: task,
          },
        }
        break
      }
      case 'model':
        await this.openModels(task)
        return
      case 'account': {
        const known = await this.opts.client
          .agentHarness(task, this.live?.worktreeOf(task) ?? '')
          .catch(() => null)
        await this.machine.loadAccountViews()
        this.state = {
          ...this.state,
          panel: menuPanel({ kind: 'account', task, current: known?.account ?? '' }, 'Account', {
            row: 3,
            col: Math.max(0, this.terminal.columns - 40),
          }),
        }
        this.draw()
        return
      }
      case 'copy-branch':
        if (facts) {
          const copied = await copyText(facts.branch, (data) => this.terminal.write(data))
          this.state = notice(this.state, copied ? `copied ${facts.branch}` : facts.branch)
        }
        break
      case 'mark-done':
        try {
          await this.opts.client.markDone(task, { by: 'you' })
          await this.live?.refresh()
          this.state = notice(this.state, `${task} is finished`)
        } catch (err) {
          this.state = notice(this.state, why(err))
        }
        break
      case 'park': {
        if (!worktree) break
        const pane = this.state.panes.find((p) => p.task === task)
        const parked = pane?.state !== 'parked'
        try {
          await this.opts.client.parkTask(worktree, parked, task)
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

  /**
   * Close an agent: stop it and take it off the list. Asked first only when
   * that would lose something — work in a worktree of its own that is not
   * merged. An agent in the project's checkout loses nothing by going: its work
   * is in the checkout, and only its task folder goes with it.
   */
  private async closeAgent(task: string): Promise<void> {
    const facts = this.live?.factsOf(task)
    const unmerged =
      facts?.workspace === 'worktree' &&
      ((this.live?.changes(task).length ?? 0) > 0 || (facts.ahead ?? 0) > 0)
    const panel = confirmRemovePanel(task)
    if (unmerged) {
      this.state = { ...this.state, panel }
      this.draw()
      return
    }
    await this.removeTask(panel)
    // Nothing to ask about, so nothing to leave open: a failure is said where you look.
    if (this.state.panel?.kind === 'confirm-remove' && this.state.panel.error) {
      const error = this.state.panel.error
      this.state = notice({ ...this.state, panel: null }, error)
    }
    this.draw()
  }

  private async removeTask(panel: ConfirmRemovePanel): Promise<void> {
    const error = await this.removeOne(panel.task)
    if (error) {
      this.state = { ...this.state, panel: { ...panel, busy: false, error } }
      return
    }
    await this.live?.refresh()
    this.state = notice({ ...this.state, panel: null }, `removed ${panel.task}`)
  }

  /**
   * Stop one agent and take its task off the list, its worktree and branch
   * with it. Says what stopped it from happening, or nothing when it did.
   */
  private async removeOne(task: string): Promise<string | null> {
    const facts = this.live?.factsOf(task)
    const worktree = this.live?.worktreeOf(task)
    const root = facts ? this.opts.config.projects[facts.project]?.root : undefined
    if (!facts || !worktree || !root) return 'I cannot find where this agent works.'
    try {
      // Its agent first: a worktree cannot go out from under a process using it.
      await this.opts.client.stopAgent(task).catch(() => {})
      const result = await this.opts.client.removeTask({
        root: expandHome(root),
        worktree,
        branch: facts.branch,
        task,
        force: true,
      })
      return result.removed ? null : result.reason
    } catch (err) {
      return why(err)
    }
  }

  /**
   * Close every agent that has finished, one after another: git cannot be
   * asked to remove two worktrees of the same repository at once. What could
   * not be closed stays on the list and is said — the rest still went.
   */
  private async closeDone(panel: CloseDonePanel): Promise<void> {
    const failed: string[] = []
    for (const task of panel.tasks) {
      const error = await this.removeOne(task)
      if (error) failed.push(`${task.split('/').at(-1) ?? task}: ${error}`)
    }
    await this.live?.refresh()
    const closed = panel.tasks.length - failed.length
    const said =
      failed.length === 0
        ? `closed ${closed} finished agent${closed === 1 ? '' : 's'}`
        : `closed ${closed} of ${panel.tasks.length} — ${failed.join('; ')}`
    this.state = notice({ ...this.state, panel: null }, said)
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
   * Stop the turn the orchestrator is on, and nothing else.
   *
   * What it already said stays, its session does not change and the next
   * thing you say carries on the same conversation — it is never introduced
   * again, so interrupting it must never be a way of restarting it. What is
   * typed on the line is not touched: escape is the key you press to stop
   * something, not to lose a sentence.
   *
   * A harness that cannot do this mid-turn says so in its own words rather
   * than swallowing the key, which would look exactly like a stop that did
   * not work.
   */
  private async interruptThinker(): Promise<void> {
    const offers = this.thinker?.offers
    if (!this.thinker?.interrupt || !offers?.interrupt.shown) {
      const why = offers?.interrupt.note ?? 'cannot be stopped once it has started'
      this.state = notice(this.state, `${offers?.harness ?? 'the orchestrator'} ${why}`)
      this.draw()
      return
    }
    try {
      await this.thinker.interrupt()
      // Said in the conversation rather than on a line that goes: scrolled
      // back to next week, it is the reason the turn above it stops mid-way.
      this.state = notice(
        withTranscript(this.state, interrupted(this.state.transcript)),
        'stopped the orchestrator',
      )
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
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
        await this.newAgent(rest)
        return
      case '/stop':
        await this.stopAgent(rest)
        return
      case '/open': {
        const task = this.findTask(rest)
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
        await this.onScreen(chosen.name)
    }
  }

  /**
   * A new agent in the project you are in: its own branch and worktree, pi in
   * it, and your eyes on it. Nothing is asked first. It is named for what you
   * said, or `agent-2` when you said nothing, and what you said — if anything —
   * is the first thing it hears. Name another project first to start one there.
   */
  private async newAgent(said: string): Promise<void> {
    const projects = Object.keys(this.opts.config.projects)
    if (projects.length === 0) {
      this.state = notice(this.state, 'no projects yet — Open project adds one')
      this.draw()
      return
    }
    const { project, intent } = whichProject(said, projects, this.state.project)
    if (!project) {
      this.state = notice(this.state, `which project? /new ${projects.join(' · ')}`)
      this.keyboard.prefill('/new ')
      return
    }
    // A second click before the first agent exists must not make a second one.
    if (this.starting) return
    this.starting = true
    this.state = notice(this.state, `starting a new agent in ${project}…`)
    this.draw()
    try {
      const id = await this.startTask(project, intent)
      this.state = focusTask(notice(this.state, `${id} is ready`), id)
    } catch (err) {
      this.state = notice(this.state, why(err))
    } finally {
      this.starting = false
    }
    this.draw()
  }

  /**
   * A branch, a worktree and an agent in it. The name is the first free one:
   * a branch left behind by an agent you removed still holds its name. The pane
   * is refreshed before anything tries to focus it, because a pane you cannot
   * see yet cannot take focus.
   */
  private async startTask(project: string, intent: string): Promise<string> {
    // A name is never used twice: pi keeps a conversation by the task's name,
    // so a new agent given an old one's would carry on its conversation.
    const before = await this.opts.client.events({ types: ['task_created'] }).catch(() => [])
    const taken = new Set([
      ...this.state.panes.filter((pane) => pane.project === project).map((pane) => pane.name),
      ...before
        .map((event) => event.task ?? '')
        .filter((task) => task.startsWith(`${project}/`))
        .map((task) => task.slice(project.length + 1)),
    ])
    // Said without words, it is an agent to look around with: no branch until
    // it changes something, and then one named for what it did.
    const detached = intent === ''
    const stem = (intent ? slugify(intent) : '') || 'agent'
    for (let n = 1; n <= 100; n++) {
      const slug = intent && n === 1 ? stem : `${stem}-${n}`
      if (taken.has(slug)) continue
      let task: Awaited<ReturnType<Workbench['createTask']>>
      try {
        task = await this.opts.client.createTask({ project, slug, intent, detached, by: 'you' })
      } catch (err) {
        if (/already exists|used before/.test(why(err))) continue
        throw err
      }
      await this.opts.client.startAgent({ task: task.id, cwd: task.worktree, prompt: intent })
      await this.live?.refresh()
      return task.id
    }
    throw new Error(`every name like ${stem} is taken in ${project}`)
  }

  /**
   * An agent in a project you have just added, so there is somewhere to type.
   * Only then: a project whose agents you removed stays without one — opening
   * the window again must never bring back what you took away.
   */
  private ensureAgent(project: string | null): void {
    if (!project || !this.live || this.opened.has(project)) return
    if (!this.opts.config.projects[project]) return
    this.opened.add(project)
    if (this.state.panes.some((pane) => pane.project === project)) return
    void this.newAgent('')
  }

  /**
   * An agent that started without a branch has changed something: give it one,
   * named for its work. Once — a failure is said, not retried every two seconds.
   */
  private async nameAgent(task: {
    id: string
    project: string
    worktree: string
    title: string
  }): Promise<void> {
    const root = this.opts.config.projects[task.project]?.root
    if (!root || this.naming.has(task.id)) return
    this.naming.add(task.id)
    try {
      const branch = await this.opts.client.nameTask({
        task: task.id,
        root: expandHome(root),
        worktree: task.worktree,
        title: task.title,
      })
      await this.live?.refresh()
      this.state = notice(this.state, `${task.title} is working on ${branch}`)
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  /** Open the agent in front of you: the conversation picks up where it stopped. */
  /**
   * Agents that were working when Tade last closed — not stopped, not
   * removed, and not ended on their own — opened again where they left off, as
   * though the window had never gone. Once each per window, and without taking
   * you away from where you are.
   */
  private reopenLost(): void {
    const lost = this.opts.client
      .lanes()
      .filter((lane) => lane.kind === 'agent' && !lane.alive && lane.lost === true)
    for (const lane of lost) {
      const pane = this.state.panes.find((one) => one.task === lane.task)
      if (!pane || pane.lane || this.reopened.has(lane.task) || this.opening.has(lane.task))
        continue
      if (!this.live?.worktreeOf(lane.task)) continue
      this.reopened.add(lane.task)
      void this.openAgent(lane.task, false)
    }
  }

  private async openAgent(task: string | null = this.state.focused, focus = true): Promise<void> {
    if (!task) return
    const worktree = this.live?.worktreeOf(task)
    if (!worktree) {
      this.state = notice(this.state, `I do not know where ${task} works`)
      this.draw()
      return
    }
    // Two clicks before the first agent has registered must not start two.
    if (this.opening.has(task)) return
    this.opening.add(task)
    try {
      // Reattached, never restarted: its lane and its conversation come back
      // exactly where they were, and nothing is said to it. An agent told its
      // first instruction a second time would do the work again.
      await this.opts.client.reopenAgent({ task: task as never, cwd: worktree })
      await this.live?.refresh()
      const told = notice(this.state, `opened ${task} where it left off`)
      this.state = focus ? focusTask(told, task) : told
    } catch (err) {
      this.state = notice(this.state, why(err))
    } finally {
      this.opening.delete(task)
    }
    this.draw()
  }

  /**
   * The agent in front of you is not running — the window it ran in closed, or
   * it stopped — so open it again, where it left off, without being asked.
   * Once per agent per window: one that stops again straight away is left for
   * you to look at, with its button, rather than started in a loop.
   */
  private reopenStopped(): void {
    const pane = this.state.panes.find((one) => one.task === this.state.focused)
    // Only an agent whose run stopped: one never started waits to be asked,
    // and one that finished is waiting for review, not for another run.
    if (!pane || pane.lane || pane.state !== 'failed') return
    if (this.reopened.has(pane.task) || this.opening.has(pane.task)) return
    if (!this.live?.worktreeOf(pane.task)) return
    this.reopened.add(pane.task)
    void this.openAgent(pane.task)
  }

  /** Stop the agent you are watching, or the one you name. Its work stays. */
  private async stopAgent(said: string): Promise<void> {
    const task = this.findTask(said) ?? this.state.focused
    if (!task) {
      this.state = notice(this.state, 'which agent? /stop name')
      this.keyboard.prefill('/stop ')
      return
    }
    try {
      // Stopped on purpose: not something to start again behind your back.
      this.reopened.add(task)
      await this.opts.client.stopAgent(task)
      await this.live?.refresh()
      this.state = notice(this.state, `${task} stopped — its branch and worktree stay`)
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
      // ctrl+c closes the form, not Tade.
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
    this.state = withTranscript(this.state, thinking(this.state.transcript, this.now()))
    this.draw()
    const images = this.sending.flatMap((path) => readImage(path) ?? [])
    this.sending = []
    this.speakingTurn =
      this.opts.config.surfaces.voice.speak && !this.opts.config.surfaces.voice.muted
    // What happened since it last heard goes with what you said, so what
    // answers you knows it — and is shown, since it is part of what was asked.
    if (this.news.length > 0) {
      const told = this.news.map((one) => one.text).join('; ')
      this.state = withTranscript(
        this.state,
        tadeDid(this.state.transcript, `told the orchestrator: ${told}`, this.now()),
      )
    }
    const message = withNews(text, this.news, clockOf)
    this.news = []
    try {
      return await this.thinker.ask(message, images)
    } catch (err) {
      this.state = withTranscript(this.state, problem(this.state.transcript, why(err), this.now()))
      return ''
    } finally {
      this.speakingTurn = false
      this.voice.flushSpeech()
    }
  }

  /** Everything addressed to Tade arrives here, however it was said. */
  private say(said: string): void {
    if (said === '' || !this.voice.ready) return
    this.keyboard.remember(said)
    // Shown the moment it is sent, not once something has answered it. The
    // pictures waiting go with it, and only with it.
    this.sending = this.state.attached
    const attached = [...this.state.attached]
    this.answering = attached
    this.state = withTranscript(
      { ...this.state, attached: [] },
      youSaid(this.state.transcript, said, this.now(), this.state.attached),
    )
    this.draw()
    void this.voice
      .handle(said)
      .then(() => {
        this.state = setQuestion(this.state, this.voice.awaiting)
        this.draw()
      })
      .catch((err: unknown) => {
        this.state = withTranscript(
          this.state,
          problem(this.state.transcript, why(err), this.now()),
        )
        this.draw()
      })
      .finally(() => {
        // Answered: what came with it goes to no agent started after.
        if (this.answering === attached) this.answering = []
      })
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
    this.reopenStopped()
    this.askExtensions()
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

  private thinkerAccount(): NonNullable<Frame['orchestratorAccount']> {
    const { provider, model } = this.opts.config.orchestrator
    const paying = provider ?? (model?.includes('/') ? (model.split('/')[0] ?? null) : null)
    return {
      provider: paying,
      credential: this.machine.credential(paying),
    }
  }

  /** The orchestrator's model as the config has it: `provider/id`, or the id alone. */
  private thinkerModel(): string | null {
    const { provider, model } = this.opts.config.orchestrator
    return model ? (provider ? `${provider}/${model}` : model) : null
  }

  /** Choose a model for the orchestrator, or for one agent's session. */
  private async openModels(target: string): Promise<void> {
    if (this.models.length === 0) {
      this.models = (await this.opts.models?.().catch(() => [])) ?? []
    }
    const worktree = target === 'orchestrator' ? null : this.live?.worktreeOf(target)
    this.pickerModels =
      target === 'orchestrator'
        ? ((await this.opts.orchestratorModels?.().catch(() => null)) ?? null)
        : worktree
          ? await this.opts.client.agentModels(target, worktree).catch(() => null)
          : null
    const offered = this.pickerModels ?? this.models
    // Starting on the one in use, so enter is a no-op and ↑↓ is "the one next to it".
    const current =
      target === 'orchestrator' ? this.thinkerModel() : (this.live?.vitals(target)?.model ?? null)
    const index = current
      ? Math.max(
          0,
          offered.findIndex((one) => one.id === current || one.id.endsWith(`/${current}`)),
        )
      : 0
    this.state = { ...this.state, panel: { ...modelPanel(target), index } }
    this.draw()
  }

  /**
   * Switch to a model. An agent switches its own session there and then. The
   * orchestrator's is written to the config — so it stays — and it is started
   * again on it, carrying on the same conversation.
   */
  private async chooseModel(panel: ModelPanel, id: string): Promise<void> {
    try {
      if (panel.for === 'orchestrator') {
        const [provider, ...rest] = id.split('/')
        writeSetting(this.configPath, 'orchestrator.provider', provider)
        writeSetting(this.configPath, 'orchestrator.model', rest.join('/'))
        const loaded = await loadConfig(this.configPath)
        if (loaded.ok) this.useConfig(loaded.config)
        this.state = { ...this.state, panel: null }
        this.state = notice(this.state, `the orchestrator is moving to ${rest.join('/')}`)
        this.draw()
        await this.opts.restartThinker?.()
      } else {
        const chosen = await this.opts.client.setAgentModel(panel.for, id)
        // It is new agents' model now too: read back what the workbench wrote.
        const loaded = await loadConfig(this.configPath)
        if (loaded.ok) this.opts.config = loaded.config
        this.state = notice(
          { ...this.state, panel: null },
          `${panel.for} is switching to ${chosen.id}, and new agents start on it`,
        )
      }
    } catch (err) {
      this.state = { ...this.state, panel: { ...panel, busy: false, error: why(err) } }
    }
    this.draw()
  }

  /**
   * The tools Tade wrote for itself, as the panel shows them: the files it
   * found, and whether each is turned on, which is a setting like any other.
   */
  private writtenViews(): WrittenToolView[] {
    return (this.opts.written?.() ?? []).map((tool) => ({
      ...tool,
      on: extensionEnabled(this.opts.config.extensions[tool.name], 'yours'),
    }))
  }

  /**
   * What an extension can be given and where each value stands, as its own
   * setup says it — kept until the extensions are read again.
   *
   * Asking costs something: where a credential is kept is answered by the
   * keychain, which is a program started. Doing that for every extension on
   * every frame is how a window that redraws on each keystroke ends up
   * running `security` a hundred times a minute, and the answer only ever
   * changes when Tade reloads the extensions — which is where it is dropped.
   */
  private setupShown = new Map<string, { configurable: boolean; fields: HostSetupField[] }>()

  private setupView(name: string): { configurable: boolean; fields: HostSetupField[] } {
    const had = this.setupShown.get(name)
    if (had) return had
    const setup = this.opts.extensions?.setupOf(name) ?? null
    const view = { configurable: setup !== null, fields: setup?.fields ?? [] }
    this.setupShown.set(name, view)
    return view
  }

  /**
   * The MCP servers nobody has decided about: the catalogue row, with what
   * each one is for and what turning it on would need. A server somebody has
   * decided about is a row of its own among the extensions instead, because a
   * live source of tools belongs beside the others.
   */
  private serverOffers(): McpServerOffer[] {
    return this.mcpShown
      .filter((server) => !server.decided)
      .map((server) => ({
        name: server.name,
        title: server.title,
        description: server.description,
        workflow: server.workflow,
        how: server.how,
        needs: server.problem,
        install: server.install,
        note: server.note,
        fetches: server.fetches,
      }))
  }

  /**
   * A server somebody has decided about, as a row among the extensions.
   *
   * One that is on and working is already one — the broker made an extension
   * of it and the host loaded it — so this is the rest: the ones turned off,
   * and the ones turned on that cannot work yet. It says only what is true of
   * a server nothing has connected to, which is what it is and what it needs.
   */
  private serverViews(loaded: readonly string[]): ExtensionView[] {
    return this.mcpShown
      .filter((server) => server.decided && !loaded.includes(`mcp-${server.name}`))
      .map((server) => ({
        name: `mcp-${server.name}`,
        title: server.title,
        description: server.description,
        // Its own words about how it is used are the catalogue's, and it was
        // never imported, so there is nothing else to say.
        workflow: server.on ? server.workflow : [],
        source: 'mcp' as const,
        state: server.on ? ('needs setup' as const) : ('off' as const),
        // A server that is on and workable is an extension by now, so one
        // that is on and here was left out — `--safe`, or a name Tade's own
        // took first. Either way it is said rather than left blank.
        problem: server.on
          ? (server.problem ?? `${server.name} is on, but nothing connected it in this window`)
          : server.problem,
        tools: [],
        actions: [],
        options: [],
        unknownSettings: [],
        configurable: false,
        folder: null,
        watches: [],
        server: serverFacts(server),
      }))
  }

  /**
   * The server a row is about, whether the row is the server itself or the
   * extension it became. Null when the row is not one.
   */
  private serverNamed(name: string): McpServerShown | null {
    const said = name.startsWith('mcp-') ? name.slice('mcp-'.length) : name
    return this.mcpShown.find((server) => server.name === said) ?? null
  }

  /**
   * What each server is and what it offered, read again.
   *
   * Asked when the page is opened and whenever the extensions are read again
   * — never per frame: what a server offered is a file on disk per server,
   * and a page that redraws four times a second must not read eleven of them
   * each time. It only changes when somebody changes a setting, which is
   * exactly where it is asked again.
   */
  private mcpShown: readonly McpServerShown[] = []

  private readServers(): void {
    this.mcpShown = this.opts.mcpServers?.(this.opts.config) ?? []
  }

  /**
   * Turn a server on or off — which is a setting, and a person's alone.
   *
   * Taking a capability away may be immediate and giving one may not: turning
   * one off drops it from what is offered at once, and turning one on
   * connects the next time Tade starts, because a client dialling into a
   * half-configured server inside a running window is the evening lost.
   */
  private async turnServer(name: string, on: boolean): Promise<string> {
    writeSetting(this.configPath, `mcp.servers.${name}.enabled`, on)
    await this.reloadExtensions()
    const server = this.serverNamed(name)
    const needs = on && server?.problem ? `, and needs setting up: ${server.problem}` : ''
    return on
      ? `${name} is on — it connects the next time Tade starts, and its tools are offered to every agent and the orchestrator${needs}`
      : `${name} is off — its tools stop being offered`
  }

  /** The extensions, as the panel shows them. */
  private extensionViews(): ExtensionView[] {
    const offers = this.opts.extensions?.watches() ?? []
    const project = this.state.project
    const schedules = this.opts.client.schedules()
    const servers = this.mcpShown
    const loaded = this.opts.extensions?.list() ?? []
    return [
      ...loaded.map((one) => ({
        name: one.name,
        title: one.title,
        description: one.description,
        workflow: one.workflow,
        source: one.source,
        state: one.state,
        problem: one.problem,
        tools: one.tools.map((tool) => ({
          name: tool.name,
          summary: toolSummary(tool.description),
          for: tool.for,
        })),
        actions: one.actions.map((action) => ({ id: action.id, title: action.title })),
        options: this.setupView(one.name).fields.map((field) => ({
          key: field.key,
          label: field.label,
          value: field.value,
          have: field.have,
          secret: field.kind === 'secret',
        })),
        unknownSettings: one.unknownSettings,
        configurable: this.setupView(one.name).configurable,
        folder: one.source === 'yours' ? one.path : null,
        watches: offers
          .filter((offer) => offer.extension === one.name)
          .map((offer) => ({
            id: offer.id.slice(one.name.length + 1),
            title: offer.title,
            means: offer.means,
            every: offer.every,
            project,
            on:
              schedules.find(
                (each) =>
                  each.project === project &&
                  each.does.kind === 'watch' &&
                  each.does.watch === offer.id,
              )?.id ?? null,
          })),
        // What is true of a server and of nothing else, for a row that is one.
        ...(one.source === 'mcp'
          ? { server: serverFacts(servers.find((each) => `mcp-${each.name}` === one.name)) }
          : {}),
      })),
      ...this.serverViews(loaded.map((one) => one.name)),
    ]
  }

  /**
   * Turn a watch on in a project, as you: a schedule named for the watch, or
   * for the watch and the project when it is already on somewhere else, looking
   * as often as the watch says. Said in a line: when it looks, and what it waits
   * for when its extension cannot look yet.
   */
  private async turnOnWatch(watch: string, project: string): Promise<string> {
    const offer = this.opts.extensions?.watches().find((one) => one.id === watch)
    if (!offer) throw new Error(`there is no watch called ${watch}`)
    const elsewhere = this.opts.client
      .schedules()
      .some((one) => one.id === scheduleIdOf(offer.title) && one.project !== project)
    const name = elsewhere ? `${offer.title} in ${project}` : offer.title
    await this.schedules.set({ name, project, said: '', watch, by: 'you' })
    const view = this.schedules.views().find((one) => one.id === scheduleIdOf(name))
    const first = view?.next[0]
    const when = first === undefined ? '' : `, first at ${whenShort(first, this.now())}`
    const yet = offer.problem ? `; it cannot look yet: ${offer.problem}` : ''
    return `${name} is on in ${project}: it looks ${view?.when ?? `every ${offer.every}`}${when}${yet}`
  }

  /** Something pressed in the Extensions panel. */
  private async fromExtensions(panel: ExtensionsPanel, choice: string): Promise<void> {
    const [verb, ...rest] = choice.split(':')
    const name = rest[0] ?? ''
    const host = this.opts.extensions
    const stay = (said: string | null) => {
      this.state = { ...this.state, panel: { ...panel, busy: false, said } }
      this.draw()
    }
    try {
      switch (verb) {
        case 'action':
          this.state = { ...this.state, panel: null }
          await this.runExtension(name, rest[1] ?? '')
          return
        case 'setup':
          this.openSetup(name)
          return
        case 'folder': {
          const folder = host?.list().find((one) => one.name === name)?.path
          if (folder) await this.reveal(folder, true)
          return stay(null)
        }
        case 'watch': {
          const project = this.state.project
          if (!project) return stay('Open a project to watch it')
          return stay(await this.turnOnWatch(`${name}.${rest[1] ?? ''}`, project))
        }
        case 'watching':
          this.state = openSchedule({ ...this.state, panel: null }, name)
          this.draw()
          return
        // A server nobody had decided about, turned on from the catalogue.
        case 'server':
          return stay(await this.turnServer(name, true))
        // The line that installs a server's program, run where you can watch
        // it: Tade never installs anything itself.
        case 'install': {
          const line = this.serverNamed(name)?.install
          if (!line) return stay(null)
          this.state = { ...this.state, panel: null }
          await this.machine.watchCommand('install', line)
          return
        }
        case 'toggle': {
          // One switch, and for a server it is its own: `extensions.<it>` is
          // not a second question, because a server's extension is only ever
          // handed over when the server is already on.
          const server = this.serverNamed(name)
          if (server) return stay(await this.turnServer(server.name, !server.on))
          const was = host?.list().find((one) => one.name === name)
          const tool = was ? null : this.writtenViews().find((one) => one.name === name)
          if (!was && !tool) return stay(null)
          const on = was ? was.state === 'off' : tool?.on !== true
          // Written down either way: one of Tade's own is on unless it says
          // otherwise, and one of yours is off until it says so.
          writeSetting(this.configPath, `extensions.${name}.enabled`, on)
          await this.reloadExtensions()
          if (tool) {
            // Nothing is loaded mid-session, so say when it takes effect.
            return stay(
              on
                ? `${name} is on — it loads the next time Tade starts`
                : `${name} is off — it stops loading the next time Tade starts`,
            )
          }
          const now = host?.list().find((one) => one.name === name)
          const later =
            now?.state === 'off' && now.problem?.startsWith('turned on') ? ` — ${now.problem}` : ''
          return stay(
            on
              ? `${was?.title ?? name} is on${later}${now?.state === 'needs setup' ? `, and needs setting up: ${now.problem}` : ''}`
              : `${was?.title ?? name} is off`,
          )
        }
        case 'read': {
          const tool = this.writtenViews().find((one) => one.name === name)
          if (!tool) return stay(null)
          this.state = { ...this.state, panel: null }
          await this.openPlace({ path: tool.path })
          return
        }
        default:
          return stay(null)
      }
    } catch (err) {
      stay(why(err))
    }
  }

  /**
   * Read the config again and let the extensions take it. The orchestrator is
   * started again when what it can call changed, so a turned-on extension is
   * one it can use now, not after a restart.
   */
  private async reloadExtensions(): Promise<void> {
    const host = this.opts.extensions
    if (!host) return
    const before = host
      .specs('orchestrator')
      .map((one) => one.name)
      .join()
    const loaded = await loadConfig(this.configPath)
    if (!loaded.ok) throw new Error(loaded.issues[0]?.message ?? 'the config would not load')
    this.useConfig(loaded.config)
    await host.reconfigure(loaded.config.extensions)
    // What each one can be given, and where its key is, is asked again: this
    // is the one thing that changes it. The servers with them, since turning
    // one on is a setting in the same file.
    this.setupShown.clear()
    this.readServers()
    this.linkers = host.linkers()
    if (
      host
        .specs('orchestrator')
        .map((one) => one.name)
        .join() !== before
    ) {
      void this.opts.restartThinker?.()
    }
  }

  /**
   * What extensions keep in the status bar, asked every few seconds and never
   * waited on: the tick goes on drawing while they answer, and an open view is
   * asked again with them so it stays current.
   */
  private askExtensions(): void {
    const host = this.opts.extensions
    const tade = this.opts.extensionWorkbench
    if (!host || !tade || this.asking || this.now() - this.statusedAt < STATUS_MS) return
    this.asking = true
    this.statusedAt = this.now()
    const panel = this.state.panel
    void host
      .statuses(tade)
      .then(async (found) => {
        this.statuses = found.map((one) => ({
          extension: one.extension,
          text: one.item.text,
          tone: one.item.tone ?? 'quiet',
          viewable: one.viewable,
        }))
        if (panel?.kind === 'extension-view') await this.refreshExtensionView(panel.extension)
        // The sections extensions keep in the sidebar, on the same beat: the
        // host answers each from its own cache and asks nobody oftener than
        // that section says, so this costs a function call most times.
        this.listSections = await host.lists(tade).catch(() => this.listSections)
        this.draw()
      })
      .catch(() => {})
      .finally(() => {
        this.asking = false
      })
  }

  /** Ask an extension for its view again, and show it if its panel is still open. */
  private async refreshExtensionView(name: string): Promise<void> {
    const host = this.opts.extensions
    const tade = this.opts.extensionWorkbench
    if (!host || !tade) return
    try {
      const view = await host.view(name, tade)
      this.extensionShown = { name, ...view, at: this.now() }
    } catch (err) {
      this.extensionShown = { name, title: name, markdown: why(err), at: this.now() }
    }
    if (this.state.panel?.kind === 'extension-view') this.draw()
  }

  /** Set an extension up, or change its settings, in a panel. */
  private openSetup(name: string): void {
    const setup = this.opts.extensions?.setupOf(name)
    if (!setup) return
    this.setupChoices = {}
    this.state = { ...this.state, panel: extensionSetupPanel(name, setup.fields) }
    this.draw()
    // What a field offers — the organizations a token can see — is looked up
    // once the panel is open, rather than making it wait.
    for (const field of setup.fields.filter((one) => one.offers)) {
      void this.opts.extensions?.choices(name, field.key).then((choices) => {
        this.setupChoices = { ...this.setupChoices, [field.key]: choices }
        this.draw()
      })
    }
  }

  /** The setup panel's facts: the extension as it stands, and what its fields offer. */
  private setupFacts(panel: ExtensionSetupPanel): NonNullable<PanelContext['setup']> | null {
    const host = this.opts.extensions
    const setup = host?.setupOf(panel.extension)
    const loaded = host?.list().find((one) => one.name === panel.extension)
    if (!setup || !loaded) return null
    return {
      title: loaded.title,
      state: loaded.state,
      problem: loaded.problem,
      guide: setup.guide,
      links: setup.links,
      fields: setup.fields.map((field) => ({
        key: field.key,
        label: field.label,
        help: field.help,
        placeholder: field.placeholder,
        kind: field.kind,
        choices: this.setupChoices[field.key] ?? [],
        ...(field.have ? { have: field.have } : {}),
      })),
    }
  }

  /** Save what was typed into the setup panel, and say whether it works now. */
  private async saveSetup(panel: ExtensionSetupPanel): Promise<void> {
    const host = this.opts.extensions
    const setup = host?.setupOf(panel.extension)
    if (!host || !setup) return
    const before = readFileSync(this.configPath, 'utf8')
    try {
      const kept: string[] = []
      for (const field of setup.fields) {
        const typed = panel.values[field.key] ?? ''
        if (field.kind === 'secret') {
          // Never into the config. A key goes to the keychain, or to Tade's
          // own 0600 file, and an empty field that had nothing in it is left
          // alone rather than forgetting what is already kept.
          if (typed.trim() === '') continue
          const saved = host.saveSecret(panel.extension, field.key, typed)
          kept.push(
            saved.beaten
              ? `${field.label} is in ${saved.where}, but ${saved.beaten} is set and wins`
              : `${field.label} is in ${saved.where}`,
          )
          continue
        }
        const value = settingFrom(typed, field.kind)
        writeSetting(
          this.configPath,
          `extensions.${panel.extension}.${field.key}`,
          value as Parameters<typeof writeSetting>[2],
        )
      }
      await this.reloadExtensions()
      const now = host.list().find((one) => one.name === panel.extension)
      const said = [
        now?.state === 'ready' ? `Saved. ${now.title} is ready.` : kept.length > 0 ? 'Saved.' : '',
        ...kept,
      ]
        .filter((line) => line !== '')
        .join(' ')
      this.state = {
        ...this.state,
        panel: {
          ...panel,
          busy: false,
          // What was typed is gone from the panel the moment it is kept:
          // nothing holds a key in memory for the next repaint to draw.
          values: Object.fromEntries(
            Object.entries(panel.values).map(([key, value]) => [
              key,
              setup.fields.find((one) => one.key === key)?.kind === 'secret' ? '' : value,
            ]),
          ),
          error: now?.state === 'ready' ? null : (now?.problem ?? null),
          said: said === '' ? null : said,
        },
      }
    } catch (err) {
      writeFileSync(this.configPath, before)
      this.state = { ...this.state, panel: { ...panel, busy: false, error: why(err) } }
    }
    this.draw()
  }

  /**
   * Show extension tools running in the conversation: yours from start to
   * answer, and how the orchestrator's are getting on while they run. An
   * agent's are shown in its own pane, by its harness.
   */
  private watchExtensions(): void {
    this.opts.extensions?.onRun((run) => {
      const at = this.now()
      let transcript = this.state.transcript
      // An agent running its project's checks is a run somebody may be
      // watching on its ACTIONS tab: look often while it goes, the same as
      // for the button here.
      if (run.tool === 'checks_run' && run.caller.kind === 'agent' && run.state !== 'ok') {
        this.live?.hurryUp(run.caller.task)
      }
      if (run.caller.kind === 'agent') return
      if (run.caller.kind === 'you') {
        if (run.state === 'running') transcript = ran(transcript, run, at)
        if (run.state === 'ok' || run.state === 'failed') {
          transcript = fromThinker(
            transcript,
            {
              type: 'tool_done',
              id: run.id,
              ok: run.state === 'ok',
              text: run.state === 'ok' ? '' : run.text,
            },
            at,
          )
          if (run.state === 'ok') transcript = said(transcript, run.text, at)
        }
      }
      if (run.state === 'progress') {
        transcript = fromThinker(transcript, { type: 'progress', id: run.id, text: run.text }, at)
      }
      this.state = this.anchored(withTranscript(this.state, transcript))
      this.draw()
    })
  }

  /** Run one of an extension's actions for the project you are in, in front of you. */
  private async runExtension(name: string, id: string): Promise<void> {
    const host = this.opts.extensions
    const found = host?.actions().find((one) => one.extension.name === name && one.action.id === id)
    if (!host || !found) {
      this.state = notice(this.state, `no extension action ${name}:${id}`)
      this.draw()
      return
    }
    const { action } = found
    const project = this.state.project
    if (action.project && !project) {
      this.state = notice(this.state, 'open a project first: this works on one')
      this.draw()
      return
    }
    this.state = {
      ...this.state,
      bottom: ORCHESTRATOR_TAB,
      bottomMode: this.state.bottomMode === 'min' ? 'open' : this.state.bottomMode,
    }
    this.draw()
    await host
      .call(
        action.tool,
        { ...(action.input ?? {}), ...(action.project && project ? { project } : {}) },
        {
          caller: { kind: 'you' },
          id: `you-${++this.ranCount}`,
          tade: this.opts.extensionWorkbench ?? null,
        },
      )
      // Shown by the run itself: a failure's reason is already on its line.
      .catch(() => {})
  }

  /**
   * Open a row an extension keeps in the sidebar: it runs the tool the row
   * names, in the conversation, and the answer lands where everything else
   * an extension says does.
   */
  private async openListRow(section: string, id: string): Promise<void> {
    const host = this.opts.extensions
    const row = this.listSections
      .find((one) => one.id === section)
      ?.rows.find((one) => one.id === id)
    if (!host || !row) return
    if (!row.opens) {
      const link = row.links?.[0]
      if (link) await this.openLink(link.url)
      return
    }
    this.state = {
      ...this.state,
      bottom: ORCHESTRATOR_TAB,
      bottomMode: this.state.bottomMode === 'min' ? 'open' : this.state.bottomMode,
    }
    this.draw()
    await host
      .call(row.opens.tool, row.opens.input ?? {}, {
        caller: { kind: 'you' },
        id: `you-${++this.ranCount}`,
        tade: this.opts.extensionWorkbench ?? null,
      })
      .catch(() => {})
  }

  /**
   * Something said that an extension listens for, run as its button would be;
   * the answer lands in the transcript, and its first sentence is the reply.
   */
  private async heardByExtension(said: string): Promise<string | null> {
    const host = this.opts.extensions
    const found = host?.heard(said)
    if (!host || !found) return null
    const project = this.state.project
    if (found.action.project && !project) return 'Open a project first: that works on one.'
    try {
      const answer = await host.call(
        found.action.tool,
        { ...(found.action.input ?? {}), ...(found.action.project && project ? { project } : {}) },
        {
          caller: { kind: 'you' },
          id: `you-${++this.ranCount}`,
          tade: this.opts.extensionWorkbench ?? null,
        },
      )
      return answer.said ?? spokenLine(answer.text)
    } catch (err) {
      return why(err)
    }
  }

  /**
   * The brief, on demand: what is stopped, what is moving, and what the
   * extensions found — with what to ask about each offered to click. Returned
   * as it would be said, for a surface that speaks it.
   */
  private async brief(): Promise<string> {
    const tasks = (this.live?.tasks ?? []).map((task) => ({
      task: task.task,
      state: task.state,
      waiting: task.approval?.summary ?? null,
      reason: '',
    }))
    const found = (await this.opts.extensions?.brief().catch(() => null)) ?? {
      items: [],
      problems: [],
    }
    const composed = composeBrief(tasks, {
      localHour: new Date(this.now()).getHours(),
      extras: found.items.map((item) => item.said),
    })
    const at = this.now()
    let transcript = said(this.state.transcript, composed.spoken, at)
    for (const item of found.items) {
      if (item.ask) transcript = suggest(transcript, item.said, item.ask, at)
    }
    this.state = withTranscript({ ...this.state, bottom: ORCHESTRATOR_TAB }, transcript)
    if (found.problems.length > 0) this.state = notice(this.state, found.problems.join(' · '))
    this.draw()
    return composed.spoken
  }

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
   * `tade skills` and the next brief. Nothing is said out loud.
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
      // must not make Tade ask again about the same task every two seconds.
      await this.opts.client.log
        .append({ type: 'reflected', task, detail: { by: 'orchestrator' } })
        .catch(() => {})
      await this.tell(reflectionPrompt(task)).catch(() => {})
    }
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
   * Tell the orchestrator something now rather than with the next thing you
   * say: after the turn it is on, never across it. Sent in the middle of your
   * question, it used to be refused, and was lost.
   */
  private async tell(text: string): Promise<void> {
    const thinker = this.thinker
    if (!thinker) return
    const message = withNews(text, this.news, clockOf, 'Tade says:')
    this.news = []
    if (thinker.tell) await thinker.tell(message)
    else await thinker.ask(message)
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
      this.ensureAgent(name)
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
    const viewed = panel?.kind === 'file' && this.viewed?.file.path === panel.path
    const file = panel?.kind === 'file' ? this.fileBody(panel) : null
    return {
      entries: this.search.entries(),
      lines:
        this.state.panel?.kind === 'extension-view' ? this.extensionViewLines() : this.fileLines(),
      text: viewed ? (this.viewed?.text ?? []) : [],
      ...(file ? { body: file.rows, columns: file.columns } : {}),
      branches: this.branchRows,
      found: this.lanes.findMatches().length,
      rows:
        this.state.panel?.kind === 'open-project'
          ? this.openRowsFor(this.state.panel).map((view) => view.row)
          : [],
      choices: this.choices,
      items: this.menuItemsFor(this.state.panel),
      extensions: this.extensionViews(),
      written: this.state.panel?.kind === 'extensions' ? this.writtenViews() : [],
      harnessExtensions: this.harnessPieces,
      servers: this.serverOffers(),
      scrollable: this.extensionRoom().body,
      listRoom: this.extensionRoom().listRoom,
      setupFields:
        this.state.panel?.kind === 'extension-setup'
          ? (this.setupFacts(this.state.panel)?.fields ?? [])
          : [],
      models: this.state.panel?.kind === 'model' ? (this.pickerModels ?? this.models) : this.models,
      settings: this.settings.rows(),
      accountActions: accountActions(this.machine.accounts),
      updateActions: updateActions(this.machine.updates, this.machine.updatesBusy),
    }
  }

  /**
   * How much further each side of the Extensions panel could be scrolled, and
   * how many rows its list shows, laid out exactly as it is drawn. The panel
   * is what holds the scroll, so what its keys, its bars and the wheel may do
   * to it has to be measured against the same layout.
   */
  private extensionRoom(): { body: number; list: number; listRoom: number } {
    const panel = this.state.panel
    if (panel?.kind !== 'extensions') return { body: 0, list: 0, listRoom: 1 }
    return extensionsScrollable(
      panel,
      {
        skin: this.skin,
        extensions: this.extensionViews(),
        written: this.writtenViews(),
        harnessExtensions: this.harnessPieces,
        servers: this.serverOffers(),
        project: this.state.project,
        date: (at: number) => this.window.dateOf(at),
      },
      this.terminal.columns,
      this.terminal.rows,
    )
  }

  /** How many lines an extension's view has, as wide as its panel draws it. */
  private extensionViewLines(): number {
    const shown = this.extensionShown
    if (!shown) return 0
    const inner = Math.min(110, this.terminal.columns - 4) - 4
    return markdownLines(shown.markdown, inner, !this.skin.colour).length
  }

  /** How many lines the viewer has to scroll through, as it is showing the file now. */
  private fileLines(): number {
    const panel = this.state.panel
    if (panel?.kind !== 'file' || !this.viewed) return 0
    const viewing = this.viewingAt(this.terminal.columns)
    if (panel.edit) return panel.edit.lines.length
    return panel.formatted && viewing?.formatted
      ? viewing.formatted.length
      : this.viewed.source.length
  }

  /** The size of the viewer's body, for keeping the caret in it and for reading a click. */
  private fileBody(panel: FilePanel): { rows: number; columns: number } {
    return fileBodySize(
      this.terminal.columns,
      this.terminal.rows,
      this.fileLines(),
      panel.asking !== null,
    )
  }

  private get configPath(): string {
    return this.settings.path
  }

  private useConfig(config: Config): void {
    this.settings.use(config)
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
        return `added ${name} → ${root}, from the next time Tade starts`
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
    // Waiting on you is a decision to make: an agent idle at its prompt is not one.
    const blocked = wanted.filter((t) => markOf(t) === 'needs-you').length
    const working = wanted.filter((t) => markOf(t) === 'working').length
    const parts = [`${wanted.length} task${wanted.length === 1 ? '' : 's'}`]
    if (working > 0) parts.push(`${working} working`)
    parts.push(blocked > 0 ? `${blocked} waiting on you` : 'nothing blocked')
    return `${parts.join(', ')}.`
  }

  private draw(): void {
    if (!this.stopped && !this.borrowed) this.tui.requestRender()
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
    if (this.stopped || this.borrowed) return
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
