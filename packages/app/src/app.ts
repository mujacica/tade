import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import {
  type Component,
  getKeybindings,
  ProcessTerminal,
  sliceByColumn,
  stripTerminalSequences,
  type Terminal,
  TUI_KEYBINDINGS,
  TuiAltScreen,
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
import { slugify, VoiceSurface, type VoiceTerminals } from '@tade/voice-core'
import { Speaker } from '@tade/voice-tts'
import { matchingLines, type Workbench } from '@tade/workbench'
import { type ParsedDiff, parseDiff } from './diff.ts'
import { chooseEditor, launch, openerFor, openerForLink } from './editor.ts'
import type { Frame, LaneView } from './frame.ts'
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
import { textOf } from './input.ts'
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
  dragAgent,
  dropAgent,
  focusTask,
  grabBar,
  initialState,
  laneShown,
  markOf,
  matchActions,
  nextWaiting,
  noteTyping,
  notice,
  ORCHESTRATOR_TAB,
  onEvent,
  openSchedule,
  parseCommand,
  projects,
  QUEUE_FILTERS,
  removeAttachment,
  resizeTo,
  scrollBarTo,
  scrollBy,
  selectProject,
  setDictation,
  setHeld,
  setQuestion,
  shownName,
  showOrchestrator,
  showPlan,
  showTerminal,
  splitPane,
  splitRatio,
  splitShown,
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
import {
  type FilePanel,
  filePanel,
  fileSelection,
  savedFile,
  scrollFile,
} from './panels/file/state.ts'
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
  findPanel,
  noteHeadlinePanel,
  type PromptPanel,
  promptPanel,
} from './panels/small/state.ts'
import { spendPanel } from './panels/spend/state.ts'
import { type Panel, type PanelInputs, panelClick, panelKey } from './panels.ts'
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
import { cutFrom, type HeldLines, type Reach, reachOf, Wheel } from './scroll.ts'
import { BAR } from './scrollbar.ts'
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
import { Machine } from './wire/machine.ts'
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

/**
 * The one component the TUI holds: it paints a frame and answers the mouse.
 *
 * Named for what it does rather than for the window, because `wire/window.ts`
 * is the window's own business — where you were, how big it all is, what the
 * title says — and two things called `Window` in one package is one too many.
 */
class Painted implements Component {
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
    frame: Painted['frame'],
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
  /** The size each lane was last made, so resizing happens once per change. */
  private readonly fitted = new Map<string, string>()
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
  /** The second half of a split pane, and of a split bottom panel, as last captured. */
  private splitScreen = ''
  private splitTerminalScreen = ''
  private statusedAt = Number.NEGATIVE_INFINITY
  private asking = false
  private speakingTurn = false
  /** A look at the lanes is under way, and whether another was asked for meanwhile. */
  private looking = false
  private lookAgain = false
  private extensionShown: { name: string; title: string; markdown: string; at: number } | null =
    null
  /** A command voice typed into a terminal, waiting for enter or "confirm". */
  private typed: { id: string; name: string; command: string } | null = null
  private soon: NodeJS.Timeout | null = null
  /** A drag held off the top or bottom of the file: it goes on scrolling until it is let go. */
  private draggingFile: NodeJS.Timeout | null = null
  private screen = ''
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
  private router: RouterState = initialRouter()
  /** Which agent the router's half-typed line belongs to. */
  private routerFor: string | null = null
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
      openFind: (id, query, index) => this.openFind(id, query, index),
      clicked: (target) => this.clicked(target),
      decide: (allow) => this.decide(allow),
      stopAgent: (task) => this.stopAgent(task),
      openDiff: (task, path) => this.openDiff(task, path),
      openSettings: (category) => this.settings.open(category),
      showTerminal: (id) => this.showTerminal(id),
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
      showTerminal: (id) => this.showTerminal(id),
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
      toLane: (data) => this.toLane(data),
      act: (said) => void this.act(said),
      say: (said) => this.say(said),
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
    this.stopDraggingFile()
    for (const watched of this.watching.values()) watched.stop()
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
      screen: this.screen,
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
          this.window.remember()
          return true
        }
        if (this.state.reordering) {
          // So does an agent let go of in the list.
          this.state = { ...dropAgent(this.state), pressed: null }
          this.window.remember()
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
        this.keyboard.selectTo(event.line, event.x, event.extend, event.drag)
        return true
      case 'selected': {
        const selected = this.keyboard.selectedText()
        if (selected !== null) void this.copySelection(selected)
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
        terminals: this.voiceTerminals(),
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
      new Painted(
        (width) => ({ state: this.state, frame: this.frameFor(live, width) }),
        (event) => this.pointer(event),
        (text) => void this.copySelection(text),
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
        this.notes.open({ at: target.at, text: target.text })
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
        this.window.remember()
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
        this.keyboard.clickedOn(target.line, at.x, at.clicks ?? 1)
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
        if (pane?.queued) await this.queue.change(pane.task, 'start')
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
    this.images.look()
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
    this.window.titleHere()
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
    const layout = resolveLayout(this.window.layout(), {
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
    const layout = resolveLayout(this.window.layout(), {
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
    const layout = resolveLayout(this.window.layout(), {
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
    const layout = resolveLayout(this.window.layout(), {
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
    const layout = resolveLayout(this.window.layout(), {
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

/** Only some terminals report key releases, which is what holding a key needs. */
function kittyActive(terminal: Terminal): boolean {
  return (terminal as { kittyProtocolActive?: boolean }).kittyProtocolActive === true
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
