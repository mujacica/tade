import { type EventInput, type TaskFile, taskOrigin } from '@tade/core'
import { type ParkResult, readTaskFile, setParked } from './tasks.ts'

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

/**
 * Who asked for a park, and what they saw when they asked.
 *
 * `by` goes on the journal line. `you` is the keyboard; a paired device's own
 * id is a *request*, and a remote act is never recorded as the person's words
 * (`ACTING_IS_NOT_YOU`) — which is why this field exists at all rather than
 * every park being somebody's.
 *
 * `was` is the park the caller saw. Given, it is a compare-and-set: the file
 * is read, the flag compared and a mismatch refused, so a screen from two
 * minutes ago cannot undo what somebody did at the machine since. **What it
 * cannot be is exactly-once against another process** — the check and the
 * write are one `await` apart in the window, which holds the home lock, and
 * that is as atomic as a file in a folder gets. Said here rather than implied
 * away, because a caller that believed otherwise would stop re-reading.
 */
export interface ParkedBy {
  by?: string
  was?: boolean
}

/**
 * That picking this up again would be approving work from outside, which a
 * request from off the machine may not do.
 *
 * **The hole this closes, said out loud because it is not obvious.** A
 * proposed intake *is* a parked task — that is the shape the queue fix chose,
 * and approving one is `parkTask(id, false)`. So a device that could lift any
 * park could approve a stranger's ticket into an agent on this machine, which
 * is DESIGN §9.1's *accept work from an outside source* by a longer route.
 * That act is an `answer`-tier one with two re-checks of its own — the grant
 * must still allow it, and **the source must still say what it said** — and it
 * is not built by any phase. Until it is, the verb does not reach it.
 *
 * Only ever the **lift**: adding a hold is always safe, and a device parking
 * one of these is a person saying *not this one yet*.
 */
export class NotYours extends Error {
  constructor(task: string) {
    super(
      `${task} came from outside this machine: approving it is a keypress here, not a request from away`,
    )
    this.name = 'NotYours'
  }
}

/**
 * The park door: the file, then the line in the journal, in that order.
 *
 * Here rather than on the workbench because this file is already where the
 * park's reasoning lives, and because the write and the record of it are one
 * act that three callers want — the window, the CLI and, now, one verb from a
 * paired device. The order matters: nothing is written down that did not
 * happen, so the file moves first and a throw leaves no line claiming it did.
 */
export async function park(
  tade: { home: string; log: { append(input: EventInput): Promise<unknown> } },
  task: string,
  parked: boolean,
  how: ParkedBy = {},
): Promise<ParkResult> {
  // Asked **before** the write, and only of a request from off the machine
  // lifting a hold: `NotYours` has the argument. A file that cannot be read is
  // not refused here — `setParked` is the one that says there is no task.
  if (!parked && how.by !== undefined && how.by !== 'you') {
    const file = await readTaskFile(tade.home, task)
    if (file !== null && taskOrigin(file.by).kind === 'intake') throw new NotYours(task)
  }
  const result = await setParked(tade.home, task, parked, how.was)
  await tade.log.append({
    type: 'state_change',
    task: result.task || null,
    detail: { state: parked ? 'parked' : 'resumed', by: how.by ?? 'you' },
  })
  return result
}
