import type { IncomingMessage } from 'node:http'
import { type SeenWord, SLEPT_MOST_MS } from '@tade/core'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// Another machine of the person's saying it is up, or saying goodbye: what its
// window's link to this one beats with while it is open (`/api/seen`), so this
// machine knows the Mac is closed rather than guessing from a silence — and a
// phone looking at this machine is told so (`machines-seen.ts` has the rules).
//
// **What it is allowed to be**, which is a short list and mostly absences:
//
// 1. **An owner's, or the person's own phone's.** An owner session is another
//    machine's Tade (`owner.ts`): its word that it is up or closing is that
//    machine's word about itself, under the label it paired with. The
//    person's own phone may say it too (`Route.theirs`): they decided it may
//    do what they can, and all it can say is that *it* — by its own label —
//    is up or closing. No session can speak for another machine's name.
// 2. **Only on this machine's own door** (`here`), which from anywhere else is
//    an SSH connection.
// 3. **An age and never a moment** (`presence.ts`'s rule): `slept` is how long
//    ago that machine went to sleep, worked out here into this machine's
//    clock, and bounded to a week so a wrong clock cannot write a year.
// 4. **It can only say what it is.** It reaches no project and starts
//    nothing: the worst a session could do with it is say a machine is up or
//    closed, which the next silence corrects (`lost`).

const SeenBody = z.discriminatedUnion('state', [
  z.strictObject({ state: z.literal('up'), slept: z.int().min(0).max(SLEPT_MOST_MS).optional() }),
  z.strictObject({ state: z.literal('closed') }),
])

/** The window's half: a machine link said this, at this moment in this machine's clock. */
export type WebSeen = (device: Pick<Device, 'id' | 'label'>, word: SeenWord, at: number) => void

/** One word out of a body, for this device: what it said, or why it is refused. Pure. */
export function seenOf(
  body: unknown,
  device: Pick<Device, 'owner' | 'scopes' | 'granted'>,
): { ok: true; word: SeenWord } | { ok: false; refusal: Refusal } {
  if (!ownsOrTheirs(device)) return { ok: false, refusal: refuse('out_of_scope') }
  const got = SeenBody.safeParse(body)
  if (!got.success) return { ok: false, refusal: refuse('malformed') }
  if (got.data.state === 'closed') return { ok: true, word: { state: 'closed' } }
  return { ok: true, word: { state: 'up', slept: got.data.slept ?? null } }
}

/** The route. `seen` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function seenHere(
  req: IncomingMessage,
  device: Device,
  now: number,
  seen: WebSeen | undefined,
): Promise<{ body: { at: string } } | { refusal: Refusal }> {
  if (seen === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const said = seenOf(got.body, device)
  if (!said.ok) return { refusal: said.refusal }
  seen(device, said.word, now)
  return { body: { at: new Date(now).toISOString() } }
}
