import type { Component } from '@earendil-works/pi-tui'
import type { Frame } from '../frame.ts'
import { pressable, sameTarget, type Target } from '../hits.ts'
import { textOf } from '../input.ts'
import { resolveLayout } from '../layout.ts'
import {
  type AppState,
  dragAgent,
  dropAgent,
  focusTask,
  grabBar,
  leaveLine,
  ORCHESTRATOR_TAB,
  openLine,
  resizeTo,
  scrollBarTo,
  scrollBy,
  selectProject,
  showOrchestrator,
  showTerminal,
  splitRatio,
  toggleCheck,
  toggleFolder,
  toggleSection,
  viewActions,
  viewLane,
} from '../model.ts'
import { type FilePanel, fileSelection, scrollFile } from '../panels/file/state.ts'
import type { MenuSubject } from '../panels/menu/state.ts'
import type { PanelOutcome } from '../panels/outcome.ts'
import { type PanelInputs, panelClick, panelDismiss, panelKey } from '../panels.ts'
import { Painted, type PointerEvent } from '../pointer.ts'
import { noteRecent } from '../projects.ts'
import { pointerSequence } from '../skin.ts'
import type { Wiring } from './context.ts'

// The mouse, which is a shortcut into what you could also have typed.
//
// Two tables, and their order is behaviour the way `onInput`'s is: `pointer`
// answers what the pointer did — a wheel, a drag, a press, a selection let go
// of — and `clicked` answers what it landed on. Nothing here types a command
// for you to finish; what needs more than a click opens a panel, and every
// target is something that already had a name.
//
// Where an event came from is `pointer.ts`: the component that painted the
// frame is what knows where everything landed, and this subject never works
// that out a second time.

/**
 * How often a drag held off the end of a file scrolls it. A hand held still
 * reports nothing, so this is the only clock in a selection — fast enough to
 * read as scrolling, slow enough that a whole file does not go past under it.
 */
const EDGE_MS = 80

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

/** What this subject needs from the rest of the window. */
export interface MouseDeps {
  /** The window is closing, or has closed. */
  stopped(): boolean
  /** Another screen has the terminal, so nothing here may draw over it. */
  borrowed(): boolean
  /** How big the terminal is, for a divider dragged to a cell. */
  size(): { columns: number; rows: number }
  /** Straight to the terminal: the pointer's own shape, which is not a frame. */
  write(data: string): void
  /** Whether this terminal shows a pointer shape at all. */
  pointerShapes(): boolean
  /** Where the panes and the strip are, for a divider dragged to a cell. */
  layout(): Parameters<typeof resolveLayout>[0]
  /** Where you left a divider, a fold or an order, written down as you leave it. */
  remember(): void
  /** What an open panel answers a click against, and what that answer changes. */
  panelInputs(): PanelInputs
  applyPanel(outcome: PanelOutcome): void
  /** The menu of whatever was right-clicked. */
  openMenu(subject: MenuSubject, at: { x: number; y: number }): void
  /** A named action, as a button would run it. */
  run(action: string): void
  /**
   * A lane was scrolled: cut what is held to where it now is. True when the
   * lines held reached that far, which is what says whether the driver has to
   * be asked at all.
   */
  reslice(area: 'pane' | 'terminal'): boolean
  soonTick(): void
  /** A lane that answers the wheel itself was turned in, so the window does not. */
  turnedInLane(event: Extract<PointerEvent, { kind: 'wheel' }>): boolean
  /** The orchestrator's line: its caret, what is selected on it, and a click in it. */
  selectTo(line: number, x: number, extend: boolean, drag: boolean): void
  selectedOnLine(): string | null
  clickedOn(line: number, x: number, clicks: number): void
  /** How long the file you have open is, and how much of it a screen holds. */
  fileLines(): number
  fileBody(panel: FilePanel): { rows: number; columns: number }
  /** What a drag let go of puts on the clipboard, said in the strip. */
  copySelection(text: string): void
  /** Where the things you click on lead. */
  resolvePath(path: string): string
  openFile(path: string, line?: number | null): void
  openLink(url: string): void
  openDiff(task: string, path: string): void
  openNote(note: { at: string; text: string }): void
  /** Clicking a task that is not running opens its agent again. */
  openAgent(): void
}

export class Mouse {
  private readonly wire: Wiring
  private readonly deps: MouseDeps
  /** A drag held off the top or bottom of the file: it goes on scrolling until it is let go. */
  private draggingFile: NodeJS.Timeout | null = null

  constructor(wire: Wiring, deps: MouseDeps) {
    this.wire = wire
    this.deps = deps
  }

  /**
   * The one component the TUI holds, wired to this subject: it paints the
   * frame it is handed, and every mouse event it reads comes back to
   * `pointer`.
   */
  component(
    frame: (width: number) => { state: AppState; frame: Frame },
    clock: () => number,
  ): Component {
    return new Painted(
      frame,
      (event) => this.pointer(event),
      (text) => this.deps.copySelection(text),
      clock,
    )
  }

  /**
   * The pointer moved, pressed, let go or clicked. Returns whether anything
   * visible changed, so moving across empty space costs no redraw.
   */
  private pointer(event: PointerEvent): boolean {
    if (this.deps.stopped() || this.deps.borrowed()) return false
    switch (event.kind) {
      case 'wheel': {
        const panel = this.wire.state.panel
        // The picture of a chain only ever moves sideways, so the wheel over
        // it does, shift or no shift: there is nothing above or below it.
        // Somewhere with nowhere to go sideways hands the wheel back rather
        // than swallowing it, and it scrolls as it would without shift.
        if (!panel && (event.shift || event.area === 'plan')) {
          const moved = scrollBy(this.wire.state, event.area, event.rows, event.sideways, true)
          if (moved !== this.wire.state) {
            this.wire.put(moved)
            return true
          }
        }
        if (event.area === 'panel' && panel?.kind === 'file') {
          // Over a file the wheel scrolls it. It cannot be the down key here:
          // with a caret in the text, that key moves the caret.
          this.wire.put({
            ...this.wire.state,
            panel: scrollFile(panel, event.rows, this.deps.fileLines()),
          })
          return true
        }
        // A panel that is a list rather than a page has nothing to scroll:
        // the wheel over it moves what is chosen, which is what its down key
        // does. A row a notch, never the notch's rows — a flick through a
        // list of models is not a request to visit forty of them.
        if (event.area === 'panel' && panel && !('scroll' in panel)) {
          const outcome = panelKey(
            panel,
            event.rows > 0 ? 'down' : 'up',
            '',
            this.deps.panelInputs(),
          )
          this.wire.put({ ...this.wire.state, panel: outcome.panel })
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
        if (this.deps.turnedInLane(event)) return false
        // Everywhere else: the one move, clamped to what the last frame said
        // the region actually is. Nothing is laid out again to find that out.
        const moved = scrollBy(this.wire.state, event.area, event.rows, event.reach)
        if (moved === this.wire.state) return false
        this.wire.put(moved)
        if (event.area === 'pane' || event.area === 'terminal') {
          // A lane's screen is read from the driver, so the wheel would leave
          // the text where it was until the next look while the bar beside it
          // had already moved. Cut the lines we hold to where it now is, and
          // ask for more only when it has gone past them — which is what the
          // cut says, and the only reason to go to the driver at all. Asking
          // anyway cost a screen read a notch in two lanes, 81 ms of a 735 ms
          // flick spent finding out that nothing had changed.
          if (!this.deps.reslice(event.area)) this.deps.soonTick()
        }
        return true
      }
      case 'grab':
        this.wire.put({ ...this.wire.state, resizing: event.edge })
        return true
      case 'take':
        this.wire.put(grabBar(this.wire.state, event.bar, event.track, event.y))
        // A screen scrolled back is read further back than it is tall: ask for
        // the lines now rather than at the next beat.
        if (event.bar.area === 'pane' || event.bar.area === 'terminal') {
          if (!this.deps.reslice(event.bar.area)) this.deps.soonTick()
        }
        return true
      case 'drag': {
        const bar = this.wire.state.scrolling
        if (bar) {
          this.wire.put(scrollBarTo(this.wire.state, event.y))
          if (bar.area === 'pane' || bar.area === 'terminal') {
            // As the wheel does: the text goes with the thumb rather than a
            // look behind it, and what the held lines cannot reach is asked for.
            if (!this.deps.reslice(bar.area)) this.deps.soonTick()
          }
          return true
        }
        if (!this.wire.state.resizing) return false
        if (this.wire.state.resizing === 'split' || this.wire.state.resizing === 'terminal-split') {
          this.wire.put(this.dragSplit(this.wire.state.resizing, event))
          return true
        }
        this.wire.put(
          resizeTo(this.wire.state, event, { height: Math.max(6, this.deps.size().rows) }),
        )
        return true
      }
      case 'move': {
        if (sameTarget(this.wire.state.hover, event.target)) return false
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
        const was = shapeOf(this.wire.state.hover)
        this.wire.put({ ...this.wire.state, hover: event.target })
        const now = shapeOf(event.target)
        // A hand over what can be pressed, arrows over what can be dragged,
        // where the terminal can show one.
        if (was !== now && this.deps.pointerShapes()) this.deps.write(pointerSequence(now))
        return true
      }
      case 'press':
        if (!pressable(event.target)) return false
        this.wire.put({ ...this.wire.state, pressed: event.target })
        return true
      case 'reorder':
        this.wire.put(dragAgent(this.wire.state, event.task, event.to))
        return true
      case 'release':
        this.stopDraggingFile()
        if (this.wire.state.scrolling) {
          this.wire.put({ ...this.wire.state, scrolling: null, pressed: null })
          return true
        }
        if (this.wire.state.resizing) {
          // Where you let go is where it stays, this time and next.
          this.wire.put({ ...this.wire.state, resizing: null })
          this.deps.remember()
          return true
        }
        if (this.wire.state.reordering) {
          // So does an agent let go of in the list.
          this.wire.put({ ...dropAgent(this.wire.state), pressed: null })
          this.deps.remember()
          return true
        }
        if (this.wire.state.pressed === null) return false
        this.wire.put({ ...this.wire.state, pressed: null })
        return true
      case 'click':
        this.wire.put({ ...this.wire.state, pressed: null })
        this.clicked(event.target, event.button, {
          x: event.x,
          y: event.y,
          cell: event.cell,
          clicks: event.clicks,
        })
        return true
      case 'select':
        this.deps.selectTo(event.line, event.x, event.extend, event.drag)
        return true
      case 'selected': {
        const selected = this.deps.selectedOnLine()
        if (selected !== null) this.deps.copySelection(selected)
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
        if (text !== null && text.trim() !== '') this.deps.copySelection(text)
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
    const panel = this.wire.state.panel
    if (panel?.kind !== 'file') return
    this.deps.applyPanel(panelClick(panel, `caret:${line}:${cell}:${how}`, this.deps.panelInputs()))
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

  stopDraggingFile(): void {
    if (this.draggingFile) clearInterval(this.draggingFile)
    this.draggingFile = null
  }

  /** One step of that: the file scrolled, and the selection reaching the new edge. */
  private dragFile(rows: number, cell: number): void {
    const panel = this.wire.state.panel
    if (this.deps.stopped() || panel?.kind !== 'file' || !panel.edit) {
      this.stopDraggingFile()
      return
    }
    const scrolled = scrollFile(panel, rows, this.deps.fileLines())
    const body = this.deps.fileBody(panel).rows
    const line =
      rows < 0 ? scrolled.scroll : Math.min(scrolled.scroll + body - 1, panel.edit.lines.length - 1)
    this.deps.applyPanel(
      panelClick(scrolled, `caret:${line}:${cell}:drag`, this.deps.panelInputs()),
    )
    // The end of the file: the selection has reached as far as it goes, and a
    // timer that redraws the same screen twelve times a second for the rest
    // of the drag is a window working for nothing.
    if (scrolled.scroll === panel.scroll) this.stopDraggingFile()
  }

  /** What is selected in the file, as its text, or nothing when nothing is. */
  fileSelectionText(): string | null {
    const panel = this.wire.state.panel
    if (panel?.kind !== 'file' || !panel.edit) return null
    const selected = fileSelection(panel)
    return selected ? textOf(panel.edit.lines, selected) : null
  }
  /**
   * Something was clicked.
   *
   * Every target is something you could also have typed or said, which is the
   * point: the mouse is a shortcut into the same actions, never a second way of
   * driving Tade that behaves differently. Nothing here types a command for
   * you to finish — what needs more than a click opens a panel.
   */
  clicked(
    target: Target,
    button: 'left' | 'right' = 'left',
    at: { x: number; y: number; cell?: number; clicks?: number } = { x: 0, y: 0 },
  ): void {
    if (this.wire.state.panel) {
      this.clickPanel(target, at.cell ?? 0, at.clicks ?? 1)
      return
    }
    // The path under GIT opens its folder; right-clicked, it is copied.
    if (button === 'right' && target.kind === 'action' && target.name === 'open-path') {
      this.deps.run('copy-path')
      return
    }
    // A right-click is the menu of whatever it is on, as it is everywhere else.
    if (button === 'right') {
      const subject = subjectOf(target)
      if (subject) {
        this.deps.openMenu(subject, at)
        return
      }
    }
    switch (target.kind) {
      case 'task': {
        this.wire.put(focusTask(this.wire.state, target.task))
        const pane = this.wire.state.panes.find((p) => p.task === target.task)
        // Queued work is not started by looking at it: clicking it shows what
        // it waits on, what its agent will be told and where it came from.
        // Starting it is a button on that screen, and its menu's Start now.
        if (pane?.queued) break
        // Clicking a task opens it. Resuming a session sends nothing to the
        // model, so this costs nothing until you type — which is what makes it
        // safe for a click, and not for tab, which passes over tasks on the
        // way to another.
        if (pane && !pane.lane && pane.state !== 'parked') this.deps.openAgent()
        break
      }
      case 'lane': {
        // The tab of the half beside it gives that half the keyboard; any other shows it in front.
        const split = this.wire.state.splits[target.task]
        this.wire.put(
          split?.lane === target.lane
            ? { ...focusTask(this.wire.state, target.task), keyboard: 'pane', splitFocus: true }
            : { ...viewLane(this.wire.state, target.task, target.lane), splitFocus: false },
        )
        break
      }
      case 'pane-tab':
        this.wire.put(viewActions(this.wire.state, target.task))
        break
      case 'check':
        // Reading a failure is what the page is for: it opens there, and the
        // whole log is a button inside it.
        this.wire.put(toggleCheck(this.wire.state, target.task, target.check))
        break
      case 'task-menu':
        this.deps.openMenu({ kind: 'task', task: target.task }, at)
        return
      case 'note':
        // A note cut short down the side is read whole on its own page, which
        // is also where it is changed and taken back. A click is for reading
        // it; the ≡ beside it is what asks for the menu.
        this.deps.openNote({ at: target.at, text: target.text })
        return
      case 'menu':
        this.deps.openMenu(target.subject, at)
        return
      case 'branch':
        this.deps.openMenu({ kind: 'branch' }, at)
        return
      case 'change':
        this.deps.openDiff(target.task, target.path)
        return
      case 'project': {
        this.wire.put(selectProject(this.wire.state, target.project))
        const root = this.wire.opts.config.projects[target.project]?.root
        if (root) noteRecent(this.wire.opts.home, target.project, root, this.wire.now())
        break
      }
      case 'section':
        // What the heading under the pointer said it was, so a section that
        // folds itself away opens and stays open rather than closing again.
        this.wire.put(toggleSection(this.wire.state, target.section, target.quiet === true))
        // Written where it was chosen, as a dragged divider is: a window that
        // was killed rather than closed still opens the way you left it.
        this.deps.remember()
        break
      case 'bottom-tab':
        this.wire.put(
          target.tab === ORCHESTRATOR_TAB
            ? showOrchestrator(this.wire.state)
            : showTerminal(this.wire.state, target.tab),
        )
        break
      case 'terminal':
        // Clicking into a terminal is choosing to type there — in the half
        // clicked. What was half-written at the orchestrator stays on its line.
        this.wire.put({
          ...leaveLine(this.wire.state),
          keyboard: 'terminal',
          splitFocus: target.side === 'split',
        })
        break
      case 'pane':
        this.wire.put({
          ...leaveLine(this.wire.state),
          keyboard: 'pane',
          splitFocus: target.side === 'split',
        })
        break
      case 'folder':
        this.wire.put(toggleFolder(this.wire.state, target.path))
        break
      case 'orchestrator':
        // The keyboard goes to the orchestrator's line, on whatever was left
        // on it; the agent you were watching stays in view behind it, a click
        // away.
        this.wire.put(openLine(this.wire.state))
        break
      case 'input': {
        // A click in what you have typed puts the caret there, as it does in
        // any text box; a second press takes the word it is in and a third
        // the whole line, which is what every other text box does too.
        this.deps.clickedOn(target.line, at.x, at.clicks ?? 1)
        break
      }
      case 'file':
      case 'place':
        // Read here first; the viewer has the button for your editor.
        this.deps.openFile(
          this.deps.resolvePath(target.path),
          'line' in target ? (target.line ?? null) : null,
        )
        return
      case 'link':
        this.deps.openLink(target.url)
        return
      case 'action':
        this.deps.run(target.name)
        return
      default:
        break
    }
    this.wire.draw()
  }
  private clickPanel(target: Target, cell = 0, clicks = 1): void {
    const panel = this.wire.state.panel
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
      this.deps.applyPanel(panelDismiss(panel, this.deps.panelInputs()))
      return
    }
    if (target.kind === 'control') {
      this.deps.applyPanel(panelClick(panel, target.id, this.deps.panelInputs()))
      return
    }
    if (target.kind === 'action') {
      // A link inside a panel leads somewhere else: the panel gives way to it.
      this.wire.put({ ...this.wire.state, panel: null })
      this.deps.run(target.name)
      return
    }
    this.wire.draw()
  }
  /** A split's divider dragged to a cell: the first half takes up to there. */
  private dragSplit(which: 'split' | 'terminal-split', at: { x: number; y: number }): AppState {
    const layout = resolveLayout(this.deps.layout(), {
      width: this.deps.size().columns,
      height: Math.max(6, this.deps.size().rows),
    })
    if (which === 'split') {
      const task = this.wire.state.focused
      const split = task ? this.wire.state.splits[task] : undefined
      if (!task || !split) return this.wire.state
      // The pane starts after the sidebar and its divider, below the top bar and the pane's header.
      const ratio =
        split.direction === 'beside'
          ? (at.x - layout.sidebarWidth - 1) / Math.max(1, layout.mainWidth - 1)
          : (at.y - 3 - 2) / Math.max(1, layout.bodyHeight - 2 - 1)
      return {
        ...this.wire.state,
        splits: { ...this.wire.state.splits, [task]: { ...split, ratio: splitRatio(ratio) } },
      }
    }
    const split = this.wire.state.terminalSplit
    if (!split) return this.wire.state
    const width = layout.sidebarWidth + layout.mainWidth + 1
    const top = 3 + layout.bodyHeight + 2
    const ratio =
      split.direction === 'beside'
        ? at.x / Math.max(1, width - 1)
        : (at.y - top) / Math.max(1, layout.stripHeight - 2 - 1)
    return { ...this.wire.state, terminalSplit: { ...split, ratio: splitRatio(ratio) } }
  }
}
