import type { Component, TuiMouseEvent, TuiMouseEventResult } from '@earendil-works/pi-tui'
import type { PointerReport } from '@tade/drivers-core'
import type { Frame } from './frame.ts'
import {
  extentOf,
  type Hit,
  hitBoxAt,
  pressable,
  type ScrollArea,
  scrollAt,
  selectableText,
  type Target,
} from './hits.ts'
import type { AppState } from './model.ts'
import { type Reach, reachOf, Wheel } from './scroll.ts'
import {
  cellsIn,
  type End,
  highlighted,
  lineAt,
  type Region,
  type Regions,
  selectedText,
  spanText,
  type Within,
} from './selection.ts'
import { draw } from './view.ts'

// What the terminal reported, turned into what the window means by it — and
// the selection laid over what was drawn.
//
// `Painted` is the one component the TUI holds: it paints a frame, keeps the
// hits that frame drew, and reads every press, drag and notch back against
// them. Where something ended up is always the drawing pass's to say, which is
// why nothing here lays a region out a second time to work it out.
//
// The rest is the selection: a drag over the window takes text rather than
// controls, bounded to the columns of the region it was started in, because
// the window is regions side by side and not one flow of text. What it covers
// lives in `selection.ts`; what is here is the gesture — where it was started,
// where it has got to, and the edge it is being held off.

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
   *
   * `cell` is how far along the box the pointer landed, not how far along the
   * window: the line is drawn at the foot on most screens and in the middle
   * of the pane on an empty project's (`linePlace`), and the editor counts
   * columns from its own left edge either way.
   */
  | { kind: 'select'; line: number; cell: number; extend: boolean; drag: boolean }
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
   * A selection being dragged in a region that scrolls: how far past its top or
   * its bottom edge the pointer is being held, negative above it, and `0` back
   * inside it.
   *
   * Reaching the edge is the only way to select past what is on screen with a
   * mouse, so the region scrolls under the selection until the pointer comes
   * back inside or the drag is let go. `reach` is how far the region goes, read
   * off the bar the last frame drew beside it, as every other scroll is.
   */
  | { kind: 'drag-region'; area: ScrollArea; rows: number; reach: Reach }
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
  /**
   * The pointer over a lane that answers it itself — pressed, dragged with a
   * button held, let go — in that lane's own cells, never the window's.
   *
   * The window keeps nothing about it: whatever the program draws in answer
   * is read back on the next look, like everything else it draws.
   */
  | { kind: 'point'; lane: string; report: PointerReport }
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
export class Painted implements Component {
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
    /**
     * The region it was started in, where that region scrolls: its own lines
     * are where the two ends really live, so scrolling does not abandon the
     * selection and copying gives the pages of it that are off screen.
     */
    area: ScrollArea | null
    from: End
    to: End
    moved: boolean
    /**
     * The columns of the region it was started in, which it never reaches
     * out of. The window is columns side by side rather than one flow of
     * text, so a selection that took whole rows between its two ends took
     * the sidebar with it: dragging over an agent came back with the queue
     * and the agents beside it.
     */
    within: Within | null
  } | null = null
  /** The regions the last frame drew, by area: where a selection is anchored. */
  private regions: Regions = {}
  /**
   * A press inside a lane that answers the pointer itself: everything until
   * it is let go goes there too, wherever the pointer wanders. Kept with the
   * cells the region was drawn in, so a drag that leaves it is clamped to its
   * edge rather than reported as a cell of somebody else's screen — which is
   * what a terminal does with a pointer dragged off its own window.
   */
  private pointed: {
    lane: string
    drags: boolean
    /** Columns of the window the lane's own screen was drawn across. */
    from: number
    to: number
    /** Where the region starts down the window, and the lane's own row there. */
    top: number
    rows: number
    at: number
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
    this.regions = drawn.regions ?? {}
    const selection = this.selection
    if (!selection?.moved) return drawn.rows
    // Projected onto the frame in front of you rather than kept as the cells
    // it was made in: the region may have scrolled since, and an offset into
    // rows that have gone is an offset into nothing.
    const chosen = cellsIn(selection, this.regionOf(selection.area), selection.within)
    return highlighted(drawn.rows, chosen, width, selection.within)
  }

  /** The region a selection is anchored in, where the last frame drew one. */
  private regionOf(area: ScrollArea | null): Region | null {
    return area ? (this.regions[area] ?? null) : null
  }

  /**
   * How far a drag has gone past the top or the bottom of the region it was
   * started in — negative above it — which is what the region is scrolled by
   * while the pointer is held there. Nothing, where it is still inside it or
   * where the region does not scroll.
   */
  private pastEdge(y: number): number {
    const region = this.regionOf(this.selection?.area ?? null)
    if (!region) return 0
    const last = region.row + Math.max(0, region.rows - 1)
    return y < region.row ? y - region.row : y > last ? y - last : 0
  }

  /** What a finished selection puts on the clipboard: its whole span, off-screen pages included. */
  private copied(): string {
    const selection = this.selection
    if (!selection) return ''
    const region = this.regionOf(selection.area)
    // Out of the region's own lines where it was anchored in one, and out of
    // the rows on screen where there was no region to anchor it in — the
    // sidebar, a panel, a page that does not scroll.
    if (region && selection.from.line !== null) return spanText(region, selection, selection.within)
    return selectedText(this.rows, cellsIn(selection, null, selection.within), selection.within)
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
        // A press inside a lane that answers the pointer goes on being that
        // lane's until it is let go, wherever the pointer wanders — and only
        // where it asked to be told about movement. One that asked only
        // about presses is told nothing here, and the window does not select
        // over it either: the press was its, and half a drag reported to
        // nobody is neither.
        if (event.type === 'drag' && this.pointed) {
          if (!this.pointed.drags) return { handled: true, render: false }
          return {
            handled: true,
            render: this.onPointer(this.reportOf('drag', event)),
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
              cell,
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
          // The far end follows the pointer while the drag is live: its line is
          // whatever is under it now, which is what makes the wheel and the
          // edge scroll *extend* a selection rather than leave it behind.
          this.selection = {
            ...this.selection,
            to: { x: event.x, y: event.y, line: null },
            moved: true,
          }
          const area = this.selection.area
          if (!area) return { handled: true, render: true }
          this.onPointer({
            kind: 'drag-region',
            area,
            rows: this.pastEdge(event.y),
            reach: reachOf(this.hits, area),
          })
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
        if (event.button === 'right' && target && target.kind !== 'screen') {
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
        // A cell of a lane that answers the pointer itself. Before the
        // buttons below, because there are none here to find: every cell of
        // it was drawn by the program, and what Tade drew around it — the
        // header, the bar or the mark down its side, the approval card — is
        // not in this range at all. Held, so the drag and the release that
        // follow go to the same lane even if the pointer leaves it.
        if (target?.kind === 'screen') {
          this.held = null
          this.selection = null
          this.selectingInput = null
          this.selectingFile = null
          this.pointed = {
            lane: target.lane,
            drags: target.drags,
            from: box?.from ?? 0,
            to: box?.to ?? 0,
            ...extentOf(this.hits, target),
            at: target.from,
          }
          return { capture: true, render: this.onPointer(this.reportOf('press', event)) }
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
              cell,
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
        // ever within the one region it was started in. A link or a path is
        // both: the press starts a selection here too, and the click that
        // opens it only arrives if the pointer never moved.
        const area = scrollAt(this.hits, event.x, event.y)
        const across = area ? extentOf(this.hits, { kind: 'scroll', area }, true) : null
        const region = this.regionOf(area)
        // Anchored in the region's own line rather than in the row it is on
        // now, so scrolling carries the selection with it instead of losing it.
        const at: End = {
          x: event.x,
          y: event.y,
          line: region ? lineAt(region, event.y) : null,
        }
        this.selection =
          pressable(target) && !selectableText(target)
            ? null
            : {
                area,
                from: at,
                to: { ...at },
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
        // The lane it was pressed in hears about it first and alone: a
        // release it never gets is a button it thinks is still down.
        if (this.pointed) {
          const said = this.reportOf('release', event)
          this.pointed = null
          return { handled: true, render: this.onPointer(said) }
        }
        if (this.selectingInput?.dragged) this.onPointer({ kind: 'selected' })
        this.selectingInput = null
        // Only a drag copies, as on the line you type on: a shift+click and a
        // double click select, and leave the clipboard alone.
        if (this.selectingFile?.dragged) this.onPointer({ kind: 'selected-file' })
        this.selectingFile = null
        const moved = this.selection?.moved === true
        if (this.selection) {
          // Where the far end stopped, fixed: until now it followed the
          // pointer, and left following it the highlight would slide under the
          // next scroll of a region nobody is dragging in any more.
          const region = this.regionOf(this.selection.area)
          if (region && this.selection.to.line === null) {
            this.selection = {
              ...this.selection,
              to: { ...this.selection.to, line: lineAt(region, this.selection.to.y) },
            }
          }
        }
        if (moved) {
          const text = this.copied()
          if (text.trim() !== '') this.onCopy(text)
        }
        // Kept lit until the next press, so you can see what was copied.
        if (!moved) this.selection = null
        return { handled: true, render: this.onPointer({ kind: 'release' }) || moved }
      }
      case 'click':
        // A terminal makes one out of the press and the release it already
        // reported, and both of those have gone to the lane: passed on here
        // as well it would be the same click twice.
        if (target?.kind === 'screen') return { handled: true, render: false }
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

  /**
   * What the pointer did, in the cells of the lane it was pressed in.
   *
   * Clamped to the region the press started in, because that is the whole of
   * the screen the program has: a drag let out over the sidebar is a pointer
   * dragged off the edge of its window, which every terminal reports as the
   * edge rather than as somewhere it cannot see.
   */
  private reportOf(
    did: 'press' | 'drag' | 'release',
    event: TuiMouseEvent,
  ): Extract<PointerEvent, { kind: 'point' }> {
    const held = this.pointed
    const at = held ?? { lane: '', from: 0, to: 0, top: 0, rows: 1, at: 0 }
    const column = Math.min(Math.max(event.x, at.from), at.to) - at.from
    const row =
      at.at + Math.min(Math.max(event.y, at.top), at.top + Math.max(0, at.rows - 1)) - at.top
    return {
      kind: 'point',
      lane: at.lane,
      report: {
        did,
        button: event.button === 'none' ? 'left' : event.button,
        column,
        row,
        shift: event.shift,
        alt: event.alt,
        ctrl: event.ctrl,
      },
    }
  }

  invalidate(): void {
    // Nothing is cached: every frame is drawn from the state as it is.
  }
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
