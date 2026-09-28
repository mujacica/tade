import { CONTINUE, duration } from '@tade/core'
import type { RunId, WorkerAdapter } from '@tade/harnesses-core'
import type { EventLog } from './events.ts'

// Telling an agent the machine cut off to carry on, and writing down that it
// was told.
//
// The third of three files that share a name, one per layer: `core/src/
// sleep.ts` is the rules — whether the machine was away, and who a wake is
// worth telling — `app/src/wire/sleep.ts` is the window's beat, and this is
// the act. Here on its own rather than in the supervisor because it is one
// subject with its own word and its own record, and because the supervisor is
// already a conversation.

/** What continuing one agent needs: what drives it, whose it is, where it is written down. */
export interface Continuing {
  adapter: Pick<WorkerAdapter, 'prompt'>
  /** The task whose agent this run is, for the record. */
  task: string
  log: EventLog
}

/**
 * Tell an agent whose turn the machine cut off to carry on where it stopped.
 *
 * What goes is `CONTINUE` and comes from here rather than from a caller, so
 * the rule that matters is in one place: **a nudge, never the agent's opening
 * instruction again**, which is the same rule that keeps an opening prompt to
 * the launch that created a conversation (`LaunchSpec.opening`). An agent
 * told its first instruction a second time does the work twice, and a sleep
 * is a poor reason to pay for a task twice.
 *
 * **Queued rather than steered.** The whole reason for this is a turn that is
 * over — but a harness may have reconnected and picked its own back up while
 * the lid was still shut, and this must not then be said across the middle of
 * it. Queuing is also why it is never refused for arriving at a busy moment,
 * which would leave an agent stuck with nobody told.
 *
 * **Written down after the fact.** An `agent_continued` for a nudge that did
 * not land is worse than none: what throws here is the caller's to say, and
 * the caller is also what holds "once per wake per agent" — the guard that
 * keeps a laptop that sleeps nightly from being a loop with a long period.
 */
export async function continueRun(run: RunId, slept: number, on: Continuing): Promise<void> {
  await on.adapter.prompt(run, CONTINUE, undefined, { whenBusy: 'queue' })
  await on.log.append({
    type: 'agent_continued',
    task: on.task,
    run,
    detail: { slept: duration(slept), sleptMs: slept },
  })
}
