import { z } from 'zod'
import type { Did } from './acted.ts'
import { type From, Moved, NotOffered, NotThere, type Outcome, TooMuch } from './acting.ts'
import type { Admitted, Standing } from './acts.ts'
import { ASK_BOUND } from './asking.ts'
import { type Refusal, refuse } from './errors.ts'
import type { Claimed, Receipts } from './receipts.ts'
import { trusted } from './surface.ts'
import { KEY } from './verbs.ts'

// The window itself, from a phone that draws its own copy of it (§10 T3 of the
// Duo plan, the full view): what that phone is told, and the one act it sends
// back — and **no sockets at all**, as `acted.ts` and `asked.ts` have none.
//
// ## Out: the window's state, as data
//
// A phone with the full view open says where it is looking and how big it is
// (`look`), and from then on its streams carry `window` frames: the window's
// state and the subjects' frame, whole and then as what moved (the app's
// `far.ts`). Nothing is drawn for it on the machine — it draws for itself — and
// nothing is built for a phone that has not looked, or stopped looking: a look
// runs out unless renewed (the window's `LOOK_MS`). A look changes nothing
// about the work, so it is answered like `looking.ts`: held, never written
// down, and not an act.
//
// ## In: one act, carrying an intent
//
// The phone runs the window's keymap and panels itself, so focus, scrolling
// and moving through a panel never cross. What crosses is what the window
// would *do* — the app's `Intent`: run what a button runs, answer an agent,
// type into a lane, send what is on the line, carry a panel out — as **one act
// with one schema**, not a verb per thing, because the window's own keyboard
// reaches all of them through one path (`wire/intents.ts`) and a phone is that
// keyboard somewhere else. It goes through the sequence every act does:
//
// 1. **The body is parsed by a strict schema**, its words and bytes bounded.
// 2. **The gate**: the acting setting read now, and the origin re-asked — a
//    trusted one, as every act is asked. No project, because an intent is
//    carried out where the phone is looking, which the act names (`own`), and
//    every paired device reaches every project; no projection revision,
//    because the window's state is not the projection and where the phone is
//    looking is sent with every act.
// 3. **The key is claimed before anything runs**, bound to the device and the
//    canonical intent with where it was pressed, so a phone that sends, loses
//    signal and sends again is answered out of the record.
// 4. **The window carries it out**, as that phone's face, through the door
//    the machine's own keyboard uses — which re-reads the state as the doors
//    always have.
// 5. **It is written down whatever happened**, a refusal included, as
//    `web_did` with `tool: window <kind>`. Never as a `said` line, and never
//    the words or bytes themselves: those are the person's, and the line is
//    names and Tade's own words.

/** How many bytes one act may type into a lane: a paste, not a file. */
export const TYPE_BOUND = 16_384

/** A face's place in the window, as the phone says it: an object, read field by field over there. */
const Own = z.record(z.string(), z.unknown())

/** A panel as its keys or a click left it: the window's own data, carried as it is. */
const Outcome_ = z.strictObject({
  panel: z.record(z.string(), z.unknown()).nullable(),
  submit: z.boolean(),
  choice: z.string().max(1_024).optional(),
  scroll: z.number().optional(),
})

/** The intents there are: the app's `Intent`, kind by kind. */
const IntentBody = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('run'), action: z.string().min(1).max(512) }),
  z.strictObject({ kind: z.literal('decide'), allow: z.boolean() }),
  z.strictObject({ kind: z.literal('interrupt') }),
  z.strictObject({ kind: z.literal('search') }),
  z.strictObject({ kind: z.literal('talk'), down: z.boolean() }),
  z.strictObject({ kind: z.literal('quit') }),
  z.strictObject({
    kind: z.literal('type'),
    data: z.string().min(1).max(TYPE_BOUND),
    pasted: z.boolean(),
  }),
  z.strictObject({
    kind: z.literal('say'),
    said: z
      .string()
      .max(ASK_BOUND)
      .refine((text) => text.trim() !== '', { message: 'say something' }),
  }),
  z.strictObject({ kind: z.literal('panel'), outcome: Outcome_ }),
  // A press on something the phone drew that only the machine can answer: the
  // window's own hit, carried as it is and read field by field over there.
  z.strictObject({
    kind: z.literal('click'),
    target: z.looseObject({ kind: z.string().min(1).max(64) }),
    button: z.enum(['left', 'right']),
    at: z.strictObject({
      x: z.int().min(0).max(1_000),
      y: z.int().min(0).max(500),
      cell: z.int().min(0).max(1_000).optional(),
      clicks: z.int().min(1).max(3).optional(),
    }),
  }),
])

/** One intent, as the door hands it to the window. */
export type WindowIntent = z.infer<typeof IntentBody>

/** What a look carries: where the phone looks, its size, and the revision it holds. */
const LookBody = z.strictObject({
  own: Own.optional(),
  columns: z.int().min(20).max(1_000),
  rows: z.int().min(6).max(500),
  /** The window revision the phone holds and can build on; null asks for a whole. */
  rev: z.int().nonnegative().nullable(),
})

/** One look, parsed. */
export type WindowLook = z.infer<typeof LookBody>

/** What one act carries. */
const ActBody = z.strictObject({
  key: z.string().regex(KEY),
  intent: IntentBody,
  /** Where the phone was looking when it was pressed, laid on its face before it is carried out. */
  own: Own.optional(),
})

/**
 * The window's half: what the listener is handed by a heart with a face that
 * can carry a phone's (`wire/far-faces.ts`) — `tade app`'s, and `tade serve`'s,
 * which opens the window unseen. Absent, both routes are the `404` of a path
 * nobody built — a heart alone, with no window to share.
 */
export interface WindowDoor {
  /** Whether acting from away is on **now**: read at the act, never cached. */
  unlocked(): boolean
  /** This device has the full view open: where it looks, how big, and what it holds. */
  look(device: string, look: WindowLook): { rev: number | null }
  /**
   * Carry one intent out as this device's face. Throws `NotOffered` for what
   * a phone cannot ask (the machine's microphone, closing its window).
   */
  act(
    device: string,
    intent: WindowIntent,
    own: Record<string, unknown> | undefined,
    from: From,
  ): Outcome
  /** This device closed the full view: nothing more is built for it. */
  leave(device: string): void
}

/** Everything one act is decided against. */
export interface Windowing extends Standing {
  window: WindowDoor
  receipts: Receipts
  device: string
  now: number
  request: string
}

/** What this act came to: what the device is told, and what is written down. */
export interface Windowed {
  body: Record<string, unknown> | null
  refusal: Refusal | null
  did: Did
  warning: string | null
}

/** A look, carried: the revision the window will build on, or a refusal. */
export function carryLook(
  body: unknown,
  device: string,
  window: WindowDoor | undefined,
): { body: Record<string, unknown> } | { refusal: Refusal } {
  if (window === undefined) return { refusal: refuse('no_such') }
  const parsed = LookBody.safeParse(body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: window.look(device, parsed.data) }
}

/** Whether this act may go through: the setting now, and a trusted origin. */
export function admitWindow(standing: Standing): Admitted {
  if (!standing.unlocked || !standing.surface.acting) {
    return { ok: false, refusal: refuse('locked'), why: 'window act while acting is turned off' }
  }
  if (!trusted(standing.origin, standing.surface)) {
    return {
      ok: false,
      refusal: refuse('locked'),
      why: `window act from ${standing.origin.scheme}://${standing.origin.host}, which is not a trusted origin`,
    }
  }
  return { ok: true }
}

/**
 * The canonical thing a key is bound to: the device, the word, and the intent
 * with where it was pressed, as text. A newline separates them, which neither
 * a device id nor `window` contains.
 */
export function boundToWindow(
  device: string,
  intent: WindowIntent,
  own: Record<string, unknown> | undefined,
): string {
  return [device, 'window', JSON.stringify({ intent, own: own ?? null })].join('\n')
}

/** Carry one act out, or say why not. `body` is whatever `readBody` produced. */
export async function carryWindow(body: unknown, ctx: Windowing): Promise<Windowed> {
  const parsed = ActBody.safeParse(body)
  if (!parsed.success) return answered(ctx, 'window', null, refuse('malformed'))
  const { key, intent, own } = parsed.data
  const tool = `window ${intent.kind}`

  const allowed = admitWindow(ctx)
  if (!allowed.ok) return answered(ctx, tool, null, allowed.refusal)

  const bound = boundToWindow(ctx.device, intent, own)
  let claim: Claimed
  try {
    claim = await ctx.receipts.claim({
      key,
      bound,
      device: ctx.device,
      verb: tool,
      task: '',
      now: ctx.now,
    })
  } catch (error) {
    // Nothing ran, because the record of being about to could not be written.
    return {
      ...answered(ctx, tool, null, refuse('broke', { request: ctx.request })),
      warning: `the away view could not write down that ${tool} was asked for: ${String(error).slice(0, 200)}`,
    }
  }
  if (claim.kind === 'reused') return answered(ctx, tool, null, refuse('reused'))
  if (claim.kind === 'unsure') return answered(ctx, tool, null, refuse('unsure'))
  if (claim.kind === 'again') return answered(ctx, tool, claim.outcome, null, 'already done')
  if (claim.kind === 'running') {
    try {
      return answered(ctx, tool, await claim.outcome, null, 'already going')
    } catch {
      return answered(ctx, tool, null, refuse('unsure'))
    }
  }

  let outcome: Outcome
  try {
    outcome = await ctx.receipts.while(key, async () =>
      ctx.window.act(ctx.device, intent, own, { how: 'remote', device: ctx.device }),
    )
  } catch (error) {
    if (error instanceof Moved) return answered(ctx, tool, null, refuse('gone', { rev: error.rev }))
    if (error instanceof NotThere) return answered(ctx, tool, null, refuse('no_such'))
    if (error instanceof NotOffered) return answered(ctx, tool, null, refuse('not_offered'))
    if (error instanceof TooMuch) return answered(ctx, tool, null, refuse('too_big'))
    return {
      ...answered(ctx, tool, null, refuse('broke', { request: ctx.request })),
      warning: `the away view could not carry out ${tool}: ${String(error).slice(0, 200)}`,
    }
  }
  await ctx.receipts.came(key, bound, outcome, ctx.now)
  return answered(ctx, tool, outcome, null, outcome.did ? 'done' : 'nothing to do')
}

/** What came of it, or why not, and the line that says so. */
function answered(
  ctx: Windowing,
  tool: string,
  outcome: Outcome | null,
  refusal: Refusal | null,
  why = refusal?.error ?? '',
): Windowed {
  return {
    body: outcome ? { did: outcome.did, rev: outcome.rev, said: outcome.said } : null,
    refusal,
    did: {
      device: ctx.device,
      tool,
      task: '',
      state: outcome ? outcome.said : 'refused',
      why,
    },
    warning: null,
  }
}
