import { describe, expect, it } from 'vitest'
import type { Device } from '../src/devices.ts'
import {
  COOKIE,
  clearCookie,
  cookieIn,
  digestMatches,
  digestOf,
  mint,
  RENEW_AFTER_MS,
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

  it('carries no __Host- prefix, which does not isolate ports', () => {
    // DECISIONS §4.4(1): the prefix requires `Secure`, `Path=/` and no
    // `Domain` and gives real guarantees about those three. It gives nothing
    // about ports — RFC 6265 §8.5 is unchanged by it — and changing the
    // cookie's *name* between transports would silently sign out a device
    // that paired over the other one.
    expect(setCookie('abc', true)).not.toContain('__Host-')
    expect(COOKIE).not.toContain('__Host')
  })

  it('clears with the same flags, so a Secure one is actually cleared', () => {
    expect(clearCookie(true)).toContain('Max-Age=0')
    expect(clearCookie(true)).toContain('Secure')
    expect(clearCookie(false)).not.toContain('Secure')
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
