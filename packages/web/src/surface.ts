import {
  AWAY_IS_WHILE_OPEN,
  COOKIES_IGNORE_PORTS,
  DEVICES_AND_AGENTS,
  DEVICES_SEEN_BY_AGENTS,
  HTTPONLY_IS_NOT_XSS,
  LAN_IS_PLAINTEXT,
} from '@tade/core'
import { GRANTS, type Grant, type Reach } from './reach.ts'

// The five sentences are **declared in `@tade/core`'s `away.ts`** and
// re-exported here, so this package still has exactly one spelling of each and
// everything that said `from './surface.ts'` still does.
//
// They moved because three of them belong on a *control* — the one that turns
// a LAN bind on, and the one that lists the devices that have been let in —
// and a control's words are a `Setting`'s `means`, which lives in the domain.
// `@tade/core` cannot import this package: the arrow goes the other way and
// `test/modularity.test.ts` holds it. So the choice was a second spelling of
// each sentence beside each control, or one spelling in the domain. A second
// spelling is the exact failure these sentences exist to prevent.
export {
  AWAY_IS_WHILE_OPEN,
  COOKIES_IGNORE_PORTS,
  DEVICES_AND_AGENTS,
  DEVICES_SEEN_BY_AGENTS,
  HTTPONLY_IS_NOT_XSS,
  LAN_IS_PLAINTEXT,
}

// What the away view is turned on as, and the four sentences about it that are
// true however it is turned on.
//
// `surfaces.web` is read here and nowhere else, so the server, the pairing
// panel and whatever draws a control all get the same answer about what is on.
// Pure: the config block in, the shape of the listener out. Nothing here binds
// anything.
//
// **The sentences are the load-bearing part of this file**, and they are
// re-exported from `@tade/core` rather than written here (see below). Three of
// them are corrections to claims that are easy to make and wrong — a LAN being
// private, a cookie prefix isolating ports, a machine's own agents being held
// out by a file mode — and each is said once so that no control, README line
// or commit message can quietly say the comfortable version instead.

/** How Tade listens: this machine alone, or every interface. */
export type Bind = 'loopback' | 'lan'

/** The away view as it is turned on. */
export interface Surface {
  enabled: boolean
  bind: Bind
  port: number
  /** Hosts beyond this machine's own that may reach it, from the config. */
  trustedHosts: readonly string[]
}

/** The `surfaces.web` block, as the one reader of it sees it. */
export interface WebConfig {
  enabled: boolean
  bind: Bind
  port: number
  trusted_hosts: readonly string[]
}

/** Off, on this machine, on the port nothing else wanted. */
export const OFF: Surface = { enabled: false, bind: 'loopback', port: 7654, trustedHosts: [] }

/**
 * The surface a config says, and it only ever *narrows* what is turned on.
 *
 * A `lan` bind with `enabled: false` is off, not "on the network and waiting":
 * two decisions, and the one that decides whether anything listens is read
 * first. Nothing here can turn anything on that the file did not.
 */
export function surfaceOf(web: WebConfig): Surface {
  return {
    enabled: web.enabled,
    bind: web.enabled ? web.bind : 'loopback',
    port: web.port,
    trustedHosts: web.enabled ? [...web.trusted_hosts] : [],
  }
}

/**
 * The addresses to listen on, which is two of them for `lan` and not one.
 *
 * `::` with `ipv6Only: false` accepts IPv4-mapped connections on many systems
 * and not all, so which addresses are served would be a property of the
 * machine rather than of the setting. Two listeners sharing one handler is
 * explicit, and explicit is the whole point of a setting that decides who can
 * reach you.
 */
export function listenOn(surface: Surface): readonly string[] {
  if (!surface.enabled) return []
  return surface.bind === 'lan' ? ['0.0.0.0', '::'] : ['127.0.0.1', '::1']
}

/**
 * Whether an origin is one a device may ever *act* from, as against read.
 *
 * `https` anywhere, or this machine itself. That is the W3C secure-contexts
 * line and it is used here for a different purpose: not what the browser will
 * let the page do, but whether the credential travelling on the request was
 * readable by anybody between the phone and here. Plain HTTP across a network
 * is readable, so a session on one may read and may never act.
 *
 * **Re-asked at the act, never only at pairing**, because the network a device
 * is on changes and a phone that paired on the sofa is on cellular an hour
 * later. The host must also be one the config trusts: an `https` origin Tade
 * was never told about is somebody else's name resolving here.
 */
export function trusted(origin: { scheme: string; host: string }, surface: Surface = OFF): boolean {
  if (loopbackHost(origin.host)) return true
  if (origin.scheme !== 'https') return false
  return surface.trustedHosts.some((one) => sameHost(one, origin.host))
}

/**
 * The most a session minted on this origin may ever have.
 *
 * Off a trusted origin it is `read` and there is no later act — not a flag
 * that could be raised, not a scope a grant could widen. `away-action-gate`
 * adds the verbs; this is the ceiling they land under, and it is written now
 * so that the verb arrives beneath a rule rather than beside one.
 */
export function scopesOn(
  origin: { scheme: string; host: string },
  surface: Surface,
  granted: readonly Scope[],
): Scope[] {
  if (trusted(origin, surface)) return SCOPES.filter((one) => granted.includes(one))
  return granted.includes('read') ? ['read'] : []
}

/**
 * What a device may do, in widening order.
 *
 * Phase 1 mints `read` and there is nothing else to mint; the rest are here
 * because a route's required scope is declared in the route table
 * (`routes.ts`) and a table whose only word is `read` cannot say that a verb
 * needs more than one. `test/routes.test.ts` asserts no Phase 1 route needs
 * more than `read`, which is the half of the guarantee a type cannot give.
 */
export const SCOPES = ['read', 'answer', 'steer', 'ask'] as const
export type Scope = (typeof SCOPES)[number]

/** Whether a host is this machine, in any of its three spellings. */
export function loopbackHost(host: string): boolean {
  const bare = host.toLowerCase().replace(/^\[|]$/g, '')
  if (bare === 'localhost' || bare.endsWith('.localhost')) return true
  if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') return true
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare)
}

/** Two host names being the same one, case and IPv6 brackets aside. */
export function sameHost(a: string, b: string): boolean {
  return a.toLowerCase().replace(/^\[|]$/g, '') === b.toLowerCase().replace(/^\[|]$/g, '')
}

/**
 * What a device was granted, as a reading reach.
 *
 * The seam between a device record and the projection: `reach.ts` is the
 * vocabulary and says it reads no config, and this is where what the person
 * granted at the machine becomes the two questions the projection asks.
 *
 * A word the grant list does not recognise is **dropped**, not carried and not
 * refused. The record is a line in an append-only file that an agent on this
 * machine can write (`DEVICES_AND_AGENTS`), so a grant nobody here understands
 * is exactly the shape of a line somebody invented — and the projection asks
 * `has(reach, grant)` with a known word, so an unknown one that rode along
 * would be silently equivalent to nothing anyway. Dropping it makes that true
 * by construction instead of by luck.
 */
export function reachOf(device: {
  id: string
  projects: readonly string[] | null
  granted: readonly string[]
}): Reach {
  return {
    device: device.id,
    projects:
      device.projects === null
        ? { kind: 'every' }
        : { kind: 'listed', names: [...device.projects] },
    granted: GRANTS.filter((grant) => device.granted.includes(grant)) as Grant[],
  }
}
