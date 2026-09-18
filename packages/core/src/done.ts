import type { TadeEvent } from './events.ts'
import type { DoneRule, TaskState } from './model.ts'
import { IDLE_REASON } from './state.ts'

// When a task is finished.
//
// Finishing is recorded, not worked out again each time it is asked: an agent
// says so, a person marks it, or Tade sees the task's own rule met and writes
// that down once. The journal is then the one answer to "is it done" — the same
// from the window, the CLI and the orchestrator, and still true long after the
// agent that did the work is gone.
//
// Pure: events and what can be seen, in; answers, out.

export interface Finished {
  /** When it was recorded. */
  at: string
  /** `agent`, `you`, `orchestrator`, or `rule`. */
  by: string
  /** What was done, in a line, when whoever finished it said. */
  summary: string
}

/** The tasks that have finished, as the journal says: each one's latest word. */
export function finishedFrom(events: readonly TadeEvent[]): Map<string, Finished> {
  const out = new Map<string, Finished>()
  for (const event of events) {
    if (event.type !== 'task_done' || !event.task) continue
    out.set(event.task, {
      at: event.ts,
      by: typeof event.detail.by === 'string' ? event.detail.by : 'unknown',
      summary: typeof event.detail.summary === 'string' ? event.detail.summary : '',
    })
  }
  return out
}

/** What Tade can see about a task that its own rule might be met by. */
export interface RuleFacts {
  state: TaskState
  reason: string
  workspace: 'checkout' | 'worktree'
  /** Its agent has ended a turn since it last started: it has done something. */
  worked: boolean
}

/**
 * Whether a task's rule is met by what can be seen now. Only the rules Tade
 * watches for itself: `said` and `manual` are recorded when they happen, so
 * nothing here can meet them.
 */
export function ruleMet(rule: DoneRule, facts: RuleFacts): boolean {
  switch (rule) {
    case 'idle':
      // A turn that ended waiting on a person's approval is not a job done.
      return (
        facts.worked &&
        ((facts.state === 'blocked' && facts.reason === IDLE_REASON) || facts.state === 'review')
      )
    case 'committed':
      return facts.worked && facts.workspace === 'worktree' && facts.state === 'review'
    case 'merged':
      return facts.state === 'merged'
    default:
      return false
  }
}

/**
 * Whether each task's agent has ended a turn since it last started, from the
 * journal: a run that started and has said nothing yet has done nothing yet.
 */
export function workedFrom(events: readonly TadeEvent[]): Set<string> {
  const worked = new Set<string>()
  for (const event of events) {
    if (!event.task) continue
    if (event.type === 'run_started') worked.delete(event.task)
    if (event.type === 'turn_done') worked.add(event.task)
  }
  return worked
}
