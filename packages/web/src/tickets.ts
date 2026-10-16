import { randomBytes, timingSafeEqual } from 'node:crypto'
import { networkInterfaces } from 'node:os'
import { routesOf } from '@tade/core'
import type { Surface } from './surface.ts'

// Pairing tickets: 160 random bits, one use, ninety seconds, in memory only.
//
// **What a ticket is, and what it is not.** It is not a credential and it
// authorises nothing. It says one thing: *whoever holds this saw the window's
// screen in the last ninety seconds.* The authorisation is the keypress at the
// machine, which is the factor no remote attacker can obtain at all.
//
// **The burn is the whole of this file.** A ticket is taken out of the store at
// the moment it is *claimed* — before the person at the machine is asked, not
// after they answer — so:
//
// - two requests racing with the same ticket: the first claims it, the second
//   finds nothing. There is no window in which both are waiting on a keypress,
//   which is what "concurrent pairing" would otherwise mean;
// - a refusal burns it, because the claim already did;
// - nobody answering burns it, for the same reason;
// - a handler that *throws* burns it, which is the case a `finally` would have
//   been written for and got wrong;
// - and a replay of a captured request finds nothing whatever happened to the
//   first one.
//
// One ticket, one attempt. Written down because the tempting shape — check it,
// ask, then delete it on success — is wrong in every one of those five ways.
//
// In memory and never on disk: a ticket outliving the window that printed it
// would be a ninety-second secret with no ninety seconds in it. **The one
// exception is a code the terminal wrote** (`pending.ts`, which has the
// argument), and what this store keeps of one is the synchronous half of its
// burn (`spend`).

/** How long a ticket is good for. Long enough to walk to the phone. */
export const TICKET_MS = 90_000

/** How many bits of it. 160, as twenty bytes, base64url. */
const TICKET_BYTES = 20

/** A ticket that was minted, as the window has it to draw. */
export interface Ticket {
  /** The value itself, which goes in the QR's fragment and nowhere else. */
  value: string
  /** When it was minted, and so when it expires. */
  at: number
  /** The URL the QR encodes, fragment and all. */
  url: string
}

/** Why a claim found nothing, in Tade's own words for the journal. */
export type NotClaimed = 'unknown' | 'expired' | 'used'

/** A ticket's value: 160 random bits, base64url, the one shape `couldBeTicket` admits. */
export function ticketValue(): string {
  return randomBytes(TICKET_BYTES).toString('base64url')
}

export type Claim = { ok: true; ticket: Ticket } | { ok: false; why: NotClaimed }

/**
 * The tickets outstanding, which is nearly always nought or one.
 *
 * A store rather than a single value, because the pairing panel can be opened
 * on two addresses — a LAN address and a tailnet name — and each needs its own
 * URL. Bounded hard (`MOST`), so nothing can make this a list.
 */
export class Tickets {
  private readonly held = new Map<string, Ticket>()
  /**
   * Values that *were* tickets, so a replay can be told from a guess.
   *
   * It costs nothing and it buys the journal a true sentence: `used` and
   * `unknown` are different things to read back, and a stream of `unknown`
   * from one address is somebody guessing while a `used` is somebody replaying
   * what they captured. Bounded by the same ceiling, and a value in here is
   * still refused — being able to name it is not being able to use it.
   */
  private readonly burnt: string[] = []
  /** The ids of written codes this process has claimed (`spend`). */
  private readonly spent: string[] = []

  private readonly ms: number
  private readonly most: number

  constructor(ms = TICKET_MS, most = 8) {
    this.ms = ms
    this.most = most
  }

  /**
   * A new ticket for one URL.
   *
   * The URL is built by the caller because only the caller knows which address
   * it is for; what this adds is the fragment, and it is a fragment rather than
   * a query parameter because **a fragment is never sent to a server**: not to
   * an access log, not into a `Referer`, not into an error report. The page
   * reads it, replaces the history entry and `POST`s it in a body.
   */
  mint(base: string, now: number): Ticket {
    this.forget(now)
    const value = ticketValue()
    const ticket: Ticket = { value, at: now, url: `${base}#t=${value}` }
    this.held.set(value, ticket)
    // Oldest first, so the ceiling drops a ticket that was about to expire
    // rather than the one somebody is walking to their phone with — and it is
    // **burned** on the way out rather than merely dropped, because a ticket
    // this program minted is one it can still name, and `used` and `unknown`
    // are two different things to read back.
    while (this.held.size > this.most) {
      const oldest = [...this.held.values()].sort((a, b) => a.at - b.at)[0]
      if (oldest === undefined) break
      this.held.delete(oldest.value)
      this.burn(oldest.value)
    }
    return ticket
  }

  /**
   * Claim a ticket, which burns it whatever happens next.
   *
   * Compared with `timingSafeEqual` against each outstanding ticket rather than
   * looked up in the map, so that how long this takes says nothing about which
   * prefix was right. The map is never more than a handful of entries, which is
   * what makes a scan affordable here where it would not be elsewhere.
   */
  claim(presented: string, now: number): Claim {
    // **No sweep first**, deliberately. Forgetting the expired ones before
    // looking would burn them, and then a ticket somebody presented ninety-one
    // seconds late would read back as `used` — a replay — when what actually
    // happened is that they were slow. The sweep belongs where a ticket is
    // minted or listed, and `expired` stays a reachable answer.
    const found = this.find(presented)
    if (found === null) {
      return { ok: false, why: this.wasBurnt(presented) ? 'used' : 'unknown' }
    }
    // Out of the store first, and before the deadline is even looked at: a
    // ticket that was presented is spent, expired or not.
    this.held.delete(found.value)
    this.burn(found.value)
    if (now - found.at > this.ms) return { ok: false, why: 'expired' }
    return { ok: true, ticket: found }
  }

  /** The tickets outstanding, newest first. What a panel draws. */
  outstanding(now: number): Ticket[] {
    this.forget(now)
    return [...this.held.values()].sort((a, b) => b.at - a.at)
  }

  /**
   * Burn a code the terminal wrote, by its id: `true` the first time, `false`
   * after.
   *
   * **Synchronous, and that is the whole of it** — the reason `claim` is. The
   * disk's own burn is a `claimed` line, and an append has an `await` in it:
   * two requests with one code that both read the file before either line
   * landed would otherwise both be told they were first. Kept for as long as
   * the burnt values are; past that the `claimed` line has long since landed.
   */
  spend(id: string): boolean {
    if (this.spent.includes(id)) return false
    this.spent.push(id)
    while (this.spent.length > this.most * 4) this.spent.shift()
    return true
  }

  /** Drop every outstanding ticket: the panel closed, or Tade is stopping. */
  clear(): void {
    for (const value of this.held.keys()) this.burn(value)
    this.held.clear()
  }

  private find(presented: string): Ticket | null {
    const offered = Buffer.from(presented)
    for (const ticket of this.held.values()) {
      const held = Buffer.from(ticket.value)
      if (held.length !== offered.length) continue
      if (timingSafeEqual(held, offered)) return ticket
    }
    return null
  }

  private burn(value: string): void {
    this.burnt.push(value)
    while (this.burnt.length > this.most * 4) this.burnt.shift()
  }

  private wasBurnt(presented: string): boolean {
    const offered = Buffer.from(presented)
    return this.burnt.some((one) => {
      const was = Buffer.from(one)
      return was.length === offered.length && timingSafeEqual(was, offered)
    })
  }

  private forget(now: number): void {
    for (const [value, ticket] of this.held) {
      if (now - ticket.at > this.ms) {
        this.held.delete(value)
        this.burn(value)
      }
    }
  }
}

/**
 * Where a phone should go, as a URL with no ticket on it yet.
 *
 * On a `lan` bind it is a reachable address — `routesOf`'s rule, so never a
 * link-local and never loopback, because a code for one of those scans
 * perfectly and goes nowhere. On a loopback bind it is `localhost`, which is
 * also what `tailscale serve` connects to.
 *
 * Here, beside the tickets, because two things put a ticket on it: the
 * window's pairing panel, and `tade web pair` writing a code (`pending.ts`).
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
 * What a ticket in a request body may look like at all, before anything is
 * compared.
 *
 * Length and alphabet, so a body carrying a megabyte of `A`s is refused before
 * it reaches a timing-safe comparison against every outstanding ticket. The
 * length is exact because every ticket this program mints is exactly that
 * long.
 */
export const TICKET_SHAPE = /^[A-Za-z0-9_-]{27}$/

/** Whether a presented value could be one of ours. */
export function couldBeTicket(value: unknown): value is string {
  return typeof value === 'string' && TICKET_SHAPE.test(value)
}
