import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// This machine's away view, as another machine of the person's window draws it
// on a tab of its AWAY VIEW panel: whether it listens and how it is reached,
// its devices, and the three things done to it from there — a code written,
// one device signed out, every one of them.
//
// **Done here, by this machine's own away-view code**, never by the asking
// one: a code is `tade web pair`'s (`writeCode`, `pending.ts`), a sign-out is
// the panel's own (`revokeOne`, `revokeEvery`), and what is drawn is the
// panel's own facts (`awayView`'s readers). The asking window only draws the
// answer, so the two panels can never say different things about one machine.
//
// **An owner's, and only at this machine's own door** (`here`), as its
// neighbours are: whoever holds the SSH key can already run `tade web pair`,
// `tade web devices` and `tade web revoke` here. **And a paired device's**,
// on any door, every one being the person's own — off this machine's asked a
// trusted origin and the passkey. A code written this way is a code the
// terminal wrote: nobody here is asked when it is used, because the press was
// the yes, exactly as running `tade web pair` over SSH is.
//
// **The secret goes back once and is kept nowhere here**: the digest is in
// `web-devices.jsonl` and the link is in the answer to the press that wrote
// it, never in a look, never in the journal. The asking window holds it in
// memory for the minutes it is good for.

/** How many devices one answer carries; past that, the newest are kept. */
export const AWAY_DEVICES_MOST = 64
/** How many written codes nobody has claimed yet one answer names. */
export const AWAY_CODES_MOST = 16

const Said = z.string().max(600)
const Id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/)

const DeviceSchema = z.object({
  id: Id,
  label: z.string().max(200),
  /** Where it paired from, in words (`whereFrom`); `AWAY_ITSELF` for this machine. */
  from: z.string().max(200),
  owner: z.boolean().optional(),
  pairedAt: z.number(),
  passkey: z.number().optional(),
  passkeyMade: z.number().optional(),
  readsOnly: z.enum(['in the clear', 'no passkey']).optional(),
  live: z.boolean(),
})

/** The answer, as this machine gives it and another reads it: for its shape, every value bounded. */
export const AwayAnswerSchema = z.object({
  /** This machine's own clock when it answered. */
  at: z.string().max(40),
  /** Whether a listener is up now — not what the config says. */
  listening: z.boolean(),
  bind: z.enum(['loopback', 'lan']),
  /** What is bound, as `host:port`. */
  bound: z.array(z.string().max(80)).max(8),
  /** The addresses a phone could reach, as `routesOf`'s rule allows. */
  reachable: z.array(z.string().max(80)).max(16),
  /** Its public name, whether its listener is up, and what the health look found. */
  public: z
    .object({
      name: z.string().max(253),
      up: z.boolean(),
      lines: z.array(z.object({ said: Said, loud: z.boolean() })).max(8),
    })
    .nullable(),
  devices: z.array(DeviceSchema).max(AWAY_DEVICES_MOST),
  /** The written codes nobody has claimed yet, by the device each would become. */
  codes: z.array(z.object({ device: Id, secondsLeft: z.int().nonnegative() })).max(AWAY_CODES_MOST),
  /** The code a press just wrote, with its link; null on a look and on any other press. */
  code: z
    .object({
      url: z.string().max(2048),
      device: Id,
      secondsLeft: z.int().nonnegative(),
    })
    .nullable(),
  /** How many streams are open now. */
  streams: z.int().nonnegative(),
  /** What went wrong in the away view here, in this Tade's words. */
  problem: Said.nullable(),
  /** Why the press did nothing — off, no address to write a code for — or null. */
  cannot: Said.nullable(),
})
export type AwayAnswer = z.infer<typeof AwayAnswerSchema>
export type AwayDeviceThere = z.infer<typeof DeviceSchema>

/** What may be asked: a look, or one press. Strict, so no other shape arrives. */
export const AwayAskSchema = z.union([
  z.strictObject({}),
  z.strictObject({ press: z.literal('code') }),
  z.strictObject({ press: z.literal('revoke'), device: Id }),
  z.strictObject({ press: z.literal('revoke all') }),
])
export type AwayAsk = z.infer<typeof AwayAskSchema>

/**
 * How a device that paired from this machine itself is named in an answer:
 * the asking window says that machine's name instead, since `this machine`
 * read on another one is the wrong one.
 */
export const AWAY_ITSELF = 'the machine itself'

/** The window's half: a look or a press, answered. Never throws: what failed is `problem`. */
export type WebAway = (asked: AwayAsk, device: string) => Promise<AwayAnswer>

/** The route. `away` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function awayThereHere(
  req: IncomingMessage,
  device: string,
  away: WebAway | undefined,
): Promise<{ body: AwayAnswer } | { refusal: Refusal }> {
  if (away === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const asked = AwayAskSchema.safeParse(got.body)
  if (!asked.success) return { refusal: refuse('malformed') }
  return { body: awayFor(await away(asked.data, device)) }
}

/** An answer within its bounds, cut rather than refused, so the other machine never refuses the whole. */
export function awayFor(all: AwayAnswer): AwayAnswer {
  const said = (text: string | null) => (text === null ? null : cut(text, 600))
  return {
    ...all,
    bound: all.bound.slice(0, 8).map((one) => cut(one, 80)),
    reachable: all.reachable.slice(0, 16).map((one) => cut(one, 80)),
    public:
      all.public === null
        ? null
        : {
            name: cut(all.public.name, 253),
            up: all.public.up,
            lines: all.public.lines
              .slice(0, 8)
              .map((one) => ({ ...one, said: cut(one.said, 600) })),
          },
    devices: all.devices.slice(-AWAY_DEVICES_MOST).map((one) => ({
      ...one,
      label: cut(one.label, 200),
      from: cut(one.from, 200),
    })),
    codes: all.codes.slice(-AWAY_CODES_MOST),
    problem: said(all.problem),
    cannot: said(all.cannot),
  }
}

/** A string at most `most` long, with an ellipsis where it was cut. */
function cut(text: string, most: number): string {
  return text.length <= most ? text : `${text.slice(0, most - 1)}…`
}
