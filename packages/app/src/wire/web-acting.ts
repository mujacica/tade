import {
  allowDevice,
  byOf,
  type Device,
  type From,
  Moved,
  NotThere,
  type Outcome,
  OutOfScope,
  type ParkCall,
  taskRev,
  type WebActing,
} from '@tade/web'
import { NoTaskFile, NotYours, ParkMovedOn } from '@tade/workbench'

// The window's end of acting: what a verb actually does, and the one door a
// device's scope widens through.
//
// **Its own file, and the seam is the point.** What the away view is *handed*
// is exactly this — a `WebActing` with a method per verb and nothing else on
// it. A `WebActing` that was the whole `Away` subject would put the pairing
// panel, the device file, the projectors and the streams one property access
// away from a route, which is the shape a route somebody added in a hurry gets
// through. Here the route can reach the verbs and nothing besides.
//
// Everything in this file owes the three things only the window can do, and
// `acting.ts` is where they are written down: re-check the state the act
// named, against the file, at the moment of the write; do it as atomically as
// the thing allows; and carry the provenance into the record.

/** What a verb needs of the window. Two things, and neither is a path. */
export interface ActingDeps {
  /** The workbench: the one writer of a task file, and of the line about it. */
  tade: {
    parkTask(
      task: string,
      parked: boolean,
      how: { by?: string; was?: boolean },
    ): Promise<{ task: string; parked: boolean; was: boolean }>
  }
  /** Whether the setting is on, read **at the act** and never cached. */
  acting: () => boolean
}

/** What letting a device act needs. Deliberately not the whole window. */
export interface GrantDeps {
  home: string
  acting: () => boolean
  now: () => number
}

/**
 * What a paired device may do, as the window implements it.
 *
 * One method per verb. The absence of every other method is the guarantee:
 * there is no shape here a path, a command, a setting, a credential or a new
 * agent could arrive in (`acting.ts` has the list and the argument).
 */
export function webActing(deps: ActingDeps): WebActing {
  return {
    // Read out of the live config at every act. **This is the half of the
    // setting that can only ever take authority away**, which is why it is a
    // function and not a flag: a person who turned acting off a second ago
    // meant it, and the route table they turned it off after was built when
    // the window started.
    unlocked: () => deps.acting(),
    park: (call, from) => park(deps, call, from),
  }
}

/**
 * Park a task, or pick it back up, for whoever asked.
 *
 * The whole of the act is `parkTask`'s compare-and-set (`parked.ts`): the file
 * is read, the park compared against what the caller saw, and a mismatch
 * refused — so a screen from two minutes ago cannot undo what somebody did at
 * the keyboard since, and a captured request replayed after its receipt was
 * gone meets a task that has moved on.
 *
 * **Through the workbench and nowhere else.** The task file is the workbench's
 * to write; a second writer in this process would be two rules about one file,
 * and the journal line that goes with the write would be this function's to
 * remember rather than the door's.
 */
export async function park(deps: ActingDeps, call: ParkCall, from: From): Promise<Outcome> {
  try {
    const done = await deps.tade.parkTask(call.task, call.parked, {
      by: byOf(from),
      // The told fact the caller echoed, turned back into the boolean the file
      // holds — `taskRev` is the one rule, so a value this did not recognise
      // is a mismatch rather than a park that goes the wrong way.
      was: call.was === taskRev({ parked: true }),
    })
    return {
      // Whether it actually moved, which is not the same as whether it
      // succeeded: picking up a task that was already picked up is an answer,
      // and saying `did: true` to it would make the page draw a change nobody
      // made.
      did: done.was !== done.parked,
      rev: taskRev({ parked: done.parked }),
      said: done.parked ? 'set aside' : 'picked back up',
    }
  } catch (err) {
    // **Three answers, and each is the workbench's own.** A park that moved
    // under the caller is a `gone` carrying what is true now, so the page
    // redraws the truth rather than a toast; a task with no file is a
    // `no_such`; anything else is the window having broken, which reaches the
    // phone as a request id and a person as a `warning`. The first two are
    // classes rather than messages — matching on the words of an error is the
    // version of this that turns into a silent `500` the day somebody rewords
    // one.
    if (err instanceof ParkMovedOn) throw new Moved(err.message, taskRev({ parked: err.parked }))
    if (err instanceof NoTaskFile) throw new NotThere(err.message)
    // Work that came from outside this machine: picking it up again is
    // approving somebody else's request, which is a keypress here and is not
    // built from away at all (`parked.ts`'s `NotYours`). `out_of_scope` rather
    // than a `404`, because the task is one this device can see and the honest
    // answer is that it was not granted *that*.
    if (err instanceof NotYours) throw new OutOfScope(err.message)
    throw err
  }
}

/** What granting, or taking it back, came to. */
export interface Granted {
  /** What that device may do now, in full. */
  scopes: readonly string[]
  /** Tade's own sentence for the strip. */
  said: string
}

/**
 * Let one device act, or take it back. **A person at this machine, only.**
 *
 * There is deliberately no other door: no route, no orchestrator tool and no
 * config key, because the thing that grants authority is never reachable from
 * inside the authority it granted (DESIGN.md §9.1). What it grants is `steer`,
 * which is the tier the verbs there are sit at; the projects it may act in are
 * the ones it may already read, so revoking a project revokes acting in it in
 * the same act.
 *
 * **Refused while the setting is off**, rather than written and then ignored:
 * a grant that did nothing because of a second setting is exactly what Tade
 * accepting and ignoring a setting would be. The control is not drawn there
 * either; this is the half that holds if something else ever presses it.
 */
export async function letOneAct(
  deps: GrantDeps,
  devices: readonly Device[],
  id: string,
): Promise<Granted> {
  if (!deps.acting()) {
    throw new Error('turn on “Let a paired device act” in Settings → Away view first')
  }
  const device = devices.find((one) => one.id === id && one.revoked === null)
  if (device === undefined) throw new Error('that device is not paired')
  const may = device.scopes.some((scope) => scope !== 'read')
  // **`read` is never taken away here.** Widening what one device may do and
  // signing it out are different acts, and only the first of them is this
  // control; a grant written without `read` would quietly make a phone stop
  // being able to see anything.
  const scopes = may ? ['read'] : ['read', 'steer']
  await allowDevice(deps.home, id, scopes, new Date(deps.now()))
  const what = device.label === '' ? 'that device' : device.label
  return { scopes, said: may ? `${what} can no longer act` : `${what} can act` }
}
