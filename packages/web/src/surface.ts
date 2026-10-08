import { GRANTS, type Grant, type Reach } from './reach.ts'

// What the away view is turned on as, and the four sentences about it that are
// true however it is turned on.
//
// `surfaces.web` is read here and nowhere else, so the server, the pairing
// panel and whatever draws a control all get the same answer about what is on.
// Pure: the config block in, the shape of the listener out. Nothing here binds
// anything.
//
// **The sentences are the load-bearing part of this file.** Three of the four
// are corrections to claims that are easy to make and wrong — a LAN being
// private, a cookie prefix isolating ports, a machine's own agents being held
// out by a file mode — and each is said once, here, so that no control, README
// line or commit message can quietly say the comfortable version instead.

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
 * What is true of a `lan` bind, said on the control that turns one on.
 *
 * It does not say "use HTTPS for security"; it says what anybody on the wifi
 * can read, because the person deciding has to be able to picture it. And the
 * way out is in the same breath, which is the house rule about a warning: a
 * sentence with nothing to do about it is one people learn to scroll past.
 */
export const LAN_IS_PLAINTEXT =
  'On your network this is plain HTTP: anybody on the same wifi can read every page it serves ' +
  'and the session cookie with it. `tailscale serve localhost:7654` gives a phone HTTPS while ' +
  'Tade keeps listening on this machine alone, which is a smaller surface than this one.'

/**
 * Why a cookie prefix is not the answer to a port, said where somebody would
 * otherwise believe it is.
 *
 * `__Host-` requires `Secure`, `Path=/` and no `Domain`, and gives real
 * guarantees about all three. It gives **nothing** about ports: RFC 6265 §8.5
 * is unchanged by it. So the honest mitigations are named instead, and this
 * sentence exists because "the prefix fixes it" is what a reader of the
 * attribute list would conclude.
 */
export const COOKIES_IGNORE_PORTS =
  'Cookies are not isolated by port, and no cookie prefix changes that: anything else listening ' +
  'on this address can be sent this session cookie, and can overwrite it. What stands against ' +
  'that is the session being bound to the exact host it was paired for, and TLS, which removes ' +
  'the plaintext the other thing would be reading.'

/**
 * What `HttpOnly` does and what it does not, said once because the short
 * version of it is wrong.
 *
 * It stops a script *reading* the cookie. It does not stop injected script
 * calling `fetch` from the page's own origin with the page's own token — so it
 * is not a defence against cross-site scripting, only against the theft of a
 * credential. What is a defence is the page never building markup: no
 * `innerHTML`, no Markdown, a content policy with nothing inline.
 */
export const HTTPONLY_IS_NOT_XSS =
  'HttpOnly keeps a script from reading this session cookie. It does not keep one from using it: ' +
  'script that got onto the page can call Tade with the page’s own credentials. What stands ' +
  'against that is that the page builds no markup at all.'

/**
 * What is true of every paired device, said wherever one is granted or listed.
 *
 * The same treatment `KEYS_AND_AGENTS` gets in `@tade/core`, for the same
 * reason and said the same way round: the fact, then the way out, in one
 * breath. Nothing in the file can answer it, so it is said instead.
 */
export const DEVICES_AND_AGENTS =
  'Paired devices and the digests of their credentials live in `web-devices.jsonl`, `0600` — ' +
  'which keeps them from other people, and an agent is not another person. An agent on this ' +
  'machine runs as you with nothing containing it, so it can append a line to that file and pair ' +
  'itself. What stands against that: the device list here shows every device there is, every act ' +
  'one takes is in the journal under its id, and “Disconnect everything” needs no network.'

/** The short clause, for the one line a control gets. */
export const DEVICES_SEEN_BY_AGENTS = 'an agent on this machine could pair itself'

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
