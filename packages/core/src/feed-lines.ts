import type { TadeEvent } from './events.ts'

// What a line from another machine is, and what a machine's id looks like:
// read wherever the window is drawn, a browser included (`pure.ts`), so apart
// from `feeds.ts`, which chains and hashes the feeds with `node:crypto`.
// `feeds.ts` hands these on, so nothing that imports them from there changes.

/** What a machine id looks like: a UUID, minted once (`machine.json`). */
export const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** A line out of another machine's feed, labelled with what that machine calls itself. */
export type FleetEvent = TadeEvent & { machine: string }

/** Whether a line came out of another machine's feed rather than this one's journal. */
export function foreign(event: TadeEvent): event is FleetEvent {
  return typeof (event as Partial<FleetEvent>).machine === 'string'
}
