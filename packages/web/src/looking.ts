import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// This device's page is in front of somebody: a paired phone saying it is
// being looked at, so this machine does not buzz the phone that already shows
// what the buzz would say (REMOTE-TADE.md §5.3).
//
// ## The decision, and why it is this narrow
//
// `presence.ts` counts an owner only, and its reason stands: a phone's session
// saying "the person is here" would be a copied session able to silence every
// notification this machine sends, to every device, for as long as it kept
// saying so. §5.3 still wants a phone with the page open in front of somebody
// to count. Both are true at once only if what a phone says is **about that
// phone and nothing else**:
//
// 1. **It quiets what this device is sent, and nothing anybody else is.** The
//    push sender holds the moment per device (`WebPush.looked`) and reads it
//    only when deciding about that one device, for the same two minutes a
//    keypress counts (`focusWindowMs`). Another phone, the Mac, the earbud and
//    every other device are told exactly what they would have been.
// 2. **It is no more than that session can already do.** A session may forget
//    its own subscription (`PUSHES`' `forget`), which silences this device for
//    good; saying it is being looked at silences it for two minutes. So a
//    copy of the session buys nothing it did not have — which is the argument,
//    and the reason no passkey is asked: the proof rides on the device's own
//    session (`PASSKEY_BEFORE_ACTING`), so a copy made after it is proven
//    would carry it too, and asking for a fresh one each minute is Face ID on
//    a timer. Nor a trusted origin, as `forget` asks: on one that is not, no
//    browser could have subscribed — a worker needs a secure context — so
//    there is nothing there to quiet.
// 3. **It never holds, starts or skips work, and it is never "the person is
//    here".** "Nobody is here", said to the orchestrator, is read from the
//    keyboards — this window's and an owner's link (`nobodyHere`) — because a
//    page somebody glanced at on a train is not somebody the orchestrator can
//    put a question to.
// 4. **It is held and never written down.** A line a minute per phone would be
//    a journal of the clock, and what it decides lasts two minutes.
//
// What the page sends is its own judgement that somebody is there: the page is
// visible **and** was touched within the last minute (`push.js`'s `looking`),
// because a tab left visible on a desk is not a person.

/** What one carries: nothing — the moment is this machine's, at the request. */
const LookingBody = z.strictObject({})

/**
 * The route: the body read once and the moment handed to the window. `looking`
 * absent is a window that did not wire it, which is the `404` of a path nobody
 * built.
 */
export async function carryLooking(
  req: IncomingMessage,
  device: Device,
  now: number,
  looking: ((device: string, at: number) => void) | undefined,
): Promise<{ body: { at: string } } | { refusal: Refusal }> {
  if (looking === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  if (!LookingBody.safeParse(got.body).success) return { refusal: refuse('malformed') }
  looking(device.id, now)
  return { body: { at: new Date(now).toISOString() } }
}
