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
  checksFor,
  composeBrief,
  DEFAULT_ATTENTION,
  type DoneRule,
  describeQueueState,
  describeWhen,
  describeWork,
  dueNow,
  expandHome,
  extensionEnabled,
  HARNESS_CHOICES,
  holdSaid,
  inWrittenOrder,
  joined,
  type LaneId,
  loadConfig,
  needsReflection,
  newFindings,
  orchestratorRoute,
  orderFirst,
  type Plan,
  type PlanBusy,
  parseQuietHours,
  parseSetting,
  planStandings,
  QUEUE_CHANGES,
  queueStateOf,
  readyToStart,
  reflectionPrompt,
  resolveRoute,
  type Schedule,
  type ScheduleDoes,
  type Setting,
  type SettingGroup,
  settingsOf,
  speakable,
  startFrom,
  THINKING_LEVELS,
  type ThinkingLevel,
  taskOrigin,
  type When,
  wantedInstead,
  watchedFrom,
} from '@tade/core'
import {
  type ExtensionHost,
  type ExtensionWorkbench,
  type SetupFieldView as HostSetupField,
  type ListSection,
  settingFrom,
} from '@tade/extensions-core'
import { git } from '@tade/status'
import type { Reporter } from '@tade/telemetry'
import {
  type AudioClip,
  type Recorder,
  type Recording,
  slugify,
  type Transcriber,
  VoiceSurface,
  type VoiceTerminals,
} from '@tade/voice-core'
import { Speaker } from '@tade/voice-tts'
import { type AccountView, matchingLines, type Workbench } from '@tade/workbench'
import { lookAtUpdates, type UpdateLook } from '@tade/workbench/programs'
import { type ParsedDiff, parseDiff } from './diff.ts'
import { chooseEditor, launch, openerFor, openerForLink } from './editor.ts'
import { grep, listFiles, type Match, type SearchRoot } from './finder.ts'
import type { ActionsView, Frame, LaneView } from './frame.ts'
import {
  extentOf,
  type Hit,
  hitBoxAt,
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
import {
  caretOf,
  clickedSpan,
  cutSpan,
  type LineKey,
  lineKey,
  putCaret,
  type RowStart,
  rowStarts,
  type Selection,
  type Span,
  sequenceFor,
  spanOf,
  textOf,
  withSelection,
} from './input.ts'
import { appKey, checkTalkKey, keyCaps, normalKey } from './keys.ts'
import { asRemembered, type LayoutPrefs, type RememberedWindow, resolveLayout } from './layout.ts'
import type { Linker } from './links.ts'
import { knownTasks, Live } from './live.ts'
import type { TaskSnapshot } from './model.ts'
import {
  type AgentMark,
  type AppState,
  activeTerminal,
  addTurn,
  conversing,
  doneTasks,
  dragAgent,
  dropAgent,
  FOLDED_AT_START,
  focusBy,
  focusNumber,
  focusTask,
  glyph,
  grabBar,
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
  openSchedule,
  parseCommand,
  projectNumber,
  projects,
  QUEUE_FILTERS,
  removeAttachment,
  resizeTo,
  type ScheduleView,
  scrollBarTo,
  scrollBy,
  searchKey,
  selectProject,
  setDictation,
  setHeld,
  setListening,
  setQuestion,
  shownName,
  showOrchestrator,
  showPlan,
  showTerminal,
  splitPane,
  splitRatio,
  splitShown,
  startHistorySearch,
  swapSplit,
  terminalSplitShown,
  toggleCheck,
  toggleDone,
  toggleFolder,
  toggleSection,
  turnSplit,
  typingLane,
  unsplitPane,
  viewActions,
  viewLane,
  whichProject,
  withProjects,
  withTasks,
  withTerminals,
  withTranscript,
} from './model.ts'
import { extensionsScrollable, fileBodySize, fileViewSize } from './panel-view.ts'
import type { OpenRowView, PanelContext } from './panels/context.ts'
import type { PanelOutcome } from './panels/outcome.ts'
import {
  type BranchRow,
  branchPanel,
  type CloseDonePanel,
  type ConfirmRemovePanel,
  closeDonePanel,
  confirmRemovePanel,
  diffPanel,
  findPanel,
  noteHeadlinePanel,
  notePanel,
  type PromptPanel,
  promptPanel,
} from './panels/small/state.ts'
import {
  ACCOUNTS,
  type AgentOffers,
  accountActions,
  accountMenuItems,
  agentOffers,
  branchMenuItems,
  type Choice,
  changeMenuItems,
  type ExtensionSetupPanel,
  type ExtensionsPanel,
  type ExtensionView,
  extensionSetupPanel,
  extensionsPanel,
  extensionViewPanel,
  type FilePanel,
  fileMenuItems,
  filePanel,
  fileSelection,
  harnessMenuItems,
  imageMenuItems,
  laneMenuItems,
  type McpServerOffer,
  type McpServerShown,
  type McpServerView,
  type MenuSubject,
  type ModelChoice,
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
  panelClick,
  panelKey,
  priceSaid,
  queueMenuItems,
  type SettingsPanel,
  savedFile,
  scheduleMenuItems,
  scrollFile,
  searchPanel,
  settingsPanel,
  spendPanel,
  type ThinkerOffers,
  terminalMenuItems,
  thinkingMenuItems,
  toolSummary,
  UPDATES,
  updateActions,
  type WrittenToolView,
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
import {
  describeQueue,
  describeSchedule,
  foundMessage,
  heldMessage,
  planAnswer,
  scheduleView,
  whyStarting,
} from './queue.ts'
import { initialRouter, pending, type RouterState, route } from './router.ts'
import { runScreen, ScreenCancelled, type Ui } from './screen.ts'
import { cutFrom, type HeldLines, type Reach, reachOf, Wheel } from './scroll.ts'
import { BAR } from './scrollbar.ts'
import {
  parseOpenId,
  parseQuery,
  type SearchEntry,
  searchResults,
  shortlist,
  TEXT_MIN,
  worthAsking,
} from './search.ts'
import { addProject, editSettings, writeSetting } from './settings.ts'
import { PLAIN, pointerSequence, pointerShapes, type Skin, skinFor } from './skin.ts'
import { spendView as spendViewOf } from './spend.ts'
import { windowTitle } from './title.ts'
import {
  fromThinker,
  interrupted,
  problem,
  ran,
  said,
  suggest,
  type ThinkerEvent,
  tadeDid,
  thinking,
  youSaid,
} from './transcript.ts'
import { transcriptLines } from './transcript-view.ts'
import { draw } from './view.ts'
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

/**
 * How many lines past what is on screen a lane is read back, once it is being
 * scrolled: room for the wheel to move in before the driver has to be asked
 * again.
 *
 * A capture costs what it asks for — a tenth of a millisecond a line, so
 * twelve of them two thousand lines back — and it used to be paid again on
 * every look and again on every notch, for the same lines that had not
 * changed since the agent printed them. Scrollback above the live screen
 * never changes; only the bottom does. So the lines are kept, and the screen
 * the window draws is cut out of them.
 */
const HELD_LINES = 200

/** How long a screen the terminal wiped on its own stays dark, at most. */
const REPAINT_MS = 2_000
/**
 * How often a drag held off the end of a file scrolls it. A hand held still
 * reports nothing, so this is the only clock in a selection — fast enough to
 * read as scrolling, slow enough that a whole file does not go past under it.
 */
const EDGE_MS = 80
/** How much of what you said up and ctrl+r reach back through. */
const HISTORY_MAX = 1_000
/**
 * The column of ground pi's editor leaves either side of the line's text.
 * What is selected is laid on the rows it drew, so where its text starts in
 * them has to be the same number it was given.
 */
const INPUT_PAD = 1
/** How often extensions are asked what they keep in the status bar. */
const STATUS_MS = 5_000
/**
 * A look at the tasks slower than this is worth knowing about: the window
 * looks every couple of seconds, so one this slow is already late for the next.
 */
const SLOW_LOOK_MS = 2_000
/** How often the clipboard is looked at for a picture, while the orchestrator's line is open. */
const CLIPBOARD_MS = 3_000
/**
 * How many of the things Tade can do are put to whoever reads a sentence
 * typed into search. Enough that the right one is nearly always among them,
 * few enough that the question stays about this person's sentence.
 */
const MEANT_CHOICES = 24

/** A stuck key must not record until the disk is full. */
const MAX_SPEECH_MS = 120_000

/** Backspace, and what some terminals send instead. */

const HELP =
  'tab moves · / lists commands · ctrl+space talks · esc stops · ctrl+c clears, then quits'

/** Two readings of a lane's screen that say the same thing, and so redraw nothing. */
function same(a: LaneView | null, b: LaneView | null): boolean {
  if (!a || !b) return a === b
  return (
    a.lines === b.lines &&
    a.cursor.back === b.cursor.back &&
    a.cursor.column === b.cursor.column &&
    a.scrolling === b.scrolling
  )
}

/** A printable key, which is somebody starting to type rather than a shortcut. */
function printable(data: string): boolean {
  return data.length === 1 && data >= ' ' && data !== '\x7f'
}

/** What the pointer did, reduced to what the window cares about. */
export type PointerEvent =
  | { kind: 'move'; target: Target | null }
  | { kind: 'press'; target: Target | null }
  | { kind: 'release' }
  /** `cell` is how far along what was clicked the pointer landed, from its left edge. */
  | {
      kind: 'click'
      target: Target
      button: 'left' | 'right'
      x: number
      y: number
      cell: number
      /** Presses in a row on the same cell: two takes a word, three a line. */
      clicks: number
    }
  /**
   * Selecting text on the orchestrator's line: pressed at a column of one of
   * its rows, and dragged from there. `extend` is shift held, which takes the
   * selection from where the caret already is instead of starting a new one.
   */
  | { kind: 'select'; line: number; x: number; extend: boolean; drag: boolean }
  /**
   * A drag that was selecting text on that line has been let go: what it
   * covers is copied, as a drag anywhere else on the window is.
   */
  | { kind: 'selected' }
  /**
   * Selecting text in the file you have open: pressed on one of its lines, at
   * a cell of the text. `how` is what the press meant — putting the caret
   * down, reaching there from where it already was, dragging on from it, or
   * the second and third press, which take the word and the line.
   */
  | {
      kind: 'select-file'
      line: number
      cell: number
      how: 'put' | 'extend' | 'drag' | 'word' | 'line'
    }
  /**
   * A drag that has left the top or the bottom of the file, by this many rows
   * — negative is above it. The file scrolls under the selection and the
   * selection goes on reaching, which is the only way to select past what is
   * on screen with a mouse.
   */
  | { kind: 'drag-file'; rows: number; cell: number }
  /** A drag that was selecting in the file has been let go: what it covers is copied. */
  | { kind: 'selected-file' }
  /**
   * The wheel over somewhere that scrolls, and how far that somewhere goes —
   * down its side and along its bottom — read off the bars the last frame
   * drew, as a press on a scrollbar reads its numbers off the same map. The
   * window is what knows where things ended up; laying the region out again
   * to count it is the same work twice, on every notch.
   */
  | {
      kind: 'wheel'
      area: ScrollArea
      rows: number
      /** Shift held, which turns the wheel sideways wherever there is a sideways. */
      shift: boolean
      reach: Reach
      sideways: Reach
      /**
       * Where the pointer is inside the region, zero-based from its top left.
       * Only a lane that answers the wheel itself needs it: a program with
       * more than one region in it scrolls the one under the pointer.
       */
      at: { column: number; row: number }
    }
  /** A divider taken hold of, dragged to a cell, and let go. */
  | { kind: 'grab'; edge: 'sidebar' | 'bottom' | 'split' | 'terminal-split' }
  /** A scrollbar taken hold of: what it was drawn from, where its track is, and where it was pressed. */
  | {
      kind: 'take'
      bar: { area: ScrollArea; total: number; shown: number; across?: boolean }
      /** Rows down the window, or columns across it for the bar lying down. */
      track: { top: number; rows: number }
      y: number
    }
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
  private readonly clock: () => number
  /** The wheel, which remembers only when it last turned. */
  private readonly wheel = new Wheel()
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
  private selection: {
    from: Cell
    to: Cell
    moved: boolean
    /**
     * The columns of the region it was started in, which it never reaches
     * out of. The window is columns side by side rather than one flow of
     * text, so a selection that took whole rows between its two ends took
     * the sidebar with it: dragging over an agent came back with the queue
     * and the agents beside it.
     */
    within: { from: number; to: number } | null
  } | null = null
  /**
   * A press on the line you type on: every drag until it is let go is
   * selecting text in it, not dragging a selection across the window.
   */
  private selectingInput: { dragged: boolean } | null = null
  /**
   * The same for the file you have open: a press in its text selects in it,
   * by the lines of the file rather than by the rows of the window.
   */
  private selectingFile: { dragged: boolean } | null = null

  constructor(
    frame: Window['frame'],
    onPointer: (event: PointerEvent) => boolean,
    onCopy: (text: string) => void,
    clock: () => number,
  ) {
    this.frame = frame
    this.onPointer = onPointer
    this.onCopy = onCopy
    this.clock = clock
  }

  render(width: number): string[] {
    const { state, frame } = this.frame(width)
    const drawn = draw(state, frame)
    this.hits = drawn.hits
    this.rows = drawn.rows
    const chosen = this.selection?.moved ? ordered(this.selection) : null
    return chosen
      ? highlighted(drawn.rows, chosen, width, this.selection?.within ?? null)
      : drawn.rows
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    const box = hitBoxAt(this.hits, event.x, event.y)
    const target = box?.target ?? null
    // How far along the thing you clicked the pointer landed. Only the hit
    // knows where it starts: a panel is centred, and what drew the row was
    // laid out long before it was put where it ended up.
    const cell = box ? event.x - box.from : 0
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
        // Dragging in the line you type on takes the selection with it, and
        // only while the pointer is still over one of its rows: off the end
        // of them it stays where it last was rather than jumping.
        if (event.type === 'drag' && this.selectingInput) {
          if (target?.kind !== 'input') return { handled: true, render: false }
          this.selectingInput = { dragged: true }
          return {
            handled: true,
            render: this.onPointer({
              kind: 'select',
              line: target.line,
              x: event.x,
              extend: false,
              drag: true,
            }),
          }
        }
        // Dragging in the file takes its selection with it, by the lines of
        // the file rather than the rows of the window — and off the top or
        // the bottom of it scrolls the file under the selection, because
        // that is the only way to reach past what is on screen with a mouse.
        if (event.type === 'drag' && this.selectingFile) {
          this.selectingFile = { dragged: true }
          const where = draggedInFile(this.hits, event.x, event.y)
          if (!where) return { handled: true, render: false }
          return {
            handled: true,
            render: this.onPointer(
              'line' in where
                ? { kind: 'select-file', line: where.line, cell: where.cell, how: 'drag' }
                : { kind: 'drag-file', rows: where.rows, cell: where.cell },
            ),
          }
        }
        if (event.type === 'drag' && this.selection) {
          this.selection = { ...this.selection, to: { x: event.x, y: event.y }, moved: true }
          return { handled: true, render: true }
        }
        return { handled: true, render: this.onPointer({ kind: 'move', target }) }
      case 'press': {
        // A divider taken hold of keeps every movement until it is let go.
        if (event.button === 'left' && target?.kind === 'divider') {
          this.dragging = true
          return { capture: true, render: this.onPointer({ kind: 'grab', edge: target.edge }) }
        }
        // So does a scrollbar. Where its track is on the screen is read back
        // out of the map: the region that drew it no longer knows where it ended up.
        if (event.button === 'left' && target?.kind === 'scrollbar') {
          this.dragging = true
          // A bar lying down is dragged by its column, and its track is the
          // columns it covers: the same sums, read the other way.
          const across = target.across === true
          return {
            capture: true,
            render: this.onPointer({
              kind: 'take',
              bar: { area: target.area, total: target.total, shown: target.shown, across },
              track: extentOf(this.hits, target, across),
              y: across ? event.x : event.y,
            }),
          }
        }
        // A right-click is a click the moment it is pressed: the terminal
        // reports no click for it, and a menu should not wait for a release.
        if (event.button === 'right' && target) {
          this.onPointer({
            kind: 'click',
            target,
            button: 'right',
            x: event.x,
            y: event.y,
            cell,
            clicks: 1,
          })
          return { handled: true }
        }
        if (event.button !== 'left') return undefined
        // The line you type on takes its own selection, so a press in it puts
        // the caret down rather than starting one across the window.
        if (target?.kind === 'input') {
          this.held = null
          this.selection = null
          this.selectingFile = null
          this.selectingInput = { dragged: false }
          return {
            handled: true,
            render: this.onPointer({
              kind: 'select',
              line: target.line,
              x: event.x,
              extend: event.shift,
              drag: false,
            }),
          }
        }
        // A file you have open takes its own selection too, in its own lines.
        if (target?.kind === 'caret') {
          this.held = null
          this.selection = null
          this.selectingFile = { dragged: false }
          return {
            handled: true,
            render: this.onPointer({
              kind: 'select-file',
              line: target.line,
              cell,
              how: event.shift ? 'extend' : 'put',
            }),
          }
        }
        this.selectingFile = null
        // An agent pressed may be about to be dragged somewhere else in the list.
        this.held = target?.kind === 'task' ? heldAgent(this.hits, target.task, event.y) : null
        // Anywhere that is not a control is text you might select — and only
        // ever within the one region it was started in.
        const area = scrollAt(this.hits, event.x, event.y)
        const across = area ? extentOf(this.hits, { kind: 'scroll', area }, true) : null
        this.selection = pressable(target)
          ? null
          : {
              from: { x: event.x, y: event.y },
              to: { x: event.x, y: event.y },
              moved: false,
              within:
                across && across.rows > 0
                  ? { from: across.top, to: across.top + across.rows - 1 }
                  : null,
            }
        return {
          handled: target !== null || this.selection !== null,
          render: this.onPointer({ kind: 'press', target }) || true,
        }
      }
      case 'release': {
        this.dragging = false
        this.held = null
        if (this.selectingInput?.dragged) this.onPointer({ kind: 'selected' })
        this.selectingInput = null
        // Only a drag copies, as on the line you type on: a shift+click and a
        // double click select, and leave the clipboard alone.
        if (this.selectingFile?.dragged) this.onPointer({ kind: 'selected-file' })
        this.selectingFile = null
        const chosen = this.selection?.moved ? ordered(this.selection) : null
        if (chosen) {
          const text = selectedText(this.rows, chosen, this.selection?.within ?? null)
          if (text.trim() !== '') this.onCopy(text)
        }
        // Kept lit until the next press, so you can see what was copied.
        if (!chosen) this.selection = null
        return { handled: true, render: this.onPointer({ kind: 'release' }) || chosen !== null }
      }
      case 'click':
        if (!target || (event.button !== 'left' && event.button !== 'right')) return undefined
        this.onPointer({
          kind: 'click',
          target,
          button: event.button,
          x: event.x,
          y: event.y,
          cell,
          clicks: event.clickCount ?? 1,
        })
        return { handled: true }
      case 'wheel': {
        // Swallowed wherever it lands, even over a corner of the window that
        // scrolls nothing. Tade draws exactly one screen and never scrolls
        // one, so a notch handed back is a notch the terminal library moves
        // its own viewport by — the whole window sliding, the line you type
        // on with it. The keys that did this are already taken back
        // (`freeViewportKeys`); the wheel is the one that was left.
        const area = scrollAt(this.hits, event.x, event.y)
        if (!area || !event.wheelDelta) return { handled: true, render: false }
        // How far a notch goes is the wheel's to say: what the terminal
        // counted, at a few rows each when they arrive apart and a row each
        // when they arrive in a run. Three rows for every notch of a flick is
        // what made a trackpad cross the screen three times over.
        // Shift turns the wheel sideways, as it does everywhere else.
        const rows = this.wheel.rows(area, event.wheelDelta, this.clock())
        if (rows === 0) return { handled: true, render: false }
        const region = extentOf(this.hits, { kind: 'scroll', area })
        const across = extentOf(this.hits, { kind: 'scroll', area }, true)
        return {
          handled: true,
          render: this.onPointer({
            kind: 'wheel',
            area,
            rows,
            shift: event.shift,
            reach: reachOf(this.hits, area),
            sideways: reachOf(this.hits, area, true),
            at: { column: event.x - across.top, row: event.y - region.top },
          }),
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
  /** Tell it something without cutting across what it is doing: after its turn, if it is on one. */
  tell?(text: string): Promise<void>
  /**
   * How hard it thinks, from its next reply on. Its conversation carries on:
   * the level is asked of the process it is already in, never a restart.
   */
  setThinking?(level: string): Promise<void>
  /**
   * Stop the turn it is on. Not stopping it: the conversation, its session and
   * everything it has already said stay exactly as they are, and the next
   * thing you say carries on from there.
   */
  interrupt?(): Promise<void>
  /** What its harness can be asked of a turn in flight, in `offer()`'s words. */
  offers?: ThinkerOffers
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
  /** Tade's state directory, where generated earcons are kept. */
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
   * Where Tade's own trouble goes. The window reports what it cannot show
   * you: a look at the tasks that took far longer than the time between two.
   */
  report?: Reporter
  /**
   * Start the orchestrator again, on what the config now says, carrying on its
   * conversation. Without it, a new model applies when Tade next starts.
   */
  restartThinker?: () => Promise<void>
  /** What the orchestrator could run on, as its own harness offers them. */
  orchestratorModels?: () => Promise<ModelChoice[]>
  /**
   * Restart the window with the same arguments so changes can be tried live.
   * The callback should stop the app, release the home lock, and re-exec.
   */
  reloadWindow?: () => Promise<void>
  /**
   * The tools Tade wrote for itself, to list. Whether each is on is a
   * setting, which the window reads and writes like any other.
   */
  written?: () => { name: string; why: string; path: string }[]
  /** Extensions and servers each harness loads by itself, which Tade lists but does not run. */
  harnessExtensions?: () => Promise<{ name: string; where: string }[]>
  /**
   * The MCP servers Tade has been told about — the catalogue's among them,
   * all off until somebody says otherwise. Read again whenever the extensions
   * are, because turning one on is a setting like any other.
   */
  mcpServers?: (config: Config) => readonly McpServerShown[]
  now?: () => number
  frameMs?: number
}

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
  /** The size each lane was last made, so resizing happens once per change. */
  private readonly fitted = new Map<string, string>()
  private titled = ''
  /** When the title was last written, so a stolen one is taken back. */
  private titledAt = 0
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
  /**
   * What the driver says about the two screens in front — how far back each
   * goes, and where typing lands in it. Read beside the capture, because a
   * scrollbar drawn from one frame's text and another frame's depth jumps.
   */
  private paneView: LaneView | null = null
  private terminalView: LaneView | null = null
  /**
   * The lines each of those two screens was last read as, and how deep the
   * read went — what the wheel cuts a new screen out of, through `cutFrom`.
   */
  private readonly held = new Map<'pane' | 'terminal', HeldLines>()
  /** A terminal's scrollback, read for finding in it. */
  private findText: { id: string; lines: string[] } | null = null
  private statuses: NonNullable<Frame['statuses']> = []
  /** The sections extensions keep in the sidebar, as they last answered. */
  private listSections: ListSection[] = []
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
  /** What you said to Tade, oldest first. */
  private history: string[] = []
  /** pi's own editor, for the orchestrator's line. */
  private readonly editor: Editor
  /**
   * What is selected on that line: where the selection was started, and where
   * the caret has since taken it. The editor holds the text and the caret —
   * this is the one thing it has no idea about, so the head is read back out
   * of it rather than remembered, and only the anchor is kept.
   */
  private anchor: number | null = null
  /**
   * The line's rows as they were last drawn, and where each starts in the
   * text: what a click on a row and a selection up or down a row are counted
   * in. Read back out of what was drawn, because the editor wraps and scrolls
   * the text its own way.
   */
  private inputRows: RowStart[] = []
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
  /** A drag held off the top or bottom of the file: it goes on scrolling until it is let go. */
  private draggingFile: NodeJS.Timeout | null = null
  private screen = ''
  private recording: Recording | null = null
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
  /** Every file in every place search looks, and when they were listed. */
  private searchFiles: { at: number; files: { root: SearchRoot; path: string }[] } | null = null
  /**
   * Tasks whose checks the window is running now, and when it asked, so a
   * second press waits and the page says it is going before the run has had
   * time to write anything down.
   */
  private readonly runningChecks = new Map<string, number>()
  /** Lines found inside files, for the text they were found for. */
  private grepped: { text: string; matches: Match[] } = { text: '', matches: [] }
  private grepping: string | null = null
  private grepTimer: NodeJS.Timeout | null = null
  /** Search's results for the last query, so a redraw does not rank every file again. */
  private results: { key: string; entries: SearchEntry[] } | null = null
  /**
   * What somebody made of the last sentence typed into search, and which
   * sentence it was about: shown only while that sentence is still in the box,
   * because an answer to what was there before moves the list under your hands.
   */
  private meant: { said: string; entries: SearchEntry[] } | null = null
  private askingAbout: string | null = null
  private askingWith: AbortController | null = null
  private askTimer: NodeJS.Timeout | null = null
  /** The models an agent can be started on, once they have been read. */
  private models: ModelChoice[] = []
  /**
   * The models the open picker offers, when it is for one agent: its
   * harness's, which are not the orchestrator's or another harness's.
   */
  private pickerModels: ModelChoice[] | null = null
  /** Providers the harness is signed in to, once read. */
  private accounts: string[] = []
  /**
   * Every account agents can run as, as each harness last said: asked in the
   * background, and again after anything is done to one.
   */
  private accountViews: AccountView[] = []
  /**
   * What the Updates page last read: which of the programs Tade runs are
   * here, and — once somebody pressed the button — what is current. Null
   * until the page is opened, because none of it is worth reading before.
   */
  private updates: UpdateLook | null = null
  /** A check is going. The only thing on that page that touches the network. */
  private updatesBusy = false
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
  /** Tasks whose rule was met and is being written down, so it is written once. */
  private readonly marking = new Set<string>()
  /** Queued work being started now, so a refresh in the middle does not start it twice. */
  private readonly startingQueued = new Set<string>()
  /** The queue pass under way, if one is. */
  private advancing: Promise<string[]> | null = null
  /** The schedules pass under way, if one is. */
  private scheduling: Promise<void> | null = null
  /** When each schedule was last run from this window, before the journal says so. */
  private readonly fired = new Map<string, number>()
  /** Watches looking now, so a slow look is never started twice. */
  private readonly lookingWith = new Map<string, Promise<string>>()
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
      { paddingX: INPUT_PAD },
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
    return handOffFiles(this.answering, cwd)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    if (this.soon) clearTimeout(this.soon)
    this.stopDraggingFile()
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
        // Only what is not what a window starts at, exactly as a dragged size
        // is: a file that wrote down today's defaults would freeze them, and
        // the day `FOLDED_AT_START` changes nobody who had ever moved a
        // divider would see it. So `[]` is written down — you opened the one
        // section that starts folded, and that is a choice — while `['notes']`
        // is not, because it is not one.
        ...(this.state.hidingDone ? { hidingDone: true } : {}),
        ...(sameSections(this.state.folded, FOLDED_AT_START) ? {} : { folded: this.state.folded }),
        ...(this.state.opened.length > 0 ? { opened: this.state.opened } : {}),
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
      case 'schedule': {
        const one = this.scheduleViews().find((view) => view.id === subject.id)
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
        return accountMenuItems(this.accountViews, this.harnessShown(subject.task), subject.current)
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
        settings: this.settingRows(),
        accounts: this.accountViews,
        updates: this.updates,
        updatesBusy: this.updatesBusy,
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
      actions: this.state.focused
        ? (() => {
            const seen = live.actions(this.state.focused, this.reviewOf(this.state.focused))
            if (!seen) return null
            const asked = this.runningChecks.get(seen.task)
            // A run writes down what it is doing as it does it; between the
            // press and the first check starting there is nothing written,
            // and a button that does nothing for a second is a button people
            // press twice.
            if (seen.running || asked === undefined) return seen
            return {
              ...seen,
              running: { since: asked, by: 'you', done: 0, total: seen.checks.length },
            }
          })()
        : null,
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
        credential: provider ? credentialLabel(this.credentials[provider]) : null,
      },
      vitals: live.vitals(this.state.focused),
      offers: this.state.focused ? (this.offersByTask.get(this.state.focused) ?? null) : null,
      spendView,
      panel: this.panelFacts(live, width),
      voice: {
        keys: keyCaps(this.opts.config.surfaces.voice.talk.key),
        available: this.opts.recorder !== undefined,
      },
      terminal: {
        screen: this.terminalScreen,
        find: this.findView(),
        view: this.terminalView,
      },
      paneScreen: this.paneView,
      home: tilde(this.opts.home),
      linkers: this.linkers,
      orchestratorModel: this.thinkerModel(),
      orchestratorThinking: this.opts.config.orchestrator.thinking ?? null,
      orchestratorAccount: this.thinkerAccount(),
      orchestratorOffers: this.thinker?.offers ?? null,
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
      schedules: this.scheduleViews(),
      clock: (at: number) => whenShort(at, this.now()),
      date: (at: number) => this.dateOf(at),
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
        // The picture of a chain only ever moves sideways, so the wheel over
        // it does, shift or no shift: there is nothing above or below it.
        // Somewhere with nowhere to go sideways hands the wheel back rather
        // than swallowing it, and it scrolls as it would without shift.
        if (!panel && (event.shift || event.area === 'plan')) {
          const moved = scrollBy(this.state, event.area, event.rows, event.sideways, true)
          if (moved !== this.state) {
            this.state = moved
            return true
          }
        }
        if (event.area === 'panel' && panel?.kind === 'file') {
          // Over a file the wheel scrolls it. It cannot be the down key here:
          // with a caret in the text, that key moves the caret.
          this.state = { ...this.state, panel: scrollFile(panel, event.rows, this.fileLines()) }
          return true
        }
        // A panel that is a list rather than a page has nothing to scroll:
        // the wheel over it moves what is chosen, which is what its down key
        // does. A row a notch, never the notch's rows — a flick through a
        // list of models is not a request to visit forty of them.
        if (event.area === 'panel' && panel && !('scroll' in panel)) {
          const outcome = panelKey(panel, event.rows > 0 ? 'down' : 'up', '', this.panelInputs())
          this.state = { ...this.state, panel: outcome.panel }
          return true
        }
        // An open panel is in front of everything: the wheel beside it moves
        // nothing behind it, however much of the window is still drawn there.
        if (panel && event.area !== 'panel' && event.area !== 'panel-side') return false
        // A lane whose program took the whole screen keeps no scrollback for
        // the window to move, and the ones that do it ask for the mouse so
        // they can answer the wheel themselves. So it gets the wheel, and
        // scrolls its own conversation. Nothing here changes: what it does
        // with it is read back on the next look, like everything else it draws.
        if (this.turnedInLane(event)) return false
        // Everywhere else: the one move, clamped to what the last frame said
        // the region actually is. Nothing is laid out again to find that out.
        const moved = scrollBy(this.state, event.area, event.rows, event.reach)
        if (moved === this.state) return false
        this.state = moved
        if (event.area === 'pane' || event.area === 'terminal') {
          // A lane's screen is read from the driver, so the wheel would leave
          // the text where it was until the next look while the bar beside it
          // had already moved. Cut the lines we hold to where it now is, and
          // ask for more only when it has gone past them.
          this.reslice(event.area)
          this.soonTick()
        }
        return true
      }
      case 'grab':
        this.state = { ...this.state, resizing: event.edge }
        return true
      case 'take':
        this.state = grabBar(this.state, event.bar, event.track, event.y)
        // A screen scrolled back is read further back than it is tall: ask for
        // the lines now rather than at the next beat.
        if (event.bar.area === 'pane' || event.bar.area === 'terminal') {
          this.reslice(event.bar.area)
          this.soonTick()
        }
        return true
      case 'drag': {
        const bar = this.state.scrolling
        if (bar) {
          this.state = scrollBarTo(this.state, event.y)
          if (bar.area === 'pane' || bar.area === 'terminal') {
            // As the wheel does: the text goes with the thumb rather than a
            // look behind it, and what the held lines cannot reach is asked for.
            this.reslice(bar.area)
            this.soonTick()
          }
          return true
        }
        if (!this.state.resizing) return false
        if (this.state.resizing === 'split' || this.state.resizing === 'terminal-split') {
          this.state = this.dragSplit(this.state.resizing, event)
          return true
        }
        this.state = resizeTo(this.state, event, { height: Math.max(6, this.terminal.rows) })
        return true
      }
      case 'move': {
        if (sameTarget(this.state.hover, event.target)) return false
        const shapeOf = (target: Target | null) =>
          target?.kind === 'divider'
            ? target.edge === 'sidebar'
              ? 'ew-resize'
              : 'ns-resize'
            : // Text you can put the caret in: the shape everything else uses for that.
              target?.kind === 'caret' || target?.kind === 'input'
              ? 'text'
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
        this.stopDraggingFile()
        if (this.state.scrolling) {
          this.state = { ...this.state, scrolling: null, pressed: null }
          return true
        }
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
        this.clicked(event.target, event.button, {
          x: event.x,
          y: event.y,
          cell: event.cell,
          clicks: event.clicks,
        })
        return true
      case 'select':
        this.selectTo(event.line, event.x, event.extend, event.drag)
        return true
      case 'selected': {
        const selected = this.selectionSpan()
        if (selected)
          void this.copySelection(this.editor.getText().slice(selected.from, selected.to))
        return false
      }
      case 'select-file':
        this.stopDraggingFile()
        this.selectInFile(event.line, event.cell, event.how)
        return true
      case 'drag-file':
        this.dragFileOn(event.rows, event.cell)
        return true
      case 'selected-file': {
        this.stopDraggingFile()
        const text = this.fileSelectionText()
        if (text !== null && text.trim() !== '') void this.copySelection(text)
        return false
      }
    }
  }

  /**
   * The caret put where the pointer is in the file, with whatever the press
   * meant for the selection behind it. It goes through the panel, like every
   * other click on it: what a press means to a file is the panel model's, and
   * what is selected lives there beside the caret.
   */
  private selectInFile(line: number, cell: number, how: string): void {
    const panel = this.state.panel
    if (panel?.kind !== 'file') return
    this.applyPanel(panelClick(panel, `caret:${line}:${cell}:${how}`, this.panelInputs()))
  }

  /**
   * A drag held off the top or the bottom of the file: it scrolls under the
   * selection, as far past the edge as the pointer is and on until it is let
   * go — the pointer sitting still off the end still reports nothing, and a
   * selection that stopped there could never reach past one screen.
   */
  private dragFileOn(rows: number, cell: number): void {
    this.stopDraggingFile()
    this.draggingFile = setInterval(() => this.dragFile(rows, cell), EDGE_MS)
    this.draggingFile.unref?.()
    // After the timer, so the first step can stop it where there is nothing
    // left to scroll.
    this.dragFile(rows, cell)
  }

  private stopDraggingFile(): void {
    if (this.draggingFile) clearInterval(this.draggingFile)
    this.draggingFile = null
  }

  /** One step of that: the file scrolled, and the selection reaching the new edge. */
  private dragFile(rows: number, cell: number): void {
    const panel = this.state.panel
    if (this.stopped || panel?.kind !== 'file' || !panel.edit) {
      this.stopDraggingFile()
      return
    }
    const scrolled = scrollFile(panel, rows, this.fileLines())
    const body = this.fileBody(panel).rows
    const line =
      rows < 0 ? scrolled.scroll : Math.min(scrolled.scroll + body - 1, panel.edit.lines.length - 1)
    this.applyPanel(panelClick(scrolled, `caret:${line}:${cell}:drag`, this.panelInputs()))
    // The end of the file: the selection has reached as far as it goes, and a
    // timer that redraws the same screen twelve times a second for the rest
    // of the drag is a window working for nothing.
    if (scrolled.scroll === panel.scroll) this.stopDraggingFile()
  }

  /** What is selected in the file, as its text, or nothing when nothing is. */
  private fileSelectionText(): string | null {
    const panel = this.state.panel
    if (panel?.kind !== 'file' || !panel.edit) return null
    const selected = fileSelection(panel)
    return selected ? textOf(panel.edit.lines, selected) : null
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
    const { sidebarWidth, stripHeight, order, hidingDone, folded, opened } = this.remembered ?? {}
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
        if (this.seenTasks) {
          for (const text of taskNews(this.seenTasks, tasks)) {
            this.news = addNews(this.news, text, this.now())
          }
        }
        this.seenTasks = tasks
        void this.learnHarnesses(tasks)
        void this.recordRulesMet()
        void this.runSchedules().then(() => this.advanceQueue())
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
    this.voice = await VoiceSurface.start({
      tade: this.opts.client,
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
        () => this.now(),
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
    // should reach an agent. ctrl+c still closes Tade, as it does everywhere.
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
        // Pasted over a selection, as typing over one: it replaces it.
        this.removeSelection()
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
          'tab switches · ctrl+space talks · a/d answers · ctrl+c clears, then quits',
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
          this.anchor = null
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
      case 'interrupt':
        void this.interruptThinker()
        return { consume: true }
      case 'leave-line':
        // Only ever reached with nothing on the line, so nothing is lost.
        this.anchor = null
        this.state = setListening(setDictation(this.state, null), false)
        this.draw()
        return { consume: true }
      case 'discard':
        this.discardLine()
        return { consume: true }
      case 'quit':
        this.quit()
        return { consume: true }
      default:
        break
    }

    // A terminal with the keyboard gets every keystroke Tade did not keep.
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
   * driving Tade that behaves differently. Nothing here types a command for
   * you to finish — what needs more than a click opens a panel.
   */
  private clicked(
    target: Target,
    button: 'left' | 'right' = 'left',
    at: { x: number; y: number; cell?: number; clicks?: number } = { x: 0, y: 0 },
  ): void {
    if (this.state.panel) {
      this.clickPanel(target, at.cell ?? 0, at.clicks ?? 1)
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
        // Queued work is not started by looking at it: clicking it shows what
        // it waits on, what its agent will be told and where it came from.
        // Starting it is a button on that screen, and its menu's Start now.
        if (pane?.queued) break
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
      case 'pane-tab':
        this.state = viewActions(this.state, target.task)
        break
      case 'check':
        // Reading a failure is what the page is for: it opens there, and the
        // whole log is a button inside it.
        this.state = toggleCheck(this.state, target.task, target.check)
        break
      case 'task-menu':
        this.openMenu({ kind: 'task', task: target.task }, at)
        return
      case 'note':
        // A note cut short down the side is read whole on its own page, which
        // is also where it is changed and taken back. A click is for reading
        // it; the ≡ beside it is what asks for the menu.
        this.openNote({ at: target.at, text: target.text })
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
        // What the heading under the pointer said it was, so a section that
        // folds itself away opens and stays open rather than closing again.
        this.state = toggleSection(this.state, target.section, target.quiet === true)
        // Written where it was chosen, as a dragged divider is: a window that
        // was killed rather than closed still opens the way you left it.
        this.remember()
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
      case 'input': {
        // A click in what you have typed puts the caret there, as it does in
        // any text box; a second press takes the word it is in and a third
        // the whole line, which is what every other text box does too.
        this.caretAt(target.line, at.x)
        const taken = clickedSpan(this.editor.getText(), this.caretOffset(), at.clicks ?? 1)
        this.anchor = taken.to > taken.from ? taken.from : null
        if (taken.to > taken.from) this.moveCaretTo(taken.to)
        break
      }
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
      await this.closeAgent(action.slice('close-task:'.length))
      return
    }
    if (action.startsWith('checks-adopt:')) {
      await this.adoptChecks(action.slice('checks-adopt:'.length))
      return
    }
    if (action.startsWith('check-log:')) {
      const [task, check] = action.slice('check-log:'.length).split('\u0000')
      if (task && check) await this.showCheck(task, check)
      return
    }
    if (action.startsWith('checks-run:')) {
      await this.runChecks(action.slice('checks-run:'.length))
      return
    }
    if (action.startsWith('list-row:')) {
      const [section, id] = action.slice('list-row:'.length).split('\u0000')
      await this.openListRow(section ?? '', id ?? '')
      return
    }
    const scheduling = /^schedule-(open|run|pause|resume|remove|rename):(.+)$/.exec(action)
    if (scheduling?.[1] && scheduling[2]) {
      await this.onSchedule(scheduling[2], scheduling[1])
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
      await this.changeQueue(queued[2], queued[1])
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
      case 'toggle-done':
        this.state = toggleDone(this.state)
        // Written here and not only on the way out: the window you press this
        // in is the window you leave open for days, and one that was killed
        // rather than closed would forget it every time.
        this.remember()
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
        // Back to the newest line, and the text goes there with the bar: the
        // lines held may already reach it, and the look catches up if not.
        this.reslice('pane')
        this.soonTick()
        return
      case 'terminal-end':
        this.state = { ...this.state, terminalScroll: 0 }
        this.reslice('terminal')
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
        if (pane?.queued) await this.changeQueue(pane.task, 'start')
        else await this.openAgent()
        return
      }
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

  private clickPanel(target: Target, cell = 0, clicks = 1): void {
    const panel = this.state.panel
    if (!panel) return
    if (target.kind === 'caret') {
      // The press already put the caret in the file — which line is the hit's,
      // and which character of it is how far along the hit the click landed,
      // which the panel turns into a column: it knows about tabs and about how
      // far the body has slid to keep the caret on screen. What a click adds
      // is the second and third press, which take the word and the line; a
      // first press read again here would undo a shift+click behind it.
      if (clicks >= 2) this.selectInFile(target.line, cell, clicks >= 3 ? 'line' : 'word')
      return
    }
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
    if (outcome.panel?.kind === 'search') {
      this.lookInFiles()
      this.askWhatIsMeant()
    }
    // The Updates page reads the machine when it is opened, and asks the
    // network only when the button on it is pressed.
    if (outcome.panel?.kind === 'settings' && outcome.panel.category === UPDATES) {
      void this.lookAtWhatIsInstalled()
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
        await this.fromSearch(choice ?? '')
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
          const text = this.fileSelectionText()
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
          if (path !== undefined) await this.saveSetting(panel, path, value ?? '')
          return
        }
        if (choice === 'open-file') {
          this.state = { ...this.state, panel: null }
          await this.openPlace({ path: this.configPath })
          return
        }
        if (choice?.startsWith('account:')) await this.accountAction(choice)
        if (choice?.startsWith('updates:')) await this.updateAction(choice)
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
      ['run:keys', 'Shortcuts'],
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
    for (const group of this.settingRows()) {
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
      this.meant?.said === panel.query ? this.meant.entries.length : -1,
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
          ...(this.meant?.said === panel.query ? { meant: this.meant.entries } : {}),
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

  /**
   * Put a sentence to whoever reads sentences, a moment after typing stops.
   *
   * Only a sentence, and only one whose letters found nothing — search matches
   * letters, and that is still what answers first and what answers instantly.
   * This can only ever add rows to what is already there, and if it is late,
   * or wrong, or nobody answers, search is what it has always been.
   */
  private askWhatIsMeant(): void {
    const panel = this.state.panel
    if (panel?.kind !== 'search') return
    const said = panel.query
    const host = this.opts.extensions
    if (!host) return
    if (this.meant?.said === said || this.askingAbout === said) return
    if (!worthAsking(said, this.searchEntries())) return
    if (this.askTimer) clearTimeout(this.askTimer)
    this.askTimer = setTimeout(() => {
      const choices = shortlist(said, this.searchable(), MEANT_CHOICES)
      if (choices.length === 0) return
      this.askingAbout = said
      // Whatever was being asked about the line before this one is not wanted
      // now: they have typed since, and are looking at something else.
      this.askingWith?.abort()
      const stop = new AbortController()
      this.askingWith = stop
      void host
        .meant({
          said,
          choices: choices.map((entry) => ({
            id: entry.id,
            label: entry.label,
            ...(entry.detail ? { detail: entry.detail } : {}),
          })),
          signal: stop.signal,
        })
        .then((answer) => {
          if (this.askingAbout !== said) return
          // What was typed while it was thinking is what they are looking at
          // now, and this is not about that.
          const panel = this.state.panel
          if (panel?.kind !== 'search' || panel.query !== said) return
          const by = new Map(choices.map((entry) => [entry.id, entry]))
          const entries = answer.ids
            .map((id) => by.get(id))
            .filter((entry): entry is SearchEntry => entry !== undefined)
          this.meant = { said, entries }
          this.results = null
          for (const problem of answer.problems) this.state = notice(this.state, problem)
          this.draw()
        })
        .catch((err: unknown) => {
          // Never the reason search shows nothing: it shows what it always did.
          this.state = notice(this.state, why(err))
        })
        .finally(() => {
          if (this.askingAbout === said) this.askingAbout = null
        })
    }, 250)
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
                : subject.kind === 'account'
                  ? 'Account'
                  : subject.kind === 'lane'
                    ? subject.name
                    : subject.kind === 'thinking'
                      ? 'Thinking'
                      : subject.kind === 'note'
                        ? 'Note'
                        : subject.kind === 'schedule'
                          ? (this.scheduleViews().find((one) => one.id === subject.id)?.name ??
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
        return this.giveImages(subject.paths, item)
      case 'harness':
        return this.chooseHarness(subject.task, item)
      case 'account':
        return this.chooseAccount(subject.task, item)
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
  private openNote(note: { at: string; text: string }): void {
    const kept = this.opts.client
      .recallAll()
      .find((one) => one.at === note.at && one.text === note.text)
    this.state = {
      ...this.state,
      panel: notePanel(
        {
          at: note.at,
          summary: kept?.summary ?? null,
          scope: kept?.scope ?? null,
          by: kept?.by ?? 'unknown',
        },
        note.text,
      ),
    }
    this.draw()
  }

  /** What a note's menu does: open it, copy its words, or forget it. */
  private async fromNoteMenu(note: { at: string; text: string }, item: string): Promise<void> {
    if (item === 'edit') {
      this.openNote(note)
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
    await this.loadAccountViews()
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

  /** Mute everything Tade says and plays, or bring it back; kept for next time. */
  private async toggleMute(): Promise<void> {
    const muted = !this.opts.config.surfaces.voice.muted
    try {
      writeSetting(this.configPath, 'surfaces.voice.muted', muted ? true : undefined)
    } catch {
      // Not writable: muted for this window only.
    }
    this.useConfig({
      ...this.opts.config,
      surfaces: {
        ...this.opts.config.surfaces,
        voice: { ...this.opts.config.surfaces.voice, muted },
      },
    })
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
      this.forgetNote(note)
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
        await this.signInto(harness, name)
        await this.loadAccountViews()
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
        await this.loadAccountViews()
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

  /**
   * A choice about queued work made in the window: written down as yours, and
   * acted on at once rather than at the next look — pressing Start and waiting
   * two seconds for anything to happen reads as broken.
   */
  private async changeQueue(task: string, change: string): Promise<void> {
    try {
      // "Do this one first" is an order written like any other: this task in
      // front of whatever order the queue is already in.
      const live = this.live
      const order =
        change === 'first' && live ? orderFirst(live.queued, live.queueFacts().events, task) : []
      const answer = await this.queueTools().change(
        change === 'first' ? { change: 'order', order, by: 'you' } : { task, change, by: 'you' },
      )
      this.state = notice(this.state, answer)
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  private async fromTaskMenu(task: string, item: string): Promise<void> {
    const facts = this.live?.factsOf(task)
    const worktree = this.live?.worktreeOf(task)
    if (item.startsWith('queue-')) {
      await this.changeQueue(task, item.slice('queue-'.length))
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
        await this.loadAccountViews()
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
   * so the line behaves as pi's does. Enter sends it; escape stops whatever is
   * thinking and never touches it, and ctrl+c is what throws it away.
   *
   * What is selected is Tade's own, because the editor has no idea there is
   * a selection: the few keys a selection changes the meaning of are
   * answered here — backspace takes the selection rather than a character,
   * ctrl+a takes all of it, shift and an arrow reach further — and
   * everything that puts text in replaces what was selected first.
   */
  private type(data: string): void {
    if (isKeyRelease(data)) return
    const key = parseKey(data)
    // Searching back through what you said: the search has the keys until it ends.
    if (this.state.historySearch) {
      const searched = searchKey(this.state, this.history, key, data)
      this.state = searched.state
      if (!this.state.historySearch) {
        this.editor.setText(this.state.dictation ?? '')
        this.anchor = null
      }
      if (searched.send) this.submit()
      else this.draw()
      return
    }
    if (key === 'ctrl+r') {
      this.anchor = null
      this.state = startHistorySearch(setDictation(this.state, this.editor.getText()), this.history)
      this.draw()
      return
    }
    if (key === 'enter') {
      this.submit()
      return
    }
    if (key === 'escape') {
      // Never the line. Escape is how every harness stops what is thinking —
      // pi, Claude Code and Codex all interrupt on it and all leave the editor
      // untouched — and `keyAction` has already spent it on the turn if there
      // was one to stop. Here there was not, so nothing happens: losing a
      // half-written message to the key you press when you want something to
      // stop is the worst version of this. ctrl+c is what throws it away.
      return
    }
    if (!this.selectionKey(key ?? null)) {
      // A letter, or a line break: what is selected is what it replaces.
      // Anything else the editor has its own mind about, and a selection
      // nobody can see the point of any more is let go of.
      if (printable(data) || key === 'shift+enter' || key === 'alt+enter') this.removeSelection()
      else this.anchor = null
      this.editor.handleInput(data)
    }
    this.state = setDictation(this.state, this.editor.getText())
    this.draw()
  }

  /**
   * The keys a selection changes the meaning of, answered against what is
   * selected. True when the key was spent here and the editor must not also
   * see it.
   */
  private selectionKey(key: string | null): boolean {
    const what: LineKey | null = lineKey(key === null ? null : normalKey(key))
    if (!what) return false
    const text = this.editor.getText()
    const selected = this.selectionSpan()
    switch (what.do) {
      case 'select all':
        this.anchor = 0
        this.moveCaretTo(text.length)
        return true
      case 'delete':
        // With nothing selected it is the editor's own backspace, a grapheme
        // or a whole paste marker at a time.
        if (!selected) {
          this.anchor = null
          return false
        }
        this.removeSelection()
        return true
      case 'move':
        return this.moveOrExtend(what, selected, text)
    }
  }

  /**
   * An arrow, home or end, with or without shift. Shift takes the selection
   * with the caret; without it a selection is let go of, and collapses to the
   * end the caret was sent towards rather than moving on from where it was.
   */
  private moveOrExtend(
    what: Extract<LineKey, { do: 'move' }>,
    selected: Span | null,
    text: string,
  ): boolean {
    if (!what.extend) {
      this.anchor = null
      if (!selected || what.by !== 'char') return false
      this.moveCaretTo(what.back ? selected.from : selected.to)
      return true
    }
    if (this.anchor === null) this.anchor = this.caretOffset()
    if (what.by === 'row') {
      this.moveCaretTo(this.rowStep(what.back, text))
      return true
    }
    // A page is more than this line has, however many rows it wraps to: it
    // reaches the end it was sent towards, which is what a text box shorter
    // than a page does.
    if (what.by === 'page') {
      this.moveCaretTo(what.back ? 0 : text.length)
      return true
    }
    const key =
      what.by === 'word'
        ? what.back
          ? 'alt+left'
          : 'alt+right'
        : what.by === 'line'
          ? what.back
            ? 'home'
            : 'end'
          : what.back
            ? 'left'
            : 'right'
    // The move itself is the editor's: it knows what a word is to it, and
    // where its own lines wrap.
    this.editor.handleInput(sequenceFor(key))
    return true
  }

  /**
   * Where the caret lands a row up or down: the same column of the row
   * before or after the one it is on, counted in the rows the line was last
   * drawn as — past the first is the very start, past the last is the very
   * end, which is what a text box does. The editor's own up and down are not
   * used here: on the first row up is how you reach what you said last, and
   * shift held is no reason to go looking through the history.
   */
  private rowStep(back: boolean, text: string): number {
    const at = this.caretOffset()
    const rows = this.inputRows.filter((row) => row.at !== null)
    let index = -1
    rows.forEach((row, i) => {
      if ((row.at ?? 0) <= at) index = i
    })
    const to = rows[index + (back ? -1 : 1)]
    if (index < 0 || !to || to.at === null) return back ? 0 : text.length
    const column = at - (rows[index]?.at ?? 0)
    return Math.min(to.at + column, to.at + to.length)
  }

  /** Where the editor's caret is, as one offset into the text. */
  private caretOffset(): number {
    return caretOf(this.editor)
  }

  /** What is selected on the line, in reading order, or nothing. */
  private selectionSpan(): Span | null {
    if (this.anchor === null) return null
    const length = this.editor.getText().length
    const selection: Selection = {
      anchor: Math.max(0, Math.min(this.anchor, length)),
      head: this.caretOffset(),
    }
    return spanOf(selection)
  }

  /** Put the editor's caret at an offset, by the keys that move it. */
  private moveCaretTo(offset: number): void {
    putCaret(this.editor, offset)
  }

  /** Take out what is selected, if anything is. */
  private removeSelection(): boolean {
    const selected = this.selectionSpan()
    this.anchor = null
    if (!selected) return false
    cutSpan(this.editor, selected)
    return true
  }

  /**
   * The caret where the pointer is, and the selection with it: a press starts
   * one where it landed, shift held reaches there from where the caret
   * already was, and every drag after the press takes it further.
   */
  private selectTo(line: number, x: number, extend: boolean, drag: boolean): void {
    const was = this.caretOffset()
    this.caretAt(line, x)
    if (drag) this.anchor = this.anchor ?? was
    else this.anchor = extend ? (this.anchor ?? was) : this.caretOffset()
  }

  /**
   * The caret at a column of one of the line's rows. The editor works the
   * column out itself, from the same rows it drew: it knows where its own
   * padding and wrapping are.
   */
  private caretAt(line: number, x: number): void {
    this.editor.handleMouse({
      type: 'click',
      button: 'left',
      x,
      // Its own rows: the rule it draws above the text, then the lines.
      y: line + 1,
      screenX: x,
      screenY: 0,
      width: this.terminal.columns,
      height: this.terminal.rows,
      shift: false,
      alt: false,
      ctrl: false,
    })
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
   * Throw away what you were about to send: the line, the pictures going with
   * it, and a search you were part-way through. The keyboard stays where it
   * is, so the next thing you type lands on the same line.
   *
   * Pressed again there is nothing left to throw away, and ctrl+c does what
   * it does everywhere else in Tade and closes it — which is pi's, Claude
   * Code's and Codex's "clear input, then quit", without a timer deciding
   * whether your second press counted.
   */
  private discardLine(): void {
    this.anchor = null
    this.editor.setText('')
    // Emptied, never closed: only ever reached with the line open, and the
    // keyboard stays on it.
    this.state = setDictation({ ...this.state, attached: [], historySearch: null }, '')
    // Nothing is said about it: the line says what ctrl+c does next, and
    // clearing your own line is not something the conversation should record.
    this.draw()
  }

  /**
   * Hand what was said to the surface, which works out who you meant.
   *
   * Sending empties the line; it never closes it. The keyboard is on the
   * orchestrator because you put it there, and one message is rarely all you
   * have to say — a line that closed itself dropped the next sentence into
   * whichever agent happened to be in front of you. Escape is what leaves an
   * empty one, and ctrl+c is what empties it.
   */
  private submit(): void {
    this.syncLine()
    const said = this.editor.getExpandedText().trim()
    this.editor.setText('')
    this.anchor = null
    // Emptied where it was open. Closed only where it never was: push-to-talk
    // that ends with nothing to transcribe comes through here too, and that
    // is not you typing.
    const open = this.state.dictation !== null
    this.state = setListening(
      setDictation({ ...this.state, historySearch: null }, open ? '' : null),
      false,
    )
    this.draw()
    // A command is carried out here; anything else is a sentence for Tade.
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
      this.voice?.flushSpeech()
    }
  }

  /** Everything addressed to Tade arrives here, however it was said. */
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

    // A line beginning "tade " is addressed to Tade, not to the agent.
    const routed = route(this.router, data)
    this.router = routed.state
    this.state = setHeld(this.state, pending(this.router))

    const lane = pane ? typingLane(this.state, pane) : null
    if (routed.toLane !== '' && lane) {
      void this.opts.client.write(lane as LaneId, routed.toLane).catch(() => {})
    }
    if (routed.toTade !== null) this.say(routed.toTade)
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
    this.lookAtClipboard()
    if (this.now() - this.repaintedAt >= REPAINT_MS) {
      this.repaintedAt = this.now()
      this.repaint()
    }
    const pane = this.state.panes.find((p) => p.task === this.state.focused)
    const lane = pane ? laneShown(this.state, pane) : null
    const split = pane ? splitShown(this.state, pane) : null
    const halves = this.halves(this.paneSize(split !== null), split)
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
    this.title(pane ? `${pane.project} › ${shownName(pane)}` : this.state.project)
    // How deep the lane is, read before its text: which lines are held is
    // counted from the depth, so a screen cut against a depth from the frame
    // before it is a screen cut in the wrong place.
    // Only for the one screen the bar and the cursor are drawn on: a split is
    // two lanes and gets neither.
    const view = split ? null : ((await this.live?.screen(lane)) ?? null)
    if (!same(view, this.paneView)) {
      this.paneView = view
      this.draw()
    }
    const screen = await this.laneScreen('pane', lane, size.rows)
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

  /** Which of the two screens an area is, and where each keeps how far back it is. */
  private static readonly SCROLL_OF = {
    pane: 'paneScroll',
    terminal: 'terminalScroll',
  } as const

  /**
   * A lane's screen, cut to where it is scrolled to — read back from the
   * driver only when what is already held does not reach that far.
   *
   * Scrollback is the one thing about a lane that cannot change: the agent
   * appends, it never rewrites what it printed an hour ago. So a screen read
   * two thousand lines back is read once, and the wheel moving through it is
   * an array slice. What still has to be asked every look is the bottom,
   * where the agent is typing, and that is the cheap end.
   */
  private async laneScreen(
    area: 'pane' | 'terminal',
    lane: string | null,
    rows: number,
  ): Promise<string> {
    if (!lane) {
      this.held.delete(area)
      return ''
    }
    const which = App.SCROLL_OF[area]
    const at = (area === 'pane' ? this.paneView : this.terminalView)?.lines ?? 0
    // Never further back than there is to read: the wheel is clamped against
    // what the last frame drew, and this is the same clamp against what the
    // driver says now, for a lane that shrank or was relaunched under us.
    const most = Math.max(0, at - rows)
    if (at > 0 && this.state[which] > most) this.state = { ...this.state, [which]: most }
    const back = this.state[which]
    const held = this.held.get(area)
    if (held?.lane === lane && at >= held.at) {
      const cut = cutFrom(held, rows, back, at)
      if (cut !== null) return cut
    }
    // Room to move in before the driver has to be asked again — only once
    // there is scrollback in play, so a lane at its newest line costs what it
    // always did.
    const asked = rows + back + (back > 0 ? HELD_LINES : 0)
    const captured = (await this.live?.capture(lane, asked, this.skin.colour)) ?? ''
    const lines = captured.split('\n')
    // A capture ends at the newest line, so how many lines came back is what
    // says which lines they are. A lane with no depth of its own — half of a
    // split — has only its capture to count from.
    const read = { lane, lines, at: Math.max(at, lines.length), asked }
    this.held.set(area, read)
    return cutFrom(read, rows, back, read.at) ?? lines.slice(-rows).join('\n')
  }

  /**
   * A wheel that is the lane's to answer rather than the window's: turned in
   * it, and true when it was.
   *
   * Which it is comes from the lane, never from which harness is in it: a
   * shell with an editor open in it is the same situation as an agent that
   * draws its own conversation, and only the lane's own screen knows. The
   * driver was asked on the last look (`scrolling`), so this costs nothing.
   *
   * `nobody` — a program that took the screen and does not want the mouse —
   * is still the lane's, and still true: there is nothing to scroll and
   * moving something else instead would be worse than doing nothing.
   */
  private turnedInLane(event: Extract<PointerEvent, { kind: 'wheel' }>): boolean {
    if (event.area !== 'pane' && event.area !== 'terminal') return false
    const view = event.area === 'pane' ? this.paneView : this.terminalView
    if (!view || view.scrolling === undefined || view.scrolling === 'window') return false
    const lane = event.area === 'pane' ? this.paneLane() : (activeTerminal(this.state)?.id ?? null)
    if (view.scrolling === 'lane' && lane) {
      void this.live?.wheel(lane, { rows: event.rows, ...event.at })
      // What it drew in answer is a change to its screen, which the next look
      // reads as it reads every other: sooner, because somebody is watching.
      this.soonTick()
    }
    return true
  }

  /** The lane the agent's pane is showing, if it is showing one. */
  private paneLane(): string | null {
    const pane = this.state.panes.find((one) => one.task === this.state.focused)
    return pane ? laneShown(this.state, pane) : null
  }

  /**
   * Cut the lines already held to where the wheel has just put them, so the
   * text moves on the same frame as the bar beside it. What it cannot reach
   * waits for the look the wheel asked for, a few milliseconds behind.
   */
  private reslice(area: 'pane' | 'terminal'): void {
    const held = this.held.get(area)
    if (!held) return
    const view = area === 'pane' ? this.paneView : this.terminalView
    const cut = cutFrom(
      held,
      this.laneRows(area),
      this.state[App.SCROLL_OF[area]],
      view?.lines ?? held.at,
    )
    if (cut === null) return
    if (area === 'pane') this.screen = cut
    else this.terminalScreen = cut
  }

  /** How many rows of a lane are on screen: what a capture is cut to. */
  private laneRows(area: 'pane' | 'terminal'): number {
    if (area === 'pane') {
      const pane = this.state.panes.find((p) => p.task === this.state.focused)
      const split = pane ? splitShown(this.state, pane) : null
      return this.halves(this.paneSize(split !== null), split).first.rows
    }
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    const split = terminalSplitShown(this.state)
    // Sized exactly as `captureTerminal` sizes it: two readings of one layout
    // drift, and a screen cut to the wrong number of rows is a screen that
    // jumps when the look catches up with the wheel.
    return this.halves(
      {
        cols: Math.max(20, layout.sidebarWidth + layout.mainWidth + 1 - (split ? 0 : BAR)),
        rows: Math.max(1, layout.stripHeight - 2),
      },
      split,
    ).first.rows
  }

  /**
   * Read the terminal in front of the bottom panel, sized to the panel. Says
   * whether what it shows has changed. Nothing is read while the panel is
   * folded or showing the orchestrator.
   */
  private async captureTerminal(): Promise<boolean> {
    const terminal = activeTerminal(this.state)
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    if (!terminal || this.state.bottomMode === 'min') {
      this.watch(null, 'terminal')
      this.terminalView = null
      return false
    }
    const split = terminalSplitShown(this.state)
    const halves = this.halves(
      {
        // Less the scrollbar's column, which the window draws and the lane
        // must not: a split has none, and takes the width back.
        cols: Math.max(20, layout.sidebarWidth + layout.mainWidth + 1 - (split ? 0 : BAR)),
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
    // The depth before the text, as an agent's pane reads them: what is held
    // is kept by which lines they are, and that is counted from the depth.
    const view = split ? null : ((await this.live?.screen(terminal.id)) ?? null)
    if (!same(view, this.terminalView)) {
      this.terminalView = view
      changed = true
    }
    const screen = await this.laneScreen('terminal', terminal.id, size.rows)
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
  private paneSize(split = false): { cols: number; rows: number } {
    const layout = resolveLayout(this.layout(), {
      width: this.terminal.columns,
      height: Math.max(6, this.terminal.rows),
    })
    // The scrollbar's column is the window's, not the lane's: a lane sized to
    // the whole pane would draw its last column under the bar.
    return {
      cols: Math.max(20, layout.mainWidth - (split ? 0 : BAR)),
      rows: Math.max(4, layout.bodyHeight - 2),
    }
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

  /**
   * Say what is happening in the window's own title.
   *
   * Tade owns the title outright: everything it starts on a timer or in the
   * background runs detached, so no child of ours can name the terminal after
   * itself. Written when it changes — which, while anything works, is every
   * look, because the indicator turns — and otherwise re-asserted on the same
   * slow beat as the repaint, so a title something else took is taken back.
   */
  private title(where: string | null): void {
    const now = this.now()
    const count = (mark: AgentMark) => this.state.panes.filter((p) => markOf(p) === mark).length
    const title = windowTitle({
      working: count('working'),
      waiting: count('needs-you'),
      failed: count('failed'),
      agents: this.state.panes.length,
      orchestrator:
        this.state.listening && this.state.talkingSince !== null
          ? 'listening'
          : this.state.transcript.thinking !== null
            ? 'thinking'
            : 'quiet',
      where,
      now,
    })
    if (title === this.titled && now - this.titledAt < REPAINT_MS) return
    this.titled = title
    this.titledAt = now
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
    const drawn = this.editor.render(width)
    // The rules it draws above and below the text are not text: the rows
    // between them are what a selection is in, and what a click counts in.
    const body = drawn.slice(1, -1)
    const text = this.editor.getText()
    this.inputRows = rowStarts(body, text, INPUT_PAD)
    const selected = this.selectionSpan()
    if (!selected) return { input: { lines: drawn } }
    const lit = withSelection(body, text, selected, this.skin, INPUT_PAD, width)
    return { input: { lines: [drawn[0] ?? '', ...lit, ...drawn.slice(body.length + 1)] } }
  }

  /** The editor holds what the state says the line holds. */
  private syncLine(): void {
    const wanted = this.state.dictation ?? ''
    if (this.editor.getText() === wanted) return
    // Text put there by something else — a transcript, a command finished for
    // you — is a new line, and nothing of the old one is still selected.
    this.editor.setText(wanted)
    this.anchor = null
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
    await this.queueTools().schedule({ name, project, said: '', watch, by: 'you' })
    const view = this.scheduleViews().find((one) => one.id === scheduleIdOf(name))
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
          await this.watchCommand('install', line)
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

  /**
   * The review a task is out for, as the extension that keeps that list last
   * saw it. Read from its cache: the window never asks a forge anything.
   */
  private reviewOf(task: string): ActionsView['review'] {
    // `checks.ci` is what asks for the other half of the row: with it off,
    // the ACTIONS tab is the local run and says nothing about anybody's CI.
    if (!checksFor(this.opts.config, task.split('/')[0] ?? null).ci) return null
    for (const section of this.listSections) {
      const row = section.rows.find((one) => one.task === task)
      if (!row) continue
      const link = row.links?.[0]
      return {
        number: row.title.split(' ')[0] ?? '',
        title:
          row.title
            .split(/\s{2,}/)
            .slice(1)
            .join(' ') || row.title,
        url: link?.url ?? '',
        marks: row.marks ?? [],
      }
    }
    return null
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

  /**
   * Every setting Settings shows: what the config holds, and a field for each
   * credential the loaded extensions ask for — so a key can be pasted here as
   * well as on the extension's own page, and is kept in the same one place.
   */
  private settingRows(): SettingGroup[] {
    const secrets = (this.opts.extensions?.secrets() ?? []).map((one) => ({
      name: one.name,
      title: `${one.title} ${one.label.toLowerCase()}`,
      means: one.means,
      from: one.from,
      placeholder: one.placeholder,
      variables: one.variables,
    }))
    return settingsOf(this.opts.config, secrets)
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
   * Write what this project already runs in CI into its `.tade/checks.yaml`,
   * which is what turns a reading into checks Tade may run.
   *
   * It goes through `checks_propose` rather than writing the file here: the
   * orchestrator, the CLI and this button must all write the same file the
   * same way, and what the tool says about what it could not take is worth
   * putting in the conversation, where there is room for it — a notice is one
   * line and the next notice eats it.
   */
  private async adoptChecks(task: string): Promise<void> {
    const host = this.opts.extensions
    if (!host) {
      this.state = notice(this.state, 'no extensions are loaded, so nothing can write them here')
      this.draw()
      return
    }
    const project = task.split('/')[0] ?? task
    this.state = {
      ...this.state,
      bottom: ORCHESTRATOR_TAB,
      transcript: ran(
        this.state.transcript,
        { id: `you-${this.ranCount + 1}`, tool: 'checks_propose', input: { project, adopt: true } },
        this.now(),
      ),
    }
    this.draw()
    try {
      const answer = await host.call(
        'checks_propose',
        { project, adopt: true },
        // A person pressing a button is not an agent: the tool is the
        // orchestrator's, and `you` is neither, so no audience gate applies.
        {
          caller: { kind: 'you' },
          id: `you-${++this.ranCount}`,
          tade: this.opts.extensionWorkbench ?? null,
        },
      )
      this.state = {
        ...this.state,
        transcript: said(this.state.transcript, answer.text, this.now()),
      }
    } catch (err) {
      this.state = {
        ...this.state,
        transcript: problem(this.state.transcript, why(err), this.now()),
      }
    } finally {
      this.draw()
    }
  }

  /**
   * Run a task's checks, in its own worktree, through the same path
   * everything else uses: one run at a time per checkout, written down
   * against the commit, and shown here as it goes.
   */
  private async runChecks(task: string): Promise<void> {
    if (this.runningChecks.has(task)) {
      /* the same press twice: the first one is still going */
      this.state = notice(this.state, `${task} is already running its checks`)
      this.draw()
      return
    }
    const host = this.opts.extensions
    const project = task.split('/')[0] ?? task
    if (!host) {
      this.state = notice(this.state, 'no extensions are loaded, so nothing can run them here')
      this.draw()
      return
    }
    this.runningChecks.set(task, this.now())
    // Look often while it goes, so the page shows which check is running
    // rather than nothing for ten seconds.
    this.live?.hurryUp(task)
    this.draw()
    try {
      const worktree = this.live?.worktreeOf(task) ?? null
      await host.call(
        'checks_run',
        { project },
        {
          caller: worktree ? { kind: 'agent', task, project, cwd: worktree } : { kind: 'you' },
          id: `you-${++this.ranCount}`,
          tade: this.opts.extensionWorkbench ?? null,
        },
      )
    } catch (err) {
      this.state = notice(this.state, why(err))
    } finally {
      this.runningChecks.delete(task)
      this.draw()
    }
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

  /** What one check printed the last time it ran here, in the conversation. */
  private async showCheck(task: string, check: string): Promise<void> {
    const host = this.opts.extensions
    const worktree = this.live?.worktreeOf(task) ?? null
    const project = task.split('/')[0] ?? task
    if (!host) return
    this.state = {
      ...this.state,
      bottom: ORCHESTRATOR_TAB,
      bottomMode: this.state.bottomMode === 'min' ? 'open' : this.state.bottomMode,
    }
    this.draw()
    await host
      .call(
        'checks_log',
        { check, project },
        {
          caller: worktree ? { kind: 'agent', task, project, cwd: worktree } : { kind: 'you' },
          id: `you-${++this.ranCount}`,
          tade: this.opts.extensionWorkbench ?? null,
        },
      )
      .catch((err: unknown) => {
        this.state = notice(this.state, why(err))
        this.draw()
      })
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

  /**
   * Start whatever queued work is ready, and say what is held. By rule, on
   * every look at the tasks: a plan keeps going whether or not the orchestrator
   * is busy, or there at all. One pass at a time, so nothing starts twice.
   */
  advanceQueue(): Promise<string[]> {
    this.advancing ??= this.doAdvanceQueue().finally(() => {
      this.advancing = null
    })
    return this.advancing
  }

  private async doAdvanceQueue(): Promise<string[]> {
    const live = this.live
    if (!live) return []
    const items = live.queued.filter((item) => !this.startingQueued.has(item.task))
    // What the tree says now, for whatever is about to start in it: `touches`
    // was one person's reading of the code when the work was planned, and
    // agents have been changing files ever since. Looked at here, at the
    // moment of starting, because that is the moment it is true.
    await live.lookAtTrees(items).catch(() => {})
    const facts = live.queueFacts()
    for (const item of items) {
      const state = queueStateOf(item, facts)
      if (state.kind !== 'held') continue
      // A start that failed wrote its own hold when it failed; what waits on
      // trouble and what the tree moved under are written here.
      const how =
        state.on !== null
          ? { on: state.on }
          : state.changed
            ? { changed: state.changed, by: state.by ?? [] }
            : null
      if (!how) continue
      if (holdSaid(item.task, state, facts.events)) continue
      await this.opts.client.holdQueued(item.task, state.because, how).catch(() => {})
      this.state = withTranscript(
        this.state,
        tadeDid(this.state.transcript, `${item.task} is held: ${state.because}`, this.now()),
      )
      void this.tell(heldMessage(item.task, state.because, state.changed)).catch(() => {})
    }
    // Room only where a project says how many may run: the queue waits for a
    // slot rather than failing the start the way a limit used to.
    const room = new Map<string, number>()
    for (const [project, settings] of Object.entries(this.opts.config.projects)) {
      if (!settings.max_parallel) continue
      const running = this.opts.client
        .runs()
        .filter((run) => run.task.startsWith(`${project}/`)).length
      room.set(project, settings.max_parallel - running)
    }
    const started: string[] = []
    // In the order last written for it, which is a fact in the journal like
    // every other choice about the queue. The rule is unchanged: what starts
    // is what `readyToStart` says is ready, as far as there is room.
    for (const task of readyToStart(inWrittenOrder(items, facts.events), facts, room)) {
      const item = items.find((one) => one.task === task)
      const worktree = live.worktreeOf(task)
      if (!item || !worktree) continue
      this.startingQueued.add(task)
      const because = whyStarting(item, facts)
      try {
        await this.opts.client.startQueued({
          task,
          worktree,
          why: because,
          from: startFrom(item.start.after, live.upstream, live.baseOf(task)),
        })
        started.push(task)
        this.news = addNews(this.news, `started ${task}: ${because}`, this.now())
        this.state = withTranscript(
          this.state,
          tadeDid(this.state.transcript, `started ${task}: ${because}`, this.now()),
        )
      } catch (err) {
        // Held with why, and said: work that silently never starts looks like waiting.
        this.startingQueued.delete(task)
        await this.opts.client.holdQueued(task, why(err), { start: 'failed' }).catch(() => {})
        this.state = withTranscript(
          this.state,
          tadeDid(this.state.transcript, `${task} could not start: ${why(err)}`, this.now()),
        )
        void this.tell(heldMessage(task, `it could not start: ${why(err)}`)).catch(() => {})
      }
    }
    if (started.length > 0) await live.refresh()
    this.draw()
    return started
  }

  /** What the orchestrator's queue tools do, answered from this window. */
  queueTools(): {
    advance(): Promise<string[]>
    describe(): Promise<string>
    change(req: {
      task?: string
      schedule?: string
      project?: string
      change: string
      name?: string
      order?: readonly string[]
      by?: 'you' | 'orchestrator'
    }): Promise<string>
    plan(plan: Plan): Promise<string>
    schedule(req: ScheduleRequest): Promise<string>
  } {
    return {
      advance: () => this.advanceQueue(),
      describe: async () => {
        await this.live?.refresh()
        const live = this.live
        if (!live) return 'Tade is still opening.'
        const now = this.now()
        const schedules = this.scheduleViews()
        return [
          describeQueue(live.queued, live.queueFacts(), clockOf),
          ...(schedules.length > 0
            ? [
                '',
                'Schedules:',
                ...schedules.map((one) => describeSchedule(one, (at) => whenShort(at, now))),
              ]
            : []),
        ].join('\n')
      },
      schedule: async (req) => {
        const now = this.now()
        const id = scheduleIdOf(req.name)
        const existing = this.opts.client.schedules().find((one) => one.id === id)
        const ways = [req.agent, req.ask, req.watch].filter((way) => way !== undefined)
        if (ways.length !== 1) {
          throw new Error(
            'say what it does each time with one of: agent (what to tell it), ask, or watch',
          )
        }
        let does: ScheduleDoes
        let when = req.when
        let waits = ''
        if (req.watch !== undefined) {
          const host = this.opts.extensions
          const offer = host?.watches().find((one) => one.id === req.watch)
          const refused = host
            ? host.watchProblem(req.watch, req.input ?? {})
            : 'this window runs no extensions'
          if (refused || !offer) throw new Error(refused ?? `there is no watch called ${req.watch}`)
          if (req.most !== undefined && !(Number.isInteger(req.most) && req.most > 0)) {
            throw new Error(
              'most is how many new things one look acts on: a whole number, 1 or more',
            )
          }
          does = {
            kind: 'watch',
            watch: req.watch,
            input: { ...(req.input ?? {}) },
            // What the watch says it is for, unless somebody said otherwise.
            found: req.found ?? offer.offers,
            most: req.most ?? 2,
          }
          when ??= { every: offer.every }
          // Turned on while its extension cannot look is allowed, and said.
          if (offer.problem) waits = ` It cannot look yet: ${offer.problem}.`
        } else if (req.ask !== undefined) {
          does = { kind: 'ask', prompt: req.ask }
        } else {
          does = { kind: 'agent', prompt: req.agent ?? '', ...(req.done ? { done: req.done } : {}) }
        }
        if (does.kind !== 'watch' && !does.prompt.trim()) {
          throw new Error('say what it does each time: agent (what to tell it) or ask')
        }
        if (!when) throw new Error('say when it runs: at, every or cron')
        const kept = await this.opts.client.setSchedule(
          {
            id,
            name: req.name,
            project: req.project,
            said: req.said,
            when,
            does,
            missed: req.missed ?? 'once',
            by: req.by ?? 'orchestrator',
            // Kept when it is changed: intervals count from when it was made.
            created: existing?.created ?? new Date(now).toISOString(),
          },
          req.by ?? 'orchestrator',
        )
        const view = scheduleView(kept, this.live?.runsOf(kept.id) ?? [], now)
        this.draw()
        const next = view.next.map((at) => whenShort(at, now))
        return `${kept.name} (${kept.id}): ${view.when}, ${view.does}. ${next.length > 0 ? `Next: ${next.join(', ')}.` : 'It has nothing left to run.'}${waits}`
      },
      change: async (req) => {
        if (req.schedule) {
          const id = req.schedule
          const by = req.by ?? 'orchestrator'
          if (req.change === 'start') {
            const one = this.opts.client.schedules().find((each) => each.id === id)
            if (!one) throw new Error(`there is no schedule called ${id}`)
            const said = await this.fire(
              one,
              { run: true, due: this.now(), missed: 0 },
              { asked: true },
            )
            return said ? `${said}.` : `${one.name} ran now.`
          }
          if (
            req.change === 'rename' ||
            req.change === 'pause' ||
            req.change === 'resume' ||
            req.change === 'remove'
          ) {
            const kept = await this.opts.client.changeSchedule({
              id,
              change: req.change,
              by,
              ...(req.name ? { name: req.name } : {}),
            })
            this.draw()
            return req.change === 'remove'
              ? `${id} is removed.`
              : `${kept?.name ?? id} is ${req.change === 'rename' ? 'renamed' : req.change === 'pause' ? 'paused' : 'back on'}.`
          }
          throw new Error(
            `${req.change} is not something to do to a schedule: start, pause, resume, rename, remove`,
          )
        }
        const change = QUEUE_CHANGES.find((one) => one === req.change)
        if (req.change === 'remove') {
          if (!req.task) throw new Error('remove is for one piece of work: say which')
          const facts = this.live?.factsOf(req.task)
          const worktree = this.live?.worktreeOf(req.task)
          if (!facts || !worktree) throw new Error(`there is no queued work called ${req.task}`)
          const root = this.opts.config.projects[facts.project]?.root
          const result = await this.opts.client.removeTask({
            root: root ? expandHome(root) : worktree,
            worktree,
            branch: facts.branch,
            task: req.task,
            force: true,
          })
          if (!result.removed) throw new Error(result.reason)
          await this.live?.refresh()
          return `${req.task} is removed: anything waiting on it is held`
        }
        if (!change) {
          throw new Error(
            `${req.change} is not something to do to queued work: ${[...QUEUE_CHANGES, 'remove'].join(', ')}`,
          )
        }
        // An order is written down like every other choice about the queue,
        // and changes only which of what is already ready goes first.
        const order =
          change === 'order'
            ? (req.order ?? []).filter((task) =>
                (this.live?.queued ?? []).some((one) => one.task === task),
              )
            : []
        if (change === 'order' && order.length === 0) {
          throw new Error(
            `nothing in that order is queued work${req.order?.length ? ` (${joined([...req.order])})` : ''}: say which queued tasks come first`,
          )
        }
        await this.opts.client.changeQueued({
          ...(req.task ? { task: req.task } : {}),
          ...(req.project ? { project: req.project } : {}),
          ...(change === 'order' ? { order } : {}),
          change,
          by: req.by ?? 'orchestrator',
        })
        await this.live?.refresh()
        const started = await this.advanceQueue()
        if (started.length > 0) return `Done. Started ${joined(started)}.`
        if (change === 'order')
          return `Done: ${joined(order)}, in that order, as each becomes ready.`
        return `Done: ${req.task ?? 'the queue'} ${change === 'pause' ? 'is paused' : change === 'resume' ? 'is back on' : change === 'wait' ? 'waits again' : 'starts as soon as there is room'}.`
      },
      plan: async (plan) => {
        // Checked against what the project is already on, which no plan can see:
        // agents working now, and work an earlier plan left waiting to start.
        const busy: PlanBusy[] = []
        for (const task of this.live?.tasks ?? []) {
          if (!task.task.startsWith(`${plan.project}/`)) continue
          const touches = task.queued ? task.queued.touches : (task.touches ?? [])
          if (touches.length === 0) continue
          const said = task.queued
            ? 'queued'
            : task.state === 'working'
              ? 'working'
              : task.state === 'blocked'
                ? 'waiting on you'
                : ''
          if (said) busy.push({ task: task.task, said, touches })
        }
        const made = await this.opts.client.planTasks(plan, 'orchestrator', busy)
        await this.live?.refresh()
        const started = await this.advanceQueue()
        const live = this.live
        const facts = live?.queueFacts()
        const waiting = made.made
          .map((task) => task.id)
          .filter((task) => !started.includes(task))
          .map((task) => {
            const item = live?.queued.find((one) => one.task === task)
            return {
              task,
              state:
                item && facts ? describeQueueState(queueStateOf(item, facts), clockOf) : 'queued',
            }
          })
        return planAnswer({
          project: plan.project,
          made: made.made.map((task) => task.id),
          started,
          waiting,
          warnings: made.warnings,
        })
      },
    }
  }

  /** Every schedule, as the SMART QUEUE shows it. */
  private scheduleViews(): ScheduleView[] {
    const now = this.now()
    return this.opts.client
      .schedules()
      .map((one) =>
        scheduleView(
          one,
          this.live?.runsOf(one.id) ?? [],
          now,
          one.does.kind === 'watch' ? this.live?.watchedOf(one.id) : undefined,
        ),
      )
  }

  /** What is done to a schedule from the window: yours, and at once. */
  private async onSchedule(id: string, change: string): Promise<void> {
    try {
      if (change === 'open') {
        this.state = openSchedule(this.state, id)
      } else if (change === 'rename') {
        const name = this.scheduleViews().find((one) => one.id === id)?.name ?? ''
        this.state = {
          ...this.state,
          panel: {
            ...promptPanel('rename-schedule', 'Rename schedule', 'NAME', name),
            target: id,
          },
        }
      } else if (change === 'run') {
        const one = this.opts.client.schedules().find((each) => each.id === id)
        if (!one) throw new Error(`there is no schedule called ${id}`)
        await this.fire(one, { run: true, due: this.now(), missed: 0 }, { asked: true })
      } else if (change === 'pause' || change === 'resume' || change === 'remove') {
        await this.opts.client.changeSchedule({ id, change, by: 'you' })
        if (change === 'remove' && this.state.schedule === id) {
          this.state = { ...this.state, schedule: null }
        }
        const said =
          change === 'remove' ? 'is removed' : change === 'pause' ? 'is paused' : 'is back on'
        this.state = notice(this.state, `${id} ${said}`)
      }
    } catch (err) {
      this.state = notice(this.state, why(err))
    }
    this.draw()
  }

  /**
   * Run the schedules that are due, by rule, on every look at the tasks: only
   * while this window is open, catching up once, or skipping, for what came due
   * while none was. One pass at a time, so nothing runs twice.
   */
  private runSchedules(): Promise<void> {
    this.scheduling ??= this.doRunSchedules().finally(() => {
      this.scheduling = null
    })
    return this.scheduling
  }

  private async doRunSchedules(): Promise<void> {
    const live = this.live
    if (!live) return
    const now = this.now()
    for (const one of this.opts.client.schedules()) {
      if (one.paused) continue
      const runs = live.runsOf(one.id)
      const last = Math.max(
        runs.at(-1)?.due ?? Number.NEGATIVE_INFINITY,
        this.fired.get(one.id) ?? Number.NEGATIVE_INFINITY,
      )
      const due = dueNow(
        one,
        Number.isFinite(last) ? last : null,
        runs.filter((run) => run.ran).length,
        now,
      )
      if (!due) continue
      await this.fire(one, due).catch((err) => {
        this.state = withTranscript(
          this.state,
          problem(this.state.transcript, `${one.name} could not run: ${why(err)}`, this.now()),
        )
      })
    }
  }

  /**
   * One run of a schedule: written down first, then done — its agent's work
   * queued, or the orchestrator asked — and said where you would look.
   */
  private async fire(
    one: Schedule & { paused: boolean },
    due: { run: boolean; due: number; missed: number },
    how: { asked?: boolean } = {},
  ): Promise<string> {
    this.fired.set(one.id, due.due)
    const { task } = await this.opts.client.fireSchedule(one.id, due, this.now())
    const missed =
      due.missed > 0
        ? `, ${due.missed} run${due.missed === 1 ? '' : 's'} missed while Tade was closed`
        : ''
    let said: string
    if (!due.run) {
      said = `${one.name} skipped what came due while Tade was closed${missed}`
    } else if (one.does.kind === 'watch') {
      // Looking is not news; what it finds is, and the look says it. One asked
      // for is waited on, so whoever asked hears what it found, nothing included.
      const looking = this.lookWith(one, how.asked === true)
      return how.asked ? await looking : ''
    } else if (one.does.kind === 'agent') {
      said = `${one.name} ran: ${task ?? 'its agent'} is queued${missed}`
      void this.advanceQueue()
    } else {
      said = `${one.name} ran: the orchestrator is asked${missed}`
      const who = askedByWords(one.by)
      void this.tell(
        `It is time for "${one.name}", a schedule ${who} made to run ${describeWhen(one.when)}. ${one.does.kind === 'ask' ? one.does.prompt : ''}`,
      ).catch(() => {})
    }
    this.news = addNews(this.news, said, this.now())
    this.state = withTranscript(this.state, tadeDid(this.state.transcript, said, this.now()))
    this.draw()
    return said
  }

  /**
   * One look with a watch. What it found is written down first; then what is
   * new, as far as the most one look acts on, becomes queued work — or is told
   * to the orchestrator — and the rest waits for the next look, which starts
   * where this one did so it finds them again. Said where you would look, except
   * a look nobody asked for that found nothing new; one that could not look is
   * said when it starts going wrong, not at every look while it stays wrong.
   * One look at a time per watch: a slow one is never started twice.
   */
  private lookWith(one: Schedule & { paused: boolean }, asked = false): Promise<string> {
    const running = this.lookingWith.get(one.id)
    if (running) return running
    const looking = this.doLookWith(one, asked).finally(() => this.lookingWith.delete(one.id))
    this.lookingWith.set(one.id, looking)
    return looking
  }

  private async doLookWith(one: Schedule & { paused: boolean }, asked: boolean): Promise<string> {
    const does = one.does
    if (does.kind !== 'watch') return ''
    const client = this.opts.client
    const watched = this.live?.watchedOf(one.id) ?? watchedFrom([], one.id)
    const say = (said: string, bad = false) => {
      this.news = addNews(this.news, said, this.now())
      this.state = withTranscript(
        this.state,
        bad
          ? problem(this.state.transcript, said, this.now())
          : tadeDid(this.state.transcript, said, this.now()),
      )
      this.draw()
      return said
    }
    let looked: Awaited<ReturnType<ExtensionHost['look']>>
    try {
      const host = this.opts.extensions
      if (!host) throw new Error('this window runs no extensions')
      looked = await host.look(does.watch, {
        project: one.project,
        input: does.input,
        since: watched.since,
        turnedOn: one.created,
        // A watch that looks at what Tade is running needs the window it is
        // running in; one that does not never asks for it.
        tade: this.opts.extensionWorkbench ?? null,
      })
    } catch (err) {
      const reason = why(err)
      await client.watchChecked(one.id, { problem: reason }).catch(() => {})
      const said = `${one.name} could not look: ${reason}`
      if (asked || watched.looks[0]?.problem !== reason) return say(said, true)
      return said
    }
    const { fresh, acting, left } = newFindings(looked.found, watched.seen, does.most)
    await client.watchChecked(one.id, {
      found: looked.found.length,
      fresh: fresh.map((finding) => finding.key),
      left,
      since: left > 0 ? watched.since : looked.since,
    })
    if (acting.length === 0) {
      const said = `${one.name} looked: ${looked.found.length === 0 ? 'found nothing' : 'nothing new'}`
      if (asked) {
        this.state = notice(this.state, said)
        this.draw()
      }
      return said
    }
    const waits =
      left > 0 ? `; ${left} more ${left === 1 ? 'waits' : 'wait'} for its next look` : ''
    if (does.found === 'ask') {
      for (const finding of acting) {
        await client.watchFound(one.id, finding, { told: 'orchestrator' }).catch(() => {})
      }
      void this.tell(
        foundMessage({
          name: one.name,
          watch: does.watch,
          project: one.project,
          who: askedByWords(one.by),
          found: acting,
          left,
        }),
      ).catch(() => {})
      const said = `${one.name} found ${fresh.length} new: the orchestrator is told${waits}`
      this.state = withTranscript(this.state, tadeDid(this.state.transcript, said, this.now()))
      this.draw()
      return said
    }
    const started: string[] = []
    const failed: string[] = []
    for (const finding of acting) {
      try {
        const agent = await looked.agent(finding).catch(async (err: unknown) => {
          // Written down as found, with why: tried again at every look, it would say so at every look.
          await client.watchFound(one.id, finding, { problem: why(err) }).catch(() => {})
          throw err
        })
        const { task } = await client.watchFound(one.id, finding, {
          agent: { ...agent, links: agent.links ?? finding.links ?? [] },
        })
        if (task) started.push(task)
      } catch (err) {
        failed.push(`${finding.title} (${why(err)})`)
      }
    }
    if (started.length > 0) {
      await this.live?.refresh()
      void this.advanceQueue()
    }
    const parts = [
      started.length > 0 ? `queued ${joined(started)}` : '',
      failed.length > 0 ? `could not start work on ${failed.join('; ')}` : '',
    ].filter(Boolean)
    return say(
      `${one.name} found ${fresh.length} new: ${parts.join('; ')}${waits}`,
      started.length === 0,
    )
  }

  /** A task's own rule met — an idle turn, committed work, a merge — written down, once. */
  private async recordRulesMet(): Promise<void> {
    for (const { task, rule } of this.live?.rulesMet ?? []) {
      if (this.marking.has(task)) continue
      this.marking.add(task)
      await this.opts.client.markDone(task, { by: 'rule', rule }).catch(() => {})
    }
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
  private async openSettings(category = 'agents'): Promise<string> {
    this.state = { ...this.state, panel: settingsPanel(category) }
    this.draw()
    // Asked each time the page opens: a sign-in made in another terminal counts.
    void this.loadAccountViews()
    if (category === UPDATES) void this.lookAtWhatIsInstalled()
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
      entries: this.searchEntries(),
      lines:
        this.state.panel?.kind === 'extension-view' ? this.extensionViewLines() : this.fileLines(),
      text: viewed ? (this.viewed?.text ?? []) : [],
      ...(file ? { body: file.rows, columns: file.columns } : {}),
      branches: this.branchRows,
      found: this.findMatches().length,
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
      settings: this.settingRows(),
      accountActions: accountActions(this.accountViews),
      updateActions: updateActions(this.updates, this.updatesBusy),
    }
  }

  /** A time as a person reads one: the day, the date and the clock. */
  private dateOf(at: number): string {
    const time = new Date(at)
    const month = [
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ]
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getDay()] ?? ''
    return `${day} ${time.getDate()} ${month[time.getMonth()] ?? ''} ${clockOf(at)}`
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
        date: (at: number) => this.dateOf(at),
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
    return join(this.opts.home, 'config.yaml')
  }

  /**
   * Write one setting, read the config back, and use it. A value the schema
   * refuses is put back as it was, with the reason in the panel — never left
   * in a file Tade will not open next time.
   */
  /**
   * The config as it is now, everywhere that holds one. The workbench keeps its
   * own copy, and it is the one that decides where agents work, how many may
   * run and what they are told: a setting saved here that only the window saw
   * would say "applies now" and apply to nothing.
   */
  private useConfig(config: Config): void {
    const was = this.opts.config.surfaces.voice.muted
    this.opts.config = config
    this.opts.client.config = config
    this.live?.useConfig(config)
    // Muted is quiet now, not at the end of the sentence: the moment you press
    // it is the moment you needed it. What was queued behind goes with it, and
    // the rest of the answer still arriving is not spoken either. Here rather
    // than in the button, so muting from the settings does the same thing.
    if (config.surfaces.voice.muted && !was) {
      this.speakingTurn = false
      void this.voice?.silence()
    }
  }

  private async saveSetting(panel: SettingsPanel, path: string, value: string): Promise<void> {
    const setting = this.settingRows()
      .flatMap((group) => group.settings)
      .find((one) => one.path === path)
    // A credential never goes near the config, so it never goes near the
    // read-change-write below either: it is kept, and the extension asked
    // again whether it can work now.
    if (setting?.kept) {
      await this.saveKey(panel, setting, value)
      return
    }
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
          throw new Error(
            `${setting?.title ?? path} needs ${setting ? wantedInstead(setting) : 'a usable value'}.`,
          )
        writeSetting(this.configPath, path, typed)
      }
      const loaded = await loadConfig(this.configPath)
      if (!loaded.ok) {
        writeFileSync(this.configPath, before)
        throw new Error(loaded.issues[0]?.message ?? 'the config would not load with that')
      }
      this.useConfig(loaded.config)
      // An extension's own setting means nothing until the extension has it:
      // Settings can change one (which Sentry the Sentry extension reads), so
      // the host is handed the config here as it is from the Extensions panel.
      if (path.startsWith('extensions.')) {
        await this.opts.extensions?.reconfigure(loaded.config.extensions)
        this.setupShown.clear()
      }
      // How hard the orchestrator thinks is live only if the one running is
      // told: a setting that looks applied and is not is worse than one that
      // waits honestly, so where it could not be told, it says so.
      const trouble =
        path === 'orchestrator.thinking' && loaded.config.orchestrator.thinking
          ? await this.tellThinkerThinking(loaded.config.orchestrator.thinking)
          : null
      const said =
        setting?.live === false
          ? `Saved. ${setting.title} applies when Tade next starts.`
          : trouble
            ? `Saved. It applies when the orchestrator next starts: ${trouble}`
            : 'Saved. It applies now.'
      this.state = { ...this.state, panel: { ...panel, saved: said, error: null } }
    } catch (err) {
      this.state = { ...this.state, panel: { ...panel, saved: null, error: why(err) } }
    }
    this.draw()
  }

  /**
   * Keep a key somebody pasted into Settings. It goes where Tade keeps
   * credentials — never the config — and what is said back says where it
   * went, whether the environment still beats it, and never the key.
   */
  private async saveKey(panel: SettingsPanel, setting: Setting, value: string): Promise<void> {
    const kept = setting.kept ?? ''
    const [extension, ...rest] = kept.split('.')
    try {
      const host = this.opts.extensions
      if (!host || !extension || rest.length === 0) throw new Error(`nowhere to keep ${kept}`)
      const saved = host.saveSecret(extension, rest.join('.'), value)
      // Its extension may have been waiting on exactly this to be ready, and
      // where its key is is what the Extensions page says about it.
      await host.reconfigure(this.opts.config.extensions)
      this.setupShown.clear()
      const said =
        value.trim() === ''
          ? `${setting.title} is cleared.`
          : saved.beaten
            ? `Saved in ${saved.where} — but ${saved.beaten} is set, and that is what is used.`
            : `Saved in ${saved.where}. It applies now.`
      this.state = { ...this.state, panel: { ...panel, saved: said, error: null } }
    } catch (err) {
      this.state = { ...this.state, panel: { ...panel, saved: null, error: why(err) } }
    }
    this.draw()
  }

  /**
   * What is installed on this machine, for the Updates page: where each
   * program Tade runs is, how it got there and what it says its version is.
   *
   * Never on a timer and never on the draw path — it runs a `--version` per
   * program, which belongs to somebody opening the page. It touches nothing
   * but this machine; what is *current* is asked separately, and only when
   * the button is pressed.
   */
  private async lookAtWhatIsInstalled(): Promise<void> {
    if (this.updates || this.updatesBusy) return
    this.updatesBusy = true
    this.draw()
    try {
      this.updates = await lookAtUpdates(this.opts.config, this.opts.home)
    } catch (err) {
      this.state = notice(this.state, why(err))
    } finally {
      this.updatesBusy = false
      this.draw()
    }
  }

  /**
   * Do something about updates: ask what is current, run an update in a
   * terminal, or reload.
   *
   * Nothing installs anything here — the exact command is on the page before
   * it is pressed, and pressing it types that command into a terminal you are
   * looking at. Reloading goes the way every reload goes, which asks first
   * when it would stop agents living inside this window.
   */
  private async updateAction(id: string): Promise<void> {
    const said = (saved: string | null, error: string | null = null) => {
      const panel = this.state.panel
      if (panel?.kind === 'settings') {
        this.state = { ...this.state, panel: { ...panel, saved, error } }
      }
      this.draw()
    }
    if (id === 'updates:check') {
      if (this.updatesBusy) return
      this.updatesBusy = true
      said('Asking what is current…')
      try {
        this.updates = await lookAtUpdates(this.opts.config, this.opts.home, { ask: true })
        const behind = this.updates.programs.filter((one) => one.behind).length
        const newer = this.updates.tade.newer ? 1 : 0
        said(
          behind + newer === 0
            ? 'Everything Tade could ask about is current.'
            : `${behind + newer} could move forward.`,
        )
      } catch (err) {
        said(null, why(err))
      } finally {
        this.updatesBusy = false
        this.draw()
      }
      return
    }
    if (id === 'updates:reload') {
      this.state = { ...this.state, panel: null }
      this.reload()
      return
    }
    const action = updateActions(this.updates, this.updatesBusy).find((one) => one.id === id)
    if (!action?.command) return
    await this.watchCommand('updates', action.command)
  }

  /**
   * Run a command in a terminal somebody is looking at, rather than behind
   * their back: the same terminal each time, opened if it is not there, and
   * put in front before a key of it is typed.
   */
  private async watchCommand(name: string, command: string): Promise<void> {
    const project = this.state.project ?? Object.keys(this.opts.config.projects)[0] ?? null
    if (!project) {
      // No project, no folder to open a shell in. The command is the answer.
      this.state = notice(this.state, `Run it yourself: ${command}`)
      this.draw()
      return
    }
    try {
      let id: string | null = null
      try {
        id = this.opts.client.terminal(name, project).id
      } catch {
        // None open under that name yet.
      }
      if (!id) {
        const layout = resolveLayout(this.layout(), {
          width: this.terminal.columns,
          height: Math.max(6, this.terminal.rows),
        })
        const opened = await this.opts.client.openTerminal({
          project,
          name,
          cols: layout.sidebarWidth + layout.mainWidth + 1,
          rows: Math.max(4, layout.stripHeight - 2),
        })
        id = opened.id
      }
      this.state = { ...this.state, panel: null }
      await this.showTerminal(id)
      await this.opts.client.runInTerminal(id, command)
    } catch (err) {
      this.state = notice(this.state, why(err))
      this.draw()
    }
  }

  /** Ask every harness who its accounts are signed in as, and draw what they say. */
  private async loadAccountViews(): Promise<void> {
    this.accountViews = await this.opts.client.accounts().catch(() => this.accountViews)
    this.draw()
  }

  /**
   * Do something to an account from the Accounts page: sign it in with its
   * harness's own sign-in, sign it out, have new agents use it, add one, set
   * a key, or take one away. Whatever happens is said on the page.
   */
  private async accountAction(id: string): Promise<void> {
    const [, verb = '', harness = '', named = ''] = id.split(':')
    const name = named || null
    const title = HARNESS_CHOICES.find((one) => one.id === harness)?.title ?? harness
    const said = (saved: string | null, error: string | null = null) => {
      const panel = this.state.panel
      if (panel?.kind === 'settings') {
        this.state = { ...this.state, panel: { ...panel, saved, error } }
      }
    }
    try {
      switch (verb) {
        case 'sign-in':
          await this.signInto(harness, name)
          said(`${name ?? title}: signed in, as far as ${title} says below.`)
          break
        case 'sign-out':
          await this.opts.client.signOut(harness, name)
          said(`${name ?? title} is signed out.`)
          break
        case 'use':
          await this.opts.client.useAccount(harness, name)
          said(`New ${title} agents run as ${name ?? 'its own sign-in'}.`)
          break
        case 'remove':
          if (name) await this.opts.client.removeAccount(name)
          said(`${name} is gone, and signed out.`)
          break
        case 'add':
        case 'add-key':
          this.state = {
            ...this.state,
            panel: {
              ...promptPanel(
                'account-name',
                verb === 'add'
                  ? `Add a ${title} account`
                  : `Add a ${title} account paid with an API key`,
                'NAME',
              ),
              target: `${harness}\u0000${verb === 'add' ? 'subscription' : 'api-key'}`,
            },
          }
          this.draw()
          return
        case 'key':
          if (!name) return
          this.state = {
            ...this.state,
            panel: {
              ...promptPanel('account-key', `${name}'s API key`, 'KEY'),
              target: name,
            },
          }
          this.draw()
          return
      }
    } catch (err) {
      said(null, why(err))
    }
    await this.loadAccountViews()
  }

  /** An account's own sign-in, in a terminal inside this one, then the accounts read again. */
  private async signInto(harness: string, name: string | null): Promise<void> {
    const signing = this.opts.client.signInFor(harness, name)
    await this.onScreenWith(async (ui) => {
      ui.say(`  ${signing.how}`)
      await ui.run(name ?? harness, signing.launch.command, signing.launch.args, signing.launch.env)
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

/**
 * What a drag means to the selection in the file you have open: which of its
 * lines the pointer is on, or how far past the top or the bottom of it the
 * drag has gone — which scrolls the file under the selection, because it is
 * the only way to reach past one screen of it with a mouse.
 *
 * Read back out of the map, because only the map knows where the panel ended
 * up: the rows the file's own text was drawn on are exactly the rows a caret
 * can be put in, and where they stop is where the file stops. Off to the side
 * of them — over the line numbers, over the bar — is still a line of the
 * file, taken at the near end of it rather than as leaving it.
 */
export function draggedInFile(
  hits: readonly Hit[],
  x: number,
  y: number,
): { line: number; cell: number } | { rows: number; cell: number } | null {
  let top = Number.POSITIVE_INFINITY
  let bottom = -1
  let from = 0
  let to = 0
  let here: number | null = null
  for (const hit of hits) {
    if (hit.target.kind !== 'caret') continue
    top = Math.min(top, hit.row)
    bottom = Math.max(bottom, hit.row)
    from = hit.from
    to = hit.to
    if (hit.row === y) here = hit.target.line
  }
  if (bottom < 0) return null
  const cell = Math.max(0, Math.min(x - from, to - from))
  if (here !== null) return { line: here, cell }
  return { rows: y < top ? y - top : y - bottom, cell }
}

/**
 * The columns a selection may reach: the region it was started in, or the
 * whole row where it was started on nothing in particular.
 *
 * The window is regions side by side, not one flow of text. A selection that
 * took whole rows between its two ends took whatever else was drawn on them
 * with it — dragging over an agent's screen came back with the sidebar's
 * queue and its agents down the left of every line but the first and the
 * last. So a selection is bounded to where it began, in columns.
 */
export interface Within {
  from: number
  to: number
}

/** The first and the last column of a row a selection takes, in reading order. */
function columnsOn(
  chosen: { from: Cell; to: Cell },
  y: number,
  width: number,
  within: Within | null,
): { start: number; end: number } {
  const start = Math.max(within?.from ?? 0, y === chosen.from.y ? chosen.from.x : 0)
  const end = Math.min(
    within ? within.to + 1 : Number.POSITIVE_INFINITY,
    y === chosen.to.y ? chosen.to.x + 1 : width,
  )
  return { start, end: Math.max(start, end) }
}

/** The text a selection covers, one line per row, without the spaces that pad a row out. */
export function selectedText(
  rows: readonly string[],
  chosen: { from: Cell; to: Cell },
  within: Within | null = null,
): string {
  const lines: string[] = []
  for (let y = chosen.from.y; y <= chosen.to.y; y++) {
    const plain = stripTerminalSequences(rows[y] ?? '')
    const { start, end } = columnsOn(chosen, y, visibleWidth(plain), within)
    lines.push(sliceByColumn(plain, start, Math.max(0, end - start)).trimEnd())
  }
  return lines.join('\n')
}

/** Rows with a selection shown the way a terminal shows one: reversed. */
export function highlighted(
  rows: readonly string[],
  chosen: { from: Cell; to: Cell },
  width: number,
  within: Within | null = null,
): string[] {
  return rows.map((row, y) => {
    if (y < chosen.from.y || y > chosen.to.y) return row
    const { start, end } = columnsOn(chosen, y, width, within)
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
export interface ScheduleRequest {
  name: string
  project: string
  said: string
  /** When it runs; for a watch, how often it looks, which is the watch's own unless said. */
  when?: When
  /** Start an agent each time, told this. */
  agent?: string
  /** Ask the orchestrator this each time. */
  ask?: string
  /** Look with an extension's watch each time: `<extension>.<id>`. */
  watch?: string
  /** What the watch is turned on with. */
  input?: Readonly<Record<string, unknown>>
  /** What each new thing a watch finds becomes: an agent on it, or a question for the orchestrator. */
  found?: 'agent' | 'ask'
  /** At most this many new things acted on from one look. */
  most?: number
  done?: DoneRule
  missed?: 'once' | 'skip'
  by?: string
}

/** A schedule's id, for good, from the name it was first given: made again under it, it is changed. */
function scheduleIdOf(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'schedule'
  )
}

/** Who made a schedule, in words for the orchestrator. */
function askedByWords(by: string): string {
  const origin = taskOrigin(by)
  return origin.kind === 'you' ? 'the person' : origin.kind === 'orchestrator' ? 'you' : origin.name
}

/** A moment as short as it can be said: the time today, or the day and time otherwise. */
function whenShort(at: number, now: number): string {
  const time = new Date(at)
  const today = new Date(now)
  const clock = clockOf(at)
  const sameDay =
    time.getFullYear() === today.getFullYear() &&
    time.getMonth() === today.getMonth() &&
    time.getDate() === today.getDate()
  if (sameDay) return clock
  return `${['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][time.getDay()] ?? ''} ${clock}`
}

/** The time of day something happened, the way news is said: `14:02`. */
function clockOf(at: number): string {
  const time = new Date(at)
  return `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}`
}

function why(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * The same set of sections, whatever order they were folded in: what is
 * written down is a set, and folding two and unfolding one of them is not a
 * different answer from having folded the other first.
 */
function sameSections(folded: readonly string[], others: readonly string[]): boolean {
  return folded.length === others.length && folded.every((name) => others.includes(name))
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

/**
 * The head of some Markdown, as it would be said: no emphasis, no code marks,
 * no link targets, and never a fence read out as backticks. One line of it,
 * because what an extension answers is a report and this is its headline.
 */
export function spokenLine(markdown: string): string {
  const [first = ''] = speakable(markdown).split(/(?<=[.!?])\s+/)
  return first
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
