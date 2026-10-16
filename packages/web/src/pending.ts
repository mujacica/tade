import { randomBytes } from 'node:crypto'
import { appendDevice, type PendingCode, readDevices } from './devices.ts'
import type { Grant } from './reach.ts'
import { digestMatches, digestOf } from './sessions.ts'
import type { Scope } from './surface.ts'
import { type NotClaimed, type Tickets, ticketValue } from './tickets.ts'

// A pairing code the terminal wrote down: `tade web pair`, the one ticket that
// is ever on a disk.
//
// **What changed, and why it is acceptable** (REMOTE-TADE.md §11 item 3). The
// rule was that a ticket lives in the memory of the process whose server has to
// claim it, and so `tade web pair` could not mint one: there was no channel
// from a shell into the window, and the window's ticket is worth something only
// because the person at its screen is asked before a device is let in. A box
// with no screen — a VPS — has nobody to ask that way. But **approval at the
// machine was the point, and a shell on the machine is at the machine**: over
// SSH it is the SSH key, which can already do anything here. So the person who
// runs `tade web pair` is the person letting a device in, the command is the
// keypress, and what it lets the device have is written down at that moment.
//
// What keeps it the same size of thing as the window's ticket:
//
// - **The digest is written, never the secret.** `sha256` of 160 random bits,
//   as a session's is: the secret is in the link the command printed and
//   nowhere else, so the file holds nothing anybody could present.
// - **It is on the disk for `PENDING_MS`, readable by everything running as
//   you** — an agent on this machine included. That agent can already append a
//   `paired` line and let itself in (`DEVICES_AND_AGENTS`), so a digest it can
//   read and cannot present widens nothing. Where agents run as another user
//   (§8.4), it cannot read the file at all.
// - **One use, burned on the claim twice**: in memory first and synchronously
//   (`Tickets.spend`), so two requests racing with one code never both mint;
//   then on the disk, a `claimed` line written *before* the device is, so a
//   restart between the two can never make it claimable again — the ordering
//   `tickets.ts` argues, kept across a restart. Expired, presented on another
//   host, or claimed: each is burned all the same.
// - **Bound to the host its link names**, so a code printed for the public name
//   is claimed there, and the session it becomes is bound to that host as every
//   session is.
// - **Nobody is asked again.** The window's ticket asks the person at the
//   screen because the screen is all it proves; this one was minted by the
//   asking. The window still says it in the strip when one is claimed, and the
//   device is in the list with every other.
// - **Ended like a device**: `tade web revoke <id>` and "Disconnect
//   everything" both write a `revoked` line for one nobody claimed yet.

/**
 * How long a written code is good for: a few minutes, not ninety seconds.
 *
 * Longer than the window's, because the link is read off a terminal that may be
 * on another machine — a Mac showing a VPS's code — and the phone may first
 * have to put the page on its home screen, where an installed page keeps its
 * own cookies and has to pair itself. Short, because for those minutes the link
 * alone is a way in.
 */
export const PENDING_MS = 5 * 60_000

/** What the person at the terminal let a written code's device have. */
export interface Letting {
  /** The exact `Host` the link names, which is the only one it may be claimed on. */
  host: string
  /** What to call it. Empty is the phone's own word, as a code from the window has. */
  label: string
  scopes: readonly Scope[]
  projects: readonly string[] | null
  granted: readonly Grant[]
}

/** A code written down, as the terminal prints it. The secret is never written. */
export interface Written {
  /** The id the device will have once it is claimed, and the one that revokes it before. */
  device: string
  /** The one-time secret: the link's fragment, and the only place it is. */
  secret: string
  until: number
}

/**
 * Write a pairing code into the device list. `tade web pair`, and a test.
 *
 * **Every code nobody claimed is revoked first**, the window's own rule for
 * its panel (`mintPairing`): a code somebody photographed and walked away from
 * is a credential, and only the one just printed should be claimable.
 */
export async function writeCode(home: string, letting: Letting, now: number): Promise<Written> {
  for (const code of (await readDevices(home)).pending) {
    await appendDevice(home, {
      kind: 'revoked',
      device: code.id,
      at: new Date(now).toISOString(),
      why: 'revoked at the machine',
    })
  }
  const device = randomBytes(8).toString('hex')
  const secret = ticketValue()
  const until = now + PENDING_MS
  await appendDevice(home, {
    kind: 'pending',
    device,
    at: new Date(now).toISOString(),
    until: new Date(until).toISOString(),
    digest: digestOf(secret),
    host: letting.host,
    label: letting.label,
    scopes: [...letting.scopes],
    projects: letting.projects === null ? null : [...letting.projects],
    granted: [...letting.granted],
  })
  return { device, secret, until }
}

/** Why a written code was not claimed: a ticket's reasons, and one of its own. */
export type NotWritten = NotClaimed | 'elsewhere'

/**
 * What presenting a value came to against the written codes.
 *
 * `burn` is the code to write a `claimed` line for, whatever the answer: a code
 * that was presented is spent, refused or not. It is absent only where nothing
 * was found, or where this process had already spent it.
 */
export type WrittenClaim =
  | { ok: true; code: PendingCode }
  | { ok: false; why: NotWritten; burn: PendingCode | null }

/**
 * Claim one of the codes the terminal wrote, which burns it in memory before
 * this returns.
 *
 * Synchronous from the look to the burn, which is what makes the race safe:
 * the caller read the file, and two requests that both read it before either
 * `claimed` line landed meet here one after the other. The digests are compared
 * in constant time, one per outstanding code, which is nearly always one.
 */
export function claimWritten(
  presented: string,
  pending: readonly PendingCode[],
  tickets: Pick<Tickets, 'spend'>,
  host: string,
  now: number,
): WrittenClaim {
  const found = pending.find((code) => digestMatches(presented, code.digest))
  if (found === undefined) return { ok: false, why: 'unknown', burn: null }
  if (!tickets.spend(found.id)) return { ok: false, why: 'used', burn: null }
  if (!Number.isFinite(found.until) || now >= found.until) {
    return { ok: false, why: 'expired', burn: found }
  }
  // The whole value a browser sent against the whole value the link named,
  // case aside — `sessions.ts`' rule, for the session this would become.
  if (found.host.toLowerCase() !== host.trim().toLowerCase()) {
    return { ok: false, why: 'elsewhere', burn: found }
  }
  return { ok: true, code: found }
}
