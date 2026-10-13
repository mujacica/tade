import type { TaskState } from './model.ts'
import { IDLE_REASON } from './state.ts'

/**
 * What an agent is doing, as its mark says at a glance: working right now,
 * idle with its session open, waiting on you, failed, finished, not running,
 * or parked.
 *
 * **One rule for every surface.** The window draws it beside every agent, and
 * the away view carries the window's own answer on each task row rather than
 * deriving one of its own: a phone that read `deriveState`'s `blocked` where
 * the window reads `done` drew every finished agent as one wanting you.
 */
export const AGENT_MARKS = [
  'working',
  'idle',
  'needs-you',
  'failed',
  'done',
  'stopped',
  'parked',
] as const
export type AgentMark = (typeof AGENT_MARKS)[number]

/** What a mark is read from: an agent's state and why, and whether anything waits on you. */
export interface Marked {
  state: TaskState
  reason?: string
  /** An approval is waiting on it. */
  waiting?: boolean
  approval?: object | null
  /** The journal says it is finished (`task_done`), out of the **whole** journal. */
  finished?: object | null
  queued?: { state: { kind: string } } | null
}

export function markOf(pane: Marked): AgentMark {
  // Held queued work is a decision nobody has made yet, like an approval.
  if (pane.waiting || pane.approval || pane.queued?.state.kind === 'held') return 'needs-you'
  // Finished is what its rule says, or what someone said: an agent that ended
  // its turn after saying so is done, not idle. Put back to work, it is working.
  if (pane.finished && pane.state !== 'working' && pane.state !== 'parked') return 'done'
  switch (pane.state) {
    case 'working':
      return 'working'
    case 'failed':
      return 'failed'
    case 'parked':
      return 'parked'
    case 'review':
    case 'merged':
      return 'done'
    // Its turn is over. Only waiting to be told something is not a decision to make.
    case 'blocked':
      return pane.reason === IDLE_REASON ? 'idle' : 'needs-you'
    default:
      return 'stopped'
  }
}
