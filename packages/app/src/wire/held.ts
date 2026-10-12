import type { LaneView } from '../frame.ts'
import { asking, cutFrom, type HeldLines, holding, keeping, settledAbove } from '../scroll.ts'
import type { Skin } from '../skin.ts'
import type { Wiring } from './context.ts'
import type { Fitting } from './fitting.ts'

// The lines the two screens that scroll back are cut out of.
//
// A lane's screen is read once and cut, not read again per notch: scrollback
// above the live screen cannot change — an agent appends, it never rewrites —
// so the lines are held with how deep the lane was when they were read, and
// the screen is cut out of them. Only the bottom is asked for again. That is
// also what puts the text and the bar beside it on the same frame.

/** The two screens the wheel scrolls back: the agent's pane and the terminal below. */
export type Scrolled = 'pane' | 'terminal'

/** Where each of the two keeps how far back it is. */
const SCROLL_OF = { pane: 'paneScroll', terminal: 'terminalScroll' } as const

/**
 * What has happened to a lane since the lines held of it were read: what says
 * whether its live rows in them may still be drawn, and whether the driver is
 * still to be told it is being looked at.
 */
interface Since {
  /** It printed, so the rows it is still rewriting may say something else now. */
  printed: boolean
  /** A look answered from the lines held rather than reading them again. */
  skipped: boolean
  /** The driver was told its newest lines are still looked at, since the last look. */
  told: boolean
}

/** A screen cut from the lines held, and whether it is the whole answer or a look still has to read. */
export interface Cut {
  screen: string
  whole: boolean
}

export class Held {
  private readonly wire: Wiring
  private readonly fitting: Fitting
  private readonly skin: Skin
  /**
   * The lines the pane and the terminal were last read as, and how deep the read
   * went, which the wheel cuts a new screen out of: replaced, never written into.
   */
  private kept: ReadonlyMap<Scrolled, HeldLines> = new Map()
  private readonly since: Record<Scrolled, Since> = {
    pane: { printed: false, skipped: false, told: false },
    terminal: { printed: false, skipped: false, told: false },
  }

  constructor(wire: Wiring, fitting: Fitting, skin: Skin) {
    this.wire = wire
    this.fitting = fitting
    this.skin = skin
  }

  /** What the frame is handed: a selection dragged over a screen and scrolled reaches into these. */
  get lines(): ReadonlyMap<Scrolled, HeldLines> {
    return this.kept
  }

  /** Another lane is in front of an area: a notch cut out of the one it left would be that one. */
  drop(area: Scrolled): void {
    this.kept = holding(this.kept, area, null)
  }

  /** The lane in front of an area printed. */
  printed(area: Scrolled): void {
    this.since[area].printed = true
  }

  /**
   * A lane's screen, cut to where it is scrolled to — read back from the
   * driver only when what is already held does not reach that far.
   *
   * Scrollback is the one thing about a lane that cannot change: the agent
   * appends, it never rewrites what it printed an hour ago. So a screen read
   * two thousand lines back is read once, and the wheel moving through it is
   * an array slice. What still has to be asked every look is the bottom,
   * where the agent is typing, and that is the cheap end — which is what
   * `settledAbove` holds this to. Answering the bottom from held lines too, a
   * lane repainting in place never gets deeper, so the pane froze on the first
   * screen ever read of it and drew that for as long as you watched.
   */
  async read(
    area: Scrolled,
    lane: string | null,
    rows: number,
    view: LaneView | null,
  ): Promise<string> {
    if (!lane) {
      this.drop(area)
      return ''
    }
    const which = SCROLL_OF[area]
    const at = view?.lines ?? 0
    // Never further back than there is to read: the wheel is clamped against
    // what the last frame drew, and this is the same clamp against what the
    // driver says now, for a lane that shrank or was relaunched under us.
    const most = Math.max(0, at - rows)
    if (at > 0 && this.wire.state[which] > most)
      this.wire.put({ ...this.wire.state, [which]: most })
    const back = this.wire.state[which]
    const since = this.since[area]
    // A look: the next notch may tell the driver again (`keepWatching`).
    since.told = false
    const held = keeping(view) && this.settled(lane, back) ? this.kept.get(area) : undefined
    if (held?.lane === lane && at >= held.at) {
      const cut = cutFrom(held, rows, back, at)
      if (cut !== null) {
        since.skipped = true
        return cut
      }
    }
    // Room to move in before the driver has to be asked again — only once
    // there is scrollback in play, so a lane at its newest line costs what it
    // always did — and the same count for a run of notches (`asking`).
    const asked = asking(rows, back)
    // Before the read, so a print that lands while it is under way still counts.
    since.printed = false
    since.skipped = false
    const captured = (await this.wire.live?.capture(lane, asked, this.skin.colour)) ?? ''
    const lines = captured.split('\n')
    // A capture ends at the newest line, so how many lines came back is what
    // says which lines they are. A lane with no depth of its own — half of a
    // split — has only its capture to count from.
    const read = { lane, lines, at: Math.max(at, lines.length), asked }
    this.kept = holding(this.kept, area, keeping(view) ? read : null)
    return cutFrom(read, rows, back, read.at) ?? lines.slice(-rows).join('\n')
  }

  /**
   * The lines already held, cut to where the wheel has just put them, so the
   * text moves on the same frame as the bar beside it — or nothing, where
   * they do not reach that far. `shown` is what the area shows now, and the
   * cut is only ever of that lane's own lines: what a focus left is not.
   *
   * Whole where the cut is clear of the live rows (`settledAbove`), and then
   * there is nothing to ask the driver: what a notch changed is where the
   * window is looking, not what the lane holds. Asking anyway cost a screen
   * read a notch in every lane in front of you — 81 ms of a 735 ms flick spent
   * being told that nothing had changed.
   *
   * Over the live rows it is drawn all the same, as new as the look that read
   * it — which is as new as any frame is — and a look still reads them again
   * behind it. The first screenful up from the newest line used to wait for
   * that look on every notch, the text behind the bar: 19 ms from the notch to
   * the text at the median and up to 30 at the ninetieth, measured through the
   * window under test, against 2 and 3 drawn from here.
   */
  cut(area: Scrolled, shown: { lane: string | null; view: LaneView | null }): Cut | null {
    const held = this.kept.get(area)
    if (!held || held.lane !== shown.lane) return null
    const back = this.wire.state[SCROLL_OF[area]]
    const whole = this.settled(held.lane, back)
    // Never live rows older than the last look: a lane that printed while the
    // looks answered from above them has rewritten rows nobody has read since.
    const since = this.since[area]
    if (!whole && since.printed && since.skipped) return null
    const screen = cutFrom(held, this.fitting.laneRows(area), back, shown.view?.lines ?? held.at)
    if (screen === null) return null
    if (whole) this.keepWatching(area, held.lane)
    return { screen, whole }
  }

  /**
   * Tell the driver the newest lines of a lane are still being looked at,
   * while the wheel moves through the lines held above them and the lane goes
   * on printing.
   *
   * A driver that keeps a frame ready keeps it only while it is asked for
   * (`WATCH_MS` in `drivers/pty`), and here nothing asks: the cut is the whole
   * answer. So a long read let it lapse, and the notch back down onto the live
   * rows waited for a frame to be made of everything printed meanwhile. Asked
   * once a look, only while the lane prints — one that is quiet has nothing new
   * to make a frame of — and for what that notch will ask, the first screenful
   * up from the newest line, never the lines held: a frame of those made on
   * every print would cost what holding them saved. Nobody waits for it.
   */
  private keepWatching(area: Scrolled, lane: string): void {
    const since = this.since[area]
    if (since.told || !since.printed) return
    since.told = true
    const rows = this.fitting.laneRows(area)
    const live = this.fitting.rows(lane) ?? rows
    void this.wire.live?.capture(lane, asking(rows, live - 1), this.skin.colour)
  }

  /** `settledAbove`, against the screen this lane was actually made. */
  private settled(lane: string, back: number): boolean {
    const live = this.fitting.rows(lane)
    return live === undefined ? false : settledAbove(back, live)
  }
}
