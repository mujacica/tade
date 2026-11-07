import type { TadeEvent } from './events.ts'
import type { TurnState } from './model.ts'

// When a finished agent's lane closes by itself (`close_when_done`).
//
// Only ever on the journal's word that the task is finished (`task_done`) and
// never on what an agent looks like: one that asked a question and one that is
// done look the same from outside. And it is about one `task_done`: an agent
// somebody opened again, or that was handed work again and asked something, has
// nothing owed until it finishes again, or a press of Open would be undone two
// seconds later by this rule.
//
// Pure: lines of the journal and what can be seen now, in; an answer, out. The
// acting is the window's (`app/src/wire/close-when-done.ts`).

/** What this is decided from, read whole: a task finished yesterday may still have its agent open. */
export const CLOSE_READS = [
  'task_done',
  'task_removed',
  'run_started',
  'turn_started',
  'turn_done',
  'document_ready',
  'agent_closed',
] as const

const READS: ReadonlySet<string> = new Set(CLOSE_READS)

/**
 * How long after a turn ended, or a task was marked finished, its lane is left
 * alone. Not evidence of anything and never what decides that it closes: the
 * time for what arrives behind a turn's last word — its usage, a steer already
 * on its way — to arrive while there is still a process to receive it.
 */
export const CLOSE_SETTLE_MS = 5_000

/** What the setting says, on both of its rows. */
export const CLOSE_WHEN_DONE_MEANS =
  'a finished agent closes once its turn has ended and the orchestrator has been told, which costs the orchestrator a turn, and never while you are looking at it; its task, branch and conversation stay, so it can be opened again'

/** What somebody would say for it, which is what finds the row and what names it (`namedBy`). */
export const CLOSE_WHEN_DONE_WORDS = [
  'auto-close',
  'auto close',
  'close when done',
  'closing',
  'finished agents',
  'done agents',
  'clean up',
  'cleanup',
]

/** One task, as far as closing its agent goes. */
export interface CloseFacts {
  /** The `task_done` still owed a close, or null where nothing is. */
  done: TadeEvent | null
  /** Its agent's turn, as the journal last said. */
  turn: TurnState | 'unknown'
  /** When it last went quiet: a turn ending, or being marked finished. */
  quietSince: number
}

/** Take one line in. A line this does not read changes nothing, so anything may be handed to it. */
export function closeStep(facts: Map<string, CloseFacts>, event: TadeEvent): void {
  if (!event.task || !READS.has(event.type)) return
  const one = facts.get(event.task) ?? { done: null, turn: 'unknown', quietSince: 0 }
  facts.set(event.task, one)
  const at = Date.parse(event.ts)
  switch (event.type) {
    case 'task_done':
      one.done = event
      one.quietSince = Math.max(one.quietSince, at)
      break
    case 'turn_started':
      one.turn = 'running'
      break
    case 'turn_done':
      one.turn = 'idle'
      one.quietSince = Math.max(one.quietSince, at)
      break
    case 'run_started':
      one.turn = 'unknown'
      one.done = null
      break
    // A draft handed over while it carries on is not somebody being waited on.
    case 'document_ready':
      if (event.detail.waits !== false) one.done = null
      break
    default:
      one.done = null
  }
}

/** Every task's facts, out of the journal's lines. */
export function closeFactsFrom(events: readonly TadeEvent[]): Map<string, CloseFacts> {
  const facts = new Map<string, CloseFacts>()
  for (const event of events) closeStep(facts, event)
  return facts
}

/** What can only be seen now, beside what the journal says. */
export interface CloseNow {
  now: number
  /** Its turn as its run last said, which knows nothing of a run this window never saw start. */
  turn: TurnState | 'unknown'
  /** Something it asked is waiting on a person. */
  approval: boolean
  /** Its process went with the window, so there is no turn to wait for (`lost`). */
  lost: boolean
  /** The orchestrator has what it reported. */
  told: boolean
  /** A person has it in front of them. */
  looking: boolean
}

/** What a close is waiting for, or null when nothing is. A turn nobody can see the end of never ends. */
export function closeWaitsOn(
  facts: CloseFacts,
  seen: CloseNow,
): 'finished' | 'report' | 'turn' | 'approval' | 'settling' | 'looking' | null {
  if (!facts.done) return 'finished'
  if (!seen.told) return 'report'
  if (seen.lost) return null
  // Either saying it is at work is enough, and one of them has to say it is not.
  if (seen.turn === 'running' || facts.turn === 'running') return 'turn'
  if (seen.turn !== 'idle' && facts.turn !== 'idle') return 'turn'
  if (seen.approval) return 'approval'
  if (seen.now - facts.quietSince < CLOSE_SETTLE_MS) return 'settling'
  return seen.looking ? 'looking' : null
}
