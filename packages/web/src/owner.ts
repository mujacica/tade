import { appendDevice } from './devices.ts'
import { GRANTS } from './reach.ts'
import { mint, SESSION_MS } from './sessions.ts'
import { SCOPES } from './surface.ts'

// An owner device: a session `tade web pair --owner` mints over SSH, bound to
// this machine, whose turns reach what the keyboard reaches.
//
// **What changed, and why it is acceptable** (REMOTE-TADE.md §11 item 4). A
// turn from a paired device is narrowed (`@tade/orchestrator`'s `origin.ts`):
// it may not start an agent, plan, schedule or create a task, because a
// phone's session is a weaker credential than being at the keyboard. The Mac
// driving a VPS needs to *start* work there, and everything it would do
// through an owner session, `ssh vps` already lets it do — attaching to that
// box's window in tmux and typing included. The SSH key is the owner; a
// request that arrives through that connection can never be more than it.
//
// **Why it can only ever be used on this machine**, which is the whole of the
// argument and five facts, each held where it lives:
//
// 1. **Only this file writes `owner`, and only the CLI calls it.** No route
//    mints one: pairing from the window or from a written code never sets it
//    (`paired.ts`, and `test/owner.test.ts` claims both).
// 2. **It is bound to `localhost`**, and the device list makes an owner only of
//    a line bound to this machine's own name (`ownerOf`): one written by hand
//    for a public name is an ordinary device.
// 3. **A session is bound to its host, exactly** (`sessions.ts`).
// 4. **A public listener refuses this machine's names at the door**
//    (`hostAllowed`), so `Host: localhost` is answerable only on the loopback
//    listener — from outside the box, through SSH (a forward, or `ssh -W`).
// 5. **The local reach is given only where the door says the message came in
//    on this machine** (`thisMachine`) **and** the record says owner now
//    (`web-asking.ts`'s `armOf`). Either alone is a device's ordinary turn.
//
// What it does **not** change: its words are never a `said` line, so an
// `asked`-tier setting still needs the person's own; every act is recorded as
// `device <id>`; and `tade web revoke <id>` ends it with no window and no
// network. `OWNER_IS_YOUR_SSH_KEY` (`@tade/core`) says the rest where one is
// minted: anything that can use your SSH key can use it, an agent on the
// machine that keeps it included — one hop past `DEVICES_AND_AGENTS`.

/** The host every owner is minted for, on the loopback listener's port. */
export function ownerHost(port: number): string {
  return `localhost:${port}`
}

/** What the terminal prints, once: the credential and what to send it with. */
export interface Owner {
  device: string
  /** `<device>.<secret>`, for the `tade_away` cookie. Never written down. */
  cookie: string
  /** The token a request that changes something carries in `x-tade-csrf`. */
  csrf: string
  /** The `Host` every request must name, exactly. */
  host: string
  until: number
}

/**
 * Mint an owner device. **`tade web pair --owner`, and nothing else.**
 *
 * Everything granted, every project, because the reach it stands for is the
 * keyboard's; the boxes in the window can still take any of it back, and the
 * settings that turn a capability on are still the person's. `from` is where
 * the SSH connection came from, or empty for a shell here.
 */
export async function mintOwner(
  home: string,
  what: { port: number; label: string; from: string },
  now: number,
): Promise<Owner> {
  const minted = mint()
  const host = ownerHost(what.port)
  const until = now + SESSION_MS
  await appendDevice(home, {
    kind: 'paired',
    device: minted.device,
    at: new Date(now).toISOString(),
    label: what.label,
    digest: minted.digest,
    host,
    csrf: minted.csrf,
    until: new Date(until).toISOString(),
    scopes: [...SCOPES],
    projects: null,
    granted: [...GRANTS],
    from: what.from,
    owner: true,
  })
  return { device: minted.device, cookie: minted.cookie, csrf: minted.csrf, host, until }
}
