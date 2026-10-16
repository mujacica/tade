import { describe, expect, it } from 'vitest'
import type { Device } from '../src/devices.ts'
import {
  COOKIE,
  clearCookie,
  cookieIn,
  digestMatches,
  digestOf,
  HOST_COOKIE,
  mint,
  presentedIn,
  RENEW_AFTER_MS,
  renamed,
  renewal,
  SESSION_MS,
  sessionOf,
  setCookie,
  splitCookie,
} from '../src/sessions.ts'

const NOW = Date.parse('2026-10-08T12:00:00Z')

function device(over: Partial<Device> = {}): Device {
  const minted = mint()
  return {
    id: minted.device,
    label: 'iPhone',
    digest: minted.digest,
    host: '192.168.1.10:7654',
    csrf: minted.csrf,
    until: NOW + SESSION_MS,
    pairedAt: NOW,
    scopes: ['read'],
    projects: null,
    granted: [],
    from: '192.168.1.42',
    revoked: null,
    owner: false,
    passkey: null,
    ...over,
  }
}

/** One device, and the cookie value that is its credential. */
function paired(over: Partial<Device> = {}): { device: Device; cookie: string } {
  const minted = mint()
  const one = device({ id: minted.device, digest: minted.digest, csrf: minted.csrf, ...over })
  return { device: one, cookie: `${COOKIE}=${minted.cookie}` }
}

describe('minting a credential', () => {
  it('is 256 bits of randomBytes, different every time', () => {
    const seen = new Set<string>()
    for (let at = 0; at < 200; at++) seen.add(mint().cookie)
    expect(seen.size).toBe(200)
  })

  it('writes down only the digest, never the secret', () => {
    const minted = mint()
    const secret = minted.cookie.split('.')[1] ?? ''
    expect(minted.digest).toBe(digestOf(secret))
    expect(minted.digest).not.toContain(secret)
    expect(minted.digest).toMatch(/^[0-9a-f]{64}$/)
    // An agent that reads the device list finds a digest it cannot present.
    expect(digestMatches(minted.digest, minted.digest)).toBe(false)
  })

  it('mints a token that is not the secret', () => {
    const minted = mint()
    expect(minted.csrf).not.toBe(minted.cookie)
    expect(minted.csrf.length).toBe(43)
  })
})

describe('verifying one', () => {
  it('accepts the credential it minted', () => {
    const { device: one, cookie } = paired()
    const session = sessionOf(cookie, [one], one.host, NOW)
    expect(session?.device).toBe(one.id)
    expect(session?.scopes).toEqual(['read'])
  })

  it('refuses a missing cookie, and a cookie header with other things in it', () => {
    const { device: one, cookie } = paired()
    expect(sessionOf(null, [one], one.host, NOW)).toBeNull()
    expect(sessionOf('', [one], one.host, NOW)).toBeNull()
    expect(sessionOf('other=1; another=2', [one], one.host, NOW)).toBeNull()
    expect(sessionOf(`other=1; ${cookie}; another=2`, [one], one.host, NOW)).not.toBeNull()
  })

  it('refuses an expired session', () => {
    const { device: one, cookie } = paired({ until: NOW - 1 })
    expect(sessionOf(cookie, [one], one.host, NOW)).toBeNull()
    // And exactly at the moment it expires, which is the boundary somebody
    // writes `>` for and means `>=`.
    const edge = paired({ until: NOW })
    expect(sessionOf(edge.cookie, [edge.device], edge.device.host, NOW)).toBeNull()
  })

  it('refuses a revoked one, however long it has left', () => {
    const { device: one, cookie } = paired({ revoked: 'revoked at the machine' })
    expect(sessionOf(cookie, [one], one.host, NOW)).toBeNull()
  })

  it('refuses one minted for another host, which is the cookie-port answer', () => {
    // A cookie reaches every listener on this address. When it does, the
    // `Host` is not the one this session was minted for — so it is not a
    // session, and whatever is on the other port cannot become one either.
    const { device: one, cookie } = paired({ host: '192.168.1.10:7654' })
    expect(sessionOf(cookie, [one], '192.168.1.10:3000', NOW)).toBeNull()
    expect(sessionOf(cookie, [one], 'localhost:7654', NOW)).toBeNull()
    expect(sessionOf(cookie, [one], '192.168.1.10:7654', NOW)).not.toBeNull()
  })

  it('refuses a secret that is right for another device', () => {
    const a = paired()
    const b = paired()
    // b's secret under a's device id, which is the shape of somebody who read
    // the device list and has one real credential.
    const swapped = `${COOKIE}=${a.device.id}.${b.cookie.split('.')[1]}`
    expect(sessionOf(swapped, [a.device, b.device], a.device.host, NOW)).toBeNull()
  })

  it('refuses a value that is not the shape of a credential at all', () => {
    const { device: one } = paired()
    for (const value of [
      'nodot',
      '.onlysecret',
      `${one.id}.`,
      `${one.id}.short`,
      `nothex0123456789.${'A'.repeat(43)}`,
      `${one.id}.${'A'.repeat(44)}`,
      `${one.id}.${'A'.repeat(42)}`,
      `${one.id}.${'+'.repeat(43)}`,
    ])
      expect(sessionOf(`${COOKIE}=${value}`, [one], one.host, NOW), value).toBeNull()
  })

  it('refuses a stored digest that is not one', () => {
    expect(digestMatches('whatever', 'not a digest')).toBe(false)
    expect(digestMatches('whatever', '')).toBe(false)
  })

  it('takes the last cookie of a name, not the first', () => {
    // Something on another port of this address can set a cookie of this name.
    // Taking the last does not fix that — nothing in a cookie jar can — and
    // the host binding above is what refuses it whichever one it was.
    expect(cookieIn(`${COOKIE}=theirs; ${COOKIE}=ours`, COOKIE)).toBe('ours')
    expect(cookieIn('novalue; a=1', 'novalue')).toBeNull()
  })

  it('reads a session under __Host- first, and under the old name only where there is none', () => {
    // A page on a shared tunnel domain can plant a `tade_away` of its own, and
    // can never plant a `__Host-` one: the browser refuses it. So with both
    // present the prefixed one is the session, and a planted value cannot
    // displace it — the old name is read for a phone paired before the prefix.
    const ours = paired()
    const theirs = paired()
    const both = `${COOKIE}=${theirs.cookie.split('=')[1]}; ${HOST_COOKIE}=${ours.cookie.split('=')[1]}`
    const devices = [ours.device, theirs.device]
    expect(sessionOf(both, devices, ours.device.host, NOW)?.device).toBe(ours.device.id)
    expect(sessionOf(theirs.cookie, devices, theirs.device.host, NOW)?.device).toBe(
      theirs.device.id,
    )
    expect(presentedIn(both)?.named).toBe(HOST_COOKIE)
    expect(presentedIn(theirs.cookie)?.named).toBe(COOKIE)
    expect(presentedIn('a=1')).toBeNull()
  })
})

describe('the cookie’s flags', () => {
  it('is HttpOnly, SameSite=Strict and Path=/ always', () => {
    const set = setCookie('abc', false)
    expect(set).toContain('HttpOnly')
    expect(set).toContain('SameSite=Strict')
    expect(set).toContain('Path=/')
    expect(set).toContain(`Max-Age=${SESSION_MS / 1000}`)
  })

  it('is Secure over https and not over http, because the browser would drop it', () => {
    expect(setCookie('abc', true)).toContain('Secure')
    expect(setCookie('abc', false)).not.toContain('Secure')
  })

  it('is __Host- over https, and the plain name where it cannot be Secure', () => {
    // The prefix requires `Secure`, `Path=/` and no `Domain`, which is every
    // flag this cookie already had, and gives real guarantees about those
    // three: a sibling name on a shared domain cannot plant one. It gives
    // nothing about ports — RFC 6265 §8.5 is unchanged by it — and the two
    // names never meet, because a session is bound to one host and another
    // transport is another host.
    expect(setCookie('abc', true).startsWith(`${HOST_COOKIE}=abc; `)).toBe(true)
    expect(setCookie('abc', false).startsWith(`${COOKIE}=abc; `)).toBe(true)
    expect(HOST_COOKIE).toBe(`__Host-${COOKIE}`)
    expect(setCookie('abc', true)).not.toContain('Domain')
  })

  it('clears with the same flags, so a Secure one is actually cleared', () => {
    for (const one of clearCookie(true)) {
      expect(one).toContain('Max-Age=0')
      expect(one).toContain('Secure')
    }
    expect(clearCookie(false)).toEqual([expect.not.stringContaining('Secure')])
  })

  it('clears both names on https, so a session from before the prefix goes too', () => {
    expect(clearCookie(true).map((one) => one.split('=')[0])).toEqual([HOST_COOKIE, COOKIE])
    expect(clearCookie(false).map((one) => one.split('=')[0])).toEqual([COOKIE])
  })
})

describe('moving a session from before __Host- under it', () => {
  const HTTPS = { scheme: 'https' }
  const value = `${'0'.repeat(16)}.${'A'.repeat(43)}`

  it('moves the old name over https: the same value under the prefix, the old one cleared', () => {
    // Nobody is signed out by the upgrade. The value is the one the request
    // presented — the credential in the phone does not change — and it lasts
    // what the session has left, never a fresh thirty days.
    const moved = renamed(`${COOKIE}=${value}`, HTTPS, 3_600_000)
    expect(moved).toHaveLength(2)
    expect(moved?.[0]?.startsWith(`${HOST_COOKIE}=${value}; `)).toBe(true)
    expect(moved?.[0]).toContain('Max-Age=3600')
    expect(moved?.[0]).toContain('Secure')
    expect(moved?.[1]?.startsWith(`${COOKIE}=; `)).toBe(true)
    expect(moved?.[1]).toContain('Max-Age=0')
  })

  it('moves nothing over http, which cannot hold the prefix, or what is already moved', () => {
    expect(renamed(`${COOKIE}=${value}`, { scheme: 'http' }, 3_600_000)).toBeNull()
    expect(renamed(`${HOST_COOKIE}=${value}`, HTTPS, 3_600_000)).toBeNull()
    expect(renamed(`${COOKIE}=x; ${HOST_COOKIE}=${value}`, HTTPS, 3_600_000)).toBeNull()
    expect(renamed(null, HTTPS, 3_600_000)).toBeNull()
    expect(renamed('a=1', HTTPS, 3_600_000)).toBeNull()
  })
})

describe('the sliding expiry', () => {
  it('does not renew on a session used again the same hour', () => {
    const one = device({ until: NOW + SESSION_MS })
    expect(renewal(one, NOW)).toBeNull()
    expect(renewal(one, NOW + RENEW_AFTER_MS - 1)).toBeNull()
  })

  it('renews once a day has passed, and pushes it a full term out', () => {
    const one = device({ until: NOW + SESSION_MS })
    const at = NOW + RENEW_AFTER_MS
    expect(renewal(one, at)).toBe(at + SESSION_MS)
  })

  it('renews a session that is nearly out, which is the point of it', () => {
    const one = device({ until: NOW + 60_000 })
    expect(renewal(one, NOW)).toBe(NOW + SESSION_MS)
  })
})

describe('splitting a credential', () => {
  it('is the device id and the secret, and nothing else is either', () => {
    const minted = mint()
    expect(splitCookie(minted.cookie)).toEqual({
      device: minted.device,
      secret: minted.cookie.split('.')[1],
    })
    expect(splitCookie('')).toBeNull()
    expect(splitCookie('.')).toBeNull()
  })
})
