import type { Surface } from '@tade/web'

// The away view's listener brought to what the config says, as a setting
// changes (`Away.follow`, from `Settings.use`).
//
// **Up, down, and built again.** Off to on brings the listener up with
// whatever the rest says; on to off closes it at once, the direction that
// takes authority away; and a change to anything it was built from while it
// is on (`builtFrom`) closes it and brings it up again. Built again rather
// than *on restart*, because the panel, the chip and the code are about the
// listener: one left on loopback under a config saying `lan` drew *listening
// on the network* and minted a code for an address nothing was listening on.
// A phone with a page open is cut off and comes back on the new epoch with a
// snapshot, which is what opening Tade again would have done to it — its
// session is a line in the device list and outlives the listener.

/** What `turnTo` needs of the away subject. */
export interface Turning {
  open(): Promise<void>
  stop(): Promise<void>
  /** A code for a page that draws one, now that something listens. */
  mint(): void
  /** Said where somebody will see it, and kept for the panel. */
  failed(what: string, err: unknown): void
}

/**
 * What a listener is built from, as one value to compare — null for none.
 *
 * Every part of the surface but `pushDetails`, which the notifying half reads
 * off the config at every beat rather than when the listener comes up.
 */
export function builtFrom(surface: Surface): string | null {
  if (!surface.enabled) return null
  const { pushDetails: _onTheBeat, ...built } = surface
  return JSON.stringify(built)
}

/** One turn from the listener built for `was` to the one for `want`. Never throws. */
export async function turnTo(
  was: string | null,
  want: string | null,
  away: Turning,
): Promise<void> {
  const again = was !== null && want !== null
  try {
    if (want === null || again) await away.stop()
    if (want === null) return
    await away.open()
    away.mint()
  } catch (err) {
    away.failed(want === null ? 'stop' : again ? 'start again' : 'start', err)
  }
}
