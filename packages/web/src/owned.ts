import type { IncomingMessage } from 'node:http'
import { type CarryAnswer, carryHere } from './carried.ts'
import type { Device } from './devices.ts'
import type { Refusal } from './errors.ts'
import { carryPresence } from './presence.ts'
import type { ServerOptions } from './serving.ts'

// What only an owner device may ask of this machine, and only at its own door
// (`here` in `routes.ts`): that the person is at another of their screens
// (`presence.ts`), and another machine's setup carried here (`carried.ts`).
// One door in `server.ts` for both, because both are the SSH key's word and
// nothing a phone's session is ever answered.

export async function carryOwned(
  route: string,
  req: IncomingMessage,
  device: Device,
  now: number,
  opts: Pick<ServerOptions, 'present' | 'carrying'>,
): Promise<{ body: { at: string } | CarryAnswer } | { refusal: Refusal }> {
  return route === 'carry'
    ? carryHere(req, device, opts.carrying)
    : carryPresence(req, device, now, opts.present)
}
