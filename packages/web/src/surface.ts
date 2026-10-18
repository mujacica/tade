import {
  ACTING_IS_NOT_YOU,
  ACTING_IS_NOT_YOU_SHORT,
  AWAY_IS_WHILE_OPEN,
  COOKIES_IGNORE_PORTS,
  DEVICES_AND_AGENTS,
  DEVICES_SEEN_BY_AGENTS,
  HTTPONLY_IS_NOT_XSS,
  LAN_IS_PLAINTEXT,
  PUBLIC_IS_THE_INTERNET,
  PUSH_GOES_THROUGH_A_STRANGER,
  PUSH_IS_WHILE_OPEN,
  PUSH_NEEDS_A_GESTURE,
  PUSH_SAYS_NOTHING,
} from '@tade/core'
import { GRANTS, type Grant, type Reach } from './reach.ts'

// The sentences about the away view are **declared in `@tade/core`'s `away.ts`**
// and
// re-exported here, so this package still has exactly one spelling of each and
// everything that said `from './surface.ts'` still does.
//
// They moved because four of them belong on a *control* — the one that turns a
// LAN bind on, the one that lets a paired device act, and the one that lists
// the devices that have been let in —
// and a control's words are a `Setting`'s `means`, which lives in the domain.
// `@tade/core` cannot import this package: the arrow goes the other way. So
// the choice was a second spelling of each sentence beside each control, or
// one spelling in the domain. A second spelling is the exact failure these
// sentences exist to prevent.
export {
  ACTING_IS_NOT_YOU,
  ACTING_IS_NOT_YOU_SHORT,
  AWAY_IS_WHILE_OPEN,
  COOKIES_IGNORE_PORTS,
  DEVICES_AND_AGENTS,
  DEVICES_SEEN_BY_AGENTS,
  HTTPONLY_IS_NOT_XSS,
  LAN_IS_PLAINTEXT,
  PUBLIC_IS_THE_INTERNET,
  PUSH_GOES_THROUGH_A_STRANGER,
  PUSH_IS_WHILE_OPEN,
  PUSH_NEEDS_A_GESTURE,
  PUSH_SAYS_NOTHING,
}

// What the away view is turned on as, and the sentences about it that are true
// however it is turned on.
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
  /**
   * Hosts beyond this machine's own that may reach it: the public name first,
   * then `trusted_hosts`.
   */
  trustedHosts: readonly string[]
  /**
   * The name this machine answers the internet by, through Caddy, or null.
   *
   * Set, there is a second listener — the Unix socket Caddy connects to — and
   * it is `public` whatever a request on it says about itself. The name is
   * also the first of `trustedHosts`, because Caddy ends TLS for it: that is
   * what makes its `https` origin one a device may act from, and the address
   * a pairing code carries.
   */
  publicName: string | null
  /**
   * How long a passkey's proof lets a device act from the public listener, in
   * milliseconds; nought for never asking (`surfaces.web.passkey_hours`).
   *
   * **Asked of the public listener alone** (`proven`, `guard.ts`): it is the
   * one a copied session reaches from anywhere. This machine, an SSH forward
   * and a tailnet name each come in on the loopback listener, already behind
   * something of the person's own.
   */
  passkeyMs: number
  /**
   * Whether a paired device may change anything at all.
   *
   * **Read twice, and the two readings are different questions.** At start-up
   * it decides whether the acting routes are in the table at all
   * (`routesFor`), so with it off a crafted call is the same `404` as a path
   * nobody built — read-only by absence rather than by a flag. At every act it
   * is read again, so turning it off takes authority away now rather than at
   * the next restart. On its own it grants nothing: a device still needs the
   * scope a person granted it at the machine, and the request still needs a
   * trusted origin.
   */
  acting: boolean
  /**
   * Whether a paired device may talk to the orchestrator.
   *
   * **Read twice like `acting`, and for the same two reasons**: at start-up it
   * decides whether the asking route is in the table at all (`routesFor`), and
   * at every turn it is read again so turning it off takes authority away now.
   * It is a *fourth* decision and not a reading of `acting`: a verb is a target
   * plus the state it expects, and this is free text to a model that holds
   * tools. One switch for both would be a yes to a question nobody was asked.
   */
  talking: boolean
  /**
   * Whether a paired device may save a field of a draft workflow.
   *
   * **Read twice like `acting` and `talking`, and for the same two reasons**:
   * at start-up it decides whether the saving route is in the table at all
   * (`routesFor`), and at every save it is read again so turning it off takes
   * authority away now. It is a *fifth* decision and not a reading of either:
   * a verb is about work that exists, a message is free text to a model, and
   * this writes a file every future run of a workflow would be stamped from
   * once somebody at the machine publishes it.
   */
  drafting: boolean
  /**
   * Whether a paired device may change a setting.
   *
   * **Read twice like the three above, and for the same two reasons**: at
   * start-up it decides whether the changing route is in the table at all
   * (`routesFor`), and at every change it is read again so turning it off
   * takes authority away now. A *sixth* decision and not a reading of any of
   * them: it writes the config, and what it may write is `settingReach`'s
   * `open` tier and nothing else (`configuring.ts` has why).
   */
  configuring: boolean
  /**
   * Whether a device may install the shell and open it with nothing to ask.
   *
   * **Read twice like the three above, and the second reading is the one that
   * can take it away.** At start-up it decides what `/sw.js` answers with: the
   * worker that precaches the shell, or the one that removes itself. There is
   * no third answer and in particular no `404`, because a `404` on a worker's
   * script leaves the installed one exactly where it was (w3c/ServiceWorker
   * issue 204, closed as *will not do* in 2017). So turning it off is a thing
   * the device has to be **told**, and it is told the next time it reaches
   * this machine.
   *
   * It grants nothing. The shell carries no data at all — it is the same bytes
   * for a device with every grant and for one that has never paired — and
   * every value on the page still comes from a route that needs a session.
   */
  installing: boolean
  /**
   * Whether a device may keep a few counts on its own disk.
   *
   * Narrowed under `installing` rather than standing beside it: what this is
   * for is the *cold* open, with nothing to ask, and there is no cold open
   * without a shell to open. A setting that could be on while nothing could
   * read it is a setting Tade accepts and ignores.
   */
  keepsView: boolean
  /**
   * Whether a device that installed the shell may be sent a notification.
   *
   * **Narrowed under `installing` like `keepsView`, and read at the beat
   * rather than at start-up.** A notification is not a route: nothing is built
   * with the listener for it, so both directions take effect at the next beat
   * — which is why this is the one away-view capability whose setting is
   * honestly `live`. What makes it small is what a notification carries
   * (`PUSH_SAYS_NOTHING`), where it goes (`PUSH_GOES_THROUGH_A_STRANGER`) and
   * that this window is the only thing that sends one
   * (`PUSH_IS_WHILE_OPEN`).
   *
   * It grants nothing on its own: each phone still has to allow notifications
   * in its own browser (`PUSH_NEEDS_A_GESTURE`), which nothing here can press.
   */
  pushing: boolean
  /**
   * Whether a notification may name the work it is about.
   *
   * Narrowed under `pushing` for the reason `keepsView` is narrowed under
   * `installing`: a key that could be on while nothing could be sent is a
   * setting Tade accepts and ignores. It is narrowed **again** per device at
   * the moment a notification is built — a phone that may not read titles
   * never gets one — so this is a ceiling and never a grant.
   */
  pushDetails: boolean
}

/** The `surfaces.web` block, as the one reader of it sees it. */
export interface WebConfig {
  enabled: boolean
  bind: Bind
  port: number
  trusted_hosts: readonly string[]
  public: string
  passkey_hours: number
  acting: boolean
  orchestrator: boolean
  drafts: boolean
  settings: boolean
  install: boolean
  offline: boolean
  push: boolean
  push_details: boolean
}

/** Off, on this machine, on the port nothing else wanted, changing nothing. */
export const OFF: Surface = {
  enabled: false,
  bind: 'loopback',
  port: 7654,
  trustedHosts: [],
  publicName: null,
  passkeyMs: 0,
  acting: false,
  talking: false,
  drafting: false,
  configuring: false,
  installing: false,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

/**
 * The surface a config says, and it only ever *narrows* what is turned on.
 *
 * A `lan` bind with `enabled: false` is off, not "on the network and waiting":
 * two decisions, and the one that decides whether anything listens is read
 * first. `acting` and `talking` are narrowed the same way and for the same
 * reason — a config that says a device may act and that nothing is listening
 * says, together, that nothing may act. Nothing here can turn anything on
 * that the file did not.
 */
export function surfaceOf(web: WebConfig): Surface {
  const named = web.public === '' ? [] : [web.public.toLowerCase()]
  return {
    enabled: web.enabled,
    bind: web.enabled ? web.bind : 'loopback',
    port: web.port,
    trustedHosts: web.enabled ? [...new Set([...named, ...web.trusted_hosts])] : [],
    publicName: web.enabled ? (named[0] ?? null) : null,
    passkeyMs: web.enabled ? web.passkey_hours * 3_600_000 : 0,
    acting: web.enabled && web.acting,
    talking: web.enabled && web.orchestrator,
    drafting: web.enabled && web.drafts,
    configuring: web.enabled && web.settings,
    installing: web.enabled && web.install,
    // Two keys deep, because a view kept on a phone's disk is read by the
    // shell on that phone and there is no shell without the first one.
    keepsView: web.enabled && web.install && web.offline,
    // Two keys deep for the same reason: a notification is delivered to a
    // service worker, and there is no worker without the shell that registers
    // one.
    pushing: web.enabled && web.install && web.push,
    // Three keys deep, and the third is this one's own: details that could be
    // on while nothing could be sent is a setting Tade accepts and ignores.
    pushDetails: web.enabled && web.install && web.push && web.push_details,
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
 * Which of Tade's listeners accepted a connection: the one only this machine
 * can open, or one anybody who can reach it can.
 *
 * **Decided by which server accepted the socket, and never by an address in the
 * request** — not the `Host`, and not the peer either. A peer of `127.0.0.1` is
 * what *every* request through a proxy on the same box looks like, which is how
 * the OpenClaw gateways of January 2026 (openclaw issue #2245) handed the
 * internet a loopback session. A wildcard bind is `public` although this
 * machine can connect to it too: a server that anybody can reach cannot tell
 * this machine from anybody by anything it was told.
 */
export type Listener = 'loopback' | 'public'

/** The listener a server bound to this address is. */
export function listenerAt(address: string): Listener {
  return loopbackHost(address) ? 'loopback' : 'public'
}

/** Where a request came from, as every gate that re-asks about it is told. */
export interface Origin {
  scheme: string
  host: string
  /** Which listener accepted the socket. The server's own answer, never the request's. */
  listener: Listener
}

/**
 * Whether a request is from this machine: **both** that the loopback listener
 * accepted it **and** that it names a loopback host.
 *
 * Either alone is not enough, and each half stops something the other cannot.
 * The listener without the host is a proxy on this box: Caddy or `tailscale
 * serve` connect to loopback for whoever is outside, and they say whose name
 * they were reached by. The host without the listener is the request that
 * *says* `Host: localhost` from across the internet, which costs one header.
 * A request on a public listener is public whatever it says about itself
 * (`hostAllowed` refuses this machine's names there), so a session minted for
 * this machine can only ever be used from this machine.
 */
export function thisMachine(origin: Origin): boolean {
  return origin.listener === 'loopback' && loopbackHost(origin.host)
}

/**
 * Whether an origin is one a device may ever *act* from, as against read.
 *
 * `https` anywhere, or this machine itself (`thisMachine`). That is the W3C
 * secure-contexts line and it is used here for a different purpose: not what
 * the browser will let the page do, but whether the credential travelling on
 * the request was readable by anybody between the phone and here. Plain HTTP
 * across a network is readable, so a session on one may read and may never act.
 *
 * **Re-asked at the act, never only at pairing**, because the network a device
 * is on changes and a phone that paired on the sofa is on cellular an hour
 * later. The host must also be one the config trusts: an `https` origin Tade
 * was never told about is somebody else's name resolving here.
 */
export function trusted(origin: Origin, surface: Surface = OFF): boolean {
  if (thisMachine(origin)) return true
  if (origin.scheme !== 'https') return false
  return surface.trustedHosts.some((one) => sameHost(one, origin.host))
}

/**
 * The most a session minted on this origin may ever have.
 *
 * Off a trusted origin it is `read` and there is no later act — not a flag
 * that could be raised, not a scope a grant could widen. The verbs land under
 * this ceiling: `allowed` re-asks `trusted` at every act, so a device granted
 * `steer` at the machine and then carried onto somebody's wifi reads and does
 * nothing else until it is back.
 */
export function scopesOn(origin: Origin, surface: Surface, granted: readonly Scope[]): Scope[] {
  if (trusted(origin, surface)) return SCOPES.filter((one) => granted.includes(one))
  return granted.includes('read') ? ['read'] : []
}

/**
 * What a device may do, in widening order.
 *
 * Pairing mints `read` and nothing else; everything above it is a grant made
 * at the machine, per device, through the one door that widens one
 * (`allowDevice`). A route's required scope is declared in the route table
 * (`routes.ts`), and `test/routes.test.ts` asserts no route in `ROUTES` needs
 * more than `read` — which is the half of the guarantee a type cannot give.
 *
 * `ask` is the fourth and is the odd one: `answer` and `steer` are what a
 * *verb* needs, and `ask` is what sending a message to the orchestrator needs.
 * It is deliberately not implied by either — a device that may answer what is
 * waiting has not been granted free text to a model that holds tools, and the
 * two are granted by two controls. What a turn sent under it may then reach is
 * `answer` and `steer` again, read as an `Arm` (`@tade/core`'s `origin.ts`),
 * so there is no third list of the same decision.
 *
 * `draft` is the fifth, and it is not implied by anything either — nor does it
 * imply anything. The four above it are all about work that already exists or
 * a conversation that is already going; this writes a file that decides what
 * every future run of a workflow does, once somebody at the machine publishes
 * it. It is also the one scope with a reading requirement of its own: a
 * workflow can name any repository, so `admitDraft` refuses a device whose
 * reading is a list rather than every project.
 *
 * `agents` and `projects` are the sixth and seventh, and they are the
 * lifecycle: stopping an agent or opening a stopped one again where it left
 * off, and closing a project or opening a closed one again. **Implied by
 * nothing and implying nothing**, each its own chip at the machine and off for
 * every device until somebody presses it. They sit beside the acting tiers
 * rather than inside one because a device that may answer and steer has been
 * granted things that change what an agent *does*, and stopping one changes
 * whether it does anything at all — a person who said yes to the first has not
 * answered the second. Neither reaches a remote turn's arm (`REMOTE_GRANTS`),
 * so a device that may close a project cannot ask Tade to close one either.
 *
 * `configure` is the eighth, and it is the one that writes the config: the
 * settings `settingReach` puts in its `open` tier, and nothing else. Implied by
 * nothing and implying nothing, its own chip at the machine, and it needs the
 * `settings` *reading* grant beside it — a device may not change what it was
 * not allowed to see. It does not reach a remote turn's arm either.
 */
export const SCOPES = [
  'read',
  'answer',
  'steer',
  'ask',
  'draft',
  'agents',
  'projects',
  'configure',
] as const
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
 *
 * `answers` is the device's own `answer` scope, as granted — not narrowed by
 * where the request came from, as no reading is (`scopesOn` narrows acts).
 */
export function reachOf(device: {
  id: string
  projects: readonly string[] | null
  granted: readonly string[]
  scopes?: readonly string[]
  owner?: boolean
}): Reach {
  return {
    device: device.id,
    projects:
      device.projects === null
        ? { kind: 'every' }
        : { kind: 'listed', names: [...device.projects] },
    granted: GRANTS.filter((grant) => device.granted.includes(grant)) as Grant[],
    answers: device.scopes?.includes('answer') === true,
    // Only where it is true, so every reach that is not the person's own reads
    // exactly as it did.
    ...(theirsOf(device) ? { theirs: true } : {}),
  }
}

/**
 * Whether a device has full access: every scope and every reading grant —
 * what pairing gives unless somebody unticks something (the panel's `full
 * access` box draws exactly this). **Such a device is the person's own**: its
 * turns reach what the keyboard reaches and what is typed on it is theirs
 * (`Arm`'s owner variant, `theirs`). A device with anything taken away keeps
 * exactly the grant it has. Revoking it is a line, read at every request.
 */
export function fullAccess(device: {
  scopes: readonly string[]
  granted: readonly string[]
}): boolean {
  return (
    SCOPES.every((scope) => device.scopes.includes(scope)) &&
    GRANTS.every((grant) => device.granted.includes(grant))
  )
}

/**
 * Whether a device is the person's own: full access, and **not a machine
 * link** (`tade web pair --owner`), whose words may be another machine's
 * model's and whose reach stays the one it was paired with — the same two
 * halves `armOf` asks. Read off the record at every request, so revoking it
 * or unticking one box ends it at the next one.
 */
export function theirsOf(device: {
  scopes?: readonly string[]
  granted: readonly string[]
  owner?: boolean
}): boolean {
  return (
    device.owner !== true &&
    device.scopes !== undefined &&
    fullAccess({ scopes: device.scopes, granted: device.granted })
  )
}
