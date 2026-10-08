import type { TaskFile } from '@tade/core'
import { readTaskFile } from './tasks.ts'

// Why queued work a person has parked does not start, said in one place
// because three doors ask it.
//
// Parking is one of the two things Tade is told rather than derives, and
// `deriveState` puts it ahead of every state but a merge. `queueStateOf` reads
// it too, so nothing Tade starts by rule ever reaches a start door parked.
// These are the doors that do not go through that rule: `startQueued`, which a
// caller could reach another way, and the `start` change, which is the answer
// to a hold and is the one hold it may not answer.
//
// Refused, rather than written down and quietly doing nothing: pressing Start
// and watching nothing happen reads as broken. `resume` is not refused — a
// queue pause and a park are two holds, and lifting one while the other stands
// is a coherent thing to want.

/** What to say, so one sentence covers every door. */
const SAID = 'is parked: pick it up again before it can start'

/**
 * Why this task cannot be started, as the error to throw. Pure: the file is
 * read by whoever already had it, and the caller decides that it cannot — so
 * this says which of the two reasons it was, and never that there is none.
 */
export function notStartable(task: string, file: TaskFile | null): Error {
  if (file?.parked) return new Error(`${task} ${SAID}`)
  return new Error(`${task} is not queued work`)
}

/** The same answer for a door that has not read the task file yet. */
export async function refuseParked(home: string, task: string): Promise<void> {
  const file = await readTaskFile(home, task)
  if (file?.parked) throw new Error(`${task} ${SAID}`)
}
