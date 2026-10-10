import { appendDevice, type Device, readDevices, revokeAll, type Tickets } from '@tade/web'

// The three ways a paired device stops being one, and the one thing all three
// have in common: a stream it holds is closed and nothing of it is kept.
//
// Two of them are a keypress at this machine — **one device**, and
// **everything** — and they are here rather than in `web.ts` because they are
// the same subject as the third and were the same five lines twice. The third
// is the one with an argument behind it:
//
// **Why this is the window's and not the listener's.** The listener reads
// `web-devices.jsonl` on every request, so a device revoked a moment ago is
// refused by its next one — that half needs nothing here. What a request
// cannot answer for is a stream that is *already open*: an `EventSource` makes
// no second request, so nothing would ever re-ask. A session lasts thirty
// days, and the terminal's own sentence is *its credential is no longer a
// session, and any open page stops within a beat*.
//
// **And why it is read from the file rather than told.** `tade web revoke`,
// `tade web revoke --all` and `tade web off` all append to the device list
// **without the window** — deliberately, because disconnecting a phone you
// have lost must not depend on Tade being open. There is no channel from a
// shell into the window (the `ToolHost` is for the window's own child agents
// and must never become one), so the file is the whole of what the two
// processes share. The window reads it again; it is not sent anything.
//
// **Only while something is listening.** That is what keeps *nothing is built
// for nobody* true: with no stream open there is no socket to close and the
// next request re-reads the list anyway, so an away view nobody paired a phone
// to pays nothing. With a stream open, one file read per beat is the cost the
// listener already pays per request.

/** What ending a session needs of the window. */
export interface Sessions {
  home: string
  now: () => number
  /** Every device with a stream open right now. */
  listening: () => readonly string[]
  /** The list as it has just been read, for the window to keep. */
  keep: (devices: readonly Device[]) => void
  /**
   * Close this device's streams, drop everything held for it, and write it
   * down.
   *
   * One method for all three, because two out of three is a projection and a
   * revision kept for a device that cannot ask again.
   */
  letGo: (device: string, why: string) => void
  /** Said in the strip, where somebody who was not looking at the panel sees it. */
  news: (said: string) => void
  /** Read the list again and draw: a file read on a person's own act. */
  reread: () => Promise<void>
}

/** One device, disconnected at the machine. Its streams close now. */
export async function revokeOne(deps: Sessions, id: string): Promise<void> {
  await appendDevice(deps.home, {
    kind: 'revoked',
    device: id,
    at: new Date(deps.now()).toISOString(),
    why: 'revoked at the machine',
  })
  deps.letGo(id, 'revoked at the machine')
  await deps.reread()
}

/**
 * Every device, disconnected. **It needs no network**: what a phone holds is
 * checked at every request, so one that is off, lost or on another continent
 * is disconnected by this.
 *
 * The outstanding code goes too, which is the half that is easy to forget: a
 * ticket minted a minute ago is a credential nobody has claimed yet, and
 * "disconnect everything" that left one claimable would be one phone short of
 * what it says.
 */
export async function revokeEvery(deps: Sessions, tickets: Tickets): Promise<void> {
  const gone = await revokeAll(deps.home, new Date(deps.now()))
  for (const id of gone) deps.letGo(id, 'everything disconnected')
  tickets.clear()
  deps.news(gone.length === 0 ? 'no device was paired' : `${gone.length} device(s) disconnected`)
  await deps.reread()
}

/**
 * Which of the devices listening no longer holds a session, and the word for
 * each.
 *
 * Pure, so the three cases can be asked of it directly rather than through a
 * socket:
 *
 * - **Revoked**, which carries the file's own reason — signed out, revoked at
 *   the machine, everything disconnected — because that is the sentence
 *   somebody at the machine chose.
 * - **Missing from a list that was read**, which is a device the listener
 *   would answer `401`. The file is append-only and nothing rewrites it, so
 *   this is a list that lost a line; letting the stream go is the direction
 *   that matches what every request to it would get.
 * - **Its own line unparseable**, which arrives here as missing and is let go
 *   for the same reason. A credential whose record cannot be read is not a
 *   credential, and a stream outliving the requests of the same cookie is the
 *   shape this exists to prevent.
 */
export function lostSessions(
  listening: readonly string[],
  devices: readonly Device[],
): { device: string; why: string }[] {
  const out: { device: string; why: string }[] = []
  for (const id of listening) {
    const held = devices.find((one) => one.id === id)
    if (held !== undefined && held.revoked === null) continue
    out.push({ device: id, why: held?.revoked ?? 'no session at this machine any more' })
  }
  return out
}

/**
 * Read the device list, keep it, and let go of every stream it no longer
 * answers for.
 *
 * **A list that could not be read at all leaves every stream alone**: an
 * unreadable file is not a file saying nobody is paired, and closing every
 * page because a disk hiccuped is the failure this direction avoids. The next
 * beat asks again.
 */
export async function letGoOfRevoked(deps: Sessions): Promise<void> {
  const listening = deps.listening()
  if (listening.length === 0) return
  const read = await readDevices(deps.home).catch(() => null)
  if (read === null) return
  deps.keep(read.devices)
  for (const lost of lostSessions(listening, read.devices)) deps.letGo(lost.device, lost.why)
}
