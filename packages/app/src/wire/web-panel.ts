import { networkInterfaces } from 'node:os'
import {
  ACTING_IS_NOT_YOU_SHORT,
  DEVICES_SEEN_BY_AGENTS,
  LAN_IS_PLAINTEXT_SHORT,
  routesOf,
  SETTINGS_FROM_AWAY_SHORT,
  TALKING_IS_NOT_YOU_SHORT,
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
import { AWAY_CONTROLS } from '../panels/away/state.ts'
import type { AwayDevice, AwayView } from '../panels/away/view.ts'
import type { Panel } from '../panels.ts'
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
    configuring: facts.surface.configuring,
    help: grantsHelp(facts.surface),
    lan: LAN_IS_PLAINTEXT_SHORT,
    agents: DEVICES_SEEN_BY_AGENTS,
    problem: facts.problem,
  }
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
          [AWAY_CONTROLS.act]: `act: ${ACTING_IS_NOT_YOU_SHORT}`,
          [AWAY_CONTROLS.agents]: `agents: ${RUNS.agents}`,
          [AWAY_CONTROLS.projects]: `projects: ${RUNS.projects}`,
        }
      : {}),
    ...(surface.talking ? { [AWAY_CONTROLS.talk]: `talk: ${TALKING_IS_NOT_YOU_SHORT}` } : {}),
    ...(surface.configuring
      ? { [AWAY_CONTROLS.configure]: `configure: ${SETTINGS_FROM_AWAY_SHORT}` }
      : {}),
    [AWAY_CONTROLS.see]: `lanes: ${SEES.lanes}; only paths and keys are taken out`,
    [AWAY_CONTROLS.settings]: `settings: ${SEES.settings}; a key is said as set or not set`,
    [AWAY_CONTROLS.revoke]: '×: disconnect this device now',
  }
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
      pairedAt: one.pairedAt,
      reads: readsOf(reachOf(one)),
      mayAct: one.scopes.some((scope) => scope === 'answer' || scope === 'steer'),
      mayTalk: one.scopes.includes('ask'),
      maySee: one.granted.includes('lanes'),
      mayStop: one.scopes.includes('agents'),
      mayClose: one.scopes.includes('projects'),
      mayReadSettings: one.granted.includes('settings'),
      mayConfigure: one.scopes.includes('configure'),
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
