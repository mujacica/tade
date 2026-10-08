import { type ErrorKind, type Refusal, refuse } from './errors.ts'
import type { Route } from './routes.ts'
import { loopbackHost, type Scope, type Surface, sameHost, trusted } from './surface.ts'

// Everything that has to be true before a route runs, in one pure function.
//
// **Pure on purpose, and it is the most load-bearing decision in this file.**
// A guard that reads `req` is a guard you can only test by making a request,
// which means the attacks it is for — a rebinding `Host`, a cross-site
// `Origin`, a form post dressed as a verb — get tested at most once each, for
// the one route somebody remembered. This takes a description of a request and
// answers; `test/guard.test.ts` runs the whole cross-product, and `server.ts`
// has one call site, so there is no route that skipped a layer.
//
// The layers, in the order they are asked, and each stops something different:
//
// 1. **`Host`** — the DNS-rebinding defence, on *every* request, `GET`
//    included. An attacker's page at `evil.example` whose DNS answers with this
//    machine's address sends `Host: evil.example`; refused here, so rebinding
//    never reaches a route. This is the one that has to be first: it is also
//    the check that decides what "the expected origin" even is for the two
//    below.
// 2. **`Origin`** — scheme, host and port, all three, on every mutation. A
//    *missing* `Origin` on a mutation is a refusal, not a pass, because "the
//    header was absent" is what every non-browser client sends and a verb is
//    not for one.
// 3. **`Sec-Fetch-Site`** — where the browser itself says the request came
//    from. Absent is allowed (older browsers, `curl`); present and not
//    `same-origin` is refused, which catches the same-site subdomain case the
//    `Origin` check cannot see. **Not on a document navigation**: opening the
//    shell by scanning a code is a typed URL, which is `none`, and following a
//    link to it is `cross-site`, so requiring `same-origin` there would refuse
//    every real way in.
// 4. **`Content-Type: application/json`** — so no HTML form post can ever be a
//    verb. A simple-request `POST` with `text/plain` is the shape that tries.
// 5. **The token** — a per-session value in a header a form cannot set.
// 6. **The session** — present, not expired, not revoked, and minted for
//    *this* host.
// 7. **The scope** — what the device was granted, against what the route needs.
//
// All of them, because each fails differently and the cost of all of them is
// this file. And **nothing here reads a forwarded header** (`NEVER_TRUSTED`,
// `headers.ts`): the address is the socket's and the host is `Host`.

/** A request, as everything deciding about it needs to see it. */
export interface Asking {
  method: string
  /** The path, already split from the query. */
  path: string
  /** The `Host` header, verbatim, or null where there was none. */
  host: string | null
  /** The `Origin` header, verbatim, or null. */
  origin: string | null
  /** `Sec-Fetch-Site`, or null where the browser did not send one. */
  site: string | null
  /** The `Content-Type`, verbatim. */
  contentType: string | null
  /** The CSRF token the request carried, out of its own header. */
  token: string | null
  /** The cookie header, verbatim. */
  cookie: string | null
  /**
   * Whether the connection itself was TLS.
   *
   * The **socket's** answer, never a header's: `encrypted` on the socket, which
   * a client cannot claim. Behind `tailscale serve` this is false and the
   * origin is `https` — which is why the trusted-origin rule reads the
   * `Origin`/`Host` pair against a configured host list and not this flag.
   */
  tls: boolean
  /** The peer's address, as the socket gives it. Never a header's claim. */
  from: string
}

/** What the guard concluded: the session's device and scopes, or a refusal. */
export type Verdict =
  | { ok: true; device: string; scopes: readonly Scope[]; origin: { scheme: string; host: string } }
  | { ok: false; refusal: Refusal; why: string }

/** What a guard needs to know beyond the request itself. */
export interface Guarding {
  surface: Surface
  /** The addresses actually bound, so the allow-list is what is listened on. */
  bound: readonly string[]
  /** The session behind this cookie, or null. Already checked for expiry. */
  session: Session | null
}

/** A session, as the guard reads one. Minting and storing it is `sessions.ts`. */
export interface Session {
  device: string
  scopes: readonly Scope[]
  /**
   * The exact `Host` this session was minted for.
   *
   * A mismatch is a `401`, not a silent accept, and it is the honest half of
   * the answer to cookies not being isolated by port (`COOKIES_IGNORE_PORTS`):
   * a cookie that reached here from another listener on this address does not
   * match the host it was minted for, so it is not a session.
   */
  host: string
  csrf: string
}

/**
 * Whether this `Host` is one of ours, which decides whether anything else is
 * asked at all.
 *
 * Compared **port-insensitively** against the addresses actually bound plus the
 * three spellings of this machine plus whatever the config trusts — so the
 * allow-list is a fact about this listener rather than a list somebody has to
 * keep in step with it. An IPv6 literal arrives in brackets and is compared
 * without them.
 */
export function hostAllowed(host: string | null, guarding: Guarding): boolean {
  if (host === null || host === '') return false
  const bare = hostOf(host)
  if (bare === null) return false
  if (loopbackHost(bare)) return true
  const allowed = [...guarding.bound, ...guarding.surface.trustedHosts]
  // `0.0.0.0` and `::` are what was *bound*, never what a browser asks for: a
  // request that named either is a request nobody's browser made.
  return allowed.some((one) => one !== '0.0.0.0' && one !== '::' && sameHost(one, bare))
}

/**
 * The host out of a `Host` header, without its port.
 *
 * Null where the value is not one host — a header with a comma in it is two
 * claims, which is a request worth refusing rather than picking from.
 */
export function hostOf(header: string): string | null {
  const value = header.trim()
  if (value === '' || /[,\s]/.test(value)) return null
  if (value.startsWith('[')) {
    const close = value.indexOf(']')
    if (close === -1) return null
    const rest = value.slice(close + 1)
    if (rest !== '' && !/^:\d{1,5}$/.test(rest)) return null
    return value.slice(0, close + 1)
  }
  const colon = value.indexOf(':')
  if (colon === -1) return value
  if (!/^:\d{1,5}$/.test(value.slice(colon))) return null
  return value.slice(0, colon)
}

/**
 * The origin this request is for, as a scheme and a host.
 *
 * The scheme is the `Origin` header's where there is one, because that is the
 * browser's own statement of which origin the page is, and the connection's
 * otherwise. A page on `https://studio.ts.net` reaches a loopback listener
 * through a proxy that terminated the TLS, so the socket is plaintext and the
 * origin is not — and it is the origin that decides whether the credential
 * travelled in the clear.
 */
export function originOf(asking: Asking, host: string): { scheme: string; host: string } {
  const stated = asking.origin === null ? null : parseOrigin(asking.origin)
  if (stated !== null && sameHost(stated.host, host)) return stated
  return { scheme: asking.tls ? 'https' : 'http', host }
}

/** An `Origin` header, or null for anything that is not one absolute origin. */
export function parseOrigin(value: string): { scheme: string; host: string; port: string } | null {
  if (value === 'null' || value === '') return null
  const matched = /^(https?):\/\/(\[[0-9a-fA-F:.]+]|[^/:?#]+)(?::(\d{1,5}))?$/.exec(value.trim())
  if (matched === null) return null
  return { scheme: matched[1] ?? '', host: matched[2] ?? '', port: matched[3] ?? '' }
}

/**
 * Whether the `Origin` is exactly the origin of the `Host` that was accepted:
 * scheme, host and port, all three.
 *
 * **The port is where this earns its place.** A cookie reaches every listener
 * on an address, so a page served by something else on another port of this
 * machine is a *different origin* holding a perfectly good session cookie. The
 * host alone would let it through, and on a laptop running other dev servers
 * that is not a hypothetical.
 *
 * **The scheme is checked against how the request actually arrived**, which
 * takes a little care rather than a comparison with the socket: `tailscale
 * serve` terminates TLS and connects to loopback in the clear, so a perfectly
 * good `https` origin arrives on a plaintext socket. So the rule is: the
 * socket's own scheme, plus `https` for a host the config trusts — which is
 * exactly the set of hosts a proxy may be terminating for. Anything else is a
 * scheme this listener could not have served.
 */
export function originMatches(origin: string, host: string, schemes: readonly string[]): boolean {
  const stated = parseOrigin(origin)
  if (stated === null) return false
  if (!schemes.includes(stated.scheme)) return false
  const bare = hostOf(host)
  if (bare === null) return false
  if (!sameHost(stated.host, bare)) return false
  const wanted = portOf(host)
  const sent = stated.port === '' ? defaultPort(stated.scheme) : stated.port
  return wanted === null ? sent === defaultPort(stated.scheme) : sent === wanted
}

/**
 * The schemes this listener could have served this request as.
 *
 * The socket's own, and `https` for a host somebody wrote into
 * `trusted_hosts` — the one case where what reached the socket and what the
 * browser saw are honestly different.
 */
export function schemesFor(asking: Asking, host: string, surface: Surface): string[] {
  const own = asking.tls ? 'https' : 'http'
  const proxied = surface.trustedHosts.some((one) => sameHost(one, host))
  return proxied && own !== 'https' ? [own, 'https'] : [own]
}

function portOf(host: string): string | null {
  const value = host.trim()
  const at = value.startsWith('[') ? value.indexOf(']') + 1 : value.indexOf(':')
  if (at <= 0 || value[at] !== ':') return null
  return value.slice(at + 1)
}

function defaultPort(scheme: string): string {
  return scheme === 'https' ? '443' : '80'
}

/**
 * The one question every request is asked.
 *
 * Order matters and is the order above: `Host` first so that what counts as
 * "this origin" is settled, then the cross-site layers for a mutation, then
 * who this is, then what they may do. A refusal carries two sentences — the
 * page's (`refusal.said`) and the journal's (`why`) — and `why` is the only
 * place the host that was offered or the check that failed is ever written.
 */
export function allowed(asking: Asking, route: Route, guarding: Guarding): Verdict {
  if (!hostAllowed(asking.host, guarding)) {
    return no('bad_origin', `host offered: ${quoted(asking.host)}`)
  }
  const host = hostOf(asking.host ?? '')
  if (host === null) return no('bad_origin', `host offered: ${quoted(asking.host)}`)
  const origin = originOf(asking, host)

  // **Not on a document navigation**, and this is the correction somebody will
  // otherwise make twice. A person who scans the pairing code is a *typed URL*,
  // which browsers send as `Sec-Fetch-Site: none`; one who follows a link from
  // anywhere is `cross-site`. Requiring `same-origin` on the shell would refuse
  // every real way of opening it and allow only the one nobody uses. On
  // everything else — every `fetch` the page makes, including the pairing POST
  // — `same-origin` is what the browser sends, so the check is exact there and
  // catches the same-site subdomain case `Origin` cannot see.
  const navigation = route.public === true && !route.mutates
  if (!navigation && asking.site !== null && asking.site !== '' && asking.site !== 'same-origin') {
    return no('bad_origin', `Sec-Fetch-Site said ${quoted(asking.site)}`)
  }

  if (route.mutates) {
    if (asking.origin === null) {
      return no('bad_origin', 'a mutation with no Origin header')
    }
    if (
      !originMatches(asking.origin, asking.host ?? '', schemesFor(asking, host, guarding.surface))
    ) {
      return no('bad_origin', `origin offered: ${quoted(asking.origin)}`)
    }
    if (!isJson(asking.contentType)) {
      return no('bad_origin', `content type offered: ${quoted(asking.contentType)}`)
    }
  }

  // A route that needs no session: the shell, the pairing page, and the one
  // request that *mints* a session and so has none to present. It is not an
  // exemption from the guard — everything above still applied: a `Host` in the
  // allow-list, an exact `Origin` on the mutation, `Sec-Fetch-Site` where the
  // browser sent one, JSON only, the rate limit, the one-use ticket, and — the
  // authorisation nothing remote can obtain — the keypress at the machine.
  //
  // **A public route is exempt from the token layer by construction, not by
  // choice**: a CSRF token is a value out of a session, and there is no session
  // here to take one from. DECISIONS §4.2 is the argument for why that is
  // sound rather than a hole; `routes.ts` carries `opens` so that
  // `test/routes.test.ts` can assert the one route it is true of, and that no
  // route is ever public and mutating without being that one.
  if (route.public === true) {
    // **A public route that mutates must say it is the one that mints a
    // session.** Otherwise "no session needed" and "changes something" is a
    // route with no token layer and nobody having decided that — so the marker
    // is enforced here rather than only asserted in a test, and a route added
    // as public and mutating without it is refused instead of quietly exempt.
    if (route.mutates && route.opens !== true) {
      return no(
        'bad_origin',
        `${route.name} is public and mutating without being the pairing route`,
      )
    }
    return { ok: true, device: '', scopes: [], origin }
  }

  const session = guarding.session
  if (session === null) return no('no_session', 'no session, or one that is no longer valid')
  if (!sameOriginHost(session.host, asking.host ?? '')) {
    return no('no_session', `session was minted for ${quoted(session.host)}`)
  }

  if (route.mutates && !tokenMatches(asking.token, session.csrf)) {
    return no('bad_origin', 'the session token was missing or wrong')
  }

  if (!session.scopes.includes(route.needs)) {
    return no(
      'out_of_scope',
      `needs ${route.needs}, device has ${session.scopes.join(', ') || 'nothing'}`,
    )
  }

  // Re-asked here and not only at pairing, because the network a device is on
  // changes. A session that may read keeps reading over plain HTTP; anything
  // above `read` needs an origin whose credential did not travel in the clear.
  if (route.needs !== 'read' && !trusted(origin, guarding.surface)) {
    return no(
      'locked',
      `${route.needs} from ${origin.scheme}://${origin.host}, which is not a trusted origin`,
    )
  }

  return { ok: true, device: session.device, scopes: session.scopes, origin }
}

function no(error: ErrorKind, why: string): Verdict {
  return { ok: false, refusal: refuse(error), why }
}

/** A session's host against the one offered, port and all. */
function sameOriginHost(minted: string, offered: string): boolean {
  return minted.toLowerCase() === offered.trim().toLowerCase()
}

/** Whether a content type is JSON, parameters and casing aside. */
export function isJson(value: string | null): boolean {
  if (value === null) return false
  const type = value.split(';')[0]?.trim().toLowerCase()
  return type === 'application/json'
}

/**
 * The token, compared without leaking its length or its prefix through timing.
 *
 * Both are the same length by construction (`mintCsrf`), so the length check
 * refuses rather than short-circuiting a comparison of unequal strings.
 */
export function tokenMatches(presented: string | null, expected: string): boolean {
  if (presented === null || presented.length !== expected.length) return false
  let same = 0
  for (let at = 0; at < expected.length; at++) {
    same |= presented.charCodeAt(at) ^ expected.charCodeAt(at)
  }
  return same === 0
}

/** A value as it goes into a `warning`: quoted, bounded, and on one line. */
export function quoted(value: string | null): string {
  if (value === null) return '(none)'
  return JSON.stringify(value.replace(/[\r\n]+/g, ' ').slice(0, 120))
}

/**
 * How many refusals from one peer are one line in the journal.
 *
 * A refusal is cheap and correct — a port scanner on the wifi gets three of
 * them and nobody needs to know — so nothing is written until a peer is past
 * the threshold inside the window. What is worth a line is *a sustained
 * attempt*, which is the thing a person could act on.
 */
export const REFUSALS_BEFORE_SAYING = 3
export const REFUSAL_WINDOW_MS = 60_000

/** How many pairing attempts one address gets, and over how long. */
export const PAIR_TRIES = 5
export const PAIR_WINDOW_MS = 10 * 60_000

/**
 * A count per key inside a sliding window, which is both rate limits.
 *
 * Bounded by construction: a key whose window has run out is dropped on the
 * next look, and the whole map is dropped once it is over `most` keys — which
 * is what keeps a stream of made-up peers from being a memory leak with a
 * rate limiter's name on it. Dropping it is safe in the only direction that
 * matters: it loses counts, so the worst it does is forgive, and it cannot
 * make Tade refuse somebody it should not.
 */
export class Window {
  private readonly seen = new Map<string, number[]>()
  private readonly most: number
  private readonly ms: number
  private readonly keys: number

  constructor(most: number, ms: number, keys = 1024) {
    this.most = most
    this.ms = ms
    this.keys = keys
  }

  /** How many times this key has been counted inside the window, including now. */
  add(key: string, now: number): number {
    this.forget(now)
    const kept = (this.seen.get(key) ?? []).filter((at) => now - at < this.ms)
    kept.push(now)
    this.seen.set(key, kept)
    return kept.length
  }

  /** How many times, without counting this look. */
  count(key: string, now: number): number {
    return (this.seen.get(key) ?? []).filter((at) => now - at < this.ms).length
  }

  /** Whether this key is over its allowance. */
  over(key: string, now: number): boolean {
    return this.count(key, now) >= this.most
  }

  /** When this key's oldest count falls out of the window, in seconds. */
  after(key: string, now: number): number {
    const oldest = (this.seen.get(key) ?? []).filter((at) => now - at < this.ms)[0]
    if (oldest === undefined) return 0
    return Math.max(1, Math.ceil((this.ms - (now - oldest)) / 1000))
  }

  private forget(now: number): void {
    for (const [key, times] of this.seen) {
      if (times.every((at) => now - at >= this.ms)) this.seen.delete(key)
    }
    if (this.seen.size > this.keys) this.seen.clear()
  }
}
