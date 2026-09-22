// How often the window looks, and how long it waits before looking again.
//
// Pure, and its own file, because the rate turned out to be the one thing
// about the loop nobody had chosen. The beat was written down; what was never
// written down was the ceiling, and a loop with no ceiling takes whatever the
// machine will give it.

/** How often a lane's screen is re-read when nothing has said it changed. */
export const FRAME_MS = 250

/** How soon after a lane prints something it is looked at again. */
export const LOOK_SOON_MS = 8

/**
 * The least time between two looks, however fast the lane in front is printing.
 *
 * `LOOK_SOON_MS` says how quickly a look may follow something happening, which
 * is what puts a keystroke on screen as you type it. What nothing said is how
 * *often*: an agent streaming output asks for a look with every chunk it
 * prints, so the rate was one over whatever a look happened to cost — and that
 * is the wrong thing for it to depend on, because the cheaper a look gets the
 * harder the loop spins. Measured at 58 looks a second against a beat of four
 * on a full-sized window, and 107 on a small one, where a look costs less.
 *
 * Thirty a second is past what anyone reads text at, and is still seven times
 * the beat. Nothing is skipped by looking less often — a look reads the screen
 * as it is now, so the one that happens shows everything the ones that did not
 * would have.
 */
export const LOOK_FLOOR_MS = 33

/** How long a screen the terminal wiped on its own stays dark, at most. */
export const REPAINT_MS = 2_000

/**
 * A look at the tasks slower than this is worth knowing about: the window
 * looks every couple of seconds, so one this slow is already late for the next.
 */
export const SLOW_LOOK_MS = 2_000

/**
 * How long to wait before looking again, `since` milliseconds after the last
 * look started.
 *
 * Soon, but never sooner than the floor allows. After a quiet moment the whole
 * of `LOOK_SOON_MS` is left to run, which is what makes a keystroke appear as
 * you type it; under an agent printing flat out it is whatever is left of the
 * floor, which is what keeps the loop off the machine.
 *
 * A `since` below zero is a clock that went backwards, and is read as no time
 * at all rather than as a reason to wait longer than the floor ever allows.
 */
export function lookWait(since: number): number {
  return Math.max(LOOK_SOON_MS, LOOK_FLOOR_MS - Math.max(0, since))
}
