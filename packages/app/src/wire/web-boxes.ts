import type { Device, Grant, Scope } from '@tade/web'

/**
 * What one box on a device's row in the Away panel grants: the scopes it
 * writes, the reading grants it writes with them, and the places on the page
 * its capability draws (`WITHHOLDS` paths).
 *
 * **A box is ticked only when the page it names would show.** `talk to Tade`
 * used to write `ask` and nothing else, so a phone with the box ticked had a
 * composer whose answers it was not allowed to read and said *Not granted*
 * under it; `change settings` likewise needs the settings it changes.
 * `test/wire/web-boxes.test.ts` holds every box's `draws` to the reading
 * grants it writes, through the same table the projection gates by.
 *
 * Taking a box back takes its scopes and the reading grants nothing else here
 * gives on its own — the conversation goes with talking, while the settings
 * stay, because `read settings` is a box of its own and says so.
 */
export interface Box {
  scopes: readonly Scope[]
  reads: readonly Grant[]
  draws: readonly string[]
}

export const BOXES = {
  // `answer` also draws the command an approval asks about: a scope's place
  // (`ANSWERING`), not a reading grant's, so it is not among the `draws`.
  act: { scopes: ['answer', 'steer'], reads: [], draws: [] },
  agents: { scopes: ['agents'], reads: [], draws: [] },
  projects: { scopes: ['projects'], reads: [], draws: [] },
  talk: { scopes: ['ask'], reads: ['talk'], draws: ['chat'] },
  configure: { scopes: ['configure'], reads: ['settings'], draws: ['settings'] },
  see: { scopes: [], reads: ['lanes'], draws: ['agent.screen'] },
  settings: { scopes: [], reads: ['settings'], draws: ['settings'] },
} as const satisfies Record<string, Box>

/** Whether a device has everything a box grants: what the box draws as ticked. */
export function ticked(device: Pick<Device, 'scopes' | 'granted'>, box: Box): boolean {
  return (
    box.scopes.every((scope) => device.scopes.includes(scope)) &&
    box.reads.every((grant) => device.granted.includes(grant))
  )
}

/**
 * The reading grants after pressing a box: its own added where it is being
 * turned on, and taken where it is being turned off unless a reading box of
 * their own gives them. Everything else is kept as it was, because
 * `grantDevice` writes the whole list.
 */
export function readsAfter(device: Pick<Device, 'granted'>, box: Box, on: boolean): string[] {
  const own = new Set<string>(
    Object.values(BOXES as Record<string, Box>)
      .filter((one) => one.scopes.length === 0)
      .flatMap((one) => one.reads),
  )
  const taken = on ? [] : box.reads.filter((grant) => !own.has(grant))
  const kept = device.granted.filter((grant) => !taken.includes(grant as Grant))
  return [...new Set([...kept, ...(on ? box.reads : [])])]
}
