import type { IncomingMessage } from 'node:http'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'

// Somebody is at another of their screens: an owner's link saying how long ago
// a key was pressed there, so this machine does not buzz a phone while the
// person is sitting at the Mac (REMOTE-TADE.md §5.3).
//
// **Why it has to be told.** "Present" here means a key pressed in *this*
// window in the last couple of minutes (`noticed.ts`, `focusWindowMs`), and on
// a machine nobody types into — a VPS whose window never closes — that is
// never, so every transition would reach the phone while the person watches
// the same thing happen on the Mac. The Mac's link carries its own last
// keypress, as one number, and this is where it lands.
//
// **What it is allowed to be**, which is a short list and mostly absences:
//
// 1. **An owner's, and only an owner's.** An owner session is the SSH key's
//    (`owner.ts`), so "the person is at a keyboard of theirs" from it is the
//    person's word. A phone's session could say the same thing, and what it
//    would buy a copied one is silencing every notification — so a phone
//    saying it is being looked at is a later decision, not this route.
// 2. **Only on this machine's own door** (`here` in `routes.ts`): the loopback
//    listener and a loopback `Host`, which from anywhere else is an SSH
//    connection. The public listener answers it as a path nobody built.
// 3. **An age and never a moment**, because the two machines' clocks are two
//    clocks: `ago` is milliseconds before *this* request, and the moment is
//    worked out here, in this machine's clock, where `noticed.ts` compares it.
//    Bounded, so a link cannot say somebody was here last week.
// 4. **Held, and written once a stretch, never per keystroke.** Presence is
//    what the window holds for a couple of minutes, the way it holds a
//    keypress, and that is what decides whether a notification is sent. The
//    window also writes `person_present` — at most one line every few minutes
//    (`@tade/core`'s `presenceLineDue`) — because "since you were here" is
//    folded from the last moment this machine counted the person present
//    (`since.ts`), and a moment held in memory dies with a restart. A line per
//    keystroke on another machine would be a journal nobody could read.
// 5. **It can only hold a notification back.** Nothing here sends one, reads
//    one or reaches a project: the worst a presence can do is make this
//    machine quieter, and only for its owner.

/** The longest ago a presence may say a key was pressed: ten minutes. */
export const PRESENCE_MOST_MS = 10 * 60_000

/** What one carries: how long ago, and nothing else — no device, no moment. */
const PresenceBody = z.strictObject({ ago: z.int().min(0).max(PRESENCE_MOST_MS) })

/** A presence read: the moment it is of, in this machine's clock, or why not. */
export type Presence = { ok: true; at: number } | { ok: false; refusal: Refusal }

/** One presence out of a body, for this device, at this moment. Pure. */
export function presenceOf(body: unknown, device: Pick<Device, 'owner'>, now: number): Presence {
  if (!device.owner) return { ok: false, refusal: refuse('out_of_scope') }
  const got = PresenceBody.safeParse(body)
  if (!got.success) return { ok: false, refusal: refuse('malformed') }
  return { ok: true, at: now - got.data.ago }
}

/**
 * The route: the body read once, the presence handed to the window, and the
 * moment it came to as the answer. `present` absent is a window that did not
 * wire it, which is the `404` of a path nobody built.
 */
export async function carryPresence(
  req: IncomingMessage,
  device: Device,
  now: number,
  present: ((device: string, at: number) => void) | undefined,
): Promise<{ body: { at: string } } | { refusal: Refusal }> {
  if (present === undefined) return { refusal: refuse('no_such') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const said = presenceOf(got.body, device, now)
  if (!said.ok) return { refusal: said.refusal }
  present(device.id, said.at)
  return { body: { at: new Date(said.at).toISOString() } }
}
