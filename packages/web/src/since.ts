import type { IncomingMessage } from 'node:http'
import type { SinceHere, SinceItem } from '@tade/core'
import { z } from 'zod'
import { projectOf } from './acting.ts'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { has, type Reach, sees } from './reach.ts'
import { readBody } from './request.ts'

// "Since you were here": the card another machine of the person's draws once,
// when its link to this one comes back (REMOTE-TADE.md §5.4) — what finished,
// what is waiting on them, what is waiting to be read, what is held, what was
// put to this machine's orchestrator, and what it cost, folded here over this
// machine's own journal from the last moment it counted them present
// (`@tade/core`'s `since.ts` has the fold and the cursor).
//
// **An owner's, and only at this machine's own door** (`here` in `routes.ts`),
// like the presence it is folded from: the person at another of their screens
// asking this machine what they missed, through the SSH connection that is
// their key. A phone's session is refused it however much it was granted — a
// phone pairs with this machine and reads its projection — and the public
// listener answers the `404` of a path nobody built.
//
// **The moment they came back is told as an age**, never a moment
// (`presence.ts`' rule, for its reason: two machines are two clocks). `back`
// is how long ago that machine's link came up again; the cut is worked out
// here, in this clock, and every presence line written after it is of the
// stretch the person is in now — so the presence their link carried a breath
// before it asked cannot make the card empty.
//
// **Within what the device reads, and capped with a count.** Each row is about
// a task, and a task in a project the window took back from this device is
// left out, not counted; money only where `spend` is granted. A list is cut
// at `SINCE_MOST` and says how many more there were — a catch-up that quietly
// holds the first eight of forty is one that answers "is anything waiting for
// me" wrongly. It changes nothing and writes nothing.

/** The longest ago a link may say it came back and still be asking what it missed. */
export const SINCE_BACK_MOST_MS = 10 * 60_000

/** The rows a list carries; the rest are counted. */
export const SINCE_MOST = 8

const SinceBody = z.strictObject({ back: z.int().min(0).max(SINCE_BACK_MOST_MS) })

const ItemSchema = z.strictObject({
  task: z.string().max(200),
  at: z.string(),
  /** Tade's clause, or a proposal's title — somebody's words, so bounded and drawn as text. */
  said: z.string().max(400),
})
const ListSchema = z.strictObject({ rows: z.array(ItemSchema).max(SINCE_MOST), more: z.int() })

/** The card, as this machine answers it. Every list newest first. */
export const SinceAnswerSchema = z.strictObject({
  /** The moment it is since, in this machine's clock; null where it has never counted anybody present. */
  since: z.string().nullable(),
  finished: ListSchema,
  /** What is waiting on the person now: an approval, a question. */
  waiting: ListSchema,
  documents: ListSchema,
  held: ListSchema,
  proposed: ListSchema,
  /** What the agents here spent since; null where `spend` is not granted, or nothing is since. */
  spend: z.strictObject({ usd: z.number(), tokens: z.number(), hasCost: z.boolean() }).nullable(),
})
export type SinceAnswer = z.infer<typeof SinceAnswerSchema>

/** The window's half: the card from the cut on, for this device. */
export type WebSince = (device: Device, cut: number) => Promise<SinceAnswer>

const NONE = { rows: [], more: 0 }

/**
 * The card, out of the fold and what is waiting now, for one device's reach.
 * `here` is null where this machine has never counted the person present,
 * which is a first link and has nothing to catch up on.
 */
export function sinceAnswerOf(
  here: SinceHere | null,
  waiting: readonly SinceItem[],
  reach: Reach,
): SinceAnswer {
  if (here === null) {
    return {
      since: null,
      finished: NONE,
      waiting: listOf(waiting, reach),
      documents: NONE,
      held: NONE,
      proposed: NONE,
      spend: null,
    }
  }
  const spent = here.spend
  return {
    since: new Date(here.since).toISOString(),
    finished: listOf(here.finished, reach),
    waiting: listOf(waiting, reach),
    documents: listOf(here.documents, reach),
    held: listOf(here.held, reach),
    proposed: listOf(here.proposed, reach),
    spend:
      has(reach, 'spend') && spent.tokens > 0
        ? { usd: spent.usd, tokens: spent.tokens, hasCost: spent.hasCost }
        : null,
  }
}

function listOf(items: readonly SinceItem[], reach: Reach): SinceAnswer['finished'] {
  const seen = items.filter((one) => sees(reach, projectOf(one.task)))
  return {
    rows: seen.slice(0, SINCE_MOST).map((one) => ({
      task: one.task.slice(0, 200),
      at: new Date(one.at).toISOString(),
      said: one.said.slice(0, 400),
    })),
    more: Math.max(0, seen.length - SINCE_MOST),
  }
}

/**
 * The route: the body read once, the cut worked out in this clock, and the
 * card the window folds. `since` absent is a window that did not wire it,
 * which is the `404` of a path nobody built.
 */
export async function sinceHereFor(
  req: IncomingMessage,
  device: Device,
  now: number,
  since: WebSince | undefined,
): Promise<{ body: SinceAnswer } | { refusal: Refusal }> {
  if (since === undefined) return { refusal: refuse('no_such') }
  if (!device.owner) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const parsed = SinceBody.safeParse(got.body)
  if (!parsed.success) return { refusal: refuse('malformed') }
  return { body: await since(device, now - parsed.data.back) }
}
