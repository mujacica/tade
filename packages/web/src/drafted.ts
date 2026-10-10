import { z } from 'zod'
import type { Did } from './acted.ts'
import { type From, Moved, NotOffered, NotThere, type Outcome, TooMuch } from './acting.ts'
import { type Admitted, REVISIONS_BEHIND, type Standing } from './acts.ts'
import { DRAFT_BOUND, DRAFT_FIELD, DRAFT_NAME, DRAFT_SCOPE, type WebDrafting } from './drafting.ts'
import { type Refusal, refuse } from './errors.ts'
import type { Claimed, Receipts } from './receipts.ts'
import { type Scope, trusted } from './surface.ts'
import { KEY } from './verbs.ts'

// One field of one draft, from a parsed body to what the device is told and
// what the journal is told — and **no sockets at all**.
//
// The third sibling of `acted.ts` and `asked.ts`, and it reads alike on
// purpose: the sequence that makes a verb safe is the sequence that makes a
// message safe and the sequence that makes a save safe, and three different
// orderings of the same six steps is the shape of the bug nobody finds.
//
// 1. **The body is parsed by a strict schema.** A field nobody declared fails
//    the parse rather than riding along, and every one of the four strings is
//    bounded by a pattern Tade would have written — so there is nothing here
//    that could be a path.
// 2. **The gate** (`admitDraft`): the setting read now, the `draft` scope, the
//    origin re-asked, how old the screen was, and the one check this door has
//    that the others do not — see below.
// 3. **The key is claimed before anything runs**, bound to the device, the
//    draft and the field *and its value*. So the one failure a phone on a
//    train actually has — save, lose signal, save again — is answered out of
//    the record rather than writing twice.
// 4. **The window does it**, re-checking the draft's own content hash at the
//    moment it writes, and putting the edit through the same pure validator
//    the file goes through (`editWorkflow`).
// 5. **It is written down whatever happened**, a refusal included, as
//    `web_did`. Never as a `said` line.
//
// ## The check this door has that the others do not
//
// `admit`'s third step is the project: a verb names a task, and the device's
// read scope is the per-project boundary. A **draft names no project** — a
// workflow names the repository it works in through an input, and can name any
// of them — so there is no project here to check, and inventing one would be
// a boundary that was not a boundary.
//
// What takes its place is **every project**: a device whose reading is a list
// may not save a draft at all. That is the honest narrowing rather than a
// looser one, and it is in the direction that takes authority away: a phone
// granted one repository of five cannot edit a file that could name the other
// four. `admitAsk` solved the same problem by carrying the boundary into the
// turn, which works for a message because what a message leads to always names
// a project; a draft saved now is read by a run next week, and there is no
// later moment at which to ask.

/** What one save's body carries. Strict: an undeclared field is a refusal. */
const DraftBody = z.strictObject({
  /** The workflow's name. A pattern Tade would have written, so never a path. */
  template: z.string().regex(DRAFT_NAME),
  /** The draft's content hash, as the screen was drawn against it. */
  was: z.string().min(1).max(80),
  scope: z.string().regex(DRAFT_SCOPE),
  field: z.string().regex(DRAFT_FIELD),
  /**
   * The new value, bounded and **never trimmed into meaning**. An empty one is
   * allowed and is a real edit: clearing a field somebody filled in by mistake
   * is the commonest thing a form does, and `editWorkflow` is what decides
   * whether empty is valid for that field.
   */
  value: z.string().max(DRAFT_BOUND),
  key: z.string().regex(KEY),
  rev: z.int().nonnegative(),
})

/** One asked-for save, parsed and ready. */
export interface Saving {
  /** `draft`: the word in the journal, and the route's own name. */
  verb: 'draft'
  template: string
  was: string
  key: string
  rev: number
  /** The canonical form of this call's own fields, which the key is bound to. */
  payload: string
  /** Tade's own words for what this asks for. Never the value itself. */
  said: string
  run(drafting: WebDrafting, from: From): Promise<Outcome>
}

/** Reading a body came to a `Saving`, or it did not. */
export type ReadingDraft = { ok: true; saving: Saving } | { ok: false }

/** A save, read out of a body. */
export function readDraftSave(body: unknown): ReadingDraft {
  const got = DraftBody.safeParse(body)
  if (!got.success) return { ok: false }
  const call = got.data
  return {
    ok: true,
    saving: {
      verb: 'draft',
      template: call.template,
      was: call.was,
      key: call.key,
      rev: call.rev,
      // The value **is** part of the payload, so saving the same value twice
      // is one act and saving two different values is two. A key bound only to
      // the field would make a correction after a typo an already-done.
      payload: `scope=${call.scope}\nfield=${call.field}\nvalue=${call.value}`,
      // Tade's own word, with the field named and the value **not** in it:
      // this is what goes in the journal line and in the receipt, and what
      // somebody typed on a phone is not a record Tade writes about them. The
      // length is a count, which is a thing Tade may say.
      said: `saved ${call.field} on ${call.template}, ${call.value.length} characters`,
      run: (drafting, from) =>
        drafting.save(
          {
            template: call.template,
            was: call.was,
            scope: call.scope,
            field: call.field,
            value: call.value,
          },
          from,
        ),
    },
  }
}

/**
 * The one thing a device may save, by the name in the path.
 *
 * `save` and not `draft`, so the method on `WebDrafting` and the key here are
 * the same word — which is what lets `test/separation.test.ts` hold the two
 * equal in both directions, the way it holds `WebActing` to `VERBS`. The word
 * in the journal is `Saving.verb`, which is `draft`: what a device *did* is
 * save a draft, and that is what somebody reading back is looking for.
 */
export const SAVINGS: Readonly<Record<string, (body: unknown) => ReadingDraft>> = {
  save: readDraftSave,
}

/**
 * Whether this save may go through to the window.
 *
 * Every check is a *re-check*: each was true when the device was paired or when
 * the page drew the form, and each can have stopped being true since.
 */
export function admitDraft(saving: Saving, standing: Standing): Admitted {
  // 1. The capability, read now. A person who turned it off a second ago meant
  //    it, and the route table they turned it off after is the one the window
  //    built when it started.
  if (!standing.unlocked || !standing.surface.drafting) {
    return no('locked', `${saving.verb} while saving a draft is turned off`)
  }

  // 2. The scope. `draft` and never `steer`: a device granted both acting
  //    tiers has been granted eight bounded things about work that exists, and
  //    not a file every future run would be stamped from.
  if (!standing.scopes.includes('draft')) {
    return no('out_of_scope', `${saving.verb} needs draft, device has ${said(standing.scopes)}`)
  }

  // 3. **Every project**, which is this door's own check and takes the place of
  //    the per-project boundary a verb has. A workflow names the repository it
  //    works in through an input and can name any of them, so a device whose
  //    reading is a list of two may not edit a file that could name the other
  //    three. The narrowing is in the direction that takes authority away, and
  //    there is no later moment to ask it at: a draft saved now is read by a
  //    run next week.
  if (standing.reach.projects.kind !== 'every') {
    return no(
      'out_of_scope',
      `${saving.verb} on ${saving.template} needs every project: a workflow can name any repository, and this device reads ${standing.reach.projects.names.length}`,
    )
  }

  // 4. The origin, again — the one that is *only* ever a re-check, because the
  //    network a device is on changes under it. A session that crossed a LAN in
  //    the clear reads and saves nothing, whatever was granted at the machine.
  if (!trusted(standing.origin, standing.surface)) {
    return no(
      'locked',
      `${saving.verb} from ${standing.origin.scheme}://${standing.origin.host}, which is not a trusted origin`,
    )
  }

  // 5. How old the screen was. A soft check, and the sentence says so: what
  //    decides whether a save is current is the draft's own hash.
  if (saving.rev > standing.rev || standing.rev - saving.rev > REVISIONS_BEHIND) {
    return no(
      'stale',
      `${saving.verb} against revision ${saving.rev}, which is ${standing.rev} now`,
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

/** Everything one save is decided against. */
export interface Saved extends Standing {
  drafting: WebDrafting
  receipts: Receipts
  /** The authenticated device. The first thing a key is bound to. */
  device: string
  now: number
  /** The id of the one journal line that would hold a `broke`'s detail. */
  request: string
}

/** What this save came to: what the device is told, and what is written down. */
export interface Wrote {
  body: Record<string, unknown> | null
  refusal: Refusal | null
  /** The audit line. Always there — a refusal is the case audit matters most. */
  did: Did
  warning: string | null
}

/**
 * The canonical thing a key is bound to: the device, the word, the draft, and
 * the field and its value.
 *
 * Written out rather than hashed here for the reason `boundTo` is. The
 * separator is a newline, which a device id (16 hex characters), the literal
 * `draft` and a workflow name (`DRAFT_NAME`) cannot contain — and the value
 * can, which is why it is last.
 */
export function boundToSaving(device: string, saving: Saving): string {
  return [device, saving.verb, saving.template, saving.payload].join('\n')
}

/**
 * Carry one save out, or say why not.
 *
 * `body` is whatever `readBody` produced — this never reads a socket. The
 * answer is a value, so the caller writes the headers it always writes.
 */
export async function carrySave(name: string, body: unknown, ctx: Saved): Promise<Wrote> {
  const read = SAVINGS[name]
  // A route in the table with nothing behind it is a window given half the
  // wiring: a `404`, and whoever is probing learns nothing either way.
  if (read === undefined) return nothing(ctx, refuse('no_such'))

  const reading = read(body)
  if (!reading.ok) return nothing(ctx, refuse('malformed'), name)
  const saving = reading.saving

  const allowed = admitDraft(saving, ctx)
  if (!allowed.ok) return refused(ctx, saving, allowed.refusal)

  const bound = boundToSaving(ctx.device, saving)
  let claim: Claimed
  try {
    claim = await ctx.receipts.claim({
      key: saving.key,
      bound,
      device: ctx.device,
      verb: saving.verb,
      // The draft this is about, in the place a task id goes. A receipt that
      // said nothing about which draft would answer a replay of one save with
      // the record of another's.
      task: saving.template,
      now: ctx.now,
    })
  } catch (error) {
    // **Nothing ran, because the record of being about to could not be
    // written.** The same fail-closed ordering a verb has.
    return {
      ...refused(ctx, saving, refuse('broke', { request: ctx.request })),
      warning: `the away view could not write down that a device saved a draft: ${String(error).slice(0, 200)}`,
    }
  }
  if (claim.kind === 'reused') return refused(ctx, saving, refuse('reused'))
  if (claim.kind === 'unsure') return refused(ctx, saving, refuse('unsure'))
  if (claim.kind === 'again') return done(ctx, saving, claim.outcome, 'already saved')
  if (claim.kind === 'running') {
    try {
      return done(ctx, saving, await claim.outcome, 'already going')
    } catch {
      return refused(ctx, saving, refuse('unsure'))
    }
  }

  let outcome: Outcome
  try {
    outcome = await ctx.receipts.while(saving.key, () =>
      saving.run(ctx.drafting, { how: 'remote', device: ctx.device }),
    )
  } catch (error) {
    // The draft moved under the caller, there is no draft or no such field,
    // the field is one this form may not change, or the value was too long.
    // None of them is a retry.
    if (error instanceof Moved) return refused(ctx, saving, refuse('gone', { rev: error.rev }))
    if (error instanceof NotThere) return refused(ctx, saving, refuse('no_such'))
    if (error instanceof NotOffered) return refused(ctx, saving, refuse('not_offered'))
    if (error instanceof TooMuch) return refused(ctx, saving, refuse('too_big'))
    return {
      ...refused(ctx, saving, refuse('broke', { request: ctx.request })),
      warning: `the away view could not save a draft: ${String(error).slice(0, 200)}`,
    }
  }

  await ctx.receipts.came(saving.key, bound, outcome, ctx.now)
  return done(ctx, saving, outcome, outcome.did ? 'done' : 'nothing to do')
}

function done(ctx: Saved, saving: Saving, outcome: Outcome, why: string): Wrote {
  return {
    body: { did: outcome.did, rev: outcome.rev, said: outcome.said },
    refusal: null,
    did: {
      device: ctx.device,
      tool: saving.verb,
      task: saving.template,
      state: saving.said,
      why,
    },
    warning: null,
  }
}

function refused(ctx: Saved, saving: Saving, refusal: Refusal): Wrote {
  return {
    body: null,
    refusal,
    did: {
      device: ctx.device,
      tool: saving.verb,
      task: saving.template,
      state: 'refused',
      why: refusal.error,
    },
    warning: null,
  }
}

function nothing(ctx: Saved, refusal: Refusal, name = ''): Wrote {
  return {
    body: null,
    refusal,
    did: { device: ctx.device, tool: name, task: '', state: 'refused', why: refusal.error },
    warning: null,
  }
}
