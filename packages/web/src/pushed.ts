import { z } from 'zod'
import type { Did } from './acted.ts'
import { type From, NotOffered, NotThere, type Outcome, TooMuch } from './acting.ts'
import type { Admitted, Standing } from './acts.ts'
import { ENDPOINT_BOUND, endpointAllowed } from './endpoint.ts'
import { type Refusal, refuse } from './errors.ts'
import {
  AUTH_BOUND,
  AUTH_BYTES,
  KEY_BOUND,
  P256DH_BYTES,
  type PushCall,
  type WebPushing,
} from './pushing.ts'
import { type Scope, trusted } from './surface.ts'

// Subscribing and forgetting, from a parsed body to what the device is told
// and what the journal is told — and **no sockets at all**, like its three
// siblings.
//
// It reads like `drafted.ts` with one step missing, and the missing step is
// the thing worth reading this file for.
//
// 1. **The body is parsed by a strict schema.** A field nobody declared fails
//    the parse, and the two keys are checked at their **decoded** lengths —
//    65 bytes and 16, per RFC 8291 — so a wrong one is a refusal with a
//    sentence here rather than a row that fails weeks later on somebody's
//    phone with nothing anywhere saying why.
// 2. **The endpoint is checked** (`endpointAllowed`), which is the one field
//    that decides what this machine connects to. Checked again, with its
//    resolution, at every send: a row in a file an agent on this machine can
//    append to is never an authority.
// 3. **The gate** (`admitPush`): the setting read now, the scope, and the
//    origin re-asked.
// 4. **The window does it**, writing the row under the session's own device.
// 5. **It is written down whatever happened**, a refusal included, as
//    `web_subscribed`. Never as a `said` line.
//
// ## The step that is not here, and why
//
// There is **no idempotency key and no receipt**. The other three tables need
// one because a repeat is a second act with a different meaning: two `park`s
// are two writes, two messages are two turns, two saves of different values
// are two edits. A repeat here is not: subscribing writes *where to reach this
// device*, so the same endpoint twice is the same row and a different endpoint
// is a browser that renewed, where the newer one is the one to keep. Forgetting
// twice is forgetting. The fold in `pushes.ts` is what makes that true — one
// row per device, last one wins — so a key would be ceremony around an
// operation that is already its own answer, and ceremony that could go wrong.
//
// The thing a receipt buys that is genuinely wanted — *a phone on a train that
// subscribed, lost signal and subscribed again* — is bought by the same
// property: it meets its own row.

/** The decoded byte length of a base64url value, or null for anything else. */
function bytesIn(value: string): number | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null
  return Buffer.from(value, 'base64url').length
}

/** One key of the browser's, at exactly the length RFC 8291 gives it. */
function keyOf(bytes: number, bound: number) {
  return z
    .string()
    .max(bound)
    .refine((value) => bytesIn(value) === bytes, {
      message: `must be ${bytes} bytes of base64url`,
    })
}

/**
 * What one subscribe carries. Strict: an undeclared field is a refusal.
 *
 * **There is no device id in it**, which is the binding: the row is written
 * under the session's own device, so there is no shape in which one phone
 * subscribes another. And there is no label, no title and no `url`: a
 * subscription is an address and two keys.
 */
const PushBody = z.strictObject({
  endpoint: z.string().min(1).max(ENDPOINT_BOUND),
  p256dh: keyOf(P256DH_BYTES, KEY_BOUND),
  auth: keyOf(AUTH_BYTES, AUTH_BOUND),
})

/**
 * What one forget carries, which is nothing.
 *
 * A strict empty object rather than no schema, so a body with anything in it
 * — an id especially — is a refusal rather than a field quietly ignored. A
 * device forgets its own subscription and there is nothing else it could name.
 */
const ForgetBody = z.strictObject({})

/** One asked-for change to where a device is reached, parsed and ready. */
export interface Pushing {
  /** `subscribe` or `forget`: the word in the journal, and the method's name. */
  verb: 'subscribe' | 'forget'
  /** Tade's own words for what this asks for. Never the endpoint. */
  said: string
  run(pushing: WebPushing, from: From): Promise<Outcome>
}

/** Reading a body came to a `Pushing`, or it did not. */
export type ReadingPush = { ok: true; pushing: Pushing } | { ok: false; why: string }

/** A subscribe, read out of a body. */
export function readSubscribe(body: unknown): ReadingPush {
  const got = PushBody.safeParse(body)
  if (!got.success) return { ok: false, why: 'not a subscription' }
  const call: PushCall = got.data
  // **Checked here as well as at the send**, so a device learns now that its
  // push service is one Tade will not post to — rather than subscribing
  // successfully and never being told anything.
  const checked = endpointAllowed(call.endpoint)
  if (!checked.ok) return { ok: false, why: `that endpoint ${checked.why}` }
  return {
    ok: true,
    pushing: {
      verb: 'subscribe',
      // The **host** and not the endpoint: which push service a phone uses is
      // worth being able to read back, and the rest of the URL is a token at
      // that service. The journal line carries this.
      said: `will be told through ${checked.host}`,
      run: (pushing, from) => pushing.subscribe(call, from),
    },
  }
}

/** A forget, read out of a body. */
export function readForget(body: unknown): ReadingPush {
  if (!ForgetBody.safeParse(body).success) return { ok: false, why: 'not a forget' }
  return {
    ok: true,
    pushing: {
      verb: 'forget',
      said: 'will not be told',
      run: (pushing, from) => pushing.forget(from),
    },
  }
}

/**
 * The two things a device may ask for, by the name in the path.
 *
 * The keys are the method names on `WebPushing`, exactly as `SAVINGS`'s key is
 * `save`, so `test/separation.test.ts` can hold the interface and the table
 * equal in both directions.
 */
export const PUSHINGS: Readonly<Record<string, (body: unknown) => ReadingPush>> = {
  subscribe: readSubscribe,
  forget: readForget,
}

/**
 * Whether this may go through to the window.
 *
 * Every check is a *re-check*: each was true when the device was paired, and
 * each can have stopped being true since.
 */
export function admitPush(pushing: Pushing, standing: Standing): Admitted {
  // 1. The capability, read now. A person who turned it off a second ago meant
  //    it, and the route table they turned it off after is the one the window
  //    built when it started.
  if (!standing.unlocked || !standing.surface.pushing) {
    return no('locked', `${pushing.verb} while notifications are turned off`)
  }

  // 2. The scope. `read` and nothing more, which is the honest answer: being
  //    told that two things want you reveals nothing a device could not
  //    already read, and requiring a grant above it would mean no phone got a
  //    notification until somebody granted it acting — a different decision
  //    wearing this one's clothes.
  if (!standing.scopes.includes('read')) {
    return no('out_of_scope', `${pushing.verb} needs read, device has ${said(standing.scopes)}`)
  }

  // 3. **The origin, and this is the check that earns its place here.** The
  //    route needs `read`, so the guard's own trusted-origin layer — which
  //    only runs above `read` — does not cover this one. Without it a session
  //    that crossed a network in the clear could hand this machine an endpoint
  //    of its choosing, which is the whole of what `endpoint.ts` exists about:
  //    a read-only credential must not buy an outbound request. A browser
  //    could not have made a subscription on such an origin anyway — a service
  //    worker needs a secure context — so this refuses nothing real and
  //    closes the crafted case.
  if (!trusted(standing.origin, standing.surface)) {
    return no(
      'locked',
      `${pushing.verb} from ${standing.origin.scheme}://${standing.origin.host}, which is not a trusted origin`,
    )
  }

  return { ok: true }
}

function no(error: 'locked' | 'out_of_scope', why: string): Admitted {
  return { ok: false, refusal: refuse(error), why }
}

function said(scopes: readonly Scope[]): string {
  return scopes.join(', ') || 'nothing'
}

/** Everything one of these is decided against. */
export interface Subscribed extends Standing {
  pushing: WebPushing
  /** The authenticated device. What the row is written under. */
  device: string
  now: number
  /** The id of the one journal line that would hold a `broke`'s detail. */
  request: string
}

/**
 * What this came to: what the device is told, and what is written down.
 *
 * `Notified` rather than `Told`, which is `serving.ts`'s word for a journal
 * line: two types of that name re-exported from one package is an ambiguity
 * the compiler would make somebody resolve by guessing.
 */
export interface Notified {
  body: Record<string, unknown> | null
  refusal: Refusal | null
  /** The audit line. Always there — a refusal is the case audit matters most. */
  did: Did
  warning: string | null
}

/**
 * Carry one out, or say why not.
 *
 * `body` is whatever `readBody` produced — this never reads a socket. The
 * answer is a value, so the caller writes the headers it always writes.
 */
export async function carryPush(name: string, body: unknown, ctx: Subscribed): Promise<Notified> {
  const read = PUSHINGS[name]
  // A route in the table with nothing behind it is a window given half the
  // wiring: a `404`, and whoever is probing learns nothing either way.
  if (read === undefined) return nothing(ctx, refuse('no_such'))

  const reading = read(body)
  if (!reading.ok) return nothing(ctx, refuse('malformed'), name, reading.why)
  const pushing = reading.pushing

  const allowed = admitPush(pushing, ctx)
  if (!allowed.ok) return refused(ctx, pushing, allowed.refusal)

  let outcome: Outcome
  try {
    outcome = await pushing.run(ctx.pushing, { how: 'remote', device: ctx.device })
  } catch (error) {
    // The device is no longer paired, notifications went off between the gate
    // and the write, or the endpoint was refused at the second look. None of
    // them is a retry.
    if (error instanceof NotThere) return refused(ctx, pushing, refuse('no_such'))
    if (error instanceof NotOffered) return refused(ctx, pushing, refuse('not_offered'))
    if (error instanceof TooMuch) return refused(ctx, pushing, refuse('too_big'))
    return {
      ...refused(ctx, pushing, refuse('broke', { request: ctx.request })),
      warning: `the away view could not write down a subscription: ${String(error).slice(0, 200)}`,
    }
  }
  return done(ctx, pushing, outcome)
}

function done(ctx: Subscribed, pushing: Pushing, outcome: Outcome): Notified {
  return {
    body: { did: outcome.did, rev: outcome.rev, said: outcome.said },
    refusal: null,
    did: {
      device: ctx.device,
      tool: pushing.verb,
      // No task: a subscription is about a device and about no work at all,
      // and a blank here is read as *about nothing* rather than invented.
      task: '',
      state: pushing.said,
      why: outcome.did ? 'done' : 'nothing to do',
    },
    warning: null,
  }
}

function refused(ctx: Subscribed, pushing: Pushing, refusal: Refusal): Notified {
  return {
    body: null,
    refusal,
    did: {
      device: ctx.device,
      tool: pushing.verb,
      task: '',
      state: 'refused',
      why: refusal.error,
    },
    warning: null,
  }
}

function nothing(ctx: Subscribed, refusal: Refusal, name = '', why = ''): Notified {
  return {
    body: null,
    refusal,
    did: {
      device: ctx.device,
      tool: name,
      task: '',
      state: 'refused',
      // Tade's own clause where the parse had one — *that endpoint is an
      // address rather than a name* is the line somebody debugging a
      // self-hosted push service needs, and it is Tade's words, not the
      // phone's.
      why: why === '' ? refusal.error : `${refusal.error}: ${why}`,
    },
    warning: null,
  }
}
