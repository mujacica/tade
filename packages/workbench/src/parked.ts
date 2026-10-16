import { type Asker, type EventInput, type TaskFile, taskOrigin } from '@tade/core'
import { type ParkResult, readTaskFile, setParked } from './tasks.ts'

// What a park does to starting queued work, said in one place because three
// doors ask it.
//
// Parking is one of the two things Tade is told rather than derives, and
// `deriveState` puts it ahead of every state but a merge. `queueStateOf` reads
// it too, so nothing Tade starts by rule ever reaches a start door parked —
// which is what keeps a park a park: no pass, watch, judge or agent lifts one.
//
// **Starting it is picking it up, in one act** (`pickUpToStart`). Work a watch
// or a template makes parked waits for somebody to say go, and *Start now* is
// the person saying it: refusing the press and asking for a second one — find
// the park, lift it, then press Start again — read as a button that did
// nothing, and the orchestrator asked to start one met the same wall. So the
// `start` change lifts the park as whoever asked, written down as such, and
// then writes the start; the queue's own pass does the starting, with every
// other hold — a paused queue, `max_parallel`, the tree — still in front of it
// and said in words. `startQueued` still refuses parked work outright
// (`notStartable`), because it is the door the rule reaches, and the rule never
// reaches it with a park standing.
//
// `resume` does not pick anything up — a queue pause and a park are two holds,
// and lifting one while the other stands is a coherent thing to want.

/** What to say, so one sentence covers every door that still refuses. */
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

/**
 * A start asked for on parked work: the park lifted as whoever asked, through
 * the one door that writes a park (`park`, so the journal says who), before
 * the start is written. Answers whether there was a park to lift.
 *
 * Work from outside this machine is the one park a start may not lift for
 * anybody but the person at it: lifting it is approving somebody else's
 * request (`NotYours`), and `park` refuses it before anything is written.
 */
export async function pickUpToStart(
  tade: { home: string; log: { append(input: EventInput): Promise<unknown> } },
  task: string,
  by: Asker,
): Promise<boolean> {
  const file = await readTaskFile(tade.home, task)
  if (!file?.parked) return false
  // A parked task that is not queued work has nothing for the queue to start,
  // and lifting its park on the way to finding that out would be an act
  // nobody asked for.
  if (!file.start) throw new Error(`${task} is not queued work: pick it up again instead`)
  await park(tade, task, false, { by })
  return true
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
 * request from off the machine may not do — nor the orchestrator, whose
 * tools say approving one is the person's (`tade_intake`).
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
  constructor(task: string, by?: string) {
    super(
      by === 'orchestrator'
        ? `${task} came from outside this machine: approving it is the person's, in the window or with tade intake, never the orchestrator's`
        : `${task} came from outside this machine: approving it is a keypress here, not a request from away`,
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
  // Asked **before** the write, and only of anybody but the person at the
  // machine lifting a hold — a paired device, or the orchestrator, which reads
  // the request's own words and could be talked into it: `NotYours` has the
  // argument. A file that cannot be read is not refused here — `setParked` is
  // the one that says there is no task.
  if (!parked && how.by !== undefined && how.by !== 'you') {
    const file = await readTaskFile(tade.home, task)
    if (file !== null && taskOrigin(file.by).kind === 'intake') throw new NotYours(task, how.by)
  }
  const result = await setParked(tade.home, task, parked, how.was)
  await tade.log.append({
    type: 'state_change',
    task: result.task || null,
    detail: { state: parked ? 'parked' : 'resumed', by: how.by ?? 'you' },
  })
  return result
}
