import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { type Reach, sees } from './reach.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs, reachOf } from './surface.ts'

// What one of this machine's watches has already found, for another machine of
// the person's that left the watch to this one and will take it back
// (`watchWhere`): every key it has seen and the cursor it got to, so the watch
// taken back never offers again what this machine already acted on.
//
// **An owner's, at this machine's own door** (`here`), like `machine.ts` and
// for its reasons: whoever holds the SSH key can read this machine's journal,
// and a key is a source's own id for an item — an issue number, a run's id —
// which is what `watch_found` already writes here. The person's own phone
// (`theirs`) may ask it too; it reads only what a projection already shows of
// a project it reads.
//
// **Bounded, newest kept**: a watch that has looked for a year has seen more
// keys than one answer carries, and the ones that matter for not offering a
// thing twice are the recent ones — an old key a source still lists past its
// own cursor is one a look would already pass over. How many were left out is
// said (`more`), never dropped in silence.

/** The most keys one answer carries; past that the newest are kept, and the rest counted. */
export const WATCH_SEEN_MOST = 2_000

const WatchSeenBody = z.strictObject({
  /** The project here, by its name here. */
  project: z.string().min(1).max(200),
  /** `<extension>.<watch>`. */
  watch: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,99}$/),
})
export type WatchSeenAsk = z.infer<typeof WatchSeenBody>

/**
 * The answer: read for its shape there, every value bounded, because it was
 * written on another machine.
 */
export const WatchSeenAnswerSchema = z.object({
  /** This machine's own clock when it answered. */
  at: z.string().max(40),
  /** Whether a watch of that kind looks with that project here; nothing else is said where not. */
  found: z.boolean(),
  /** The cursor its last look got to, as the source's own word; null where none. */
  since: z.string().max(2_000).nullable(),
  /**
   * A digest of what the watch was told to look at (its input): the cursor is
   * worth taking only where the two machines' watches look at the same thing,
   * and the keys are worth taking either way.
   */
  input: z.string().max(80),
  /** Every key it has found, newest first, at most `WATCH_SEEN_MOST`. */
  seen: z.array(z.string().max(200)).max(WATCH_SEEN_MOST),
  /** How many more it has seen than `seen` carries. */
  more: z.int().nonnegative(),
})
export type WatchSeenAnswer = z.infer<typeof WatchSeenAnswerSchema>

/** The window's half: what it holds of that watch, or `found: false`. */
export type WebWatchSeen = (ask: WatchSeenAsk) => Promise<WatchSeenAnswer>

/** The route. `watchSeen` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function watchSeenHere(
  req: IncomingMessage,
  device: Device,
  watchSeen: WebWatchSeen | undefined,
): Promise<{ body: WatchSeenAnswer } | { refusal: Refusal }> {
  if (watchSeen === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const ask = WatchSeenBody.safeParse(got.body)
  if (!ask.success) return { refusal: refuse('malformed') }
  return { body: watchSeenFor(await watchSeen(ask.data), ask.data, reachOf(device)) }
}

/** What one device is answered: nothing of a project it does not read, and every list within its bound. */
export function watchSeenFor(
  all: WatchSeenAnswer,
  ask: WatchSeenAsk,
  reach: Reach,
): WatchSeenAnswer {
  if (!sees(reach, ask.project) || !all.found) {
    return { at: all.at, found: false, since: null, input: '', seen: [], more: 0 }
  }
  const keys = all.seen.filter((key) => key.length <= 200)
  const seen = keys.slice(0, WATCH_SEEN_MOST)
  return {
    at: all.at,
    found: true,
    since: all.since !== null && all.since.length <= 2_000 ? all.since : null,
    input: all.input.slice(0, 80),
    seen,
    more: all.more + (keys.length - seen.length) + (all.seen.length - keys.length),
  }
}
