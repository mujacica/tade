import { type AgentPane, type AppState, laneShown, ORCHESTRATOR_TAB, type Split } from './model.ts'

// A pane cut in two: which lane the second half draws, how it is turned, and
// which half the keyboard is on.
//
// Its own file because it is its own subject and reads as one — every function
// here is about the same handful of state keys (`splits`, `splitFocus`,
// `viewing`, `terminalSplit`) — and because `model.ts` is the state of the
// whole window, where a subject that can stand on its own is a subject that
// should. Pure, like everything the window draws from: state in, state out.

/** The second lane an agent's pane shows, while it is alive and not the one already shown. */
export function splitShown(state: AppState, pane: AgentPane): Split | null {
  const split = state.splits[pane.task]
  if (!split || !pane.lanes.some((lane) => lane.id === split.lane)) return null
  return split.lane === laneShown(state, pane) ? null : split
}

/** Show a lane beside or below the one a pane shows, half and half, with the keyboard on it. */
export function splitPane(
  state: AppState,
  task: string,
  lane: string,
  direction: Split['direction'],
): AppState {
  const pane = state.panes.find((one) => one.task === task)
  if (!pane) return state
  // Splitting the lane in front with itself means the agent goes in front.
  const shown = laneShown(state, pane)
  const next =
    shown === lane ? { ...state, viewing: { ...state.viewing, [task]: pane.lane ?? lane } } : state
  return {
    ...next,
    splits: { ...next.splits, [task]: { lane, direction, ratio: 0.5 } },
    splitFocus: true,
  }
}

/** One lane again. */
export function unsplitPane(state: AppState, task: string): AppState {
  const { [task]: _, ...rest } = state.splits
  return { ...state, splits: rest, splitFocus: false }
}

/** The two halves change places. */
export function swapSplit(state: AppState, task: string): AppState {
  const pane = state.panes.find((one) => one.task === task)
  const split = pane ? splitShown(state, pane) : null
  const shown = pane ? laneShown(state, pane) : null
  if (!pane || !split || !shown) return state
  return {
    ...state,
    viewing: { ...state.viewing, [task]: split.lane },
    splits: { ...state.splits, [task]: { ...split, lane: shown } },
    splitFocus: !state.splitFocus,
  }
}

/** Beside becomes below, and below beside. */
export function turnSplit(state: AppState, task: string): AppState {
  const split = state.splits[task]
  if (!split) return state
  const direction = split.direction === 'beside' ? 'below' : 'beside'
  return { ...state, splits: { ...state.splits, [task]: { ...split, direction } } }
}

/** How much of a split the first half takes, kept where both halves stay usable. */
export function splitRatio(ratio: number): number {
  return Math.min(0.8, Math.max(0.2, ratio))
}

/** The lane typing goes to in a pane: its second half when that has the keyboard. */
export function typingLane(state: AppState, pane: AgentPane): string | null {
  const split = splitShown(state, pane)
  return split && state.splitFocus ? split.lane : laneShown(state, pane)
}

/** Two terminals in the bottom panel: the one in front, and this one beside or below it. */
export function splitTerminal(
  state: AppState,
  id: string,
  direction: Split['direction'],
): AppState {
  if (id === state.bottom || !state.terminals.some((one) => one.id === id)) return state
  return { ...state, terminalSplit: { lane: id, direction, ratio: 0.5 }, splitFocus: true }
}

/** The second terminal in the bottom panel, while both are open and the first is in front. */
export function terminalSplitShown(state: AppState): Split | null {
  const split = state.terminalSplit
  if (!split || state.bottom === ORCHESTRATOR_TAB || split.lane === state.bottom) return null
  return state.terminals.some((one) => one.id === split.lane) ? split : null
}

/**
 * What one of a split's own buttons means: swap the halves, turn the divider,
 * or close it.
 *
 * Here rather than in the subject that answers the click, for the reason every
 * other state-in, state-out answer in this file is here: what the window does
 * is the half worth testing without a terminal, and a branch written inside a
 * wiring class can only be reached by driving one.
 */
export function splitActed(state: AppState, task: string, verb: string): AppState {
  if (verb === 'swap') return swapSplit(state, task)
  if (verb === 'turn') return turnSplit(state, task)
  return unsplitPane(state, task)
}

/** The same for the bottom panel's split, whose halves are its tabs rather than a pane's lanes. */
export function terminalSplitActed(state: AppState, verb: string): AppState {
  const split = state.terminalSplit
  // One answer for closing it and for a verb about a split there is not.
  const one = { ...state, terminalSplit: null, splitFocus: false }
  if (!split) return one
  // Swapping puts the half behind in front, which for the bottom panel means
  // changing which tab is lit: there is no "the pane's lane" to fall back on.
  if (verb === 'swap' && state.bottom !== ORCHESTRATOR_TAB) {
    return {
      ...state,
      bottom: split.lane,
      terminalSplit: { ...split, lane: state.bottom },
      splitFocus: !state.splitFocus,
    }
  }
  if (verb === 'turn') {
    const direction = split.direction === 'beside' ? 'below' : 'beside'
    return { ...state, terminalSplit: { ...split, direction } }
  }
  return one
}
