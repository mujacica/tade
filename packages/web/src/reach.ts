// Whose a reading is: one paired device, by the id the machine gave it.
//
// **Every paired device is the person's own** (decided 26 Nov), so a reading
// reaches every project and everything in it, and there is nothing here to
// withhold by. What a device may not read is what no device may: an agent's
// screen and its conversation are cleaned at the boundary (`screen.ts`,
// `cleanAway`) and a key is never on the wire under any reading
// (`configuring.ts`). Those hold for every device whoever paired it.
//
// The device is still carried, because some answers are about one device:
// its own row in the list, what it said to Tade, which of its notifications
// were sent, and what it already holds of another machine's copy.

/** One device's reading. */
export interface Reach {
  /**
   * The device, by the id the machine gave it when it was paired. Never its
   * label, never its address: a label is a person's own words about their own
   * phone, and an address is a fact about a network that goes stale in a
   * minute.
   */
  device: string
}

/** The reading of one device, by its id. */
export function reachFor(device: string): Reach {
  return { device }
}
