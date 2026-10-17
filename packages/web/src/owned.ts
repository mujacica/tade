import type { IncomingMessage } from 'node:http'
import { type AttachAnswer, attachHere } from './attached.ts'
import { type CarryAnswer, carryHere } from './carried.ts'
import type { Device } from './devices.ts'
import type { Refusal } from './errors.ts'
import { carryPresence } from './presence.ts'
import type { ServerOptions } from './serving.ts'
import { type SinceAnswer, sinceHereFor } from './since.ts'

// What only an owner device may ask of this machine, and only at its own door
// (`here` in `routes.ts`): that the person is at another of their screens
// (`presence.ts`), another machine's setup carried here (`carried.ts`), what
// to run here to be shown one of its agents (`attached.ts`), and what they
// missed while they were away (`since.ts`). One door in `server.ts` for all
// four, because each is the SSH key's word and nothing a phone's session is
// ever answered.

export async function carryOwned(
  route: string,
  req: IncomingMessage,
  device: Device,
  now: number,
  opts: Pick<ServerOptions, 'present' | 'carrying' | 'attaching' | 'since'>,
): Promise<
  { body: { at: string } | CarryAnswer | AttachAnswer | SinceAnswer } | { refusal: Refusal }
> {
  if (route === 'carry') return carryHere(req, device, opts.carrying)
  if (route === 'attach') return attachHere(req, device, opts.attaching)
  if (route === 'since') return sinceHereFor(req, device, now, opts.since)
  return carryPresence(req, device, now, opts.present)
}
