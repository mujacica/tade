import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { Device } from './devices.ts'
import type { Session } from './guard.ts'
import type { Scope } from './surface.ts'

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
// forward at most once a day, so somebody who opens Tade on their phone every
// morning never signs in again and a phone in a drawer expires on its own. A
// renewal per request would be a write per request, which is a file of them.

/** How long a session lasts, and how often using it pushes that forward. */
export const SESSION_MS = 30 * 24 * 60 * 60_000
export const RENEW_AFTER_MS = 24 * 60 * 60_000

/** The cookie's name. */
export const COOKIE = 'tade_away'

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
 *
 * `randomBytes` and not `Math.random`, and said here because this is the line
 * where getting it wrong would be invisible: a predictable secret fails no
 * test, serves every page correctly, and is a session anybody can mint.
 */
export function mint(): Minted {
  const device = randomBytes(DEVICE_BYTES).toString('hex')
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
  const value = cookieIn(cookie, COOKIE)
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
 * The `Set-Cookie` for a freshly minted session.
 *
 * `Secure` **only** over `https`, because a `Secure` cookie set over plain
 * HTTP is a cookie the browser discards — which would be a pairing that
 * appeared to work and then had no session. The flags that are unconditional
 * are the three that cost nothing and stop something: `HttpOnly` (theft, not
 * use), `SameSite=Strict` (the browser never attaching it cross-site at all),
 * `Path=/`.
 *
 * **No `__Host-` prefix, and not because it is unavailable.** It requires
 * `Secure`, so it could be used on the `https` path — and it would buy the
 * `Domain` and `Path` guarantees while buying **nothing** about ports, which is
 * the problem it gets named as the fix for (`COOKIES_IGNORE_PORTS`). A prefix
 * that changes the cookie's *name* between the two transports would also mean a
 * device that paired over one and returns over the other silently has no
 * session. So: one name, and the honest mitigations.
 */
export function setCookie(value: string, secure: boolean, maxAgeMs = SESSION_MS): string {
  const parts = [
    `${COOKIE}=${value}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** The `Set-Cookie` that removes one: signing out, in the browser's own terms. */
export function clearCookie(secure: boolean): string {
  const parts = [`${COOKIE}=`, 'HttpOnly', 'SameSite=Strict', 'Path=/', 'Max-Age=0']
  if (secure) parts.push('Secure')
  return parts.join('; ')
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
