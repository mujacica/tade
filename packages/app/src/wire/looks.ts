import { ECHO_OWED_MS, lookWait, printedWait, SLOW_LOOK_MS } from '../pace.ts'
import type { AppOptions } from './context.ts'

// When the window looks at the lanes in front of it, one look at a time.
//
// Three things ask for a look and each is owed a different wait (`pace.ts`):
// the beat, which looks every quarter of a second whatever happened; something
// somebody did — a focus moved, a split opened — which is looked at soon
// (`lookWait`); and a lane in front printing, which is looked at now and no
// oftener than the floor while it streams (`printedWait`).
//
// A key typed into a lane is the reason the last of those is now rather than
// soon. Its echo is the lane printing, so the key asks for no look of its own:
// one asked for by the key landed before the program had answered, found
// nothing, and held the echo a whole floor behind it — every eighth key or so
// at 25–35 ms. Instead the echo is *owed*: the first print after the key is
// looked at at once, floor or no floor, and the frame it draws is drawn as a
// key's would be (`Screen.oweEcho`).

/** What a look waiting to happen was asked for by: somebody doing something, or a lane printing. */
type Asked = 'soon' | 'printed'

export interface LooksDeps {
  /** Read the lanes in front and draw what changed. */
  look(): Promise<void>
  stopped(): boolean
  /** A key went to a lane: whatever draws its echo is drawn as a key's frame. */
  owe(): void
  /** A look took longer than `SLOW_LOOK_MS`, which started at `startedAt`. */
  slow(startedAt: number): void
}

export class Looks {
  private readonly deps: LooksDeps
  /** A look is under way, and what asked for another while it was. */
  private looking = false
  private again: Asked | null = null
  /** How to call off the look waiting to happen, and when it is due, by the real clock. */
  private soon: (() => void) | null = null
  private dueAt = Number.POSITIVE_INFINITY
  /** When the last look started, by the real clock, as `tick` times one. */
  private lookedAt = 0
  /** Until when a key typed into a lane is owed a look at its echo. */
  private owedUntil = Number.NEGATIVE_INFINITY
  /** The lane printed while its echo was owed, and no look has started since. */
  private echoed = false

  constructor(deps: LooksDeps) {
    this.deps = deps
  }

  /**
   * Look now, one look at a time. Looks overlapping could finish out of
   * order, and a slow one finishing last would put back the screen the fast
   * one had just replaced: a line blinking, text from one frame interleaved
   * with the next. Asked again while looking, it asks the way it was asked —
   * starting one here was a look the instant the last ended, no delay.
   */
  async tick(asked: Asked = 'soon'): Promise<void> {
    if (this.deps.stopped()) return
    if (this.looking) {
      // A print is the stronger reason, and an echo waiting is one whoever asked.
      if (this.again !== 'printed') this.again = this.echoed ? 'printed' : asked
      return
    }
    this.looking = true
    // Timed by the clock, not the app's: how long a look really took is the
    // question, and a test's clock stands still.
    const started = Date.now()
    this.lookedAt = started
    // This look reads the echo, so it is paid: the next print is an ordinary
    // one, and the frame it draws is the key's however long the echo took —
    // a look that started before the echo arrived read the cursor before it
    // and the text after it, and this is the one that puts the two together.
    if (this.echoed) {
      this.owedUntil = Number.NEGATIVE_INFINITY
      this.deps.owe()
    }
    this.echoed = false
    try {
      await this.deps.look()
    } finally {
      this.looking = false
      // Only the ones worth asking about: a look is meant to be cheap, and one
      // slower than the time between two is Tade getting in its own way.
      if (Date.now() - started > SLOW_LOOK_MS) this.deps.slow(started)
    }
    const again = this.again
    this.again = null
    if (again === 'printed') this.printed()
    else if (again === 'soon') this.soonTick()
  }

  /**
   * Look at the lanes again in a moment: long enough to take a burst of what
   * was just done in one look, short enough that it is on screen before
   * anybody notices it was not.
   */
  soonTick(): void {
    this.after(lookWait(Date.now() - this.lookedAt), 'soon')
  }

  /**
   * A lane in front printed. Reading waits for the emulators to have parsed
   * it, so a look now is never a look at half of it; one owed to a key's echo
   * is not held to the floor either.
   */
  printed(): void {
    const now = Date.now()
    if (now < this.owedUntil) this.echoed = true
    this.after(printedWait(now - this.lookedAt, this.echoed), 'printed')
  }

  /** A key was typed into a lane: its echo is owed a look, and a frame. */
  typed(): void {
    this.owedUntil = Date.now() + ECHO_OWED_MS
    this.deps.owe()
  }

  /** Nothing more is looked at: the window is closing. */
  stop(): void {
    this.soon?.()
    this.soon = null
  }

  /** A look in `wait` ms — or sooner, where one is already waiting to happen sooner. */
  private after(wait: number, asked: Asked): void {
    if (this.deps.stopped()) return
    const due = Date.now() + wait
    if (this.soon) {
      if (this.dueAt <= due) return
      this.soon()
    }
    this.dueAt = due
    const look = () => {
      this.soon = null
      this.dueAt = Number.POSITIVE_INFINITY
      void this.tick(asked)
    }
    // No wait is not a timer's millisecond, which is what a timeout of nothing
    // costs: the end of this turn of the loop, so whatever else a lane printed
    // in it is read by the same look.
    if (wait <= 0) {
      const at = setImmediate(look)
      this.soon = () => clearImmediate(at)
    } else {
      const at = setTimeout(look, wait)
      this.soon = () => clearTimeout(at)
    }
  }
}

/**
 * What a slow look is reported as (`add-reporter`): how much the window had in
 * front of it, which is what tells a busy machine from a window with too much
 * to look at.
 */
export function slowLook(
  opts: Pick<AppOptions, 'report' | 'client' | 'config'>,
  tasks: number,
  startedAt: number,
): void {
  opts.report
    ?.doing({
      name: 'a look at the tasks',
      op: 'tade.look',
      startedAt,
      attributes: {
        'tade.tasks': tasks,
        'tade.agents': opts.client.runs().length,
        'tade.projects': Object.keys(opts.config.projects).length,
      },
    })
    .end()
}
