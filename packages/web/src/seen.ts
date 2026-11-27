import type { IncomingMessage } from 'node:http'
import { type SeenWord, SLEPT_MOST_MS } from '@tade/core'
import { z } from 'zod'
import { DEVICE_NAME, type Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { type Host, hostFigures } from './protocol.ts'
import { readBody } from './request.ts'

// Another machine of the person's saying it is up, or saying goodbye: what its
// window's link to this one beats with while it is open (`/api/seen`), so this
// machine knows the Mac is closed rather than guessing from a silence — and a
// phone looking at this machine is told so (`machines-seen.ts` has the rules).
//
// **What it is allowed to be**, which is a short list and mostly absences:
//
// 1. **An owner's, or a paired phone's.** An owner session is another
//    machine's Tade (`owner.ts`): its word that it is up or closing is that
//    machine's word about itself, under the label it paired with. A paired
//    phone, the person's own, may say it too: all it can say is that *it* —
//    by its own label — is up or closing. No session can speak for another machine's name.
// 2. **Only on this machine's own door** (`here`), which from anywhere else is
//    an SSH connection.
// 3. **An age and never a moment** (`presence.ts`'s rule): `slept` is how long
//    ago that machine went to sleep, worked out here into this machine's
//    clock, and bounded to a week so a wrong clock cannot write a year.
// 4. **It can only say what it is.** It reaches no project and starts
//    nothing: the worst a session could do with it is say a machine is up or
//    closed, which the next silence corrects (`lost`).
// 5. **Its figures are its own word about itself, and only numbers.** A word
//    that it is up may carry the machine's own figures (`HostSchema`) — its
//    processors, memory and disk, for the person's phone to read. Figures
//    that do not read as figures are none rather than a refusal, so a newer
//    machine's shape never costs an older one the word that it is up.
// 6. **Its name is its own word about itself too.** A word that it is up may
//    say what that machine is called now (`machineLabel` there: its
//    `machine.name`, or the kind of machine it is), so a machine that paired
//    under its host name before it had a name of its own is not called by its
//    host name here for as long as the pairing lasts. It renames only the
//    device that said it (`named` in `devices.ts`), in a label's own grammar;
//    a machine that says none keeps the label it paired with.

const SeenBody = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('up'),
    slept: z.int().min(0).max(SLEPT_MOST_MS).optional(),
    host: z.unknown().optional(),
    name: z.string().regex(DEVICE_NAME).optional(),
  }),
  z.strictObject({ state: z.literal('closed') }),
])

/**
 * The window's half: a machine link said this, at this moment in this
 * machine's clock — and, with a word that it is up, its own figures, or null
 * where it sent none that read as figures, and what it is called now, or null
 * where it did not say.
 */
export type WebSeen = (
  device: Pick<Device, 'id' | 'label'>,
  word: SeenWord,
  at: number,
  host: Host | null,
  name: string | null,
) => void

/** One word out of a body: what it said, or why it is refused. Pure. */
export function seenOf(
  body: unknown,
):
  | { ok: true; word: SeenWord; host: Host | null; name: string | null }
  | { ok: false; refusal: Refusal } {
  const got = SeenBody.safeParse(body)
  if (!got.success) return { ok: false, refusal: refuse('malformed') }
  if (got.data.state === 'closed') {
    return { ok: true, word: { state: 'closed' }, host: null, name: null }
  }
  return {
    ok: true,
    word: { state: 'up', slept: got.data.slept ?? null },
    host: hostFigures(got.data.host ?? null),
    name: got.data.name ?? null,
  }
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
  const said = seenOf(got.body)
  if (!said.ok) return { refusal: said.refusal }
  seen(device, said.word, now, said.host, said.name)
  return { body: { at: new Date(now).toISOString() } }
}
