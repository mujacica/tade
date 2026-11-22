import type { IncomingMessage } from 'node:http'
import { type Inventory, InventorySchema } from '@tade/core'
import { z } from 'zod'
import type { Device } from './devices.ts'
import { type Refusal, refuse } from './errors.ts'
import { readBody } from './request.ts'
import { ownsOrTheirs } from './surface.ts'

// Another machine of the person's telling this one what it has
// (`@tade/core`'s `inventory.ts`): which harnesses it is signed into, which
// keys it holds and where, by name and digest and never by value. Kept here
// as a copy of what that machine said, so `tade machine setup --from <it>`
// run on this machine can walk everything it has — the Mac dials, so a box
// set up from it otherwise never hears what the Mac has — and Settings ›
// Machines here has its column.
//
// **An owner's, at this machine's own door** (`here`), like its neighbours: a
// copy written into this home is what an edit to it over the same SSH already
// is. The person's own phone (`theirs`) may tell one too, which is no more than
// what it may already do. It writes one file in this home, `0600`, and the
// journal nothing: an inventory's digests are kept off it.

const InventoryToldBody = z.strictObject({ inventory: InventorySchema })

/** The answer: when it was kept, in this machine's clock. */
export const InventoryToldAnswerSchema = z.object({ at: z.string().max(40), kept: z.boolean() })
export type InventoryToldAnswer = z.infer<typeof InventoryToldAnswerSchema>

/** The window's half: keep what that machine said; whether it was kept. */
export type WebInventoryTold = (inventory: Inventory, device: string) => Promise<boolean>

/** The route. `told` absent is a window that did not wire it: the `404` of a path nobody built. */
export async function inventoryToldHere(
  req: IncomingMessage,
  device: Device,
  told: WebInventoryTold | undefined,
  now: number,
): Promise<{ body: InventoryToldAnswer } | { refusal: Refusal }> {
  if (told === undefined) return { refusal: refuse('no_such') }
  if (!ownsOrTheirs(device)) return { refusal: refuse('out_of_scope') }
  const got = await readBody(req)
  if (!got.read) return { refusal: got.refusal }
  const ask = InventoryToldBody.safeParse(got.body)
  if (!ask.success) return { refusal: refuse('malformed') }
  const kept = await told(ask.data.inventory, device.id)
  return { body: { at: new Date(now).toISOString(), kept } }
}

/** How much of a body an inventory may weigh: under the away view's own bound with room. */
const TOLD_ROOM = 56 * 1024

/**
 * An inventory as one body carries it: whole where it fits, and otherwise
 * with where each item is set left out, and then the newest items kept — so a
 * machine with a great many keys still says which it has.
 */
export function toldBody(inventory: Inventory): { inventory: Inventory } {
  const weight = (one: Inventory) => JSON.stringify({ inventory: one }).length
  if (weight(inventory) <= TOLD_ROOM) return { inventory }
  const lean = {
    ...inventory,
    items: inventory.items.map((one) => ({ ...one, where: [], said: null })),
  }
  while (lean.items.length > 0 && weight(lean) > TOLD_ROOM) lean.items = lean.items.slice(0, -10)
  return { inventory: lean }
}
