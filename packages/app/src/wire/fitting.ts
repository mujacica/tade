import type { LaneId } from '@tade/core'
import { halvesOf, resolveLayout } from '../layout.ts'
import { laneShown, terminalsOf } from '../model.ts'
import { BAR } from '../scrollbar.ts'
import { splitShown, terminalSplitShown } from '../split.ts'
import { carded, rowsRead } from '../view/lane.ts'
import type { Wiring } from './context.ts'

// How big each lane is made, and when it is told.
//
// A lane is resized by telling the program in it, and the program answers by
// drawing its whole screen again: Claude Code repaints every row, pi reflows
// its conversation. So a lane is told a size once per size, and a size that is
// still moving — the terminal window being dragged, a divider being dragged —
// is not told at all until it holds still. Dragging the window used to resize
// the agent in front on every look, up to thirty times a second, each one a
// repaint the window then had to read back.
//
// And a lane is never told a size because of something that is not about it.
// The conversation with the orchestrator takes rows from the pane while it
// goes on; the agent in front used to be made shorter when a turn started and
// taller when it ended, two whole repaints a turn because somebody spoke to
// somebody else. The pane is drawn in fewer rows instead, showing the newest
// of the lane's, as it is under an approval card.

/**
 * How long a new size has to hold still before a lane already made is told it:
 * longer than the gap between two moves of a hand dragging an edge, shorter
 * than anybody waits to see the agent fill the room it was given.
 */
export const SETTLE_MS = 120

export interface Size {
  cols: number
  rows: number
}

export interface FittingDeps {
  /** How big the terminal is: every lane is sized from it. */
  size(): { columns: number; rows: number }
  /** Lanes were told a new size, and what they draw in answer is worth a look. */
  told(): void
}

function sameSize(a: Size, b: Size): boolean {
  return a.cols === b.cols && a.rows === b.rows
}

export class Fitting {
  private readonly wire: Wiring
  private readonly deps: FittingDeps
  /** How each lane was last made, which is the size it is. */
  private readonly fitted = new Map<string, Size>()
  /** The sizes waiting to hold still, by lane. */
  private readonly owed = new Map<string, Size>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(wire: Wiring, deps: FittingDeps) {
    this.wire = wire
    this.deps = deps
  }

  /** The rows a lane was last made, which is how tall its live screen is. */
  rows(lane: string): number | undefined {
    return this.fitted.get(lane)?.rows
  }

  /**
   * Make a lane this size.
   *
   * `now` is for a lane in front of you that has never been made any size
   * here: drawn at a size nobody chose for it until the next settle is the
   * reflow this exists to keep out of sight. Everything else waits for the
   * size to hold still. A size asked for again unchanged does not start the
   * wait over — a lane printing is looked at every few milliseconds, and a
   * wait restarted by every look would never end.
   */
  async fit(lane: string, size: Size, now = false): Promise<void> {
    const was = this.fitted.get(lane)
    if (was && sameSize(was, size)) {
      this.owed.delete(lane)
      return
    }
    if (now && !was) {
      this.owed.delete(lane)
      await this.tell(lane, size)
      return
    }
    const owed = this.owed.get(lane)
    if (owed && sameSize(owed, size)) return
    this.owed.set(lane, size)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.settle(), SETTLE_MS)
    this.timer.unref?.()
  }

  /**
   * Make every live lane in the project the size it would be drawn at, not
   * only the ones in front, so going to another agent is not watching it
   * reflow. Each is told once its size holds still, as any size that moved
   * is; a lane already that size is a lookup, so this is asked every look.
   */
  behind(): void {
    const state = this.wire.state
    for (const pane of state.panes) {
      if (pane.project !== state.project) continue
      const lane = laneShown(state, pane)
      if (!lane || !pane.lanes.some((one) => one.id === lane)) continue
      const split = splitShown(state, pane)
      const halves = halvesOf(this.paneSize(split !== null), split)
      void this.fit(lane, halves.first)
      if (split) void this.fit(split.lane, halves.second)
    }
    // Folded, the panel has no room to size a terminal to; split, which half a
    // terminal would come to depends on which tab is pressed. Both are sized
    // when they are in front.
    if (state.bottomMode === 'min' || state.terminalSplit) return
    const below = this.terminalHalves().first
    for (const terminal of terminalsOf(state)) void this.fit(terminal.id, below)
  }

  /** Tell nothing more: the window is closing. */
  stop(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.owed.clear()
  }

  /**
   * The agent's part of the window: the pane, less its title and rule — as a
   * lane is made, or with `grown`, as it is drawn while the conversation has
   * the room, which only ever shows fewer of the same lane's rows.
   */
  paneSize(split = false, grown = false): Size {
    const layout = this.resolved(grown)
    // The scrollbar's column is the window's, not the lane's: a lane sized to
    // the whole pane would draw its last column under the bar.
    return {
      cols: Math.max(20, layout.mainWidth - (split ? 0 : BAR)),
      rows: Math.max(4, layout.bodyHeight - 2),
    }
  }

  /**
   * How many rows of a lane are on screen: what a capture is cut to. Exactly
   * the lines the region shows, counted as the drawing counts them — the clamp
   * here and the bar it draws have to agree about where the end is, or the top
   * of a scrollback springs back a row under every notch.
   */
  laneRows(area: 'pane' | 'terminal'): number {
    if (area === 'terminal') return this.terminalHalves().first.rows
    const state = this.wire.state
    const pane = state.panes.find((p) => p.task === state.focused)
    const split = pane ? splitShown(state, pane) : null
    // As the pane is drawn, which the conversation below may have grown into:
    // the lane keeps its size and the newest of its rows are what show.
    const rows = halvesOf(this.paneSize(split !== null, true), split).first.rows
    const lane = pane ? laneShown(state, pane) : null
    return rowsRead(rows, !split && carded(pane, lane), !split && state.paneScroll > 0)
  }

  /**
   * The bottom panel's two halves, sized as the window draws them: its width
   * less the scrollbar's column, which the window draws and the lane must not
   * — a split has none and takes it back — and the strip less its own frame.
   * One answer, because a screen cut to the wrong number of rows jumps when
   * the look catches up with the wheel.
   */
  terminalHalves(): ReturnType<typeof halvesOf> {
    const layout = this.resolved()
    const split = terminalSplitShown(this.wire.state)
    return halvesOf(
      {
        cols: Math.max(20, layout.sidebarWidth + layout.mainWidth + 1 - (split ? 0 : BAR)),
        rows: Math.max(1, layout.stripHeight - 2),
      },
      split,
    )
  }

  /**
   * How big a terminal opened here is made: the whole width under the window,
   * and the strip's height less its own two rows of frame. One answer, because
   * a terminal made one size and read at another is a screen that jumps.
   */
  terminalSize(): Size {
    const layout = this.resolved()
    return {
      cols: layout.sidebarWidth + layout.mainWidth + 1,
      rows: Math.max(4, layout.stripHeight - 2),
    }
  }

  /**
   * The window as it is laid out now: what every lane in it is sized against —
   * never grown for the conversation below, unless `grown` asks for the pane
   * as it is drawn.
   */
  private resolved(grown = false): ReturnType<typeof resolveLayout> {
    const { columns, rows } = this.deps.size()
    const prefs = this.wire.layout()
    return resolveLayout(grown ? prefs : { ...prefs, grow: false }, {
      width: columns,
      height: Math.max(6, rows),
    })
  }

  /** The sizes held still: every lane owed one is told it, at once. */
  private async settle(): Promise<void> {
    this.timer = null
    const owed = [...this.owed]
    this.owed.clear()
    await Promise.all(owed.map(([lane, size]) => this.tell(lane, size)))
    if (owed.length > 0) this.deps.told()
  }

  private async tell(lane: string, size: Size): Promise<void> {
    this.fitted.set(lane, { cols: size.cols, rows: size.rows })
    await this.wire.opts.client.resize(lane as LaneId, size.cols, size.rows).catch(() => {
      // A lane that just ended cannot be resized; the next look will not ask.
    })
  }
}
