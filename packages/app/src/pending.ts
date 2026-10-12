import type { AgentPane, AppState, TaskSnapshot } from './model.ts'

// Answering a press before what it asked for has answered.
//
// A press that waits on another process — the workbench deciding an approval,
// a harness asked what it runs, a shell starting — used to change nothing on
// screen until that process came back, and a click with no answer reads as one
// that did not land. So what Tade decides for itself is done at once: the
// control stays held down while its action runs (`AppState.busy`, set by
// `Router.run`), and an approval's card goes the moment it is answered. What
// has to be asked is still asked; nothing waits on it before it is drawn.

/**
 * An approval answered from here: its card goes now, before the workbench has
 * heard, and a look that began before the answer does not bring it back
 * (`stillAnswered`). With nothing waiting, the state is as it was.
 */
export function answering(state: AppState, task: string): AppState {
  const pane = state.panes.find((one) => one.task === task)
  if (!pane?.approval) return state
  return {
    ...state,
    answered: { ...state.answered, [task]: requestOf(pane.approval) },
    panes: state.panes.map((one) =>
      one.task === task ? { ...one, approval: null, waiting: false } : one,
    ),
  }
}

/** The answer did not land: the card is the next look's to draw again. */
export function unanswered(state: AppState, task: string): AppState {
  if (!(task in state.answered)) return state
  const answered = { ...state.answered }
  delete answered[task]
  return { ...state, answered }
}

/**
 * The answers no look has caught up with: each kept only while a look still
 * shows the very request that was answered. A look without it, or with another,
 * is the answer having landed — and another request is drawn whatever it says,
 * because an agent asking the same thing twice is waiting on you twice.
 */
export function stillAnswered(
  answered: AppState['answered'],
  tasks: readonly TaskSnapshot[],
): AppState['answered'] {
  const stale = Object.entries(answered).filter(([task, request]) => {
    const shown = tasks.find((one) => one.task === task)?.approval
    return !shown || requestOf(shown) !== request
  })
  if (stale.length === 0) return answered
  const kept = { ...answered }
  for (const [task] of stale) delete kept[task]
  return kept
}

/** Which request an approval is: its id, or — drawn by hand, with none — what it asks. */
function requestOf(approval: NonNullable<AgentPane['approval']>): string {
  return approval.id ?? `${approval.tool}: ${approval.summary}`
}
