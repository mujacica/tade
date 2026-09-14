import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  type Component,
  Editor,
  getKeybindings,
  isKeyRelease,
  ProcessTerminal,
  parseKey,
  sliceByColumn,
  stripTerminalSequences,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
  type TuiInputListenerResult,
  type TuiMouseEvent,
  type TuiMouseEventResult,
  visibleWidth,
} from '@earendil-works/pi-tui'
import {
  type Config,
  composeBrief,
  DEFAULT_ATTENTION,
  describeWork,
  expandHome,
  HARNESS_CHOICES,
  type LaneId,
  loadConfig,
  needsReflection,
  orchestratorRoute,
  parseQuietHours,
  parseSetting,
  reflectionPrompt,
  resolveRoute,
  settingsOf,
  THINKING_LEVELS,
} from '@wilco/core'
import { type ExtensionHost, type ExtensionWorkbench, settingFrom } from '@wilco/extensions-core'
import { git } from '@wilco/status'
import {
  type AudioClip,
  type Recorder,
  type Recording,
  slugify,
  type Transcriber,
  VoiceSurface,
  type VoiceTerminals,
} from '@wilco/voice-core'
import { Speaker } from '@wilco/voice-tts'
import { matchingLines, type Workbench } from '@wilco/workbench'
import { type ParsedDiff, parseDiff } from './diff.ts'
import { chooseEditor, launch, openerFor, openerForLink } from './editor.ts'
import { grep, listFiles, type Match, type SearchRoot } from './finder.ts'
import {
  type Hit,
  hitAt,
  pressable,
  type ScrollArea,
  sameTarget,
  scrollAt,
  type Target,
} from './hits.ts'
import {
  asPaste,
  clipboardImage,
  clipboardState,
  filePaths,
  handOffFiles,
  imagePaths,
  isImagePath,
  pasted,
  readImage,
  shellQuote,
} from './images.ts'
import { appKey, checkTalkKey, keyCaps } from './keys.ts'
import { asRemembered, type LayoutPrefs, type RememberedWindow, resolveLayout } from './layout.ts'
import type { Linker } from './links.ts'
import { knownTasks, Live } from './live.ts'
import type { TaskSnapshot } from './model.ts'
import {
  type AppState,
  activeTerminal,
  addTurn,
  conversing,
  dragAgent,
  dropAgent,
  focusBy,
  focusNumber,
  focusTask,
  glyph,
  initialState,
  keyAction,
  laneShown,
  MARK_TONES,
  markOf,
  matchActions,
  nextWaiting,
  noteTyping,
  notice,
  ORCHESTRATOR_TAB,
  onEvent,
  parseCommand,
  projectNumber,
  projects,
  removeAttachment,
  resizeTo,
  scrollSidebar,
  scrollTranscript,
  searchKey,
  selectProject,
  setDictation,
  setHeld,
  setListening,
  setQuestion,
  shownName,
  showOrchestrator,
  showTerminal,
  splitPane,
  splitRatio,
  splitShown,
  startHistorySearch,
  swapSplit,
  terminalSplitShown,
  toggleFolder,
  toggleSection,
  turnSplit,
  typingLane,
  unsplitPane,
  viewLane,
  whichProject,
  withProjects,
  withTasks,
  withTerminals,
  withTranscript,
} from './model.ts'
import { fileViewSize, type OpenRowView, type PanelContext } from './panel-view.ts'
import {
  type BranchRow,
  branchMenuItems,
  branchPanel,
  type Choice,
  type ConfirmRemovePanel,
  changeMenuItems,
  confirmRemovePanel,
  diffPanel,
  type ExtensionSetupPanel,
  type ExtensionsPanel,
  type ExtensionView,
  extensionControls,
  extensionSetupPanel,
  extensionsPanel,
  extensionViewPanel,
  fileMenuItems,
  filePanel,
  findPanel,
  harnessMenuItems,
  imageMenuItems,
  laneMenuItems,
  type MenuSubject,
  type ModelPanel,
  menuItems,
  menuPanel,
  modelPanel,
  nameFrom,
  noteMenuItems,
  type OpenProjectPanel,
  type OpenRow,
  openProjectPanel,
  type Panel,
  type PanelInputs,
  type PanelOutcome,
  type PromptPanel,
  type ProposalView,
  panelClick,
  panelKey,
  promptPanel,
  type SettingsPanel,
  searchPanel,
  settingsPanel,
  spendPanel,
  terminalMenuItems,
  thinkingMenuItems,
} from './panels.ts'
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
import { initialRouter, pending, type RouterState, route } from './router.ts'
import { runScreen, ScreenCancelled, type Ui } from './screen.ts'
import { parseOpenId, parseQuery, type SearchEntry, searchResults, TEXT_MIN } from './search.ts'
import { addProject, editSettings, writeSetting } from './settings.ts'
import { PLAIN, pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { spendView as spendViewOf } from './spend.ts'
import {
  fromThinker,
  problem,
  ran,
  said,
  suggest,
  type ThinkerEvent,
  thinking,
  youSaid,
} from './transcript.ts'
import { transcriptLines } from './transcript-view.ts'
import { draw, type Frame } from './view.ts'
import {
  formattable,
  formattedLines,
  markdownLines,
  readForView,
  sourceLines,
  type ViewedFile,
} from './viewer.ts'

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
/** How much of what you said up and ctrl+r reach back through. */
const HISTORY_MAX = 1_000
/** How often extensions are asked what they keep in the status bar. */
const STATUS_MS = 5_000
/** How often the clipboard is looked at for a picture, while the orchestrator's line is open. */
const CLIPBOARD_MS = 3_000

/** A stuck key must not record until the disk is full. */
const MAX_SPEECH_MS = 120_000

/** Backspace, and what some terminals send instead. */

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
  | { kind: 'wheel'; area: ScrollArea; rows: number }
  /** A divider taken hold of, dragged to a cell, and let go. */
  | { kind: 'grab'; edge: 'sidebar' | 'bottom' | 'split' | 'terminal-split' }
  | { kind: 'drag'; x: number; y: number }
  /** An agent dragged along the list: it would land at place `to` if let go now. */
  | { kind: 'reorder'; task: string; to: number }

/** An agent taken hold of in the list: which, where, and where each agent's row was then. */
interface HeldAgent {
  task: string
  y: number
  /** It has left the row it was pressed on: this is a drag, not a click. */
  moved?: boolean
  /** Every agent's own row, top to bottom, as drawn when it was pressed. */
  rows: readonly { task: string; row: number }[]
}

/**
 * Take hold of an agent in the list. The rows are read once, from what was on
 * screen when it was pressed: the list redraws in its new order as the agent
 * is dragged, and measuring against that would move the place being aimed at.
 * An agent's own row is the one with its name on it — narrower than the row,
 * where the band's half-rows around it are the whole width.
 */
export function heldAgent(hits: readonly Hit[], task: string, y: number): HeldAgent {
  const rows = new Map<string, number>()
  const widths = new Map<number, number>()
  for (const hit of hits) widths.set(hit.row, Math.max(widths.get(hit.row) ?? 0, hit.to + 1))
  for (const hit of hits) {
    if (hit.target.kind !== 'task') continue
    const narrow = hit.to - hit.from + 1 < (widths.get(hit.row) ?? 0)
    if (narrow && !rows.has(hit.target.task)) rows.set(hit.target.task, hit.row)
  }
  return {
    task,
    y,
    rows: [...rows].map(([one, row]) => ({ task: one, row })).sort((a, b) => a.row - b.row),
  }
}

/**
 * Where a dragged agent would land with the pointer on row `y`: at the place
 * of the agent whose row is nearest, and between two, at the one it is moving
 * towards.
 */
export function placeAt(held: HeldAgent, y: number): number {
  let best = 0
  let distance = Number.POSITIVE_INFINITY
  held.rows.forEach(({ row }, i) => {
    const away = Math.abs(row - y)
    const closer = away < distance || (away === distance && y > held.y)
    if (closer) {
      best = i
      distance = away
    }
  })
  return best
}

class Window implements Component {
  private readonly frame: (width: number) => { state: AppState; frame: Frame }
  private readonly onPointer: (event: PointerEvent) => boolean
  private readonly onCopy: (text: string) => void
  private hits: readonly Hit[] = []
  private rows: readonly string[] = []
  /** A divider is held: every movement until it is let go is a drag. */
  private dragging = false
  /** An agent pressed in the list, and where every agent's row was when it was. */
  private held: HeldAgent | null = null
  /**
   * Text being selected by dragging over it. The window reports the mouse, so
   * the terminal cannot select for itself: dragging anywhere that is not a
   * control selects here instead, and letting go copies it.
   */
  private selection: { from: Cell; to: Cell; moved: boolean } | null = null

  constructor(
    frame: Window['frame'],
    onPointer: (event: PointerEvent) => boolean,
    onCopy: (text: string) => void,
  ) {
    this.frame = frame
    this.onPointer = onPointer
    this.onCopy = onCopy
  }

  render(width: number): string[] {
    const { state, frame } = this.frame(width)
    const drawn = draw(state, frame)
    this.hits = drawn.hits
    this.rows = drawn.rows
    const chosen = this.selection?.moved ? ordered(this.selection) : null
    return chosen ? highlighted(drawn.rows, chosen, width) : drawn.rows
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const target = hitAt(this.hits, event.x, event.y)
    switch (event.type) {
      case 'move':
      case 'drag':
        if (this.dragging) {
          return { handled: true, render: this.onPointer({ kind: 'drag', x: event.x, y: event.y }) }
        }
        // Once it has moved off its row it follows the pointer anywhere, back home included.
        if (event.type === 'drag' && this.held && (this.held.moved || event.y !== this.held.y)) {
          this.held = { ...this.held, moved: true }
          const to = placeAt(this.held, event.y)
          return {
            handled: true,
            render: this.onPointer({ kind: 'reorder', task: this.held.task, to }),
          }
        }
        if (event.type === 'drag' && this.selection) {
          this.selection = { ...this.selection, to: { x: event.x, y: event.y }, moved: true }
          return { handled: true, render: true }
        }
        return { handled: true, render: this.onPointer({ kind: 'move', target }) }
      case 'press':
        // A divider taken hold of keeps every movement until it is let go.
        if (event.button === 'left' && target?.kind === 'divider') {
          this.dragging = true
          return { capture: true, render: this.onPointer({ kind: 'grab', edge: target.edge }) }
        }
        // A right-click is a click the moment it is pressed: the terminal
        // reports no click for it, and a menu should not wait for a release.
        if (event.button === 'right' && target) {
          this.onPointer({ kind: 'click', target, button: 'right', x: event.x, y: event.y })
          return { handled: true }
        }
        if (event.button !== 'left') return undefined
        // An agent pressed may be about to be dragged somewhere else in the list.
        this.held = target?.kind === 'task' ? heldAgent(this.hits, target.task, event.y) : null
        // Anywhere that is not a control is text you might select.
        this.selection = pressable(target)
          ? null
          : { from: { x: event.x, y: event.y }, to: { x: event.x, y: event.y }, moved: false }
        return {
          handled: target !== null || this.selection !== null,
          render: this.onPointer({ kind: 'press', target }) || true,
        }
      case 'release': {
        this.dragging = false
        this.held = null
        const chosen = this.selection?.moved ? ordered(this.selection) : null
        if (chosen) {
          const text = selectedText(this.rows, chosen)
          if (text.trim() !== '') this.onCopy(text)
        }
        // Kept lit until the next press, so you can see what was copied.
        if (!chosen) this.selection = null
        return { handled: true, render: this.onPointer({ kind: 'release' }) || chosen !== null }
      }
      case 'click':
        if (!target || (event.button !== 'left' && event.button !== 'right')) return undefined
        this.onPointer({ kind: 'click', target, button: event.button, x: event.x, y: event.y })
        return { handled: true }
      case 'wheel': {
        const area = scrollAt(this.hits, event.x, event.y)
        if (!area || !event.wheelDelta) return undefined
        return {
          handled: true,
          render: this.onPointer({ kind: 'wheel', area, rows: Math.sign(event.wheelDelta) * 3 }),
        }
      }
      default:
        return undefined
    }
  }

  invalidate(): void {
    // Nothing is cached: every frame is drawn from the state as it is.
  }
}

/**
 * Where free text goes: the orchestrator, seen from the window. Answers come
 * back from `ask`; everything it does on the way arrives through `onEvent`,
 * so the conversation can be watched rather than waited on.
 */
export interface Thinker {
  ask(text: string, images?: readonly WorkerImageFile[]): Promise<string>
  onEvent?(listener: (event: ThinkerEvent) => void): () => void
}

/** A picture to send with what you said: where it is, and what kind. */
export interface WorkerImageFile {
  path: string
  data: string
  mimeType: string
}

export interface AppOptions {
  client: Workbench
  config: Config
  /** The system clipboard's pictures: what is there, and saving it. The machine's own unless given. */
  clipboard?: {
    state: typeof clipboardState
    image: typeof clipboardImage
  }
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
  thinker?: Thinker
  /**
   * The models an agent can be started on, from the harness's own catalog.
   * Passed in, so the window does not have to know which harness it is.
   */
  models?: () => Promise<{ id: string; provider: string; name: string }[]>
  /** Providers the harness is signed in to. */
  accounts?: () => Promise<string[]>
  /** How each provider with credentials is paid for: signed in, or a key. */
  credentials?: () => Promise<Record<string, 'signed-in' | 'api-key' | 'env-key'>>
  /** The command that runs the harness interactively, for signing in. */
  signIn?: () => { command: string; args: string[] }
  /** The extensions this window runs with: their actions, their answers, their brief. */
  extensions?: ExtensionHost
  /** What the window lets an extension do: start an agent on something. */
  extensionWorkbench?: ExtensionWorkbench
  /**
   * Start the orchestrator again, on what the config now says, carrying on its
   * conversation. Without it, a new model applies when Wilco next starts.
   */
  restartThinker?: () => Promise<void>
  /**
   * Restart the window with the same arguments so changes can be tried live.
   * The callback should stop the app, release the home lock, and re-exec.
   */
  reloadWindow?: () => Promise<void>
  /** What Wilco wrote for itself and is waiting on you: to list, and to decide. */
  proposals?: {
    list(): ProposalView[]
    decide(name: string, verdict: 'approve' | 'reject'): Promise<string>
  }
  /** Extensions the harness loads by itself, which Wilco lists but does not run. */
  harnessExtensions?: () => Promise<{ name: string; where: string }[]>
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
  /** The size each lane was last made, so resizing happens once per change. */
  private readonly fitted = new Map<string, string>()
  private titled = ''
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
  /** The lanes in front — the agent's, and the terminal's — watched so they redraw as they print. */
  private readonly watching = new Map<'pane' | 'terminal', { lane: string; stop: () => void }>()
  /** The terminal in front, as last captured. */
  private terminalScreen = ''
  /** A terminal's scrollback, read for finding in it. */
  private findText: { id: string; lines: string[] } | null = null
  private statuses: NonNullable<Frame['statuses']> = []
  /**
   * A picture on the clipboard, noticed while the orchestrator's line is open:
   * the copy offered, the copy already taken or turned down, and when it was
   * last looked at.
   */
  private clipboard: {
    offered: string | null
    seen: string | null
    askedAt: number
    asking: boolean
  } = { offered: null, seen: null, askedAt: Number.NEGATIVE_INFINITY, asking: false }
  /** The second half of a split pane, and of a split bottom panel, as last captured. */
  private splitScreen = ''
  private splitTerminalScreen = ''
  /** What you said to Wilco, oldest first. */
  private history: string[] = []
  /** pi's own editor, for the orchestrator's line. */
  private readonly editor: Editor
  private statusedAt = Number.NEGATIVE_INFINITY
  private asking = false
  private speakingTurn = false
  /** A look at the lanes is under way, and whether another was asked for meanwhile. */
  private looking = false
  private lookAgain = false
  private extensionShown: { name: string; title: string; markdown: string; at: number } | null =
    null
  /** What each terminal has printed, read when search opens. */
  private terminalTexts: { id: string; name: string; project: string; text: string }[] = []
  /** A command voice typed into a terminal, waiting for enter or "confirm". */
  private typed: { id: string; name: string; command: string } | null = null
  private soon: NodeJS.Timeout | null = null
  private screen = ''
  private recording: Recording | null = null
  /** The diff the diff panel is showing, once git has answered. */
  private diff: ParsedDiff | null = null
  /** The file the viewer is showing, its coloured source, and its Markdown laid out at a width. */
  private viewed: {
    file: ViewedFile
    source: string[]
    formatted: { width: number; lines: string[] } | null
  } | null = null
  /** Every file in every place search looks, and when they were listed. */
  private searchFiles: { at: number; files: { root: SearchRoot; path: string }[] } | null = null
  /** Lines found inside files, for the text they were found for. */
  private grepped: { text: string; matches: Match[] } = { text: '', matches: [] }
  private grepping: string | null = null
  private grepTimer: NodeJS.Timeout | null = null
  /** Search's results for the last query, so a redraw does not rank every file again. */
  private results: { key: string; entries: SearchEntry[] } | null = null
  /** The models an agent can be started on, once they have been read. */
  private models: { id: string; provider: string; name: string }[] = []
  /** Providers the harness is signed in to, once read. */
  private accounts: string[] = []
  /** How each provider is paid for, once read. */
  private credentials: Record<string, 'signed-in' | 'api-key' | 'env-key'> = {}
  /** The Open project list for the last folder and query, and the branches found for its rows. */
  private openCache: { key: string; rows: OpenRow[]; browsing: string | null } | null = null
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
  /** When the whole screen was last written over itself. */
  private repaintedAt = 0
  /** Extension actions you have run, for giving each its own line. */
  private ranCount = 0
  private release: (() => void) | null = null
  private stopped = false
  private settle: () => void = () => {}
  private readonly closed: Promise<void>

  private constructor(opts: AppOptions) {
    this.opts = opts
    if (opts.thinker) this.thinkWith(opts.thinker)
    this.terminal = opts.terminal ?? new ProcessTerminal()
    // Mouse reporting is on by default, which is what makes the window
    // clickable: events arrive at the component with coordinates local to it.
    this.tui = new TuiAltScreen(this.terminal)
    freeViewportKeys()
    const plain = (text: string) => text
    this.editor = new Editor(
      this.tui,
      {
        borderColor: plain,
        selectList: {
          selectedPrefix: plain,
          selectedText: plain,
          description: plain,
          scrollInfo: plain,
          noMatch: plain,
        },
      },
      { paddingX: 1 },
    )
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
        this.voice?.speakChunk(event.text)
      } else if (this.speakingTurn && event.type === 'message' && event.text) {
        this.voice?.speakMessage(event.text)
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
      this.opts.config = {
        ...this.opts.config,
        orchestrator: {
          ...this.opts.config.orchestrator,
          model: model.id,
          ...(model.provider ? { provider: model.provider } : {}),
        },
      }
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
    return handOffFiles(this.answering, cwd)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    for (const watched of this.watching.values()) watched.stop()
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
      const kept: RememberedWindow = {
        focused: this.state.focused,
        ...this.state.sizes,
        ...(Object.keys(this.state.order).length > 0 ? { order: this.state.order } : {}),
      }
      writeFileSync(this.memoryFile, `${JSON.stringify(kept, null, 2)}\n`)
    } catch {
      // Coming back to the same pane is a convenience, not a reason to fail
      // on the way out.
    }
  }

  /** The items of an open menu, from what is true of its subject now. */
  private menuItemsFor(panel: Panel | null) {
    if (panel?.kind !== 'menu') return []
    const subject = panel.subject
    const focused = this.state.panes.find((p) => p.task === this.state.focused)
    const agent = focused?.lane != null
    switch (subject.kind) {
      case 'task': {
        const pane = this.state.panes.find((p) => p.task === subject.task)
        return pane ? menuItems(pane, this.live?.changes(subject.task).length ?? 0) : []
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
        return thinkingMenuItems(subject.current)
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
    if (named && this.credentials[named]) return named
    const offering = this.models.filter((known) => known.id.endsWith(`/${model}`))
    return (
      offering.find((known) => this.credentials[known.provider])?.provider ??
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
        models: this.models,
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
        proposals: this.opts.proposals?.list() ?? [],
        extensions: this.extensionViews(),
        harnessExtensions: this.harnessPieces,
        extensionsRoot: tilde(expandHome(this.opts.config.orchestrator.extensions)),
      }
    }
    if (panel.kind === 'branch') return { branches: this.branchRows }
    if (panel.kind === 'find') {
      return {
        found: this.findMatches().length,
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
      return { entries: this.searchEntries(), searching: this.grepping !== null }
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
        const voice = this.opts.config.surfaces.voice
        // Muted is silence: not a word, not a sound.
        if ((name === 'speak' || name === 'earcon') && voice.muted) return async () => {}
        if (name === 'speak' && !voice.speak) return async () => {}
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
      screen: this.screen,
      layout: this.layout(),
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
        thinking: route.thinking ?? null,
        provider,
        credential: provider ? credentialLabel(this.credentials[provider]) : null,
      },
      vitals: live.vitals(this.state.focused),
      spendView,
      panel: this.panelFacts(live, width),
      voice: {
        keys: keyCaps(this.opts.config.surfaces.voice.talk.key),
        available: this.opts.recorder !== undefined,
      },
      terminal: { screen: this.terminalScreen, find: this.findView() },
      home: tilde(this.opts.home),
      linkers: this.linkers,
      orchestratorModel: this.thinkerModel(),
      orchestratorAccount: this.thinkerAccount(),
      splitScreen: this.splitScreen,
      splitTerminal: this.state.terminalSplit
        ? { screen: this.splitTerminalScreen, find: null }
        : undefined,
      bindings: this.opts.config.surfaces.window.keys,
      muted: this.opts.config.surfaces.voice.muted,
      clipboardImage: this.clipboard.offered !== null,
      extensionsNeedYou: (this.opts.extensions?.list() ?? []).filter(
        (one) => one.state === 'needs setup' || one.state === 'broken',
      ).length,
      ...this.inputFor(width),
      statuses: this.statuses,
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
      case 'wheel': {
        const panel = this.state.panel
        if (event.area === 'panel' && panel) {
          const key = event.rows > 0 ? 'down' : 'up'
          let outcome: PanelOutcome = { panel, submit: false }
          for (let i = 0; i < Math.abs(event.rows); i++) {
            if (!outcome.panel) break
            outcome = panelKey(outcome.panel, key, '', this.panelInputs())
          }
          this.state = { ...this.state, panel: outcome.panel }
          return true
        }
        if (event.area === 'sidebar' && !panel) {
          this.state = scrollSidebar(this.state, event.rows)
          return true
        }
        if ((event.area === 'pane' || event.area === 'terminal') && !panel) {
          // The wheel up reads back through what was printed.
          const which = event.area === 'pane' ? 'paneScroll' : 'terminalScroll'
          this.state = { ...this.state, [which]: Math.max(0, this.state[which] - event.rows) }
          this.soonTick()
          return true
        }
        if (event.area === 'transcript' && !panel) {
          // The wheel up reads back: further from the newest line.
          this.state = scrollTranscript(this.state, -event.rows, this.transcriptRows())
          return true
        }
        return false
      }
      case 'grab':
        this.state = { ...this.state, resizing: event.edge }
        return true
      case 'drag':
        if (!this.state.resizing) return false
        if (this.state.resizing === 'split' || this.state.resizing === 'terminal-split') {
          this.state = this.dragSplit(this.state.resizing, event)
          return true
        }
        this.state = resizeTo(this.state, event, { height: Math.max(6, this.terminal.rows) })
        return true
      case 'move': {
        if (sameTarget(this.state.hover, event.target)) return false
        const shapeOf = (target: Target | null) =>
          target?.kind === 'divider'
            ? target.edge === 'sidebar'
              ? 'ew-resize'
              : 'ns-resize'
            : pressable(target)
              ? 'pointer'
              : 'default'
        const was = shapeOf(this.state.hover)
        this.state = { ...this.state, hover: event.target }
        const now = shapeOf(event.target)
        // A hand over what can be pressed, arrows over what can be dragged,
        // where the terminal can show one.
        if (was !== now && this.pointerShapes) this.terminal.write(pointerSequence(now))
        return true
      }
      case 'press':
        if (!pressable(event.target)) return false
        this.state = { ...this.state, pressed: event.target }
        return true
      case 'reorder':
        this.state = dragAgent(this.state, event.task, event.to)
        return true
      case 'release':
        if (this.state.resizing) {
          // Where you let go is where it stays, this time and next.
          this.state = { ...this.state, resizing: null }
          this.remember()
          return true
        }
        if (this.state.reordering) {
          // So does an agent let go of in the list.
          this.state = { ...dropAgent(this.state), pressed: null }
          this.remember()
          return true
        }
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
  /** The config's sizes, then the ones you dragged the dividers to, then how the bottom is shown. */
  private layout(): LayoutPrefs {
    const window = this.opts.config.surfaces.window
    const sizes = this.state.sizes
    const sidebarWidth = sizes.sidebarWidth ?? window.sidebar_width
    const stripHeight = sizes.stripHeight ?? window.strip_height
    return {
      ...(sidebarWidth ? { sidebarWidth } : {}),
      ...(stripHeight ? { stripHeight } : {}),
      bottom: this.state.bottomMode,
      grow: conversing(this.state),
    }
  }

  private async begin(): Promise<void> {
    this.remembered = this.recall()
    const { sidebarWidth, stripHeight, order } = this.remembered ?? {}
    this.state = {
      ...this.state,
      sizes: { ...(sidebarWidth ? { sidebarWidth } : {}), ...(stripHeight ? { stripHeight } : {}) },
      order: order ?? {},
    }
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
      brief: () => this.brief(),
      extension: (said) => this.heardByExtension(said),
      tasks: async () => knownTasks(live.tasks),
      history: async () => live.history,
      ask: (text: string) => this.ask(text),
      terminals: this.voiceTerminals(),
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
        (text) => void this.copySelection(text),
      ),
    )
    this.release = this.tui.addInputListener((data) => this.onInput(data))
    this.tui.start()
    void this.loadHistory()
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
    // A picture dropped on the window arrives as its path, pasted. Where it
    // landed is not something a terminal says, so ask who it is for.
    const paste = pasted(data)
    if (paste !== null) {
      // A paste with nothing in it is a terminal pasting a clipboard that holds
      // only a picture: at the orchestrator, attach it; at pi, ctrl+v is how it
      // takes a picture off the clipboard itself.
      if (paste === '' && !(this.state.keyboard === 'terminal' && activeTerminal(this.state))) {
        const pane = this.state.panes.find((one) => one.task === this.state.focused)
        const lane = pane ? typingLane(this.state, pane) : null
        if (this.state.dictation !== null || !lane) void this.attachClipboard()
        else void this.opts.client.write(lane as LaneId, '\x16').catch(() => {})
        return { consume: true }
      }
      const paths = imagePaths(paste)
      const files = filePaths(paste)
      if (paths.length > 0 || files.length > 0) {
        this.askWhereImagesGo(paths.length > 0 ? paths : files)
        return { consume: true }
      }
      // Words pasted at the orchestrator's line are typed into it, on one line.
      if (
        this.state.dictation !== null ||
        (this.state.focused === null && !activeTerminal(this.state))
      ) {
        if (this.state.dictation === null) this.state = setDictation(this.state, '')
        this.syncLine()
        // As pi takes a paste: a long one becomes a marker, sent in full.
        this.editor.handleInput(`\x1b[200~${paste}\x1b[201~`)
        this.state = setDictation(this.state, this.editor.getText())
        this.draw()
        return { consume: true }
      }
    }
    // ctrl+v at the orchestrator's line takes a screenshot off the clipboard;
    // an agent or a shell reads its own clipboard, so there it passes through.
    if (data === '\x16' && (this.state.dictation !== null || this.state.focused === null)) {
      void this.attachClipboard()
      return { consume: true }
    }
    const kitty = kittyActive(this.terminal)
    const talk = this.opts.config.surfaces.voice.talk
    const key = appKey(data, {
      kitty,
      listening: this.state.listening,
      talk: talk.key,
      toggle: talk.mode === 'toggle',
      bindings: this.opts.config.surfaces.window.keys,
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
        // What you say goes to the orchestrator, so its tab comes to the front.
        if (this.state.bottom !== ORCHESTRATOR_TAB)
          this.state = { ...this.state, bottom: ORCHESTRATOR_TAB }
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
      case 'search':
        this.openSearch()
        return { consume: true }
      case 'orchestrator':
        this.state = {
          ...this.state,
          bottom: ORCHESTRATOR_TAB,
          dictation: this.state.dictation ?? '',
        }
        this.draw()
        return { consume: true }
      case 'run':
        void this.run(action.action)
        return { consume: true }
      case 'complete': {
        // Tab on a command being typed finishes it, as a shell would.
        const [best] = matchActions(this.state, this.state.dictation ?? '')
        if (best) {
          this.editor.setText(`${best.name} `)
          this.state = setDictation(this.state, `${best.name} `)
          this.draw()
        }
        return { consume: true }
      }
      case 'agent-number':
        this.state = focusNumber(this.state, action.n)
        this.draw()
        return { consume: true }
      case 'project-number':
        this.state = projectNumber(this.state, action.n)
        this.draw()
        return { consume: true }
      case 'quit':
        this.quit()
        return { consume: true }
      default:
        break
    }

    // A terminal with the keyboard gets every keystroke Wilco did not keep.
    const terminal = activeTerminal(this.state)
    if (terminal && this.state.keyboard === 'terminal' && this.state.dictation === null) {
      this.state = { ...this.state, terminalScroll: 0 }
      const split = terminalSplitShown(this.state)
      const into = split && this.state.splitFocus ? split.lane : terminal.id
      void this.opts.client.write(into as LaneId, data).catch(() => {})
      this.soonTick()
      return { consume: true }
    }
    // Dictating: the line is being typed, not the agent.
    if (this.state.dictation !== null) {
      this.type(data)
      return { consume: true }
    }
    // Nothing focused means the orchestrator is, and it is a thing you type
    // at: a window with no agents used to swallow every keystroke.
    if (
      this.state.focused === null &&
      (printable(data) || ['up', 'ctrl+r'].includes(parseKey(data) ?? ''))
    ) {
      this.state = setDictation(this.state, '')
      this.syncLine()
      this.type(data)
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
    // The path under GIT opens its folder; right-clicked, it is copied.
    if (button === 'right' && target.kind === 'action' && target.name === 'open-path') {
      void this.run('copy-path')
      return
    }
    // A right-click is the menu of whatever it is on, as it is everywhere else.
    if (button === 'right') {
      const subject = subjectOf(target)
      if (subject) {
        this.openMenu(subject, at)
        return
      }
    }
    switch (target.kind) {
      case 'task': {
        this.state = focusTask(this.state, target.task)
        const pane = this.state.panes.find((p) => p.task === target.task)
        // Clicking a task opens it. Resuming a session sends nothing to the
        // model, so this costs nothing until you type — which is what makes it
        // safe for a click, and not for tab, which passes over tasks on the
        // way to another.
        if (pane && !pane.lane && pane.state !== 'parked') void this.openAgent()
        break
      }
      case 'lane': {
        // The tab of the half beside it gives that half the keyboard; any other shows it in front.
        const split = this.state.splits[target.task]
        this.state =
          split?.lane === target.lane
            ? { ...focusTask(this.state, target.task), keyboard: 'pane', splitFocus: true }
            : { ...viewLane(this.state, target.task, target.lane), splitFocus: false }
        break
      }
      case 'task-menu':
        this.openMenu({ kind: 'task', task: target.task }, at)
        return
      case 'note':
        // A note cut short is read whole in its menu's title; the menu is what it offers.
        this.openMenu({ kind: 'note', at: target.at, text: target.text }, at)
        return
      case 'menu':
        this.openMenu(target.subject, at)
        return
      case 'branch':
        this.openMenu({ kind: 'branch' }, at)
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
      case 'bottom-tab':
        this.state =
          target.tab === ORCHESTRATOR_TAB
            ? showOrchestrator(this.state)
            : showTerminal(this.state, target.tab)
        break
      case 'terminal':
        // Clicking into a terminal is choosing to type there — in the half clicked.
        this.state = {
          ...this.state,
          keyboard: 'terminal',
          dictation: null,
          orchestratorDraft: this.state.dictation ?? this.state.orchestratorDraft,
          splitFocus: target.side === 'split',
        }
        break
      case 'pane':
        this.state = {
          ...this.state,
          keyboard: 'pane',
          dictation: null,
          orchestratorDraft: this.state.dictation ?? this.state.orchestratorDraft,
          splitFocus: target.side === 'split',
        }
        break
      case 'folder':
        this.state = toggleFolder(this.state, target.path)
        break
      case 'orchestrator':
        // The keyboard goes to the orchestrator's line; the agent you were
        // watching stays in view behind it, a click away.
        if (this.state.dictation === null) this.state = setDictation(this.state, '')
        break
      case 'file':
      case 'place':
        // Read here first; the viewer has the button for your editor.
        this.openFile(
          this.resolvePath(target.path),
          'line' in target ? (target.line ?? null) : null,
        )
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
      const task = action.slice('close-task:'.length)
      await this.stopAgent(task)
      return
    }
    if (action.startsWith('thinking:')) {
      const task = action.slice('thinking:'.length)
      const project = task.split('/')[0]
      const current =
        this.live?.vitals(task)?.thinking ??
        resolveRoute(this.opts.config, project ? { project } : {}).thinking ??
        null
      const menu = menuPanel({ kind: 'thinking', task, current }, 'Thinking', {
        row: 3,
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
      this.forgetNote({ at: at ?? '', text: text.join('\u0000') })
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
      case 'search':
        this.openSearch()
        return
      case 'mute':
        await this.toggleMute()
        return
      case 'attach-clipboard':
        await this.attachClipboard()
        return
      case 'dismiss-clipboard':
        this.clipboard.seen = this.clipboard.offered
        this.clipboard.offered = null
        this.draw()
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
        this.soonTick()
        return
      case 'terminal-end':
        this.state = { ...this.state, terminalScroll: 0 }
        this.soonTick()
        return
      case 'transcript-end':
        this.state = { ...this.state, transcriptScroll: 0 }
        this.draw()
        return
      case 'extensions':
        this.harnessPieces = (await this.opts.harnessExtensions?.().catch(() => [])) ?? []
        {
          // The keyboard starts on the first thing to run, not on turning it off.
          const controls = extensionControls(this.extensionViews(), this.opts.proposals?.list())
          const first = controls.findIndex((control) => control.startsWith('action:'))
          this.state = {
            ...this.state,
            panel: { ...extensionsPanel(), index: Math.max(0, first) },
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
      case 'open-agent':
        await this.openAgent()
        return
      case 'new-terminal':
        await this.openTerminal()
        return
      case 'find-terminal': {
        const terminal = activeTerminal(this.state)
        if (terminal) await this.openFind(terminal.id)
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
    this.viewed = { file, source: sourceLines(file, !this.skin.colour), formatted: null }
    this.state = { ...this.state, panel: filePanel(path, line, formattable(file)) }
    this.draw()
  }

  /** What the viewer draws, with Markdown laid out for the width it has now. */
  private viewingAt(width: number): NonNullable<Frame['panel']>['viewing'] {
    const viewed = this.viewed
    if (!viewed) return null
    if (!formattable(viewed.file))
      return { file: viewed.file, source: viewed.source, formatted: null }
    const room = fileViewSize(width, this.terminal.rows).width - 4
    if (viewed.formatted?.width !== room) {
      viewed.formatted = {
        width: room,
        lines: formattedLines(viewed.file, room, !this.skin.colour),
      }
    }
    return { file: viewed.file, source: viewed.source, formatted: viewed.formatted.lines }
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
      this.state = notice(this.state, 'open an agent first: a shell starts in its worktree')
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
    if (outcome.panel?.kind === 'search') this.lookInFiles()
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
        await this.savePrompt(panel)
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
      case 'open-project':
        await this.openProject(panel)
        break
      case 'search':
        await this.fromSearch(choice ?? '')
        return
      case 'file':
        if (choice === 'editor') {
          this.state = { ...this.state, panel: null }
          await this.openPlace({ path: panel.path, ...(panel.line ? { line: panel.line } : {}) })
          return
        }
        if (choice === 'copy-path') {
          const copied = await copyText(panel.path, (data) => this.terminal.write(data))
          this.state = notice(this.state, copied ? `copied ${panel.path}` : panel.path)
        }
        break
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
      case 'reload':
        await this.opts.reloadWindow?.()
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

  /** Everything search knows without looking at the disk, what needs you first. */
  private searchable(): SearchEntry[] {
    const entries: SearchEntry[] = []
    const panes = [...this.state.panes].sort((a, b) => Number(b.waiting) - Number(a.waiting))
    const toneOf = (pane: (typeof panes)[number]): SearchEntry['tone'] => MARK_TONES[markOf(pane)]
    for (const pane of panes) {
      if (pane.approval) {
        entries.push({
          id: `approve:${pane.task}`,
          kind: 'approval',
          label: `Allow once: ${pane.approval.summary}`,
          detail: pane.name,
          mark: '▲',
          tone: 'waiting',
        })
      }
    }
    // What the extensions can do, where you are.
    for (const { extension, action: one } of this.opts.extensions?.actions() ?? []) {
      entries.push({
        id: `run:extension:${extension.name}:${one.id}`,
        kind: 'action',
        label: one.title,
        detail: extension.title,
        mark: '◆',
        complete: `>${one.title}`,
      })
    }
    for (const pane of panes) {
      entries.push({
        id: `task:${pane.task}`,
        kind: 'agent',
        label: pane.name,
        detail: `in ${pane.project}`,
        mark: glyph(pane),
        tone: toneOf(pane),
        complete: `@${pane.name}`,
        ...(pane.waiting ? { note: 'waiting on you' } : {}),
      })
    }
    const action = (id: string, label: string, mark = '›') =>
      entries.push({ id, kind: 'action', label, mark, complete: `>${label}` })
    for (const [id, label] of [
      ['run:new-agent', 'New agent'],
      ['run:new-terminal', 'New terminal'],
      ['run:open-project', 'Open project'],
      ['run:spend', 'Spend'],
      ['run:extensions', 'Extensions'],
      ['run:brief', 'Brief'],
      ['run:settings', 'Settings'],
      ['run:keys', 'Keys'],
      ['run:quit', 'Quit'],
    ] as const) {
      action(id, label)
    }
    for (const pane of panes) {
      if (pane.lane) action(`stop:${pane.task}`, `Stop ${pane.name}`, '■')
      action(`changes:${pane.task}`, `Show the changes in ${pane.name}`, '±')
    }
    for (const terminal of this.state.terminals) {
      action(`show-terminal:${terminal.id}`, `Terminal: ${terminal.name}`, '›')
    }
    for (const project of projects(this.state)) {
      entries.push({ id: `project:${project}`, kind: 'project', label: project, mark: '▣' })
    }
    for (const group of settingsOf(this.opts.config)) {
      for (const setting of group.settings) {
        entries.push({
          id: `setting:${group.id}`,
          kind: 'setting',
          label: `${group.title} › ${setting.title}`,
          mark: '◇',
        })
      }
    }
    return entries
  }

  /** Every place an agent works, and every project, for search to look in. */
  private searchRoots(): SearchRoot[] {
    const roots: SearchRoot[] = Object.entries(this.opts.config.projects).map(
      ([name, project]) => ({
        path: expandHome(project.root),
        label: name,
        task: null,
      }),
    )
    for (const pane of this.state.panes) {
      const worktree = this.live?.worktreeOf(pane.task)
      if (worktree)
        roots.push({ path: worktree, label: `${pane.project} › ${pane.name}`, task: pane.task })
    }
    return roots
  }

  /** Open search, listing the files it looks through again when that list is old. */
  private openSearch(query = ''): void {
    this.state = { ...this.state, panel: searchPanel(query) }
    this.draw()
    // What every terminal has printed, to find lines in.
    void Promise.all(
      this.state.terminals.map(async (terminal) => ({
        ...terminal,
        text: await this.opts.client.readTerminal(terminal.id, 5_000).catch(() => ''),
      })),
    ).then((texts) => {
      this.terminalTexts = texts
      this.results = null
      this.draw()
    })
    if (this.searchFiles && this.now() - this.searchFiles.at < 10_000) return
    const roots = this.searchRoots()
    void Promise.all(
      roots.map(async (root) =>
        (await listFiles(root.path).catch(() => [])).map((path) => ({ root, path })),
      ),
    ).then((lists) => {
      this.searchFiles = { at: this.now(), files: lists.flat() }
      this.results = null
      this.draw()
    })
  }

  /** What search shows for the query in the box. */
  private searchEntries(): SearchEntry[] {
    const panel = this.state.panel
    if (panel?.kind !== 'search') return []
    const text = parseQuery(panel.query).text
    const matches = this.grepped.text === text ? this.grepped.matches : []
    const key = [
      panel.query,
      this.searchFiles?.at ?? 0,
      this.grepped.text,
      matches.length,
      this.state.panes.length,
      this.state.panes.map((pane) => `${pane.task}${pane.state}${pane.waiting}`).join(),
    ].join('\0')
    if (this.results?.key !== key) {
      this.results = {
        key,
        entries: searchResults(panel.query, {
          entries: this.searchable(),
          files: this.searchFiles?.files ?? [],
          matches,
          terminals: this.terminalTexts,
        }),
      }
    }
    return this.results.entries
  }

  /**
   * Look inside files for what is typed, a moment after typing stops: every
   * keystroke starting git grep across every worktree would be most of the work
   * the machine does while you type.
   */
  private lookInFiles(): void {
    const panel = this.state.panel
    if (panel?.kind !== 'search') return
    const query = parseQuery(panel.query)
    const text = query.text
    if (
      query.scope === 'agents' ||
      query.scope === 'actions' ||
      text.length < TEXT_MIN ||
      query.line
    )
      return
    if (text === this.grepped.text || text === this.grepping) return
    if (this.grepTimer) clearTimeout(this.grepTimer)
    this.grepTimer = setTimeout(() => {
      this.grepping = text
      this.draw()
      const roots = this.searchRoots()
      void Promise.all(roots.map((root) => grep(root, text, 50).catch(() => []))).then((found) => {
        if (this.grepping !== text) return
        this.grepped = { text, matches: found.flat() }
        this.grepping = null
        this.results = null
        this.draw()
      })
    }, 150)
  }

  /** Where a search result goes. */
  private async fromSearch(id: string): Promise<void> {
    const place = parseOpenId(id)
    if (place) {
      this.openFile(place.path, place.line)
      return
    }
    if (id.startsWith('terminal\0')) {
      const [, terminal, query, back] = id.split('\0')
      if (terminal) await this.openFind(terminal, query ?? '', Number(back) || 0)
      return
    }
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
      case 'show-terminal':
        await this.showTerminal(arg)
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
                : subject.kind === 'lane'
                  ? subject.name
                  : subject.kind === 'thinking'
                    ? 'Thinking'
                    : subject.kind === 'note'
                      ? 'Note'
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
        return this.giveImages(subject.paths, item)
      case 'harness':
        return this.chooseHarness(subject.task, item)
      case 'lane':
        return this.fromLaneMenu(subject.task, subject.lane, subject.name, item)
      case 'note':
        return this.fromNoteMenu(subject, item)
      case 'thinking':
        return this.chooseThinking(subject.task, item)
    }
  }

  /** How hard an agent thinks from its next turn, and new agents from their first. */
  private async chooseThinking(task: string, level: string): Promise<void> {
    try {
      const chosen = await this.opts.client.setAgentThinking(task, level)
      const loaded = await loadConfig(this.configPath)
      if (loaded.ok) this.opts.config = loaded.config
      this.state = notice(
        this.state,
        `${task} thinks at ${chosen} from its next turn, and new agents start there`,
      )
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  /** What a note's menu does: change it, copy its words, or forget it. */
  private async fromNoteMenu(note: { at: string; text: string }, item: string): Promise<void> {
    if (item === 'edit') {
      this.state = {
        ...this.state,
        panel: {
          ...promptPanel('edit-note', 'Note', 'NOTE', note.text),
          target: `${note.at}\u0000${note.text}`,
        },
      }
      this.draw()
      return
    }
    if (item === 'copy') {
      await this.copy(note.text)
      return
    }
    if (item === 'forget') this.forgetNote(note)
  }

  /** Take a note back. It is not recalled again, by anyone, after a restart too. */
  private forgetNote(note: { at: string; text: string }): void {
    const forgot = this.opts.client.forget(note, 'window')
    this.state = notice(this.state, forgot ? 'forgot that note' : 'that note was already forgotten')
    this.draw()
  }

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

  /** The harness a task's agent is shown as running in: its route's, until it says. */
  private harnessShown(task: string): string {
    return resolveRoute(this.opts.config, { project: task.split('/')[0] ?? '' }).harness
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

  /**
   * Ask who dropped or pasted pictures are for. The keyboard starts on
   * whoever you were typing to, so enter is the likely answer.
   */
  private askWhereImagesGo(paths: string[]): void {
    const panel = menuPanel({ kind: 'images', paths }, imagesTitle(paths))
    const items = this.menuItemsFor(panel)
    const typingTo =
      this.state.dictation !== null || this.state.focused === null
        ? 'orchestrator'
        : this.state.keyboard === 'terminal' && activeTerminal(this.state)
          ? `terminal:${activeTerminal(this.state)?.id}`
          : `agent:${this.state.focused}`
    const index = Math.max(
      0,
      items.findIndex((item) => item.id === typingTo && !item.off),
    )
    this.state = { ...this.state, panel: { ...panel, index } }
    this.draw()
  }

  /** Give pictures to whoever was picked: attached, pasted as paths, or typed. */
  private async giveImages(paths: string[], to: string): Promise<void> {
    if (to === 'orchestrator') {
      this.attachImages(paths)
      return
    }
    const [kind, ...rest] = to.split(':')
    const id = rest.join(':')
    if (kind === 'agent') {
      const pane = this.state.panes.find((one) => one.task === id)
      if (!pane?.lane) {
        this.state = notice(this.state, `open ${pane ? shownName(pane) : id}'s agent first`)
        this.draw()
        return
      }
      // Pasted the way the terminal would have: the agent reads the picture
      // from its path, and you finish the sentence at its prompt.
      this.state = {
        ...focusTask(this.state, id),
        keyboard: 'pane',
        dictation: null,
        orchestratorDraft: this.state.dictation ?? this.state.orchestratorDraft,
      }
      await this.opts.client
        .write(pane.lane as LaneId, asPaste(paths.join(' ')))
        .catch((err) => (this.state = notice(this.state, why(err))))
    } else if (kind === 'terminal') {
      this.state = {
        ...this.state,
        bottom: id,
        keyboard: 'terminal',
        dictation: null,
        orchestratorDraft: this.state.dictation ?? this.state.orchestratorDraft,
      }
      await this.opts.client
        .write(id as LaneId, paths.map(shellQuote).join(' '))
        .catch((err) => (this.state = notice(this.state, why(err))))
    }
    this.soonTick()
    this.draw()
  }

  /** Pictures waiting to go to the orchestrator with what you say next. */
  private attachImages(paths: readonly string[]): void {
    const readable = paths.filter((path) => readImage(path) !== null)
    this.state = {
      ...this.state,
      attached: [...new Set([...this.state.attached, ...paths])],
      bottom: ORCHESTRATOR_TAB,
      dictation: this.state.dictation ?? '',
      notice:
        readable.length < paths.length
          ? `${paths.length - readable.length} could not be read as a picture: over 20 MB, or not an image`
          : paths.length === 1
            ? 'say or type what to do with it'
            : `say or type what to do with them`,
    }
    this.draw()
  }

  /** Mute everything Wilco says and plays, or bring it back; kept for next time. */
  private async toggleMute(): Promise<void> {
    const muted = !this.opts.config.surfaces.voice.muted
    try {
      writeSetting(this.configPath, 'surfaces.voice.muted', muted ? true : undefined)
    } catch {
      // Not writable: muted for this window only.
    }
    this.opts.config = {
      ...this.opts.config,
      surfaces: {
        ...this.opts.config.surfaces,
        voice: { ...this.opts.config.surfaces.voice, muted },
      },
    }
    this.state = notice(
      this.state,
      muted ? 'muted: nothing will be said or played' : 'sound back on',
    )
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

  /** ctrl+v at the orchestrator: the screenshot on the clipboard, attached. */
  private async attachClipboard(): Promise<void> {
    const path = await (this.opts.clipboard?.image ?? clipboardImage)()
    if (path) {
      // That copy is taken: it is not offered again.
      if (this.clipboard.offered) this.clipboard.seen = this.clipboard.offered
      this.clipboard.offered = null
      this.attachImages([path])
      return
    }
    this.state = notice(this.state, 'no picture on the clipboard — ⌘V pastes text')
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
        this.openSearch(`${path}/`)
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
            branch ? branch.replace(/^wilco\//, '') : '',
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
        await this.openFind(id)
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
        const opened = await this.openTerminal()
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
  private async savePrompt(panel: PromptPanel): Promise<void> {
    const text = panel.text.trim()
    const fail = (error: string) => {
      this.state = { ...this.state, panel: { ...panel, busy: false, error } }
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
      if (panel.purpose === 'edit-note') {
        const [at = '', ...said] = (panel.target ?? '').split('\u0000')
        const was = this.opts.client
          .recallAll()
          .find((one) => one.at === at && one.text === said.join('\u0000'))
        if (!was) return fail('That note is not there any more.')
        if (was.text !== text) {
          // Said again in its new words, about what it was about, and the old words taken back.
          this.opts.client.remember(text, was.scope, 'window')
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
        const name = text.startsWith('wilco/') ? text : `wilco/${text}`
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
    switch (item) {
      case 'open': {
        this.state = focusTask(this.state, task)
        const pane = this.state.panes.find((p) => p.task === task)
        if (pane && !pane.lane) await this.openAgent()
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

  private async removeTask(panel: ConfirmRemovePanel): Promise<void> {
    const facts = this.live?.factsOf(panel.task)
    const worktree = this.live?.worktreeOf(panel.task)
    const root = facts ? this.opts.config.projects[facts.project]?.root : undefined
    if (!facts || !worktree || !root) {
      this.state = {
        ...this.state,
        panel: { ...panel, busy: false, error: 'I cannot find where this agent works.' },
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
        task: panel.task,
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

  /**
   * Type on the orchestrator's line. pi's own editor takes the keys — the
   * cursor, words, undo, a paste, lines that wrap, ↑ for what was said —
   * so the line behaves as pi's does. Enter sends it; escape abandons it.
   */
  private type(data: string): void {
    if (isKeyRelease(data)) return
    const key = parseKey(data)
    // Searching back through what you said: the search has the keys until it ends.
    if (this.state.historySearch) {
      const searched = searchKey(this.state, this.history, key, data)
      this.state = searched.state
      if (!this.state.historySearch) this.editor.setText(this.state.dictation ?? '')
      if (searched.send) this.submit()
      else this.draw()
      return
    }
    if (key === 'ctrl+r') {
      this.state = startHistorySearch(setDictation(this.state, this.editor.getText()), this.history)
      this.draw()
      return
    }
    if (key === 'enter') {
      this.submit()
      return
    }
    if (key === 'escape') {
      // Escape abandons it rather than sending half a sentence, pictures and all.
      this.editor.setText('')
      this.state = setListening(setDictation({ ...this.state, attached: [] }, null), false)
      this.draw()
      return
    }
    this.editor.handleInput(data)
    this.state = setDictation(this.state, this.editor.getText())
    this.draw()
  }

  /**
   * Kept, verbatim, for up and ctrl+r: in this window at once, and in the
   * journal so the next window has it too.
   */
  private rememberSaid(said: string): void {
    if (this.history.at(-1) !== said) this.history.push(said)
    this.editor.addToHistory(said)
    if (this.history.length > HISTORY_MAX) this.history.splice(0, this.history.length - HISTORY_MAX)
    void this.opts.client.log
      .append({ type: 'said', task: null, detail: { text: said } })
      .catch(() => {})
  }

  /** What was said in windows before this one, oldest first, for up and ctrl+r. */
  private async loadHistory(): Promise<void> {
    const events = await this.opts.client
      .events({ types: ['said'], limit: HISTORY_MAX })
      .catch(() => [])
    const before: string[] = []
    const keep = (text: unknown) => {
      if (typeof text === 'string' && text !== '' && before.at(-1) !== text) before.push(text)
    }
    for (const event of events) keep(event.detail.text)
    // Before lines were journaled, what you asked the orchestrator is still in
    // its own sessions, where pi keeps the conversation.
    if (before.length === 0)
      for (const text of sessionPrompts(join(this.opts.home, 'orchestrator', 'sessions')))
        keep(text)
    // Anything said while this was loading is newer than all of it.
    this.history = [...before, ...this.history]
    for (const line of this.history.slice(-100)) this.editor.addToHistory(line)
  }

  /** Hand what was said to the surface, which works out who you meant. */
  private submit(): void {
    this.syncLine()
    const said = this.editor.getExpandedText().trim()
    this.editor.setText('')
    this.state = setListening(setDictation({ ...this.state, historySearch: null }, null), false)
    this.draw()
    // A command is carried out here; anything else is a sentence for Wilco.
    if (said.startsWith('/')) {
      this.rememberSaid(said)
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
      this.prefill('/new ')
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
        task = await this.opts.client.createTask({ project, slug, intent, detached })
      } catch (err) {
        if (/branch already exists|already exists/.test(why(err))) continue
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
   * Agents that were working when Wilco last closed — not stopped, not
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
      await this.opts.client.startAgent({ task: task as never, cwd: worktree, prompt: '' })
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
      this.prefill('/stop ')
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
    this.state = withTranscript(this.state, thinking(this.state.transcript, this.now()))
    this.draw()
    const images = this.sending.flatMap((path) => readImage(path) ?? [])
    this.sending = []
    this.speakingTurn =
      this.opts.config.surfaces.voice.speak && !this.opts.config.surfaces.voice.muted
    try {
      return await this.thinker.ask(text, images)
    } catch (err) {
      this.state = withTranscript(this.state, problem(this.state.transcript, why(err), this.now()))
      return ''
    } finally {
      this.speakingTurn = false
      this.voice?.flushSpeech()
    }
  }

  /** Everything addressed to Wilco arrives here, however it was said. */
  private say(said: string): void {
    if (said === '' || !this.voice) return
    this.rememberSaid(said)
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
        this.state = setQuestion(this.state, this.voice?.awaiting ?? null)
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

  /** Type into the agent you are watching, and hold focus while you do. */
  private toLane(data: string): void {
    const pane = this.state.panes.find((p) => p.task === this.state.focused)
    // Typing at an agent is looking at its newest line.
    this.state = { ...noteTyping(this.state, this.now()), paneScroll: 0 }

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

    const lane = pane ? typingLane(this.state, pane) : null
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
    try {
      await this.look()
    } finally {
      this.looking = false
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
    this.lookAtClipboard()
    if (this.now() - this.repaintedAt >= REPAINT_MS) {
      this.repaintedAt = this.now()
      this.repaint()
    }
    const pane = this.state.panes.find((p) => p.task === this.state.focused)
    const lane = pane ? laneShown(this.state, pane) : null
    const split = pane ? splitShown(this.state, pane) : null
    const halves = this.halves(this.paneSize(), split)
    const size = halves.first
    if (lane) await this.fitLane(lane, size)
    this.watch(lane)
    if (split) {
      await this.fitLane(split.lane, halves.second)
      const second =
        (await this.live?.capture(split.lane, halves.second.rows, this.skin.colour)) ?? ''
      if (second !== this.splitScreen) {
        this.splitScreen = second
        this.draw()
      }
    }
    this.title(pane ? `${pane.project} › ${shownName(pane)}` : null)
    const screen = this.scrolledBack(
      await (this.live?.capture(lane, size.rows + this.state.paneScroll, this.skin.colour) ?? ''),
      size.rows,
      'paneScroll',
    )
    const terminal = await this.captureTerminal()
    // While the orchestrator or an agent down the side works, its spinner is news every frame.
    const working =
      this.state.transcript.thinking !== null ||
      this.state.transcript.entries.some(
        (entry) => entry.kind === 'tool' && entry.state === 'running',
      ) ||
      this.state.panes.some(
        (pane) => pane.project === this.state.project && markOf(pane) === 'working',
      )
    if (screen !== this.screen || terminal || this.state.talkingSince !== null || working) {
      this.screen = screen
      this.draw()
    }
  }

  /**
   * Read the terminal in front of the bottom panel, sized to the panel. Says
   * whether what it shows has changed. Nothing is read while the panel is
   * folded or showing the orchestrator.
   */
  /**
   * How far the conversation can scroll back: its lines, less the rows the
   * strip shows them in. Laid out the way the view lays it out, at its width.
   */
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

  private transcriptRows(): number {
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    const width = layout.sidebarWidth + layout.mainWidth + 1
    const lines = transcriptLines(
      this.state.transcript,
      width,
      this.skin,
      { hover: null, pressed: null },
      this.now(),
      this.linkers,
    )
    // As the strip lays it out: its tab row, then the conversation, then the
    // input box, which is taller while what is typed wraps.
    // The strip's tabs, and the row of room under them.
    const room = layout.stripHeight - 2
    const input = Math.min(
      Math.max(3, room - 1),
      this.state.dictation !== null ? this.editor.render(width).length : 3,
    )
    return Math.max(0, lines.length - Math.max(0, room - input))
  }

  /**
   * A screen read further back than it is tall, cut to the part scrolled to.
   * Scrolling past the oldest line there is stops at it.
   */
  private scrolledBack(
    captured: string,
    rows: number,
    which: 'paneScroll' | 'terminalScroll',
  ): string {
    const back = this.state[which]
    if (back === 0) return captured
    const lines = captured.split('\n')
    const most = Math.max(0, lines.length - rows)
    if (back > most) this.state = { ...this.state, [which]: most }
    const end = lines.length - this.state[which]
    return lines.slice(Math.max(0, end - rows), end).join('\n')
  }

  private async captureTerminal(): Promise<boolean> {
    const terminal = activeTerminal(this.state)
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    if (!terminal || this.state.bottomMode === 'min') {
      this.watch(null, 'terminal')
      return false
    }
    const split = terminalSplitShown(this.state)
    const halves = this.halves(
      {
        cols: Math.max(20, layout.sidebarWidth + layout.mainWidth + 1),
        rows: Math.max(1, layout.stripHeight - 2),
      },
      split,
    )
    const size = halves.first
    await this.fitLane(terminal.id, size)
    this.watch(terminal.id, 'terminal')
    let changed = false
    if (split) {
      await this.fitLane(split.lane, halves.second)
      const second =
        (await this.live?.capture(split.lane, halves.second.rows, this.skin.colour)) ?? ''
      if (second !== this.splitTerminalScreen) {
        this.splitTerminalScreen = second
        changed = true
      }
    }
    const screen = this.scrolledBack(
      await (this.live?.capture(
        terminal.id,
        size.rows + this.state.terminalScroll,
        this.skin.colour,
      ) ?? ''),
      size.rows,
      'terminalScroll',
    )
    if (screen === this.terminalScreen) return changed
    this.terminalScreen = screen
    return true
  }

  /**
   * The sizes of the two halves of a split, as `splitView` lays them out — the
   * divider, and the second half's bar, taking their row or column.
   */
  private halves(
    whole: { cols: number; rows: number },
    split: { direction: 'beside' | 'below'; ratio: number } | null,
  ): { first: { cols: number; rows: number }; second: { cols: number; rows: number } } {
    if (!split) return { first: whole, second: whole }
    if (split.direction === 'beside' && whole.cols >= 24) {
      const first = Math.max(
        10,
        Math.min(whole.cols - 11, Math.round((whole.cols - 1) * split.ratio)),
      )
      return {
        first: { cols: first, rows: whole.rows },
        second: { cols: whole.cols - 1 - first, rows: Math.max(1, whole.rows - 1) },
      }
    }
    const first = Math.max(1, Math.min(whole.rows - 2, Math.round((whole.rows - 1) * split.ratio)))
    return {
      first: { cols: whole.cols, rows: first },
      second: { cols: whole.cols, rows: Math.max(1, whole.rows - 1 - first) },
    }
  }

  /** A split's divider dragged to a cell: the first half takes up to there. */
  private dragSplit(which: 'split' | 'terminal-split', at: { x: number; y: number }): AppState {
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    if (which === 'split') {
      const task = this.state.focused
      const split = task ? this.state.splits[task] : undefined
      if (!task || !split) return this.state
      // The pane starts after the sidebar and its divider, below the top bar and the pane's header.
      const ratio =
        split.direction === 'beside'
          ? (at.x - layout.sidebarWidth - 1) / Math.max(1, layout.mainWidth - 1)
          : (at.y - 3 - 2) / Math.max(1, layout.bodyHeight - 2 - 1)
      return {
        ...this.state,
        splits: { ...this.state.splits, [task]: { ...split, ratio: splitRatio(ratio) } },
      }
    }
    const split = this.state.terminalSplit
    if (!split) return this.state
    const width = layout.sidebarWidth + layout.mainWidth + 1
    const top = 3 + layout.bodyHeight + 2
    const ratio =
      split.direction === 'beside'
        ? at.x / Math.max(1, width - 1)
        : (at.y - top) / Math.max(1, layout.stripHeight - 2 - 1)
    return { ...this.state, terminalSplit: { ...split, ratio: splitRatio(ratio) } }
  }

  /** The scrollback the find box is looking through, and the line it is on. */
  private findView(): NonNullable<Frame['terminal']>['find'] {
    const panel = this.state.panel
    if (panel?.kind !== 'find' || this.findText?.id !== panel.terminal) return null
    const matches = this.findMatches()
    return {
      lines: this.findText.lines,
      line: matches.length > 0 ? (matches[panel.index % matches.length] ?? null) : null,
      query: panel.query,
    }
  }

  /** Put a terminal in front, once the window knows about it. For whoever opened it elsewhere. */
  async showTerminal(id: string): Promise<void> {
    // Just opened, it may take a refresh or two to be listed: it still comes to the front.
    for (let tries = 0; tries < 10; tries++) {
      if (this.state.terminals.some((terminal) => terminal.id === id)) break
      await this.live?.refresh()
      if (this.state.terminals.some((terminal) => terminal.id === id)) break
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    this.state = showTerminal(this.state, id)
    this.draw()
  }

  /** Open a terminal in a project — the one you are in unless told — and put it in front. */
  private async openTerminal(name: string | null = null, cwd?: string): Promise<string | null> {
    const project = this.state.project
    if (!project) {
      this.state = notice(this.state, 'open a project first: a terminal starts in its folder')
      this.draw()
      return null
    }
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    try {
      const opened = await this.opts.client.openTerminal({
        project,
        ...(name ? { name } : {}),
        ...(cwd ? { cwd } : {}),
        cols: layout.sidebarWidth + layout.mainWidth + 1,
        rows: Math.max(4, layout.stripHeight - 2),
      })
      await this.showTerminal(opened.id)
      return opened.name
    } catch (err) {
      this.state = notice(this.state, why(err))
      this.draw()
      return null
    }
  }

  /** Look for text in a terminal's scrollback, with the find box over it. */
  private async openFind(id: string, query = '', index = 0): Promise<void> {
    this.state = { ...showTerminal(this.state, id), panel: findPanel(id, query, index) }
    const text = await this.opts.client.readTerminal(id, 5_000).catch(() => '')
    this.findText = { id, lines: text.split('\n') }
    this.draw()
  }

  /** The lines the find box matches, newest first, as line numbers into the scrollback read. */
  private findMatches(): number[] {
    const panel = this.state.panel
    if (panel?.kind !== 'find' || this.findText?.id !== panel.terminal || panel.query === '')
      return []
    return matchingLines(this.findText.lines.join('\n'), panel.query, 10_000)
      .map((match) => match.line - 1)
      .reverse()
  }

  /** What voice does with terminals: each answers in the sentence it says back. */
  private voiceTerminals(): VoiceTerminals {
    const project = () => this.state.project ?? undefined
    // Said with no name, it is the terminal in front, or the only one in the project.
    const which = (name: string | null) => {
      const front = activeTerminal(this.state)
      if (!name && front) return this.opts.client.terminal(front.id)
      return this.opts.client.terminal(name, project())
    }
    const attempt = async (act: () => Promise<string>) => {
      try {
        return await act()
      } catch (err) {
        return `${capitalise(why(err))}.`
      }
    }
    return {
      open: (name) =>
        attempt(async () => {
          const opened = await this.openTerminal(name)
          return opened ? `Opened ${opened}.` : 'I could not open a terminal here.'
        }),
      show: (name) =>
        attempt(async () => {
          const terminal = which(name)
          await this.showTerminal(terminal.id)
          return `Showing ${terminal.name}.`
        }),
      close: (name) =>
        attempt(async () => {
          const closed = await this.opts.client.closeTerminal(which(name).id)
          await this.live?.refresh()
          return `Closed ${closed.name}.`
        }),
      rename: (name, to) =>
        attempt(async () => {
          const renamed = await this.opts.client.renameTerminal(which(name).id, to)
          await this.live?.refresh()
          return `Renamed it ${renamed.name}.`
        }),
      run: (name, command) =>
        attempt(async () => {
          const terminal = await this.opts.client.runInTerminal(which(name).id, command, {
            submit: false,
          })
          this.typed = { id: terminal.id, name: terminal.name, command }
          await this.showTerminal(terminal.id)
          return `Typed ${command} into ${terminal.name}. Press enter, or say confirm and the command, to run it.`
        }),
      search: (name, text) =>
        attempt(async () => {
          const { terminal, matches } = await this.opts.client.searchTerminal(which(name).id, text)
          await this.openFind(terminal.id, text)
          return matches.length === 0
            ? `Nothing in ${terminal.name} says ${text}.`
            : `${matches.length} line${matches.length === 1 ? '' : 's'} in ${terminal.name} mention ${text}.`
        }),
      confirm: async (phrase) => {
        const typed = this.typed
        if (!typed) return null
        const words = phrase.toLowerCase().split(/\s+/).filter(Boolean)
        const command = typed.command.toLowerCase()
        if (words.length === 0 || !words.every((word) => command.includes(word))) return null
        this.typed = null
        await this.opts.client.write(typed.id as LaneId, '\r')
        return `Ran ${typed.command} in ${typed.name}.`
      },
    }
  }

  /**
   * Watch the lane in front of you, so what it prints is on screen at once
   * rather than at the next quarter-second look. Typing waited for that look,
   * which is what made an agent feel slow to type into.
   */
  private watch(lane: string | null, slot: 'pane' | 'terminal' = 'pane'): void {
    if (this.watching.get(slot)?.lane === lane) return
    this.watching.get(slot)?.stop()
    this.watching.delete(slot)
    if (!lane) return
    const watching = { lane, stop: () => {} }
    this.watching.set(slot, watching)
    void this.opts.client
      .watch(lane as LaneId, () => this.soonTick(), { lines: 1 })
      .then((watched) => {
        if (this.watching.get(slot) === watching) watching.stop = watched.stop
        else watched.stop()
      })
      .catch(() => {})
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
  /** The orchestrator's model as the config has it: `provider/id`, or the id alone. */
  /**
   * The line, as pi's editor draws it at this width, while it is open. What
   * something else put there — a transcript, a command to finish — is taken
   * into the editor first, so there is only ever one line.
   */
  private inputFor(width: number): Pick<Frame, 'input'> {
    this.syncLine()
    if (this.state.dictation === null) return {}
    this.editor.focused = true
    this.editor.borderColor = this.skin.signal
    return { input: { lines: this.editor.render(width) } }
  }

  /** The editor holds what the state says the line holds. */
  private syncLine(): void {
    const wanted = this.state.dictation ?? ''
    if (this.editor.getText() !== wanted) this.editor.setText(wanted)
  }

  private thinkerAccount(): NonNullable<Frame['orchestratorAccount']> {
    const { provider, model } = this.opts.config.orchestrator
    const paying = provider ?? (model?.includes('/') ? (model.split('/')[0] ?? null) : null)
    return {
      provider: paying,
      credential: paying ? credentialLabel(this.credentials[paying]) : null,
    }
  }

  private thinkerModel(): string | null {
    const { provider, model } = this.opts.config.orchestrator
    return model ? (provider ? `${provider}/${model}` : model) : null
  }

  /** Choose a model for the orchestrator, or for one agent's session. */
  private async openModels(target: string): Promise<void> {
    if (this.models.length === 0) {
      this.models = (await this.opts.models?.().catch(() => [])) ?? []
    }
    // Starting on the one in use, so enter is a no-op and ↑↓ is "the one next to it".
    const current =
      target === 'orchestrator' ? this.thinkerModel() : (this.live?.vitals(target)?.model ?? null)
    const index = current
      ? Math.max(
          0,
          this.models.findIndex((one) => one.id === current || one.id.endsWith(`/${current}`)),
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
        if (loaded.ok) this.opts.config = loaded.config
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

  /** The extensions, as the panel shows them. */
  private extensionViews(): ExtensionView[] {
    return (this.opts.extensions?.list() ?? []).map((one) => ({
      name: one.name,
      title: one.title,
      description: one.description,
      source: one.source,
      state: one.state,
      problem: one.problem,
      tools: one.tools.map((tool) => tool.name),
      actions: one.actions.map((action) => ({ id: action.id, title: action.title })),
      unknownSettings: one.unknownSettings,
      configurable: this.opts.extensions?.setupOf(one.name) !== null,
      folder: one.source === 'yours' ? one.path : null,
    }))
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
        case 'toggle': {
          const was = host?.list().find((one) => one.name === name)
          const on = was?.state === 'off'
          // On is the default, so turning one on takes the setting away.
          writeSetting(this.configPath, `extensions.${name}.enabled`, on ? undefined : false)
          await this.reloadExtensions()
          const now = host?.list().find((one) => one.name === name)
          return stay(
            on
              ? `${was?.title ?? name} is on${now?.state === 'needs setup' ? `, and needs setting up: ${now.problem}` : ''}`
              : `${was?.title ?? name} is off`,
          )
        }
        case 'read': {
          const proposal = this.opts.proposals?.list().find((one) => one.name === name)
          if (!proposal) return stay(null)
          this.state = { ...this.state, panel: null }
          await this.openPlace({ path: proposal.path })
          return
        }
        case 'approve':
        case 'reject': {
          const said = await this.opts.proposals?.decide(
            name,
            verb === 'approve' ? 'approve' : 'reject',
          )
          const count = extensionControls(
            this.extensionViews(),
            this.opts.proposals?.list() ?? [],
          ).length
          this.state = {
            ...this.state,
            panel: { ...panel, index: Math.min(panel.index, Math.max(0, count - 1)) },
          }
          return stay(said ?? null)
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
    this.opts.config = loaded.config
    await host.reconfigure(loaded.config.extensions)
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
   * While the orchestrator's line is open, notice a picture on the clipboard
   * and offer it: pasting one with Cmd+V sends nothing a terminal can pass on.
   * Asked every few seconds at most, and only then.
   */
  private lookAtClipboard(): void {
    if (this.state.dictation === null) {
      this.clipboard.offered = null
      return
    }
    if (this.clipboard.asking || this.now() - this.clipboard.askedAt < CLIPBOARD_MS) return
    this.clipboard.asking = true
    this.clipboard.askedAt = this.now()
    void (this.opts.clipboard?.state ?? clipboardState)()
      .then((found) => {
        const offer = found?.image && found.copy !== this.clipboard.seen ? found.copy : null
        if (offer !== this.clipboard.offered) {
          this.clipboard.offered = offer
          this.draw()
        }
      })
      .catch(() => {})
      .finally(() => {
        this.clipboard.asking = false
      })
  }

  /**
   * What extensions keep in the status bar, asked every few seconds and never
   * waited on: the tick goes on drawing while they answer, and an open view is
   * asked again with them so it stays current.
   */
  private askExtensions(): void {
    const host = this.opts.extensions
    const wilco = this.opts.extensionWorkbench
    if (!host || !wilco || this.asking || this.now() - this.statusedAt < STATUS_MS) return
    this.asking = true
    this.statusedAt = this.now()
    const panel = this.state.panel
    void host
      .statuses(wilco)
      .then(async (found) => {
        this.statuses = found.map((one) => ({
          extension: one.extension,
          text: one.item.text,
          tone: one.item.tone ?? 'quiet',
          viewable: one.viewable,
        }))
        if (panel?.kind === 'extension-view') await this.refreshExtensionView(panel.extension)
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
    const wilco = this.opts.extensionWorkbench
    if (!host || !wilco) return
    try {
      const view = await host.view(name, wilco)
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
      for (const field of setup.fields) {
        const value = settingFrom(panel.values[field.key] ?? '', field.kind)
        writeSetting(
          this.configPath,
          `extensions.${panel.extension}.${field.key}`,
          value as Parameters<typeof writeSetting>[2],
        )
      }
      await this.reloadExtensions()
      const now = host.list().find((one) => one.name === panel.extension)
      this.state = {
        ...this.state,
        panel: {
          ...panel,
          busy: false,
          error: now?.state === 'ready' ? null : (now?.problem ?? null),
          said: now?.state === 'ready' ? `Saved. ${now.title} is ready.` : null,
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
          wilco: this.opts.extensionWorkbench ?? null,
        },
      )
      // Shown by the run itself: a failure's reason is already on its line.
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
          wilco: this.opts.extensionWorkbench ?? null,
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
   * Open what was chosen: go to a project Wilco knows, or add a folder as one —
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
      await this.live?.refresh()
      this.ensureAgent(name)
    } catch (err) {
      fail(why(err))
    }
  }

  /** What panels need to know that they do not hold. */
  private panelInputs(): PanelInputs {
    return {
      entries: this.searchEntries(),
      lines:
        this.state.panel?.kind === 'extension-view' ? this.extensionViewLines() : this.fileLines(),
      branches: this.branchRows,
      found: this.findMatches().length,
      rows:
        this.state.panel?.kind === 'open-project'
          ? this.openRowsFor(this.state.panel).map((view) => view.row)
          : [],
      choices: this.choices,
      items: this.menuItemsFor(this.state.panel),
      extensions: this.extensionViews(),
      proposals: this.state.panel?.kind === 'extensions' ? (this.opts.proposals?.list() ?? []) : [],
      setupFields:
        this.state.panel?.kind === 'extension-setup'
          ? (this.setupFacts(this.state.panel)?.fields ?? [])
          : [],
      models: this.models,
      settings: settingsOf(this.opts.config),
      accounts: this.accounts.length,
    }
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
    return panel.formatted && viewing?.formatted
      ? viewing.formatted.length
      : this.viewed.source.length
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
        const check = checkTalkKey(value, setting.type.printable === true)
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
    this.credentials = (await this.opts.credentials?.().catch(() => ({}))) ?? {}
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

  /**
   * Write the whole screen again, over itself.
   *
   * The terminal can wipe it without telling us: ⌘K is "clear" in Terminal.app,
   * iTerm2 and VS Code, and never reaches Wilco at all. Rendering only sends
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

/** A cell on the screen. */
interface Cell {
  x: number
  y: number
}

/** A selection from where it starts to where it ends, reading order, whichever way it was dragged. */
export function ordered(selection: { from: Cell; to: Cell }): { from: Cell; to: Cell } {
  const { from, to } = selection
  return from.y < to.y || (from.y === to.y && from.x <= to.x)
    ? { from, to }
    : { from: to, to: from }
}

/** The text a selection covers, one line per row, without the spaces that pad a row out. */
export function selectedText(rows: readonly string[], chosen: { from: Cell; to: Cell }): string {
  const lines: string[] = []
  for (let y = chosen.from.y; y <= chosen.to.y; y++) {
    const plain = stripTerminalSequences(rows[y] ?? '')
    const start = y === chosen.from.y ? chosen.from.x : 0
    const end = y === chosen.to.y ? chosen.to.x + 1 : visibleWidth(plain)
    lines.push(sliceByColumn(plain, start, Math.max(0, end - start)).trimEnd())
  }
  return lines.join('\n')
}

/** Rows with a selection shown the way a terminal shows one: reversed. */
export function highlighted(
  rows: readonly string[],
  chosen: { from: Cell; to: Cell },
  width: number,
): string[] {
  return rows.map((row, y) => {
    if (y < chosen.from.y || y > chosen.to.y) return row
    const start = y === chosen.from.y ? chosen.from.x : 0
    const end = y === chosen.to.y ? chosen.to.x + 1 : width
    const plain = stripTerminalSequences(row)
    const lit = sliceByColumn(plain, start, Math.max(0, end - start))
    return `${sliceByColumn(row, 0, start)}\x1b[0m\x1b[7m${lit}\x1b[0m${sliceByColumn(row, end, Math.max(0, width - end))}`
  })
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

/** How a provider is paid for, the way the status bar says it. */
function credentialLabel(kind: 'signed-in' | 'api-key' | 'env-key' | undefined): string | null {
  if (kind === 'signed-in') return 'signed in'
  if (kind === 'api-key') return 'API key'
  if (kind === 'env-key') return 'env API key'
  return null
}

/** Whose menu a right-click on this would open, if it has one. */
function subjectOf(target: Target): MenuSubject | null {
  switch (target.kind) {
    case 'task':
    case 'task-menu':
      return { kind: 'task', task: target.task }
    case 'note':
      return { kind: 'note', at: target.at, text: target.text }
    case 'file':
      return { kind: 'file', path: target.path, folder: false }
    case 'folder':
      return { kind: 'file', path: target.path, folder: true }
    case 'change':
      return { kind: 'change', task: target.task, path: target.path }
    case 'branch':
      return { kind: 'branch' }
    case 'menu':
      return target.subject
    case 'bottom-tab':
      return target.tab === ORCHESTRATOR_TAB ? null : { kind: 'terminal', id: target.tab }
    default:
      return null
  }
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/** A menu's title for pictures: who gets this one, or these. */
function imagesTitle(paths: readonly string[]): string {
  const allImages = paths.every((p) => isImagePath(p))
  const noun = paths.length === 1 ? 'file' : allImages ? 'pictures' : 'files'
  return `Send ${paths.length === 1 ? basename(paths[0] ?? '') : `${paths.length} ${noun}`} to`
}

/** The first line of Markdown, as it would be said: no emphasis, no code marks, no link targets. */
export function spokenLine(markdown: string): string {
  const first = markdown.split('\n').find((line) => line.trim() !== '') ?? ''
  return first
    .replace(/^#+\s*/, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .trim()
}

/**
 * The alternate screen claims page up and down, home and end, ctrl+up and
 * down and ctrl+shift+f to scroll and search a viewport of its own — before
 * any listener sees them. Wilco
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

/** What was typed to the orchestrator in its pi sessions, oldest first; nothing when there are none. */
export function sessionPrompts(dir: string, most = 1_000): string[] {
  let files: string[] = []
  try {
    files = readdirSync(dir)
      .filter((name) => name.endsWith('.jsonl'))
      .sort()
  } catch {
    return []
  }
  const out: string[] = []
  for (const file of files) {
    let text = ''
    try {
      text = readFileSync(join(dir, file), 'utf8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      if (!line.includes('"role":"user"')) continue
      try {
        const entry = JSON.parse(line) as {
          type?: string
          message?: { role?: string; content?: unknown }
        }
        if (entry.type !== 'message' || entry.message?.role !== 'user') continue
        const content = entry.message.content
        const said =
          typeof content === 'string'
            ? content
            : Array.isArray(content)
              ? content
                  .map((part: { type?: string; text?: string }) =>
                    part?.type === 'text' ? (part.text ?? '') : '',
                  )
                  .join('')
              : ''
        if (said.trim()) out.push(said.trim())
      } catch {
        // A line pi is still writing, or not ours to read.
      }
    }
  }
  return out.slice(-most)
}
