import type { WilcoEvent } from './events.ts'
import type { TaskState } from './model.ts'

// Looking back at a task that finished.
//
// Skills are lessons Wilco noticed and a human approved, but nothing was ever
// prompting it to notice. A tool it may call whenever it likes is a tool it
// calls when it is being helpful rather than when it has learned something —
// so the moment to ask is the one moment there is something to learn from: a
// task that is done, with its whole history sitting in the journal.
//
// Pure: what the tasks are and what the journal says, in; which ones are worth
// looking back at, out.

/** Only a task that is actually finished. `review` still wants your eyes. */
const FINISHED: readonly TaskState[] = ['merged']

export interface ReflectableTask {
  task: string
  state: TaskState
}

/**
 * Tasks that have finished and have not been looked back at.
 *
 * Which ones are already done is read from the journal rather than remembered,
 * so it survives closing the window and cannot drift: an agent is not asked to
 * reflect on the same task every morning for a week.
 */
export function needsReflection(
  tasks: readonly ReflectableTask[],
  events: readonly WilcoEvent[],
): string[] {
  const already = new Set<string>()
  for (const event of events) {
    if (event.type === 'reflected' && event.task) already.add(event.task)
  }
  return tasks
    .filter((task) => FINISHED.includes(task.state) && !already.has(task.task))
    .map((task) => task.task)
}

/**
 * What to ask about a finished task.
 *
 * Written to make saying nothing the easy answer. A model asked "what did you
 * learn" will always find something; asked "only if it would have changed what
 * you did", it mostly, correctly, declines — and a lesson nobody needed is
 * worse than no lesson, because it costs context in every prompt after it.
 */
export function reflectionPrompt(task: string): string {
  const project = task.split('/')[0] ?? task
  return [
    `${task} has finished.`,
    'Look back at it with wilco_summary and wilco_logs.',
    'If — and only if — something about working here surprised you, and knowing it earlier would',
    'have changed what you did, write it down with wilco_propose_skill and scope it to',
    `${project}.`,
    'Most finished tasks teach nothing. Saying "nothing to note" is the usual answer and a good one:',
    'a lesson nobody needed costs context in every prompt from then on.',
    'Do not propose anything that is already obvious from the code or from a note.',
  ].join(' ')
}
