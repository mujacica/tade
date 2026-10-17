import { networkInterfaces } from 'node:os'
import {
  ACTING_IS_NOT_YOU_SHORT,
  DEVICES_SEEN_BY_AGENTS,
  type Health,
  LAN_IS_PLAINTEXT_SHORT,
  PUBLIC_IS_THE_INTERNET_SHORT,
  routesOf,
  SETTINGS_FROM_AWAY_SHORT,
  TALKING_IS_NOT_YOU_SHORT,
} from '@tade/core'
import {
  blocksFor,
  codeFor,
  type Device,
  GRANTS,
  type PairingAsk,
  pairingUrl,
  reachOf,
  readsOf,
  SCOPES,
  type Surface,
  type Tickets,
} from '@tade/web'
import { AWAY_CONTROLS, AWAY_LABELS } from '../panels/away/state.ts'
import type { AwayDevice, AwayView } from '../panels/away/view.ts'
import type { Panel } from '../panels.ts'
import { BOXES, ticked } from './web-boxes.ts'
import { RUNS, SEES } from './web-grants.ts'

// What the pairing panel draws, and where a phone should go to reach this
// machine.
//
// **Pure, and that is the whole reason it is a file.** `Away` holds a server, a
// ticket store, a set of streams and a device list; the panel is a *fact about
// all of them at one moment*, and a function of what it is handed can be read
// against the four goldens (`test/screens/scenarios/away.ts`) without a
// listener, a socket or a clock.
//
// Nothing here remembers anything: the view is rebuilt every frame, which is
// the rule the whole window follows and matters most here — a ticket's
// remaining seconds, an address that stopped being reachable and a device that
// just connected are each stale the moment they are stored.

/** Everything the panel is a fact about, at one moment. */
export interface PanelFacts {
  surface: Surface
  /** What is actually bound, which a config cannot say. */
  bound: readonly string[]
  /** Whether anything is listening at all. */
  listening: boolean
  /** The socket Caddy connects to while the public listener is up, and why not where it is not. */
  publicAt: string | null
  publicTrouble: string | null
  /** The public listener's certificate and version (`web-public.ts`). */
  health: readonly Health[]
  /** The ticket outstanding, if one is, and when it was minted. */
  ticket: { url: string; at: number } | null
  /** The device at the door, and when it started asking. */
  asking: { ask: PairingAsk; at: number } | null
  devices: readonly Device[]
  /** Which devices have a stream open right now. */
  live: ReadonlySet<string>
  streams: number
  problem: string | null
  now: number
}

/** What this machine is called in a sentence: the one a person is sitting at. */
export const MACHINE = process.platform === 'darwin' ? 'this Mac' : 'this machine'

/** How long a ticket is good for, and how long somebody has to answer the door. */
const TICKET_MS = 90_000
const ASKING_MS = 60_000

/** What the panel draws. Facts every frame, never remembered. */
export function awayView(facts: PanelFacts): AwayView {
  const code = facts.ticket === null ? null : codeFor(facts.ticket.url)
  return {
    // What is *listening*, never what the config says: a bind that failed is
    // a config that says yes and a machine that says no.
    listening: facts.listening,
    bind: facts.surface.bind,
    bound: facts.bound,
    reachable: facts.surface.bind === 'lan' ? routesOf(networkInterfaces()) : ['localhost'],
    machine: MACHINE,
    ticket:
      facts.ticket === null
        ? null
        : {
            url: facts.ticket.url,
            secondsLeft: left(facts.ticket.at + TICKET_MS, facts.now),
          },
    code: code === null ? [] : blocksFor(code),
    asking:
      facts.asking === null
        ? null
        : {
            label: facts.asking.ask.label,
            from: whereFrom(facts.asking.ask.from, facts.asking.ask.host, MACHINE),
            // The address itself only where it is somebody else's: a stranger's
            // is the thing to check, and this machine's is noise.
            address: local(facts.asking.ask.from) ? '' : bare(facts.asking.ask.from),
            secondsLeft: left(facts.asking.at + ASKING_MS, facts.now),
            seconds: ASKING_MS / 1000,
          },
    devices: deviceViews(facts),
    streams: facts.streams,
    acting: facts.surface.acting,
    talking: facts.surface.talking,
    configuring: facts.surface.configuring,
    help: grantsHelp(facts.surface),
    lan: LAN_IS_PLAINTEXT_SHORT,
    internet: PUBLIC_IS_THE_INTERNET_SHORT,
    agents: DEVICES_SEEN_BY_AGENTS,
    problem: facts.problem,
    public: publicOf(facts),
  }
}

/**
 * The public listener as the panel says it: up, with what its health look
 * found, or set and not up, with why — never silent about a name the person
 * set and nothing answering on it.
 */
function publicOf(facts: PanelFacts): AwayView['public'] {
  const name = facts.surface.publicName
  if (name === null || !facts.listening) return null
  if (facts.publicAt === null) {
    return {
      name,
      up: false,
      lines: [{ said: facts.publicTrouble ?? 'nothing listens for Caddy', loud: true }],
    }
  }
  return { name, up: true, lines: facts.health }
}

/**
 * What each of a device's controls grants, in one clause, for the foot to say
 * while the pointer is on it — the moment somebody is deciding whether to
 * press it.
 *
 * **The domain's own clauses where it has one** (`_SHORT`, said once so no
 * control can say the comfortable half), and the strip's own words where it
 * does not: what a press says it did is what pointing at it says it does. The
 * whole sentences are each setting's `means` — search, `tade config` and
 * `tade_settings` read them — and the README's.
 */
export function grantsHelp(
  surface: Pick<Surface, 'acting' | 'talking' | 'configuring'>,
): Readonly<Record<string, string>> {
  return {
    // Only the controls that are drawn, so the foot keeps the rows of the
    // longest clause somebody could actually point at and no more.
    ...(surface.acting
      ? {
          [AWAY_CONTROLS.act]: said(AWAY_CONTROLS.act, ACTING_IS_NOT_YOU_SHORT),
          [AWAY_CONTROLS.agents]: said(AWAY_CONTROLS.agents, RUNS.agents),
          [AWAY_CONTROLS.projects]: said(AWAY_CONTROLS.projects, RUNS.projects),
        }
      : {}),
    ...(surface.talking
      ? { [AWAY_CONTROLS.talk]: said(AWAY_CONTROLS.talk, TALKING_IS_NOT_YOU_SHORT) }
      : {}),
    ...(surface.configuring
      ? { [AWAY_CONTROLS.configure]: said(AWAY_CONTROLS.configure, SETTINGS_FROM_AWAY_SHORT) }
      : {}),
    [AWAY_CONTROLS.see]: said(
      AWAY_CONTROLS.see,
      `${SEES.lanes}; only paths and keys are taken out`,
    ),
    [AWAY_CONTROLS.settings]: said(
      AWAY_CONTROLS.settings,
      `${SEES.settings}; a key is said as set or not set`,
    ),
    [AWAY_CONTROLS.revoke]: said(AWAY_CONTROLS.revoke, 'disconnect this device now'),
  }
}

/** A control's clause, after the word it is drawn with. */
function said(control: keyof typeof AWAY_LABELS, clause: string): string {
  return `${AWAY_LABELS[control]}: ${clause}`
}

/**
 * Where the code is drawn now: the panel, the Away page of Settings, or
 * nowhere. Settings draws it only on that page and not in a search, where the
 * rows are every page's and a code among them would be nobody's.
 */
export function codeShownOn(panel: Panel | null): 'panel' | 'settings' | null {
  if (panel?.kind === 'away') return 'panel'
  const page = panel?.kind === 'settings' && panel.category === 'away' && panel.search === ''
  return page ? 'settings' : null
}

/**
 * Where a device came from, in words a person can check against what they are
 * holding: this machine, `your network`, `Tailscale`, or `outside your
 * network` — never only an address, which was `::1 · reached localhost:7654`
 * and meant *this Mac* to nobody.
 *
 * **A loopback address that reached a name other than this machine's came
 * through a proxy** — `tailscale serve` connects from `127.0.0.1` — so it is
 * said as the name it came through rather than as this machine, which would be
 * exactly the wrong reassurance.
 */
export function whereFrom(address: string, host: string, machine: string): string {
  const at = bare(address)
  if (local(at)) {
    const name = hostname(host)
    return name === '' || local(name) || name === 'localhost' ? machine : `through ${name}`
  }
  if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(at) || /^fd7a:115c:a1e0:/i.test(at)) {
    return 'Tailscale'
  }
  const near =
    /^(10\.|192\.168\.|169\.254\.)/.test(at) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(at) ||
    /^f[cde][0-9a-f]{2}:/i.test(at)
  return near ? 'your network' : 'outside your network'
}

/** An address as the socket gives it, without the IPv4-in-IPv6 prefix. */
function bare(address: string): string {
  return address.replace(/^::ffff:/i, '')
}

/** Whether an address or a name is this machine's own loopback. */
function local(address: string): boolean {
  const at = bare(address)
  return at === '::1' || at.startsWith('127.') || at === 'localhost'
}

/** The name out of a `Host`: no port, no brackets. */
function hostname(host: string): string {
  const bracketed = host.match(/^\[([^\]]*)\]/)
  if (bracketed) return bracketed[1] ?? ''
  const colon = host.lastIndexOf(':')
  return colon === -1 || host.indexOf(':') !== colon ? host : host.slice(0, colon)
}

/** Seconds left until a deadline, and never a negative number. */
function left(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000))
}

/**
 * The devices, as the list draws them.
 *
 * **A word per capability**, each folded from the scopes rather than read off
 * a flag: the row has width for a word and not a list, and what somebody
 * scanning it is asking is *can any of these change my work*, *stop an agent*,
 * *close a project*, and *ask Tade for anything*. Those are different
 * questions with different answers, which is why they are separate.
 */
function deviceViews(facts: PanelFacts): AwayDevice[] {
  return facts.devices
    .filter((one) => one.revoked === null)
    .map((one) => ({
      id: one.id,
      label: one.label,
      // An owner came in over SSH by definition (`@tade/web`'s `owner.ts`);
      // the address it was minted from is a shell's, not a place to name.
      from: one.owner ? 'over SSH' : whereFrom(one.from, one.host, MACHINE),
      owner: one.owner,
      ...(one.passkey === null ? {} : { passkey: one.passkey.proved }),
      ...(readsOnly(one, facts.surface) ? { readsOnly: true as const } : {}),
      pairedAt: one.pairedAt,
      reads: readsOf(reachOf(one)),
      // Each box ticked by the table that says what pressing it writes (`BOXES`).
      mayAct: ticked(one, BOXES.act),
      mayTalk: ticked(one, BOXES.talk),
      maySee: ticked(one, BOXES.see),
      mayStop: ticked(one, BOXES.agents),
      mayClose: ticked(one, BOXES.projects),
      mayReadSettings: ticked(one, BOXES.settings),
      mayConfigure: ticked(one, BOXES.configure),
      full:
        GRANTS.every((grant) => one.granted.includes(grant)) &&
        SCOPES.every((scope) => one.scopes.includes(scope)),
      live: facts.live.has(one.id),
    }))
}

/**
 * A device that may act and cannot, from where it paired: bound to the public
 * name, which asks for a passkey before anything above `read` (`proven`), and
 * with none — it missed the minutes after pairing in which one is made. The
 * host it is bound to is the listener it paired on: the public listener refuses
 * this machine's own names, and the loopback one is never asked.
 */
function readsOnly(one: Device, surface: Surface): boolean {
  if (one.passkey !== null || surface.passkeyMs <= 0 || surface.publicName === null) return false
  const host = one.host.toLowerCase().replace(/:443$/, '')
  return host === surface.publicName && one.scopes.some((scope) => scope !== 'read')
}

/**
 * A fresh code to scan, for the address a phone would reach this on.
 *
 * Beside `pairingUrl` because it is nothing but that URL with a ticket on it,
 * and the one rule worth having in one place: **the outstanding one is
 * cleared first**, so there is never a second live code for a phone that was
 * shown the first — a code somebody photographed and walked away from is a
 * credential, and only the one on the screen should be claimable.
 *
 * Nothing where the address cannot be worked out: a code that scans perfectly
 * and goes nowhere is worse than none, and the panel says why instead.
 */
export function mintPairing(tickets: Tickets, surface: Surface, now: number): void {
  const base = pairingUrl(surface)
  if (base === null) return
  tickets.clear()
  tickets.mint(base, now)
}

/**
 * A code wherever one is drawn and none is outstanding: the page opened, or the
 * one it showed ran out or was claimed. Asked on every frame that draws the
 * code, so nobody presses `New code` to see the first one. In memory only, as
 * every ticket is — never journaled, never on a frame the orchestrator reads.
 */
export function keepCode(
  tickets: Tickets,
  surface: Surface,
  listening: boolean,
  now: number,
): void {
  if (listening && tickets.outstanding(now).length === 0) mintPairing(tickets, surface, now)
}
