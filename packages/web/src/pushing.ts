import type { From, Outcome } from './acting.ts'

// What a paired device may do about notifications, as the one interface the
// window implements.
//
// **A fourth table, and what makes it a different kind from the other three.**
// `ACTS` is a target plus the state it expects; `ASKS` is free text to a
// model; `DRAFTS` is a field of a file a run will read. None of those is this:
// a subscription changes nothing about any project, any task or any file of
// Tade's — it is **this browser saying where to reach it**, which is the same
// category as the session it already holds.
//
// So the honest place for it would have been `LIFECYCLE`, beside pairing and
// signing out, and it is not there for one reason: it has **a setting of its
// own**, and the three-second-table pattern is how a setting is enforced here.
// With `surfaces.web.push` off there is no interface and no route, so a
// crafted call is the `404` of a path nobody built rather than a `403` naming
// a setting. Keeping it out of `ROUTES` also keeps that table the forty lines
// somebody checks read-only against.
//
// ## What makes it safe, said here because this is where somebody looks
//
// Five things, and three of them are absences:
//
// 1. **It binds to the device that asked.** There is no device id in the body
//    and no method here that takes one: the row is written under the session's
//    own device, so there is no shape in which one phone subscribes another or
//    reads what another is subscribed to. `sendable` (`pushes.ts`) then refuses
//    any row whose device is no longer paired, so signing a phone out stops
//    its notifications with no network.
// 2. **It cannot send one.** There is no `send`, no `test` and no `notify` on
//    this interface — `test/separation.test.ts` reads the methods against the
//    route table in both directions. A notification is something the window
//    decides on its beat out of transitions it observed; a route that could
//    ask for one would be a device able to make this machine POST to an
//    address of its choosing, at a rate of its choosing, which is the whole of
//    what `endpoint.ts` exists to stop being interesting.
// 3. **The endpoint is checked where it arrives and again where it is used.**
//    `endpointAllowed` at the subscribe, and the full check with its
//    resolution at every send — because the file is one an agent on this
//    machine can append to (`DEVICES_AND_AGENTS`), so what is in it is never
//    an authority.
// 4. **It reads nothing.** There is no method here that answers with a
//    subscription, and there is no route that answers with one either. What
//    the page needs in order to draw a control is whether the machine offers
//    notifications and the public key to subscribe with — two facts about the
//    machine, beside the device list (`Notifying`) — and whether *this* phone
//    is subscribed, which the browser already knows better than this machine
//    does.
// 5. **Taking it back needs nothing of this machine.** The permission is the
//    phone's, in its own settings, and revoking it there stops delivery
//    whatever any row says. `forget` is the tidy path, not the only one.

/** What a device asks for when it subscribes: what its browser handed it. */
export interface PushCall {
  /**
   * Where the push service wants the POST.
   *
   * **The one field in Tade that decides what this machine connects to**, and
   * it comes from a browser. `endpoint.ts` is the whole of what is done about
   * that, and it is done twice.
   */
  endpoint: string
  /** The browser's own P-256 public key, base64url, 65 bytes decoded. */
  p256dh: string
  /** The browser's own authentication secret, base64url, 16 bytes decoded. */
  auth: string
}

/**
 * Subscribing and forgetting: the two methods, and the whole of what a paired
 * device may ever do about notifications.
 */
export interface WebPushing {
  /**
   * Whether notifications are still unlocked, read **at the call**.
   *
   * A function and not a flag, exactly as `WebActing.unlocked`,
   * `WebAsking.unlocked` and `WebDrafting.unlocked` are. Here the asymmetry is
   * smaller than theirs and is said honestly in the setting's own words: the
   * route table waits for a restart as usual, but what *sends* a notification
   * reads the setting on every beat, so turning it off stops delivery within a
   * beat whether or not the route is still there.
   */
  unlocked(): boolean
  /** Remember where to reach this device. Replaces whatever it said before. */
  subscribe(call: PushCall, from: From): Promise<Outcome>
  /** Forget it. The device's own, and never another's: there is no id to pass. */
  forget(from: From): Promise<Outcome>
}

/**
 * How long each of the browser's two keys may be, as text.
 *
 * Bounded here as well as parsed, because the bound is what keeps a megabyte
 * out of `web-pushes.jsonl`. The exact decoded lengths — 65 bytes and 16 —
 * are checked at the parse (`pushed.ts`), where a wrong one is a refusal with
 * a sentence rather than a row that fails at send time on somebody else's
 * phone.
 */
export const KEY_BOUND = 200
export const AUTH_BOUND = 60

/** The decoded length each of the two keys must be, per RFC 8291. */
export const P256DH_BYTES = 65
export const AUTH_BYTES = 16

/**
 * What the page is told about notifications, beside the device list.
 *
 * **Two facts about the machine and none about the device**, which is why it
 * sits in `Keeping` rather than in the shell — the shell is the same bytes for
 * everybody — and why there is no reading method on the interface above.
 *
 * Whether *this* phone is subscribed is deliberately not here: the browser
 * already knows, from its own `pushManager`, and its answer is the better one.
 * A boolean out of this machine would be a row in a file; the phone's own
 * answer accounts for a permission somebody took back in the phone's settings,
 * which this machine is never told about (`PUSH_NEEDS_A_GESTURE`). So the page
 * asks the browser about the browser and the machine about the machine, and
 * neither has to be kept in step with the other.
 *
 * `key` is the VAPID **public** key, which is the one value in this subsystem
 * that is meant to leave the machine: a browser needs it to create a
 * subscription at all (`applicationServerKey`), it is derived from the private
 * one rather than stored beside it, and it is the same key for every device.
 * Empty means *nothing has been generated yet*, which the page draws as the
 * control being unavailable rather than as an error.
 */
export interface Notifying {
  /** Whether a device may subscribe at all: the setting, and a key to use. */
  offered: boolean
  /** The VAPID public key, base64url, or empty where there is none yet. */
  key: string
}

/** Nothing offered and nothing to subscribe with. */
export const NOT_NOTIFYING: Notifying = { offered: false, key: '' }

/**
 * What a surface and a key mean for a page, which is one derived fact.
 *
 * `offered` is **both** halves and not the setting alone: a machine with
 * notifications on and no key yet cannot be subscribed to, and a page told
 * *offered* with nothing to subscribe with would draw a control whose only
 * possible outcome is a browser throwing.
 */
export function notifyingOf(opts: { pushing: boolean; key: string }): Notifying {
  return { offered: opts.pushing && opts.key !== '', key: opts.pushing ? opts.key : '' }
}
