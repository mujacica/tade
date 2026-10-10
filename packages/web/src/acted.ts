import {
  Moved,
  NotOffered,
  NotThere,
  type Outcome,
  OutOfScope,
  TooMuch,
  type WebActing,
} from './acting.ts'
import { admit, type Standing } from './acts.ts'
import { type Refusal, refuse } from './errors.ts'
import type { Claimed, Receipts } from './receipts.ts'
import type { Route } from './routes.ts'
import { type Asked, boundTo, verbFor } from './verbs.ts'

// One act, from a parsed body to what the device is told and what the journal
// is told — and **no sockets at all**.
//
// Its own file for the reason `guard.ts` is: a sequence this long that read
// `req` and wrote `res` could only be tested by making requests, and then the
// cases it exists for — a replay under load, a key reused for another payload,
// a window that died mid-act, a screen two minutes old, a setting turned off
// between the draw and the tap — get asked once each, for whichever one
// somebody remembered. Here they are a table (`test/acted.test.ts`), and
// `server.ts` has one call site that turns an `Answered` into bytes.
//
// The order, and each step is here because skipping it is a real failure
// somebody would otherwise find on a phone:
//
// 1. **The verb is looked up in a closed table.** Not parsed out of a path and
//    not dispatched on: the route *carries* the name and the name came from
//    `VERBS`. There is nothing here a crafted path can become.
// 2. **The body is parsed by that verb's own strict schema**, and what comes
//    back already knows how to do itself — so nothing downstream switches on a
//    name, and a field nobody declared fails the parse rather than riding
//    along.
// 3. **The gate** (`acts.ts`): the setting read now, the scope, the project,
//    the origin re-asked, and how old the screen was.
// 4. **The key is claimed before anything runs**, bound to the device, the
//    verb, the target and the canonical payload.
// 5. **The window does it**, re-checking the state the act named against the
//    file at the moment of the write — DESIGN.md §9.3's step 5, the one it
//    says is most likely to be skipped, and the one the whole idempotency
//    story rests on.
// 6. **It is written down whatever happened**, a refusal included. Never as a
//    `said` line: `namedBy` reads those to authorise a setting change, and a
//    request from a phone is not somebody's own words.

/**
 * One line for the journal, as this file hands one over.
 *
 * Names and counts and Tade's own words, and nothing else: not the key, not
 * the payload, not the device's label, not a word anybody wrote. `device`,
 * `tool`, `state` and `why` are in telemetry's `KEPT` allow-list, which is
 * what decides whether a *detail* key may ever leave the machine.
 *
 * `task` is not a detail key: it goes on the **event**, which is where the
 * journal's index and `historyFrom` read one, and which telemetry already
 * sends for every event it reports. So it is handed over here beside the
 * detail rather than inside it — one place per fact, and no second copy to
 * reason about.
 */
export interface Did {
  device: string
  /** The verb. `tool` because that is the key the telemetry allow-list keeps. */
  tool: string
  /** The task. Goes on the event, never in its detail. */
  task: string
  /** Tade's own word for what was asked, or `refused`. */
  state: string
  /** What came of it, in one word. */
  why: string
}

/** What this act came to: what the device is told, and what is written down. */
export type Answered = {
  /** The body for a `200`, or null where `refusal` says what happened. */
  body: Record<string, unknown> | null
  refusal: Refusal | null
  /** The audit line. Always there — a refusal is the case audit matters most. */
  did: Did
  /** A `warning` worth a person's attention: the window itself broke. */
  warning: string | null
}

/** Everything one act is decided against. */
export interface Acted extends Standing {
  acting: WebActing
  receipts: Receipts
  /** The authenticated device. The first thing a key is bound to. */
  device: string
  now: number
  /** The id of the one journal line that would hold a `broke`'s detail. */
  request: string
}

/**
 * Carry one act out, or say why not.
 *
 * `body` is whatever `readBody` produced — this never reads a socket. The
 * answer is a value, so the caller writes the headers it always writes and
 * this file cannot forget to.
 */
export async function carryOut(route: Route, body: unknown, ctx: Acted): Promise<Answered> {
  const verb = route.verb === undefined ? null : verbFor(route.verb)
  // "This listener does not do that", which is a `404` and not a hint: a route
  // in the table with no verb behind it is a window that was given half the
  // acting wiring, and whoever is probing learns nothing either way.
  if (verb === null) return nothing(ctx, refuse('no_such'))

  const reading = verb.read(body)
  if (!reading.ok) return nothing(ctx, refuse('malformed'), route.verb ?? '')
  const asked = reading.asked

  const allowed = admit(asked, verb.needs, ctx)
  if (!allowed.ok) return no(ctx, asked, allowed.refusal)

  const bound = boundTo(ctx.device, asked)
  let claim: Claimed
  try {
    claim = await ctx.receipts.claim({
      key: asked.key,
      bound,
      device: ctx.device,
      verb: asked.verb,
      task: asked.task,
      now: ctx.now,
    })
  } catch (error) {
    // **Nothing ran, because the record of being about to could not be
    // written.** That order is the whole of the fail-closed story: an act Tade
    // cannot write down beforehand is an act it would not be able to say
    // anything true about afterwards, so it does not happen.
    return {
      ...no(ctx, asked, refuse('broke', { request: ctx.request })),
      warning: `the away view could not write down that ${asked.verb} was asked for: ${String(error).slice(0, 200)}`,
    }
  }
  if (claim.kind === 'reused') return no(ctx, asked, refuse('reused'))
  if (claim.kind === 'unsure') return no(ctx, asked, refuse('unsure'))
  if (claim.kind === 'again') return did(ctx, asked, claim.outcome, 'already done')
  if (claim.kind === 'running') {
    // **The same answer as the first call's, and the verb ran once.** A
    // failure in the first is not this one's to re-run: its `asked` line
    // stands with nothing after it, so this answers `unsure` exactly as a
    // later repeat would, rather than racing it.
    try {
      return did(ctx, asked, await claim.outcome, 'already going')
    } catch {
      return no(ctx, asked, refuse('unsure'))
    }
  }

  let outcome: Outcome
  try {
    outcome = await ctx.receipts.while(asked.key, () =>
      // **Remote, by this device**, carried in rather than assumed: the window
      // writes it into the journal line, and `historyFrom` reads a `by` that is
      // not `you` as *not something you did*.
      asked.run(ctx.acting, { how: 'remote', device: ctx.device }),
    )
  } catch (error) {
    // **Five failures, five answers, and none of them is a retry.** The
    // state moved under the caller, the thing is not there, the device was not
    // granted that, nothing here can do it, what was sent was too long — or
    // the window itself broke — and in that last case the `asked` line stands with
    // nothing after it, so a repeat of this key is `unsure` rather than a
    // second attempt. That is the fail-closed half, and it is why the claim is
    // written before the act rather than after it.
    if (error instanceof Moved) return no(ctx, asked, refuse('gone', { rev: error.rev }))
    if (error instanceof NotThere) return no(ctx, asked, refuse('no_such'))
    if (error instanceof OutOfScope) return no(ctx, asked, refuse('out_of_scope'))
    // **The harness cannot do it, or there is nothing there to do it to.** A
    // `404` with the sentence a path nobody built gets: the page is not
    // supposed to reach this at all, because every row says what may be asked
    // of it and what may not with the reason, so a control nothing could carry
    // out is never drawn. What arrives here is a crafted call or a tab from
    // before the agent stopped, and neither is owed a map of the harness.
    if (error instanceof NotOffered) return no(ctx, asked, refuse('not_offered'))
    // Over the bound on what one act may carry. `too_big` rather than
    // `malformed`, because the body parsed and the request was understood.
    if (error instanceof TooMuch) return no(ctx, asked, refuse('too_big'))
    return {
      ...no(ctx, asked, refuse('broke', { request: ctx.request })),
      warning: `the away view could not carry out ${asked.verb}: ${String(error).slice(0, 200)}`,
    }
  }

  await ctx.receipts.came(asked.key, bound, outcome, ctx.now)
  return did(ctx, asked, outcome, outcome.did ? 'done' : 'nothing to do')
}

/** What came of it: the body, and the line that says it happened. */
function did(ctx: Acted, asked: Asked, outcome: Outcome, why: string): Answered {
  return {
    body: { did: outcome.did, rev: outcome.rev, said: outcome.said },
    refusal: null,
    did: { device: ctx.device, tool: asked.verb, task: asked.task, state: asked.said, why },
    warning: null,
  }
}

/**
 * A refused act: the refusal, and the line that says it was asked for.
 *
 * **The refusal's own word is what the journal gets**, and it is the whole
 * record — an act refused by this file is never counted toward `web_refused`,
 * which is about requests turned away *at the door* and kept coming. A stale
 * screen and a key reused are ordinary answers to an authenticated device, and
 * folding them into the sustained-attempt counter would raise a line about an
 * attack whenever somebody left a tab open.
 */
function no(ctx: Acted, asked: Asked, refusal: Refusal): Answered {
  return {
    body: null,
    refusal,
    did: {
      device: ctx.device,
      tool: asked.verb,
      task: asked.task,
      state: 'refused',
      why: refusal.error,
    },
    warning: null,
  }
}

/**
 * A refusal about a request that never became an act.
 *
 * A body that would not parse, or a verb nothing answers. Still a line, with
 * no target on it, because *a device sent something nobody could read* is a
 * fact worth being able to see — and the only thing it can honestly say about
 * what was asked for is the name the path carried.
 */
function nothing(ctx: Acted, refusal: Refusal, verb = ''): Answered {
  return {
    body: null,
    refusal,
    did: { device: ctx.device, tool: verb, task: '', state: 'refused', why: refusal.error },
    warning: null,
  }
}
