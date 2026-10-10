import { networkInterfaces } from 'node:os'
import {
  ACTING_IS_NOT_YOU,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT,
  routesOf,
  TALKING_IS_NOT_YOU,
} from '@tade/core'
import {
  blocksFor,
  codeFor,
  type Device,
  type PairingAsk,
  reachOf,
  readsOf,
  type Surface,
  type Tickets,
} from '@tade/web'
import type { AwayDevice, AwayView } from '../panels/away/view.ts'

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
            from: facts.asking.ask.from,
            host: facts.asking.ask.host,
            secondsLeft: left(facts.asking.at + ASKING_MS, facts.now),
          },
    devices: deviceViews(facts),
    streams: facts.streams,
    acting: facts.surface.acting,
    talking: facts.surface.talking,
    acts: ACTING_IS_NOT_YOU,
    talks: TALKING_IS_NOT_YOU,
    lan: LAN_IS_PLAINTEXT,
    agents: `${DEVICES_SEEN_BY_AGENTS[0]?.toUpperCase() ?? ''}${DEVICES_SEEN_BY_AGENTS.slice(1)}, which is why this list shows every device there is.`,
    problem: facts.problem,
  }
}

/** Seconds left until a deadline, and never a negative number. */
function left(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000))
}

/**
 * The devices, as the list draws them.
 *
 * **Two capabilities and two words**, each folded from the scopes rather than
 * read off a flag: the row has width for a word and not a list, and what
 * somebody scanning it is asking is *can any of these change my work* and *can
 * any of these ask Tade for anything*. Those are different questions with
 * different answers, which is why they are two.
 */
function deviceViews(facts: PanelFacts): AwayDevice[] {
  return facts.devices
    .filter((one) => one.revoked === null)
    .map((one) => ({
      id: one.id,
      label: one.label,
      pairedAt: one.pairedAt,
      reads: readsOf(reachOf(one)),
      mayAct: one.scopes.some((scope) => scope === 'answer' || scope === 'steer'),
      mayTalk: one.scopes.includes('ask'),
      live: facts.live.has(one.id),
    }))
}

/**
 * Where a phone should go, as a URL with no ticket on it yet.
 *
 * On a `lan` bind it is a reachable address — `routesOf`'s rule, so never a
 * link-local and never loopback, because a code for one of those scans
 * perfectly and goes nowhere. On a loopback bind it is `localhost`, which is
 * also what `tailscale serve` connects to.
 */
export function pairingUrl(surface: Surface): string | null {
  // A trusted host first, when somebody named one: that is the `https` origin
  // a proxy terminates for, and it is the only one worth printing when it
  // exists, because it is the one that keeps working off this wifi.
  const trusted = surface.trustedHosts[0]
  if (trusted !== undefined) return `https://${trusted}/pair`
  if (surface.bind === 'loopback') return `http://localhost:${surface.port}/pair`
  const address = routesOf(networkInterfaces())[0]
  if (address === undefined) return null
  const host = address.includes(':') ? `[${address}]` : address
  return `http://${host}:${surface.port}/pair`
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
