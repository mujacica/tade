import type { IncomingMessage } from 'node:http'
import { type AttachAnswer, attachHere } from './attached.ts'
import { type Answering, type CarryAnswer, carryHere } from './carried.ts'
import type { Device } from './devices.ts'
import type { Refusal } from './errors.ts'
import { carryLooking } from './looking.ts'
import { carryPresence } from './presence.ts'
import type { ServerOptions } from './serving.ts'
import { type NotesShareAnswer, shareHere } from './shared-notes.ts'
import { type SinceAnswer, sinceHereFor } from './since.ts'

// What only an owner device may ask of this machine, and only at its own door
// (`here` in `routes.ts`): that the person is at another of their screens
// (`presence.ts`), another machine's setup carried here (`carried.ts`), what
// to run here to be shown one of its agents (`attached.ts`), what they missed
// while they were away (`since.ts`), and their notes shared with another of
// their machines (`shared-notes.ts`). One door in `server.ts` for all five,
// because each is the SSH key's word and nothing a phone's session is ever
// answered.
//
// And through the same door, one word **any** device may say, because it is
// the same kind of word as the first — a device's own about the person holding
// it — and asks nothing an owner has: that its page is being looked at
// (`looking.ts`), which only ever quiets what that one device is sent.

export async function carryOwned(
  route: string,
  req: IncomingMessage,
  device: Device,
  now: number,
  opts: Pick<ServerOptions, 'present' | 'looking' | 'carrying' | 'attaching' | 'since' | 'notes'>,
  res: Answering,
): Promise<
  | { body: { at: string } | CarryAnswer | AttachAnswer | SinceAnswer | NotesShareAnswer }
  | { refusal: Refusal }
> {
  if (route === 'carry') return carryHere(req, device, opts.carrying, res)
  if (route === 'attach') return attachHere(req, device, opts.attaching)
  if (route === 'since') return sinceHereFor(req, device, now, opts.since)
  if (route === 'share notes') return shareHere(req, device, opts.notes)
  if (route === 'looking') return carryLooking(req, device, now, opts.looking)
  return carryPresence(req, device, now, opts.present)
}
