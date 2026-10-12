import type { LaneView } from '../frame.ts'

// Whose screen is on screen.
//
// The window reads a lane on its look, and a focus moves between two looks: a
// click, a tab, an agent raised. The screens used to be four strings that
// belonged to whatever was read last, so for up to a beat after a switch the
// pane drew the agent you had just left under the name of the one you had
// gone to — and a look that had already started on the old one finished
// afterwards and put it back. A screen is a lane's, so it says which.

/** The four places a lane is drawn: the pane, its second half, the terminal below, and its second half. */
export type Area = 'pane' | 'split' | 'terminal' | 'splitTerminal'

/** A lane's screen as it was last read, and whose it is. */
export interface Shown {
  readonly lane: string | null
  readonly screen: string
  /** What the driver said beside it — how deep, where typing lands — where it was asked. */
  readonly view: LaneView | null
}

/**
 * How many lanes' last screens are kept for a focus to come back to: the agents
 * somebody moves between in a sitting, not every lane there is.
 */
export const KEPT_SCREENS = 8

const NOTHING: Shown = { lane: null, screen: '', view: null }

export class Screens {
  private readonly shown = new Map<Area, Shown>()
  /** Each lane's newest screen, oldest first, so the one to let go of is the first. */
  private readonly last = new Map<string, Shown>()

  /** What an area shows now. */
  of(area: Area): Shown {
    return this.shown.get(area) ?? NOTHING
  }

  /**
   * A screen just read for an area, put in front. True when what the area shows
   * changed. `newest` says it was read at the lane's newest line, which is the
   * only screen worth coming back to: arriving at an agent is arriving at its end.
   */
  read(area: Area, shown: Shown, newest: boolean): boolean {
    const was = this.of(area)
    this.shown.set(area, shown)
    if (newest && shown.lane !== null) {
      this.last.delete(shown.lane)
      this.last.set(shown.lane, shown)
      for (const old of this.last.keys()) {
        if (this.last.size <= KEPT_SCREENS) break
        this.last.delete(old)
      }
    }
    return was.lane !== shown.lane || was.screen !== shown.screen
  }

  /**
   * The lane in front of an area now. Where that is not the lane its screen was
   * read from, the area shows that lane's own last screen, or nothing at all —
   * never another lane's — and true says a look is owed to read it.
   */
  front(area: Area, lane: string | null): boolean {
    if (this.of(area).lane === lane) return false
    this.shown.set(area, (lane !== null && this.last.get(lane)) || { ...NOTHING, lane })
    return true
  }
}
