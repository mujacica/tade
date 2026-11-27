import { type Refusal, refuse } from './errors.ts'
import { type Origin, type Surface, trusted } from './surface.ts'
import type { Asked } from './verbs.ts'

// Everything that has to be true of an *act*, after everything that has to be
// true of a request.
//
// **Two files on purpose, and the seam is worth stating.** `guard.ts` asks what
// every request is asked — the `Host`, the `Origin`, `Sec-Fetch-Site`, the
// content type, the token, the session and, for anything above `read`, a
// trusted origin. It has one call site and is already a table. This asks the
// things that are only ever about a *verb*: that the capability is still
// unlocked, that it names a project, that the screen the caller tapped was not
// ancient, and — the one that decides
// everything — that the act names the state it expects. Keeping them apart is
// what lets the guard stay the one question asked of every route while the act
// gate stays a table over verbs.
//
// Pure, for the same reason the guard is: the whole cross-product of crafted
// calls is a table (`test/acts.test.ts`), rather than a handful of requests
// somebody remembered to make.
//
// **The order is deliberate**, and the ones most likely to
// be skipped are the last two. The step after them — *the thing still exists and is still
// in the state the act assumes* — cannot be asked here at all: it is a
// question about a file at the moment of the write, so it belongs to the
// window's own verb (`acting.ts`), and the honest thing this file can do is
// refuse everything it can and then say so.

/**
 * How far behind a screen may be and still act.
 *
 * The projection revision moves on any change to anything, so this is a check
 * on *ancient*, not on *current*: 32 revisions is about a minute of ordinary
 * work on a busy machine, and a tab left open overnight is thousands. What
 * decides whether an act is current is the entity's own revision, which the
 * window re-checks against the file. A caller **ahead** of the server is never
 * trusted — a clock from the future is a client making something up, or a
 * window that restarted — and gets the same answer.
 */
export const REVISIONS_BEHIND = 32

/** What the act gate is told, beyond the act itself. */
export interface Standing {
  surface: Surface
  /** Whether the setting is on **now**. Read at the act, never cached. */
  unlocked: boolean
  /** The projection revision this device's own projection is at. */
  rev: number
  /** The origin this request came from, as the guard worked it out. */
  origin: Origin
  /**
   * The device paired in the clear (`Device.clear`). The guard refuses it every
   * act route; a table whose route is `read` asks it itself (`admitPush`).
   */
  clear?: boolean
}

/**
 * What the gate concluded.
 *
 * `Admitted` and not `Verdict`, which is `guard.ts`'s word for the answer to a
 * different question: that one carries a session, and two types
 * of the same name re-exported from one package is an ambiguity the compiler
 * would make somebody resolve by guessing.
 */
export type Admitted = { ok: true } | { ok: false; refusal: Refusal; why: string }

/**
 * Whether this act may go through to the window.
 *
 * Everything here is a *re-check*: each of these was true when the device was
 * paired, or when the page drew the control, and each can have stopped being
 * true since. That is the point — a gate that only ever asked at pairing is a
 * gate a person cannot close.
 */
export function admit(asked: Asked, standing: Standing): Admitted {
  // 1. The capability, read now. A person who turned it off a second ago meant
  //    it, and the route table they turned it off after is still the one the
  //    window built when it started.
  if (!standing.unlocked || !standing.surface.acting) {
    return no('locked', `${asked.verb} while acting is turned off`)
  }

  // 2. The project it names. Every paired device is the person's own and
  //    reaches every project, so this is only that there is one.
  if (asked.project === '') return no('malformed', `${asked.verb} names no project`)

  // 3. The origin, again — and this is the one that is *only* ever a re-check,
  //    because the network a device is on changes under it. The guard asked it
  //    of the route's scope; a verb that got here under a `read`-scoped route
  //    would have skipped it, and nothing may depend on a route table being
  //    written correctly for a credential not to buy an act over plain HTTP.
  if (!trusted(standing.origin, standing.surface)) {
    return no(
      'locked',
      `${asked.verb} from ${standing.origin.scheme}://${standing.origin.host}, which is not a trusted origin`,
    )
  }

  // 4. How old the screen was. A soft check, and the sentence says so.
  if (asked.rev > standing.rev || standing.rev - asked.rev > REVISIONS_BEHIND) {
    return no('stale', `${asked.verb} against revision ${asked.rev}, which is ${standing.rev} now`)
  }

  return { ok: true }
}

function no(error: 'locked' | 'malformed' | 'stale', why: string): Admitted {
  return { ok: false, refusal: refuse(error), why }
}
