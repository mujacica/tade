import { z } from 'zod'
import type { Did } from './acted.ts'
import { type From, Moved, NotOffered, NotThere, type Outcome, TooMuch } from './acting.ts'
import { type Admitted, REVISIONS_BEHIND, type Standing } from './acts.ts'
import { ASK_BOUND, type WebAsking } from './asking.ts'
import { type Refusal, refuse } from './errors.ts'
import type { Claimed, Receipts } from './receipts.ts'
import { type Scope, trusted } from './surface.ts'
import { KEY } from './verbs.ts'

// One message to Tade, from a parsed body to what the device is told and what
// the journal is told — and **no sockets at all**.
//
// The sibling of `acted.ts`, and it reads alike on purpose: the sequence that
// makes a verb safe is the sequence that makes a message safe, and two
// different orderings of the same six steps is the shape of the bug nobody
// finds. What is different is only what step 3 can ask, and that difference is
// written out below.
//
// 1. **The body is parsed by a strict schema.** A field nobody declared fails
//    the parse rather than riding along, and the words are bounded here rather
//    than truncated: half of what somebody wrote, handed to a model as though
//    it were the whole, is a worse lie than a refusal.
// 2. **The gate** (`admitAsk`): the setting read now, the `ask` scope, the
//    origin re-asked, and how old the screen was.
// 3. **The key is claimed before anything runs**, bound to the device and the
//    words. So the one failure a phone on a train actually has — send, lose
//    signal, send again — is answered out of the record rather than asked
//    twice, which for a conversation means two identical paragraphs in it and
//    two turns paid for.
// 4. **The window does it**, re-checking the conversation's own revision at
//    the moment it hands the words over, and refusing while a turn is in
//    flight rather than steering a stranger's words into the person's.
// 5. **It is written down whatever happened**, a refusal included, as
//    `web_asked`. Never as a `said` line.
//
// ## The one step that is different, and why that is sound
//
// `admit`'s third check is the project: a verb names a task, and the device's
// read scope is the per-project boundary. A message names no project, so there
// is nothing here to check — and the honest thing is not to invent one.
//
// What takes its place is that the boundary is **carried into the turn**: the
// arm the turn runs under holds the device's own project list, and the two
// tables in `@tade/orchestrator` refuse every call that names a task outside
// it. So the check still happens, at every tool call rather than once at the
// door, which is the stronger place for it — a message is not about one
// project and whatever it leads to always is.

/** What one message's body carries. Strict: an undeclared field is a refusal. */
const AskBody = z.strictObject({
  was: z.string().min(1).max(64),
  key: z.string().regex(KEY),
  rev: z.int().nonnegative(),
  /**
   * The words, bounded and **never trimmed into meaning**. `min(1)` after the
   * trim, so a body of spaces is a `malformed` rather than an empty turn; what
   * is handed over is what arrived.
   */
  said: z
    .string()
    .max(ASK_BOUND)
    .refine((text) => text.trim() !== '', { message: 'say something' }),
})

/** Stopping the turn in flight. No words, so nothing to bound. */
const StopBody = z.strictObject({
  was: z.string().min(1).max(64),
  key: z.string().regex(KEY),
  rev: z.int().nonnegative(),
})

/** One asked-for thing about the conversation, parsed and ready. */
export interface Saying {
  /** `ask` or `stop`: the word in the journal, and the route's own name. */
  verb: 'ask' | 'stop'
  was: string
  key: string
  rev: number
  /** The canonical form of this call's own fields, which the key is bound to. */
  payload: string
  /** Tade's own words for what this asks for. Never the message itself. */
  said: string
  run(asking: WebAsking, from: From): Promise<Outcome>
}

/** Reading a body came to a `Saying`, or it did not. */
export type ReadingAsk = { ok: true; saying: Saying } | { ok: false }

/** A message, read out of a body. */
export function readAsk(body: unknown): ReadingAsk {
  const got = AskBody.safeParse(body)
  if (!got.success) return { ok: false }
  const call = got.data
  return {
    ok: true,
    saying: {
      verb: 'ask',
      was: call.was,
      key: call.key,
      rev: call.rev,
      // The words **are** the payload, so the same message twice is one act
      // and two different messages are two. Nothing is hashed here; the digest
      // `receipts.ts` keeps is over this.
      payload: `said=${call.said}`,
      // Tade's own word for what was asked for, and **never the message
      // itself**: this is what goes in the journal line and in the receipt,
      // and what somebody typed on a phone is not a record Tade writes about
      // them. The length is a count, which is a thing Tade may say.
      said: `said ${call.said.length} characters to Tade`,
      run: (asking, from) => asking.ask({ was: call.was, said: call.said }, from),
    },
  }
}

/** Stopping the turn, read out of a body. */
export function readStop(body: unknown): ReadingAsk {
  const got = StopBody.safeParse(body)
  if (!got.success) return { ok: false }
  const call = got.data
  return {
    ok: true,
    saying: {
      verb: 'stop',
      was: call.was,
      key: call.key,
      rev: call.rev,
      payload: 'stop',
      said: 'stopped the turn',
      run: (asking, from) => asking.stop({ was: call.was }, from),
    },
  }
}

/** The two things a device may ask of the conversation, by the name in the path. */
export const SAYINGS: Readonly<Record<string, (body: unknown) => ReadingAsk>> = {
  ask: readAsk,
  stop: readStop,
}

/**
 * Whether this message may go through to the window.
 *
 * Every check is a *re-check*: each was true when the device was paired or
 * when the page drew the composer, and each can have stopped being true since.
 *
 * It is told `Standing` — the verbs' own shape — and reads four of its six
 * fields. **`reach` is carried and not read here**, deliberately: the
 * per-project boundary for a message is the arm the turn runs under, asked at
 * every tool call rather than once at the door (see the head of this file). A
 * second shape with four fields would be a second spelling of one thing.
 */
export function admitAsk(saying: Saying, standing: Standing): Admitted {
  // 1. The capability, read now. A person who turned it off a second ago meant
  //    it, and the route table they turned it off after is the one the window
  //    built when it started.
  if (!standing.unlocked || !standing.surface.talking) {
    return no('locked', `${saying.verb} while talking to Tade is turned off`)
  }

  // 2. The scope. `ask` and never `answer` or `steer`: a device granted both
  //    acting tiers has been granted eight bounded things and not this.
  if (!standing.scopes.includes('ask')) {
    return no('out_of_scope', `${saying.verb} needs ask, device has ${said(standing.scopes)}`)
  }

  // 3. The origin, again — the one that is *only* ever a re-check, because the
  //    network a device is on changes under it. A session that crossed a LAN
  //    in the clear reads and never talks, whatever was granted at the machine.
  if (!trusted(standing.origin, standing.surface)) {
    return no(
      'locked',
      `${saying.verb} from ${standing.origin.scheme}://${standing.origin.host}, which is not a trusted origin`,
    )
  }

  // 4. How old the screen was. A soft check, and the sentence says so.
  if (saying.rev > standing.rev || standing.rev - saying.rev > REVISIONS_BEHIND) {
    return no(
      'stale',
      `${saying.verb} against revision ${saying.rev}, which is ${standing.rev} now`,
    )
  }

  return { ok: true }
}

function no(error: 'locked' | 'out_of_scope' | 'stale', why: string): Admitted {
  return { ok: false, refusal: refuse(error), why }
}

function said(scopes: readonly Scope[]): string {
  return scopes.join(', ') || 'nothing'
}

/** Everything one message is decided against. */
export interface Telling extends Standing {
  asking: WebAsking
  receipts: Receipts
  /** The authenticated device. The first thing a key is bound to. */
  device: string
  now: number
  /** The id of the one journal line that would hold a `broke`'s detail. */
  request: string
}

/** What this message came to: what the device is told, and what is written down. */
export interface Spoken {
  body: Record<string, unknown> | null
  refusal: Refusal | null
  /** The audit line. Always there — a refusal is the case audit matters most. */
  did: Did
  warning: string | null
}

/**
 * The canonical thing a key is bound to: the device, the word, and the words.
 *
 * Written out rather than hashed here for the reason `boundTo` is, and with no
 * task in it: a message is about the conversation, so there is nothing between
 * the verb and the payload. The separator is a newline, which a device id (16
 * hex characters) and a verb out of the table above cannot contain.
 */
export function boundToSaying(device: string, saying: Saying): string {
  return [device, saying.verb, saying.payload].join('\n')
}

/**
 * Carry one message out, or say why not.
 *
 * `body` is whatever `readBody` produced — this never reads a socket. The
 * answer is a value, so the caller writes the headers it always writes.
 */
export async function carryAsk(verb: string, body: unknown, ctx: Telling): Promise<Spoken> {
  const read = SAYINGS[verb]
  // A route in the table with nothing behind it is a window given half the
  // wiring: a `404`, and whoever is probing learns nothing either way.
  if (read === undefined) return nothing(ctx, refuse('no_such'))

  const reading = read(body)
  if (!reading.ok) return nothing(ctx, refuse('malformed'), verb)
  const saying = reading.saying

  const allowed = admitAsk(saying, ctx)
  if (!allowed.ok) return refused(ctx, saying, allowed.refusal)

  const bound = boundToSaying(ctx.device, saying)
  let claim: Claimed
  try {
    claim = await ctx.receipts.claim({
      key: saying.key,
      bound,
      device: ctx.device,
      verb: saying.verb,
      // No task, and the receipt says so rather than inventing one: this is
      // about the conversation, which has no id of its own because there is
      // exactly one of it.
      task: '',
      now: ctx.now,
    })
  } catch (error) {
    // **Nothing ran, because the record of being about to could not be
    // written.** The same fail-closed ordering a verb has, and it matters more
    // here: an unrecorded message is a turn somebody paid for that Tade cannot
    // say anything true about.
    return {
      ...refused(ctx, saying, refuse('broke', { request: ctx.request })),
      warning: `the away view could not write down that a device said something: ${String(error).slice(0, 200)}`,
    }
  }
  if (claim.kind === 'reused') return refused(ctx, saying, refuse('reused'))
  if (claim.kind === 'unsure') return refused(ctx, saying, refuse('unsure'))
  if (claim.kind === 'again') return done(ctx, saying, claim.outcome, 'already said')
  if (claim.kind === 'running') {
    try {
      return done(ctx, saying, await claim.outcome, 'already going')
    } catch {
      return refused(ctx, saying, refuse('unsure'))
    }
  }

  let outcome: Outcome
  try {
    outcome = await ctx.receipts.while(saying.key, () =>
      saying.run(ctx.asking, { how: 'remote', device: ctx.device }),
    )
  } catch (error) {
    // The conversation moved under the caller, there is nothing to stop, this
    // harness cannot be narrowed so it answers nobody, or what was sent was
    // too long. None of them is a retry.
    if (error instanceof Moved) return refused(ctx, saying, refuse('gone', { rev: error.rev }))
    if (error instanceof NotThere) return refused(ctx, saying, refuse('no_such'))
    if (error instanceof NotOffered) return refused(ctx, saying, refuse('not_offered'))
    if (error instanceof TooMuch) return refused(ctx, saying, refuse('too_big'))
    return {
      ...refused(ctx, saying, refuse('broke', { request: ctx.request })),
      warning: `the away view could not carry out ${saying.verb}: ${String(error).slice(0, 200)}`,
    }
  }

  await ctx.receipts.came(saying.key, bound, outcome, ctx.now)
  return done(ctx, saying, outcome, outcome.did ? 'done' : 'nothing to do')
}

function done(ctx: Telling, saying: Saying, outcome: Outcome, why: string): Spoken {
  return {
    body: { did: outcome.did, rev: outcome.rev, said: outcome.said },
    refusal: null,
    did: { device: ctx.device, tool: saying.verb, task: '', state: saying.said, why },
    warning: null,
  }
}

function refused(ctx: Telling, saying: Saying, refusal: Refusal): Spoken {
  return {
    body: null,
    refusal,
    did: {
      device: ctx.device,
      tool: saying.verb,
      task: '',
      state: 'refused',
      why: refusal.error,
    },
    warning: null,
  }
}

function nothing(ctx: Telling, refusal: Refusal, verb = ''): Spoken {
  return {
    body: null,
    refusal,
    did: { device: ctx.device, tool: verb, task: '', state: 'refused', why: refusal.error },
    warning: null,
  }
}
