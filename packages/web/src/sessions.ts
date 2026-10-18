import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Device } from './devices.ts'
import type { Session } from './guard.ts'
import { type Scope, type Surface, sameHost, theirsOf } from './surface.ts'

// The session credential: minted here, hashed before it is written down, and
// verified in constant time.
//
// Three decisions worth the words, because each has a tempting wrong answer.
//
// **A cookie, not a bearer token in `localStorage`.** The decisive reason is
// mechanical rather than aesthetic: the live stream is an `EventSource` and
// `EventSource` cannot set a header, so a bearer token has nowhere to go on the
// one request that matters most. The alternative — the token in the stream's
// query string — puts a thirty-day credential in access logs and in the
// browser's history, which is exactly what the ninety-second ticket goes in a
// fragment to avoid. `HttpOnly` and `SameSite=Strict` come free with the
// choice, and `HTTPONLY_IS_NOT_XSS` (`surface.ts`) says what the first of them
// does not do.
//
// **Only the digest is stored.** `sha256(secret)`, unsalted, and unsalted is
// right here rather than lazy: the secret is 256 bits of `randomBytes`, so
// there is no dictionary to salt against and no password to slow down. What
// hashing buys is that the file an agent on this machine can read
// (`DEVICES_AND_AGENTS`) holds nothing it could present.
//
// **The expiry slides, and the renewal is bounded.** Thirty days, pushed
// forward at most once a day — the line in the device list and the cookie's
// own `Max-Age` together (`renewedCookie`) — so somebody who opens Tade on
// their phone every morning never signs in again and a phone in a drawer
// expires on its own. A renewal per request would be a write per request,
// which is a file of them.

/** How long a session lasts, and how often using it pushes that forward. */
export const SESSION_MS = 30 * 24 * 60 * 60_000
export const RENEW_AFTER_MS = 24 * 60 * 60_000

/** The cookie's name over plain HTTP, and every session's name before `__Host-`. */
export const COOKIE = 'tade_away'

/**
 * The cookie's name on `https`, where it can be `Secure`.
 *
 * `__Host-` is a promise the **browser** keeps: it accepts a cookie of this name
 * only `Secure`, `Path=/` and with no `Domain`, so a page on another name —
 * a sibling on a tunnel's shared domain that is not on the Public Suffix List
 * — cannot plant one of its own, and the session the phone holds is the one it
 * was given here. It says nothing about ports (`COOKIES_IGNORE_PORTS`).
 */
export const HOST_COOKIE = '__Host-tade_away'

/** 32 bytes of secret, 8 of device id. */
const SECRET_BYTES = 32
const DEVICE_BYTES = 8

/** A freshly minted credential: what the phone is given, once. */
export interface Minted {
  device: string
  /** The value for the cookie: `<device>.<secret>`. In memory, then gone. */
  cookie: string
  /** The digest to write down. */
  digest: string
  /** The token for the header a form cannot set. */
  csrf: string
}

/**
 * A device id and a secret, from the one source of randomness worth using.
 * The id is given only where it was minted already — a code the terminal
 * wrote names the device it will become (`pending.ts`).
 *
 * `randomBytes` and not `Math.random`, and said here because this is the line
 * where getting it wrong would be invisible: a predictable secret fails no
 * test, serves every page correctly, and is a session anybody can mint.
 */
export function mint(device: string = randomBytes(DEVICE_BYTES).toString('hex')): Minted {
  const secret = randomBytes(SECRET_BYTES).toString('base64url')
  return {
    device,
    cookie: `${device}.${secret}`,
    digest: digestOf(secret),
    csrf: randomBytes(SECRET_BYTES).toString('base64url'),
  }
}

/** The digest of a secret, which is the only form of it anything keeps. */
export function digestOf(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

/** The two halves of a cookie value, or null for anything that is not one. */
export function splitCookie(value: string): { device: string; secret: string } | null {
  const dot = value.indexOf('.')
  if (dot <= 0) return null
  const device = value.slice(0, dot)
  const secret = value.slice(dot + 1)
  if (!/^[0-9a-f]{16}$/.test(device)) return null
  // The exact length every secret this program mints has. A value of another
  // length is refused before anything is hashed or compared.
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return null
  return { device, secret }
}

/**
 * The session a cookie is, or null — and null is the only other answer.
 *
 * Expired, revoked, for a device that is not there, for a host it was not
 * minted on, or simply wrong: all of them are "not signed in", because telling
 * them apart on the wire would tell whoever is guessing which half to keep
 * guessing at. Which it was goes in the journal's own sentence.
 */
export function sessionOf(
  cookie: string | null,
  devices: readonly Device[],
  host: string,
  now: number,
): Session | null {
  if (cookie === null) return null
  const value = presentedIn(cookie)?.value ?? null
  if (value === null) return null
  const split = splitCookie(value)
  if (split === null) return null
  const device = devices.find((one) => one.id === split.device)
  if (device === undefined) return null
  if (device.revoked !== null) return null
  if (!Number.isFinite(device.until) || now >= device.until) return null
  if (!sameCookieHost(device.host, host)) return null
  if (!digestMatches(split.secret, device.digest)) return null
  return {
    device: device.id,
    scopes: device.scopes as readonly Scope[],
    host: device.host,
    csrf: device.csrf,
    proved: device.passkey?.proved ?? null,
    theirs: theirsOf(device),
  }
}

/**
 * A presented secret against a stored digest, in constant time.
 *
 * Hashed first, then compared as bytes of equal length — so the comparison is
 * of two 32-byte digests whatever was presented, and how long it takes says
 * nothing about how much of the secret was right.
 */
export function digestMatches(secret: string, stored: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(stored)) return false
  const got = Buffer.from(digestOf(secret), 'hex')
  const want = Buffer.from(stored, 'hex')
  return got.length === want.length && timingSafeEqual(got, want)
}

/**
 * The host a session was minted for, against the one offered — **including the
 * port**.
 *
 * Exact, and that is the honest half of the answer to cookies not being
 * isolated by port: the browser will send this cookie to anything else
 * listening on this address, and when it does, the `Host` will not be the one
 * this session was minted for. So that cookie is not a session here, and
 * whatever is listening on the other port cannot become one either.
 */
function sameCookieHost(minted: string, offered: string): boolean {
  // Byte-for-byte, case aside, and nothing cleverer. A rule that tried to
  // understand ports and default ports here would be a rule with a way through
  // it; the whole value a browser sent is compared with the whole value that
  // was minted, so same host on another port is deliberately not a session.
  return minted.toLowerCase() === offered.trim().toLowerCase()
}

/**
 * One cookie's value out of a `Cookie` header.
 *
 * The **last** one of a name wins, which is the direction that matters:
 * something else on another port of this address can set a cookie of this name
 * and a reader that took the first would be reading theirs. Taking the last
 * does not fix that — nothing in a cookie jar can — and what does is the
 * host-binding above, which refuses a value whichever one of them it was.
 */
export function cookieIn(header: string, name: string): string | null {
  let found: string | null = null
  for (const part of header.split(';')) {
    const at = part.indexOf('=')
    if (at === -1) continue
    if (part.slice(0, at).trim() !== name) continue
    found = part.slice(at + 1).trim()
  }
  return found
}

/**
 * The session cookie a request presented, and under which name.
 *
 * `__Host-` first, and the old name only where there is none: a page on a
 * shared domain can still plant a `tade_away` of its own, and with this order
 * it can never displace the session a phone was given under the prefix. **The
 * old name is still read** so that nobody is signed out by the upgrade
 * (`renamed` moves it), and what that leaves is narrow: a planted value is
 * read only by a browser holding no `__Host-` session, and it is a session
 * only if it is one somebody at this machine let in, for this exact host.
 */
export function presentedIn(header: string): { value: string; named: string } | null {
  for (const named of [HOST_COOKIE, COOKIE]) {
    const value = cookieIn(header, named)
    if (value !== null) return { value, named }
  }
  return null
}

/**
 * The `Set-Cookie` for a freshly minted session.
 *
 * `Secure` **only** over `https`, because a `Secure` cookie set over plain
 * HTTP is a cookie the browser discards — which would be a pairing that
 * appeared to work and then had no session. The flags that are unconditional
 * are the three that cost nothing and stop something: `HttpOnly` (theft, not
 * use), `SameSite=Strict` (the browser never attaching it cross-site at all),
 * `Path=/`.
 *
 * **`__Host-` wherever it can be `Secure`**, and the plain name where it
 * cannot, because the prefix requires `Secure`. It buys the `Domain` and
 * `Path` guarantees and **nothing** about ports (`COOKIES_IGNORE_PORTS`). Two
 * names cost nothing either: a session is bound to the one host it was minted
 * for (`sameCookieHost`), so a device never returns over the other transport
 * with it — another transport is another host, and another pairing.
 */
export function setCookie(value: string, secure: boolean, maxAgeMs = SESSION_MS): string {
  return cookieLine(secure ? HOST_COOKIE : COOKIE, value, secure, maxAgeMs)
}

function cookieLine(named: string, value: string, secure: boolean, maxAgeMs: number): string {
  const parts = [
    `${named}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * The `Set-Cookie`s that remove one: signing out, in the browser's own terms.
 *
 * On `https` both names, because a session from before the prefix is still
 * read under the old one, and a sign-out that left it would leave the session
 * the page had just been told was gone.
 */
export function clearCookie(secure: boolean): string[] {
  return (secure ? [HOST_COOKIE, COOKIE] : [COOKIE]).map((named) => cleared(named, secure))
}

function cleared(named: string, secure: boolean): string {
  const parts = [`${named}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/**
 * The `Set-Cookie`s that move a session from before `__Host-` under it, or null
 * where there is nothing to move.
 *
 * Only on `https`, the one place the prefix can be set, and only where the
 * request presented its session under the old name alone: the same value
 * under the new name, for what is left of the session, and the old one
 * cleared — so a phone paired before the prefix is moved the first time it is
 * used over `https`, and is never signed out by it. Nothing re-issues the old
 * name with a new `Max-Age` on `https`, so once a session lifetime has passed
 * no phone that paired there holds it; it is still read wherever no prefixed
 * one came (`presentedIn` says what that leaves), because over plain HTTP it
 * is the only name there is.
 */
export function renamed(
  header: string | null,
  origin: { scheme: string },
  maxAgeMs: number,
): string[] | null {
  if (origin.scheme !== 'https' || header === null) return null
  const presented = presentedIn(header)
  if (presented === null || presented.named !== COOKIE) return null
  return [setCookie(presented.value, true, maxAgeMs), cleared(COOKIE, true)]
}

/**
 * Whether using this session should push its expiry forward, and to when.
 *
 * Null for "not yet", which is the answer on all but one request a day. The
 * bound is what keeps a sliding expiry from being a write per request.
 */
export function renewal(device: Device, now: number): number | null {
  const until = now + SESSION_MS
  if (until - device.until < RENEW_AFTER_MS) return null
  return until
}

/**
 * The `Set-Cookie`s that carry a renewed expiry to the browser, or null where
 * the request presented no session under either name.
 *
 * **Sent with the renewal and with no other answer.** `renewal` already
 * decides when the expiry moves — once a day of use at most — and the
 * cookie's lifetime is the same number, so a phone used every morning holds a
 * cookie as far out as its session and a phone in a drawer loses both
 * together. Pairing set `Max-Age` once; before this the session slid and the
 * cookie did not, and a phone used every day lost it thirty days after it
 * paired. Not "when less than half is left": a browser never says how long a
 * cookie has, so that rule could only be judged against the session's own
 * expiry, which for a phone used daily is never less than twenty-nine days
 * away — and a cookie set once at pairing is exactly the one it would miss.
 *
 * **Under the name it came in under, and never less `Secure` than it was.**
 * A read cannot say its scheme — no `Origin` on one, so a read through
 * `tailscale serve` or Caddy is `http` to `originOf` — and the first request
 * of the day is a read. So `__Host-`, which only a browser on `https` holds,
 * is set again as itself; the old name on an origin that said `https` moves
 * under the prefix (`renamed`), as an act moves it; the old name on a host
 * the config trusts — what a proxy ends TLS for — is `Secure`, which a browser
 * on plain HTTP discards rather than stores, so the worst it does there is not
 * renew, where the plain line would take `Secure` off a cookie that had it;
 * and anywhere else it is plain HTTP, a LAN address or this machine's own
 * name, and is set again as it was.
 */
export function renewedCookie(
  header: string | null,
  origin: { scheme: string; host: string },
  surface: Surface,
  maxAgeMs: number,
): string[] | null {
  if (header === null) return null
  const moved = renamed(header, origin, maxAgeMs)
  if (moved !== null) return moved
  const presented = presentedIn(header)
  if (presented === null) return null
  const secure =
    presented.named === HOST_COOKIE ||
    surface.trustedHosts.some((one) => sameHost(one, origin.host))
  return [cookieLine(presented.named, presented.value, secure, maxAgeMs)]
}
