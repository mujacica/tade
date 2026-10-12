// How often the window looks, and how long it waits before looking again.
//
// Pure, and its own file, because the rate turned out to be the one thing
// about the loop nobody had chosen. The beat was written down; what was never
// written down was the ceiling, and a loop with no ceiling takes whatever the
// machine will give it.

/** How often a lane's screen is re-read when nothing has said it changed. */
export const FRAME_MS = 250

/**
 * How soon a look somebody asked for happens: a focus moved, a split opened,
 * a terminal came to the front. Long enough to take a burst of what that set
 * off in one look. Never what a lane printing waits for (`printedWait`).
 */
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

// ─── a key's echo ────────────────────────────────────────────────────────────
//
// A key typed into a lane is drawn by the lane, not by the window: it goes out
// to a program, comes back as output, is parsed on the emulators' thread, and
// is then read and drawn by a look. Every hop of that waited on a timer — the
// key's own look eight milliseconds out, which found nothing when the program
// had not answered yet and then held the echo to the floor; and the frame,
// paced as if it were news. A lane's echo was 11 ms at p50 and 26 at p99
// against 2 and 5.5 at Tade's own line (`pnpm bench window --lane`).
//
// So the key asks for no look of its own, and its echo is *owed*: the first
// thing the lane prints after it is looked at at once, floor or no floor, and
// the frame that draws it is drawn as a key's (`wire/paint.ts`). One look per
// key, so typing into a lane that streams cannot take the floor away.

/**
 * How long after a key is sent to a lane its echo is owed. Past anything a
 * program at a prompt takes to answer, and short enough that whatever it
 * prints a while later is the ordinary kind again.
 */
export const ECHO_OWED_MS = 100

/**
 * How long to wait before looking at a lane in front that just printed,
 * `since` milliseconds after the last look started.
 *
 * Not `LOOK_SOON_MS`: a read waits for the emulators to have parsed what was
 * printed, so the soon wait bought nothing here, and a look that lands inside
 * it is one the next print then waits a whole floor behind. At once from quiet,
 * then, and no oftener than the floor while it streams — unless it is a key's
 * echo (`owed`), which is never held to the floor.
 */
export function printedWait(since: number, owed: boolean): number {
  if (owed) return 0
  return Math.max(0, LOOK_FLOOR_MS - Math.max(0, since))
}

// ─── how fast the terminal lets the window draw ──────────────────────────────
//
// Everything above is about how often the window *looks*. What nothing said
// was how often the terminal can *take* a frame. On POSIX a write to a TTY is
// synchronous, so the last act of every frame waits until the terminal has
// drained it — and on a loaded machine the terminal is starved too, drains
// slowly, and the window sits in that write not answering keys. Pushing a
// frame every sixteen milliseconds into a terminal that takes forty to accept
// one is not drawing faster; it is the window spending its whole thread
// waiting to be allowed to.
//
// So how long the terminal took to accept each frame is read (`wire/paint.ts`,
// which owns the write), and the least time between two frames follows it: a
// ratchet with a floor and a ceiling, moved here and nowhere else.
//
// **One way, in the sense that matters: it only ever adds time between frames.**
// At the floor it is pi-tui's own throttle and adds nothing, so a terminal that
// keeps up — nearly all of them, nearly always — gets the window it got before.
// It never draws a frame sooner than it would have been drawn.
//
// **Up at once, down a step at a time.** A frame the terminal took more than
// its share to accept doubles the interval on the spot, because every frame
// after it would wait the same. Coming back down asks for evidence: a run of
// frames each comfortably inside what the next step down would allow, and then
// one step. Halfway rules in both directions would put the window back where
// it started on the first quick write and hunt from then on.
//
// **Only what the window asks for itself is paced.** A key you press is still
// drawn at once, because keystroke-to-echo is the one number that matters and a
// terminal slow to accept is no reason to show somebody their own typing later.
// Not by pi-tui's immediate render, which is only for a component that holds
// the focus and the window gives none of them the focus: whatever a key asks
// for while it is being answered is never held (`wire/paint.ts`), and nor is
// the echo of one typed into a lane, which a look draws (`ECHO_OWED_MS`). What
// is paced is everything else: a look, the spinner, the wheel, an event, the
// status beat.

/** The least time between two frames while the terminal keeps up: pi-tui's own throttle. */
export const RENDER_FLOOR_MS = 16

/**
 * The most a slow terminal can stretch it to: the beat. Slower than that and
 * a look's news waits for a frame that comes after the next look — and a
 * terminal that cannot take four frames a second is not one fewer would help.
 */
export const RENDER_CEILING_MS = FRAME_MS

/**
 * How much of the time between two frames the terminal may spend accepting
 * one. Half: the other half is the window's, for answering keys.
 */
export const WRITE_SHARE = 0.5

/** Frames in a row comfortably inside the next step down before it is taken. */
export const EASY_FRAMES = 8

/**
 * Where the ratchet stands: how many doublings above the floor, and how many
 * frames in a row have been easy at the step below.
 */
export interface Pace {
  step: number
  easy: number
}

/** A terminal that has given no reason to wait. */
export const UNHURRIED: Pace = { step: 0, easy: 0 }

/** The least time between two frames at this step. */
export function intervalOf(pace: Pace): number {
  return Math.min(RENDER_CEILING_MS, RENDER_FLOOR_MS * 2 ** pace.step)
}

/** The step the ceiling is reached at: no doubling past it moves anything. */
const TOP = Math.ceil(Math.log2(RENDER_CEILING_MS / RENDER_FLOOR_MS))

/**
 * Where the ratchet stands after a frame the terminal took `accepted`
 * milliseconds to accept.
 *
 * Over its share of the interval, one step up, at once. Comfortably inside the
 * share the step below would allow — half of it, so a step down is a step that
 * stays down — counts towards `EASY_FRAMES`, and that many in a row is one
 * step down. Anything between is neither, and starts the count again: a
 * terminal that is only just keeping up is not yet one that has recovered.
 */
export function paced(was: Pace, accepted: number): Pace {
  const interval = intervalOf(was)
  if (accepted > interval * WRITE_SHARE) return { step: Math.min(TOP, was.step + 1), easy: 0 }
  if (was.step === 0) return UNHURRIED
  const below = intervalOf({ step: was.step - 1, easy: 0 })
  if (accepted > below * WRITE_SHARE * 0.5) return { step: was.step, easy: 0 }
  if (was.easy + 1 < EASY_FRAMES) return { step: was.step, easy: was.easy + 1 }
  return { step: was.step - 1, easy: 0 }
}

/**
 * How long a frame asked for now waits, `since` milliseconds after the last
 * one was drawn. Nothing at the floor — pi-tui's own throttle is the floor —
 * and never longer than the interval.
 */
export function renderWait(pace: Pace, since: number): number {
  if (pace.step === 0) return 0
  return Math.min(intervalOf(pace), Math.max(0, intervalOf(pace) - Math.max(0, since)))
}

// ─── what an event is worth ──────────────────────────────────────────────────
//
// An event is news; it is not necessarily a new picture. Every line the journal
// hears — a tool call, a usage line, a turn ending — changes something the
// window may draw, and every one of them asked for a frame: a storm of four
// hundred over a second and three quarters was 115 frames, pi-tui's ceiling,
// which is what thirteen agents working looks like all day. Nobody reads an
// agent's mark changing sixty times a second, and the frames were the most
// expensive kind there is, drawing a whole window to move a figure.
//
// So news waits for a frame: drawn with the next one anything else asks for —
// a key, a look, the spinner — and on its own no oftener than the spinner
// turns. A single event in a quiet window is drawn at once, because the last
// frame was long enough ago; only a run of them is spread out. News somebody
// is waiting on — an agent asking — is not spread out at all
// (`TimedScreen.requestNews`).

/** The least time between two frames drawn for news alone: what the spinner moves. */
export const NEWS_MS = 100

/**
 * How long a frame for news waits, `since` milliseconds after the last frame
 * was drawn. A clock that went backwards is read as no time at all.
 */
export function newsWait(since: number): number {
  return Math.max(0, NEWS_MS - Math.max(0, since))
}
