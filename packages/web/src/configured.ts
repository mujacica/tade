import { z } from 'zod'
import type { Did } from './acted.ts'
import {
  type From,
  Moved,
  NotOffered,
  NotThere,
  type Outcome,
  OutOfScope,
  TooMuch,
} from './acting.ts'
import { type Admitted, REVISIONS_BEHIND, type Standing } from './acts.ts'
import {
  awayReach,
  projectOfSetting,
  SETTING_BOUND,
  SETTING_PATH,
  type WebConfiguring,
} from './configuring.ts'
import { type Refusal, refuse } from './errors.ts'
import { has, sees } from './reach.ts'
import type { Claimed, Receipts } from './receipts.ts'
import { type Scope, trusted } from './surface.ts'
import { KEY } from './verbs.ts'

// One setting changed, from a parsed body to what the device is told and what
// the journal is told — and **no sockets at all**.
//
// The fifth sibling of `acted.ts`, `asked.ts`, `drafted.ts` and `pushed.ts`,
// and it reads alike on purpose: three different orderings of the same steps
// is the shape of the bug nobody finds.
//
// 1. **The body is parsed by a strict schema, and the tier is part of the
//    parse** — read against the device the request is from, which is known
//    before the body is. For every device but the person's own, a path that is
//    not `settingReach`'s `open` tier is not a `Changing` at all — `never` and
//    `asked` paths fail here, before a key is claimed, as the `404` of a path
//    nobody built. That is what *no route exists* means for a table whose
//    routes are one per kind of thing rather than one per setting. The
//    person's own device (`Reach.theirs`, `theirsOf`) reaches every tier, as
//    the keyboard does (`configuring.ts` has the argument).
// 2. **The gate** (`admitSetting`): the setting read now, the `configure`
//    scope, the `settings` reading grant, the project the setting is one of,
//    the origin re-asked, and how old the screen was.
// 3. **The key is claimed before anything runs**, bound to the device, the
//    path and the value. A phone on a train that changes the editor, loses
//    signal and presses again is answered out of the record.
// 4. **The window does it**, re-checking at the moment of the write that the
//    device is still paired and still granted both halves, that the tier is
//    still `open`, and that the value is still the one it echoed — then
//    through the one door every setting is written by, which writes
//    `config_changed` with `by: device <id>`.
// 5. **It is written down whatever happened**, a refusal included, as
//    `web_did`, and `config_changed` says `by: device <id>` — the person's own
//    phone included, so the record always says where a change came from.
//    Never as a `said` line: a press on a control is not a sentence, and the
//    `asked` tier is reached by the device being theirs, not by words.

/** What one change's body carries. Strict: an undeclared field is a refusal. */
const SettingBody = z.strictObject({
  /** A dotted path Tade would have written. Never a file, never joined onto one. */
  path: z.string().regex(SETTING_PATH),
  /** The value the device was shown. Empty is a value: nothing set. */
  was: z.string().max(SETTING_BOUND),
  /** The new value, verbatim. Empty clears the setting. */
  value: z.string().max(SETTING_BOUND),
  /**
   * That somebody meant it, for the reason `DoneCall` carries one. The page's
   * second press is the other half, and neither stands in for the other: the
   * press stops a mis-tap, and the literal means there is no body that says
   * *do not*.
   */
  confirm: z.literal(true),
  key: z.string().regex(KEY),
  rev: z.int().nonnegative(),
})

/** One asked-for change, parsed and ready. */
export interface Changing {
  /** `setting`: the word in the journal. */
  verb: 'setting'
  path: string
  /** The project the setting is one of, or null for the machine's own. */
  project: string | null
  key: string
  rev: number
  /** The canonical form of this call's own fields, which the key is bound to. */
  payload: string
  /** Tade's own words for what this asks for. Never the value. */
  said: string
  run(configuring: WebConfiguring, from: From): Promise<Outcome>
}

/**
 * Reading a body came to a `Changing`, or it did not — and why not, because
 * a path out of reach is a different answer from a body that made no sense.
 */
export type ReadingChange =
  | { ok: true; changing: Changing }
  | { ok: false; why: 'malformed' }
  | { ok: false; why: 'out_of_reach'; path: string }

/**
 * A change, read out of a body. A path outside the `open` tier is not one,
 * unless the device is the person's own (`theirs`).
 */
export function readSettingChange(body: unknown, theirs = false): ReadingChange {
  const got = SettingBody.safeParse(body)
  if (!got.success) return { ok: false, why: 'malformed' }
  const call = got.data
  // **The tier is decided here, by path and whose device this is, before
  // anything else is asked.** So from any device but the person's own, a body
  // naming `approvals.mode` or `surfaces.web.acting` is never a change at all:
  // there is no `Changing` for it to be, no key claimed for it and no window
  // method it could reach.
  if (awayReach(call.path, theirs).may !== 'change') {
    return { ok: false, why: 'out_of_reach', path: call.path }
  }
  return {
    ok: true,
    changing: {
      verb: 'setting',
      path: call.path,
      project: projectOfSetting(call.path),
      key: call.key,
      rev: call.rev,
      // The value **is** part of the payload, so setting the same value twice
      // is one act and setting two different values is two.
      payload: `was=${call.was}\nvalue=${call.value}`,
      // The path, and never the value: `config_changed` carries what it was
      // and is, and does so by the one rule that keeps a key out of it.
      said: `changed ${call.path}`,
      run: (configuring, from) =>
        configuring.change({ path: call.path, was: call.was, value: call.value }, from),
    },
  }
}

/**
 * The one thing a device may do to a setting, by the name in the path.
 *
 * `change`, the method on `WebConfiguring` — held equal in both directions by
 * `test/separation.test.ts`, the way `WebActing` is held to `VERBS`.
 */
export const CHANGES: Readonly<Record<string, (body: unknown, theirs: boolean) => ReadingChange>> =
  {
    change: readSettingChange,
  }

/**
 * Whether this change may go through to the window.
 *
 * Every check is a *re-check*: each was true when the device was paired or
 * when the page drew the row, and each can have stopped being true since.
 */
export function admitSetting(changing: Changing, standing: Standing): Admitted {
  // 1. The capability, read now.
  if (!standing.unlocked || !standing.surface.configuring) {
    return no('locked', `${changing.verb} while changing a setting is turned off`)
  }

  // 2. The scope. `configure`, implied by nothing.
  if (!standing.scopes.includes('configure')) {
    return no(
      'out_of_scope',
      `${changing.verb} needs configure, device has ${said(standing.scopes)}`,
    )
  }

  // 3. **The reading grant beside it.** A device may not change what it was not
  //    allowed to see: the value it echoes would be a guess, and every `409`
  //    an answer to it — an oracle for a setting it cannot read.
  if (!has(standing.reach, 'settings')) {
    return no('out_of_scope', `${changing.verb} on ${changing.path} without the settings grant`)
  }

  // 4. The project, where the setting is one project's: the per-project
  //    boundary every verb has, and it is the read scope.
  if (changing.project !== null && !sees(standing.reach, changing.project)) {
    return no('out_of_scope', `${changing.verb} on ${changing.path}`)
  }

  // 5. The origin, again — only ever a re-check, because the network a device
  //    is on changes under it.
  if (!trusted(standing.origin, standing.surface)) {
    return no(
      'locked',
      `${changing.verb} from ${standing.origin.scheme}://${standing.origin.host}, which is not a trusted origin`,
    )
  }

  // 6. How old the screen was. Soft, and the sentence says so: what decides
  //    whether a change is current is the value it echoed.
  if (changing.rev > standing.rev || standing.rev - changing.rev > REVISIONS_BEHIND) {
    return no(
      'stale',
      `${changing.verb} against revision ${changing.rev}, which is ${standing.rev} now`,
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

/** Everything one change is decided against. */
export interface Configured extends Standing {
  configuring: WebConfiguring
  receipts: Receipts
  /** The authenticated device. The first thing a key is bound to. */
  device: string
  now: number
  /** The id of the one journal line that would hold a `broke`'s detail. */
  request: string
}

/** What this change came to: what the device is told, and what is written down. */
export interface Changed {
  body: Record<string, unknown> | null
  refusal: Refusal | null
  /**
   * The audit line. Always there. `task` carries the setting's **path** and
   * the caller moves it into the detail — a setting is not a task, and a
   * `web_did` carrying one as its task would make every fold keyed by task
   * read a task by that name.
   */
  did: Did
  warning: string | null
}

/**
 * The canonical thing a key is bound to: the device, the word, the path, and
 * what was echoed and asked for. A newline separates them, which a device id,
 * the word and a dotted path cannot contain; the values can, so they are last.
 */
export function boundToChange(device: string, changing: Changing): string {
  return [device, changing.verb, changing.path, changing.payload].join('\n')
}

/**
 * Carry one change out, or say why not.
 *
 * `body` is whatever `readBody` produced — this never reads a socket.
 */
export async function carryChange(name: string, body: unknown, ctx: Configured): Promise<Changed> {
  const read = CHANGES[name]
  if (read === undefined) return nothing(ctx, refuse('no_such'))

  // Whose device this is, off the record read at this request: revoked or
  // narrowed a second ago is an ordinary device's reach now.
  const reading = read(body, ctx.reach.theirs === true)
  if (!reading.ok) {
    // **A path out of reach is the `404` of a path nobody built**, not a `403`
    // naming the tier: the person who needs to know reads *at this machine*
    // beside the row, and whoever is probing learns nothing either way. The
    // journal line names the path it asked for, because a device asking to
    // change `approvals.mode` is exactly what somebody reading back needs to
    // see — and a path that parsed is one Tade would have written.
    return reading.why === 'malformed'
      ? nothing(ctx, refuse('malformed'))
      : nothing(ctx, refuse('not_offered'), reading.path)
  }
  const changing = reading.changing

  const allowed = admitSetting(changing, ctx)
  if (!allowed.ok) return refused(ctx, changing, allowed.refusal)

  const bound = boundToChange(ctx.device, changing)
  let claim: Claimed
  try {
    claim = await ctx.receipts.claim({
      key: changing.key,
      bound,
      device: ctx.device,
      verb: changing.verb,
      // The setting this is about, in the place a task id goes, so a replay of
      // one change is never answered with the record of another's.
      task: changing.path,
      now: ctx.now,
    })
  } catch (error) {
    // Nothing ran, because the record of being about to could not be written.
    return {
      ...refused(ctx, changing, refuse('broke', { request: ctx.request })),
      warning: `the away view could not write down that a device changed a setting: ${String(error).slice(0, 200)}`,
    }
  }
  if (claim.kind === 'reused') return refused(ctx, changing, refuse('reused'))
  if (claim.kind === 'unsure') return refused(ctx, changing, refuse('unsure'))
  if (claim.kind === 'again') return done(ctx, changing, claim.outcome, 'already changed')
  if (claim.kind === 'running') {
    try {
      return done(ctx, changing, await claim.outcome, 'already going')
    } catch {
      return refused(ctx, changing, refuse('unsure'))
    }
  }

  let outcome: Outcome
  try {
    outcome = await ctx.receipts.while(changing.key, () =>
      changing.run(ctx.configuring, { how: 'remote', device: ctx.device }),
    )
  } catch (error) {
    // The value moved under the caller, the setting is not there, it is not
    // one a device may change any more, the value was refused by the schema,
    // or the device was narrowed between the door and the write. None of them
    // is a retry.
    if (error instanceof Moved) return refused(ctx, changing, refuse('gone', { rev: error.rev }))
    if (error instanceof OutOfScope) return refused(ctx, changing, refuse('out_of_scope'))
    if (error instanceof NotThere) return refused(ctx, changing, refuse('no_such'))
    if (error instanceof NotOffered) return refused(ctx, changing, refuse('not_offered'))
    if (error instanceof TooMuch) return refused(ctx, changing, refuse('too_big'))
    return {
      ...refused(ctx, changing, refuse('broke', { request: ctx.request })),
      warning: `the away view could not change a setting: ${String(error).slice(0, 200)}`,
    }
  }

  await ctx.receipts.came(changing.key, bound, outcome, ctx.now)
  return done(ctx, changing, outcome, outcome.did ? 'done' : 'nothing to do')
}

function done(ctx: Configured, changing: Changing, outcome: Outcome, why: string): Changed {
  return {
    body: { did: outcome.did, rev: outcome.rev, said: outcome.said },
    refusal: null,
    did: lineOf(ctx, changing, changing.said, why),
    warning: null,
  }
}

function refused(ctx: Configured, changing: Changing, refusal: Refusal): Changed {
  return {
    body: null,
    refusal,
    did: lineOf(ctx, changing, 'refused', refusal.error),
    warning: null,
  }
}

function lineOf(ctx: Configured, changing: Changing, state: string, why: string): Did {
  return {
    device: ctx.device,
    tool: changing.verb,
    task: changing.path,
    ...(changing.project === null ? {} : { project: changing.project }),
    state,
    why,
  }
}

function nothing(ctx: Configured, refusal: Refusal, path = ''): Changed {
  const project = projectOfSetting(path)
  return {
    body: null,
    refusal,
    did: {
      device: ctx.device,
      tool: 'setting',
      task: path,
      ...(project === null ? {} : { project }),
      state: 'refused',
      why: refusal.error,
    },
    warning: null,
  }
}
