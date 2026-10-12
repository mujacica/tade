import type { Frame } from './frame.ts'
import { inboxHere, inboxMark } from './intake-view.ts'
import { type AppState, markOf, SPIN_MS, sectionOpen } from './model.ts'
import { onATurn } from './transcript.ts'

// Whether anything on screen turns, and when it next does.
//
// Its own file rather than `model.ts`'s because two of the things that turn are
// not the state's: a check running on the ACTIONS page and work a request down
// INTAKE started are each their own subject's, and reach the window only as
// the frame (`Shown`). Asking the intake marks from `model.ts` would be a cycle,
// since they are drawn in its vocabulary.
//
// Pure, like the rest of the drawing: the window hands in the moments, and
// `Window` (`wire/window.ts`) is what keeps the clock these answer for.

/** What a frame shows turning that the state does not hold. */
export type Shown = Pick<Frame, 'actions' | 'intake'>

/**
 * Whether anything on screen turns: the orchestrator on a turn, one of its
 * tools running, or an agent working in any project — every project's tab
 * wears its agents' marks, and the right of the top row counts all of them —
 * and, from the frame, a check running on the ACTIONS page or a request down
 * INTAKE whose work is going.
 *
 * Left out, those two moved only when something else drew: a running check's
 * spinner and its tenths of a second stood still for as long as nothing else
 * on screen changed.
 */
export function turning(state: AppState, shown: Shown = {}): boolean {
  if (onATurn(state.transcript)) return true
  if (state.transcript.entries.some((one) => one.kind === 'tool' && one.state === 'running'))
    return true
  if (state.panes.some((pane) => markOf(pane) === 'working')) return true
  const actions = shown.actions
  if (actions && (actions.running || actions.checks.some((one) => one.state === 'running')))
    return true
  // As the side draws it: the project in front's requests, and only while the
  // section is open — a folded heading wears no row's mark.
  const here = inboxHere(shown.intake ?? [], state.project)
  if (here.length === 0 || !sectionOpen(state, 'intake', false)) return false
  return here.some((row) => inboxMark(row).mark === 'working')
}

/**
 * Whether a look that read nothing new in either lane is still worth a frame:
 * something turns, and the spinner shows another frame at `now` than it did
 * on the frame drawn at `drawn`.
 *
 * What a frame is news about, rather than whether anything is working. Asked
 * that way it passed every look while any agent worked, and a lane printing in
 * front of you asks for a look up to thirty times a second — thirty frames to
 * show a spinner that moves ten. A rule of the moments, never of a clock read
 * here, so the window asks it with the moment its last frame was drawn for.
 */
export function turnedSince(
  state: AppState,
  drawn: number,
  now: number,
  shown: Shown = {},
): boolean {
  return turning(state, shown) && Math.floor(now / SPIN_MS) !== Math.floor(drawn / SPIN_MS)
}

/**
 * How long after `now` the spinner shows its next frame: the next boundary of
 * `SPIN_MS`, never `now` itself, so a frame drawn on a boundary waits a whole
 * turn rather than asking again for the one it is.
 */
export function untilTurns(now: number): number {
  return SPIN_MS - (((now % SPIN_MS) + SPIN_MS) % SPIN_MS)
}
