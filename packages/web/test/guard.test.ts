import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type Asking,
  allowed,
  type Guarding,
  hostAllowed,
  hostOf,
  isJson,
  originMatches,
  originOf,
  parseOrigin,
  quoted,
  schemesFor,
  tokenMatches,
  Window,
} from '../src/guard.ts'
import { NEVER_TRUSTED } from '../src/headers.ts'
import type { Route } from '../src/routes.ts'
import { ROUTES } from '../src/routes.ts'
import type { Surface } from '../src/surface.ts'

// What has to be true before a route runs, asked as the cross-product rather
// than once per route somebody remembered.

const LAN: Surface = {
  enabled: true,
  bind: 'lan',
  port: 7654,
  trustedHosts: ['studio.yak-bebop.ts.net'],
  acting: true,
  talking: false,
  drafting: false,
}

const SESSION = {
  device: '00112233445566aa',
  scopes: ['read'] as const,
  host: '192.168.1.10:7654',
  csrf: 'x'.repeat(43),
}

function guarding(over: Partial<Guarding> = {}): Guarding {
  return { surface: LAN, bound: ['192.168.1.10', '::1'], session: SESSION, ...over }
}

function asking(over: Partial<Asking> = {}): Asking {
  return {
    method: 'GET',
    path: '/api/snapshot',
    host: '192.168.1.10:7654',
    origin: null,
    site: 'same-origin',
    contentType: null,
    token: null,
    cookie: 'tade_away=00112233445566aa.whatever',
    tls: false,
    from: '192.168.1.42',
    ...over,
  }
}

const READ = route('snapshot')
const PAIR = route('pair')
const SIGN_OUT = route('sign out')
const SHELL = route('shell')

function route(name: string): Route {
  const found = ROUTES.find((one) => one.name === name)
  if (found === undefined) throw new Error(`no route called ${name}`)
  return found
}

describe('the Host allow-list, which is the DNS-rebinding defence', () => {
  it('refuses a host that is not this machine, on a GET', () => {
    // The attack: a page at evil.example whose DNS answers with this machine's
    // address. The browser sends `Host: evil.example` and the cookie with it,
    // because a cookie follows the name and not the address. Refused before
    // anything is routed, which is why this check is on reads too.
    const verdict = allowed(asking({ host: 'evil.example' }), READ, guarding())
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.refusal.status).toBe(403)
      expect(verdict.refusal.error).toBe('bad_origin')
      // The host that was offered is in the journal's sentence and not the
      // page's: the page is told one thing, in Tade's words.
      expect(verdict.why).toContain('evil.example')
      expect(verdict.refusal.said).not.toContain('evil.example')
    }
  })

  it('refuses the same attack on the shell, which needs no session', () => {
    expect(allowed(asking({ host: 'evil.example' }), SHELL, guarding()).ok).toBe(false)
  })

  it('allows this machine in all three spellings, and the address it bound', () => {
    for (const host of ['localhost:7654', '127.0.0.1:7654', '[::1]:7654', '192.168.1.10:7654'])
      expect(hostAllowed(host, guarding()), host).toBe(true)
  })

  it('allows a trusted host out of the config, and nothing else', () => {
    expect(hostAllowed('studio.yak-bebop.ts.net', guarding())).toBe(true)
    expect(hostAllowed('studio.yak-bebop.ts.net.evil.example', guarding())).toBe(false)
    // The same name with the config empty: a trusted host is a thing somebody
    // wrote down, never one a request can claim.
    expect(
      hostAllowed('studio.yak-bebop.ts.net', guarding({ surface: { ...LAN, trustedHosts: [] } })),
    ).toBe(false)
  })

  it('never allows the wildcard it bound, because no browser asks for one', () => {
    const wide = guarding({ bound: ['0.0.0.0', '::'] })
    expect(hostAllowed('0.0.0.0:7654', wide)).toBe(false)
    expect(hostAllowed('[::]:7654', wide)).toBe(false)
  })

  it('refuses a Host that is two claims, or no claim at all', () => {
    expect(hostOf('a.example, b.example')).toBeNull()
    expect(hostOf('a.example b.example')).toBeNull()
    expect(hostOf('')).toBeNull()
    expect(hostOf('[::1')).toBeNull()
    expect(hostOf('a.example:notaport')).toBeNull()
    expect(hostAllowed(null, guarding())).toBe(false)
  })

  it('ignores the port when deciding the host, and keeps it everywhere else', () => {
    expect(hostOf('192.168.1.10:7654')).toBe('192.168.1.10')
    expect(hostOf('[::1]:7654')).toBe('[::1]')
    // But a session minted on one port is not a session on another: the host
    // check is port-insensitive, the session binding is not.
    const other = allowed(asking({ host: '192.168.1.10:9999' }), READ, guarding())
    expect(other.ok).toBe(false)
    if (!other.ok) expect(other.refusal.error).toBe('no_session')
  })
})

describe('Origin, on a mutation', () => {
  const mutation = (over: Partial<Asking> = {}): Asking =>
    asking({
      method: 'DELETE',
      path: '/api/devices/00112233445566aa',
      origin: 'http://192.168.1.10:7654',
      contentType: 'application/json',
      token: SESSION.csrf,
      ...over,
    })

  it('allows the exact origin of the host that was accepted', () => {
    expect(allowed(mutation(), SIGN_OUT, guarding()).ok).toBe(true)
  })

  it('refuses a mutation with no Origin at all', () => {
    // Absent is a refusal and not a pass. Every non-browser client sends no
    // `Origin`, and a verb is not for one.
    const verdict = allowed(mutation({ origin: null }), SIGN_OUT, guarding())
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toContain('no Origin')
  })

  it('refuses an origin on another port of this very address', () => {
    // The case the host check cannot see and the one that is real on a laptop:
    // a cookie reaches every listener on an address, so a dev server on 3000
    // of this machine is a different origin holding a perfectly good cookie.
    expect(allowed(mutation({ origin: 'http://192.168.1.10:3000' }), SIGN_OUT, guarding()).ok).toBe(
      false,
    )
  })

  it('refuses a prefix, a suffix and a scheme that do not match exactly', () => {
    for (const origin of [
      'http://192.168.1.10:7654.evil.example',
      'http://evil.example',
      'https://192.168.1.10:7654',
      'http://192.168.1.100:7654',
      'http://192.168.1.10',
      'null',
      'not an origin',
    ])
      expect(allowed(mutation({ origin }), SIGN_OUT, guarding()).ok, origin).toBe(false)
  })

  it('reads a default port as the default port', () => {
    const host = 'studio.yak-bebop.ts.net'
    expect(originMatches(`http://${host}`, host, ['http'])).toBe(true)
    expect(originMatches(`https://${host}`, `${host}:443`, ['https'])).toBe(true)
    expect(originMatches(`http://${host}`, `${host}:7654`, ['http'])).toBe(false)
  })

  it('refuses a scheme this listener could not have served', () => {
    // A page on `https://192.168.1.10:7654` would need TLS on this very
    // address, which is somebody already on the machine — so it is not the
    // attack this stops. What it stops is the claim being accepted at all,
    // which is what "exact match" has to mean to be worth saying.
    expect(originMatches('https://192.168.1.10:7654', '192.168.1.10:7654', ['http'])).toBe(false)
    expect(originMatches('http://192.168.1.10:7654', '192.168.1.10:7654', ['http'])).toBe(true)
  })

  it('allows https on a plaintext socket only for a host the config trusts', () => {
    // `tailscale serve` terminates TLS and connects to loopback in the clear,
    // so a genuine `https` origin arrives on a plaintext socket — for the
    // hosts somebody wrote down, and no others.
    expect(schemesFor(asking({ tls: false }), 'studio.yak-bebop.ts.net', LAN)).toEqual([
      'http',
      'https',
    ])
    expect(schemesFor(asking({ tls: false }), '192.168.1.10', LAN)).toEqual(['http'])
    expect(schemesFor(asking({ tls: true }), '192.168.1.10', LAN)).toEqual(['https'])
  })

  it('parses an origin, or says it is not one', () => {
    expect(parseOrigin('http://a.example:80')).toEqual({
      scheme: 'http',
      host: 'a.example',
      port: '80',
    })
    expect(parseOrigin('http://[::1]:7654')?.host).toBe('[::1]')
    for (const bad of ['', 'null', 'file:///etc/passwd', 'ws://a.example', 'http://a.example/path'])
      expect(parseOrigin(bad), bad).toBeNull()
  })
})

describe('Sec-Fetch-Site', () => {
  it('refuses a cross-site fetch of a data route', () => {
    for (const site of ['cross-site', 'same-site', 'none'])
      expect(allowed(asking({ site }), READ, guarding()).ok, site).toBe(false)
  })

  it('allows it absent, because curl and older browsers send none', () => {
    expect(allowed(asking({ site: null }), READ, guarding()).ok).toBe(true)
  })

  it('does not apply to opening the shell, which is how anybody ever opens it', () => {
    // A scanned code is a typed URL, which is `none`; a followed link is
    // `cross-site`. Requiring `same-origin` here would refuse every real way
    // in and allow only the one nobody uses.
    for (const site of ['none', 'cross-site', 'same-site', null])
      expect(allowed(asking({ site, path: '/' }), SHELL, guarding()).ok, String(site)).toBe(true)
  })
})

describe('the content type, so a form post is never a verb', () => {
  it('refuses the three types a cross-site form can send', () => {
    for (const contentType of [
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      null,
    ]) {
      const verdict = allowed(
        asking({
          method: 'POST',
          path: '/api/pair',
          origin: 'http://192.168.1.10:7654',
          contentType,
        }),
        PAIR,
        guarding(),
      )
      expect(verdict.ok, String(contentType)).toBe(false)
    }
  })

  it('allows JSON, parameters and casing aside', () => {
    for (const contentType of ['application/json', 'Application/JSON; charset=utf-8'])
      expect(
        allowed(
          asking({
            method: 'POST',
            path: '/api/pair',
            origin: 'http://192.168.1.10:7654',
            contentType,
          }),
          PAIR,
          guarding(),
        ).ok,
        contentType,
      ).toBe(true)
  })
})

describe('the session', () => {
  it('refuses a data read with none', () => {
    const verdict = allowed(asking(), READ, guarding({ session: null }))
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.refusal.status).toBe(401)
      expect(verdict.refusal.error).toBe('no_session')
    }
  })

  it('refuses one minted for another host, which is the port answer', () => {
    const verdict = allowed(
      asking({ host: 'localhost:7654' }),
      READ,
      guarding({ session: { ...SESSION, host: '192.168.1.10:7654' } }),
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.refusal.error).toBe('no_session')
  })

  it('refuses a mutation whose token is missing, wrong or the wrong length', () => {
    for (const token of [null, '', 'y'.repeat(43), 'x'.repeat(42), SESSION.csrf.slice(0, -1)]) {
      const verdict = allowed(
        asking({
          method: 'DELETE',
          path: '/api/devices/00112233445566aa',
          origin: 'http://192.168.1.10:7654',
          contentType: 'application/json',
          token,
        }),
        SIGN_OUT,
        guarding(),
      )
      expect(verdict.ok, String(token)).toBe(false)
      if (!verdict.ok) expect(verdict.refusal.error).toBe('bad_origin')
    }
  })

  it('compares the token without short-circuiting on length', () => {
    expect(tokenMatches('abc', 'abc')).toBe(true)
    expect(tokenMatches('abd', 'abc')).toBe(false)
    expect(tokenMatches('ab', 'abc')).toBe(false)
    expect(tokenMatches(null, 'abc')).toBe(false)
  })

  it('refuses a public mutating route that is not the one that mints a session', () => {
    // The combination nothing else would catch: no session needed *and* it
    // changes something is a route with no token layer. `routes.ts` carries
    // `opens` on the one route that is allowed to be both, and the guard
    // enforces it — so a route added as public and mutating without it is
    // refused at runtime rather than quietly exempt from the token.
    const { opens: _opens, ...careless } = PAIR
    const verdict = allowed(
      asking({
        method: 'POST',
        path: '/api/pair',
        origin: 'http://192.168.1.10:7654',
        contentType: 'application/json',
      }),
      careless,
      guarding({ session: null }),
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.why).toContain('without being the pairing route')
  })

  it('needs none for the shell or for pairing, which has none to present', () => {
    expect(allowed(asking({ path: '/' }), SHELL, guarding({ session: null })).ok).toBe(true)
    expect(
      allowed(
        asking({
          method: 'POST',
          path: '/api/pair',
          origin: 'http://192.168.1.10:7654',
          contentType: 'application/json',
        }),
        PAIR,
        guarding({ session: null }),
      ).ok,
    ).toBe(true)
  })
})

describe('the scope, and the trusted origin an act needs', () => {
  it('refuses a route the device was not granted', () => {
    const verdict = allowed(
      asking(),
      { ...READ, needs: 'steer' },
      guarding({ session: { ...SESSION, scopes: ['read'] } }),
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) expect(verdict.refusal.error).toBe('out_of_scope')
  })

  it('refuses an act over plain HTTP off this machine, however it was granted', () => {
    // DECISIONS §4.3, and the point of asking it here rather than at pairing:
    // the network a device is on changes, so a session that may steer on the
    // sofa may not steer from a cafe. A `locked`, which the page draws as
    // *that needs turning on at the machine*.
    const verdict = allowed(
      asking(),
      { ...READ, needs: 'steer' },
      guarding({ session: { ...SESSION, scopes: ['read', 'steer'] } }),
    )
    expect(verdict.ok).toBe(false)
    if (!verdict.ok) {
      expect(verdict.refusal.error).toBe('locked')
      expect(verdict.why).toContain('not a trusted origin')
    }
  })

  it('allows the same act from this machine, and from a trusted https host', () => {
    const steering = { ...READ, needs: 'steer' as const }
    const session = { ...SESSION, scopes: ['read', 'steer'] as const }
    expect(
      allowed(
        asking({ host: 'localhost:7654' }),
        steering,
        guarding({ session: { ...session, host: 'localhost:7654' } }),
      ).ok,
    ).toBe(true)
    expect(
      allowed(
        asking({
          host: 'studio.yak-bebop.ts.net',
          origin: 'https://studio.yak-bebop.ts.net',
        }),
        steering,
        guarding({ session: { ...session, host: 'studio.yak-bebop.ts.net' } }),
      ).ok,
    ).toBe(true)
  })

  it('reads the origin’s scheme and not the socket, because a proxy terminates TLS', () => {
    // `tailscale serve` connects to loopback in the clear and serves `https`
    // to the phone, so the socket says plaintext and the credential did not
    // travel in the clear. The browser's own `Origin` is what says which.
    expect(
      originOf(
        asking({ origin: 'https://studio.yak-bebop.ts.net', tls: false }),
        'studio.yak-bebop.ts.net',
      ),
    ).toEqual({ scheme: 'https', host: 'studio.yak-bebop.ts.net', port: '' })
    // And an `Origin` for some other host is not this request's origin.
    expect(originOf(asking({ origin: 'https://evil.example' }), '192.168.1.10')).toEqual({
      scheme: 'http',
      host: '192.168.1.10',
    })
  })

  it('needs no trusted origin to read, which is the whole of what a LAN is for', () => {
    expect(allowed(asking(), READ, guarding()).ok).toBe(true)
  })
})

describe('no forwarded header is read anywhere', () => {
  it('names none of them in any source file of this package', () => {
    // The attack each of these buys for one line of trust: `X-Forwarded-For`
    // makes the rate limit and the journalled address whatever the attacker
    // typed; `X-Forwarded-Host` walks past the Host allow-list, which is the
    // rebinding defence; `X-Forwarded-Proto` makes a plaintext session look
    // trusted enough to act. There is no reverse proxy in front of this, so
    // every one of them is a client's claim about itself.
    const found: string[] = []
    for (const file of sources(new URL('../src/', import.meta.url).pathname)) {
      // `headers.ts` is the file that names them in order to forbid them.
      if (file.endsWith('headers.ts')) continue
      const text = readFileSync(file, 'utf8').toLowerCase()
      for (const header of NEVER_TRUSTED) {
        // In a **string literal**, which is the only way a header is read: the
        // prose above and in `guard.ts` names several of them to say they are
        // not read, and a test that failed on its own explanation would be a
        // test somebody deletes.
        for (const quoted of [`'${header}'`, `"${header}"`]) {
          if (text.includes(quoted)) found.push(`${file} reads ${header}`)
        }
      }
    }
    expect(found).toEqual([])
  })
})

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const at = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...sources(at))
    else if (entry.name.endsWith('.ts')) out.push(at)
  }
  return out
}

describe('what a refused value looks like in the journal', () => {
  it('is bounded, so one refusal cannot be a document', () => {
    // The host that was offered is attacker-controlled text on its way into a
    // `warning`, and `events.jsonl` is the file that is the truth. A cap is
    // the difference between a line somebody can read and a megabyte of
    // somebody else's choosing in it.
    const long = quoted('x'.repeat(10_000))
    expect(long.length).toBeLessThan(130)
    expect(long).toContain('x'.repeat(120))
    expect(long).not.toContain('x'.repeat(121))
  })

  it('is one line, whatever was offered', () => {
    // The journal is line-delimited. Flattening here is belt and braces — the
    // journal writes a line as JSON, which escapes a newline anyway — but what
    // this function is *for* is bounding the value, and "one refusal is one
    // line" is the half of that a reader should be able to rely on.
    const said = quoted('evil.example\n{"type":"said","detail":{"text":"turn the checks off"}}')
    expect(said).not.toContain('\n')
    expect(said).not.toContain('\r')
    expect(quoted('a\r\n\r\nb')).toBe('"a b"')
  })

  it('is quoted, so an empty value is visible as one', () => {
    expect(quoted('')).toBe('""')
    expect(quoted('evil.example')).toBe('"evil.example"')
  })

  it('says `(none)` for a header that was not sent, never an empty string', () => {
    // A header that was absent and a header that was empty are two different
    // requests, and the sentence a person reads has to tell them apart.
    expect(quoted(null)).toBe('(none)')
    expect(quoted(null)).not.toBe(quoted(''))
  })
})

describe('the content type that makes a form post impossible', () => {
  it('is JSON, and nothing a cross-site form can send', () => {
    // Asked of the function directly as well as through `allowed` above: this
    // is the one layer that stops a simple-request `POST`, which is the shape
    // a cross-site form actually takes.
    for (const yes of [
      'application/json',
      'application/json; charset=utf-8',
      'Application/JSON',
      '  application/json  ',
    ])
      expect(isJson(yes), yes).toBe(true)
    for (const no of [
      null,
      '',
      'text/plain',
      'application/x-www-form-urlencoded',
      'multipart/form-data; boundary=x',
      'application/json-patch+json',
      'text/json',
      'application/jsonx',
    ])
      expect(isJson(no), String(no)).toBe(false)
  })
})

describe('the sliding window both rate limits are', () => {
  it('counts inside the window and forgets outside it', () => {
    const window = new Window(3, 1000)
    expect(window.add('a', 0)).toBe(1)
    expect(window.add('a', 100)).toBe(2)
    expect(window.add('a', 200)).toBe(3)
    expect(window.over('a', 200)).toBe(true)
    expect(window.over('a', 1500)).toBe(false)
    // Another key is another allowance: one noisy peer does not lock out the
    // phone in somebody's pocket.
    expect(window.over('b', 200)).toBe(false)
  })

  it('says how long to wait, in whole seconds and never nought', () => {
    const window = new Window(1, 10_000)
    window.add('a', 0)
    expect(window.after('a', 0)).toBe(10)
    expect(window.after('a', 9_500)).toBe(1)
    expect(window.after('nobody', 0)).toBe(0)
  })

  it('is bounded, so a stream of made-up peers is not a leak', () => {
    const window = new Window(5, 60_000, 4)
    for (let at = 0; at < 50; at++) window.add(`peer-${at}`, at)
    // Over the ceiling it is cleared, which loses counts and so can only ever
    // forgive — never refuse somebody it should not have.
    expect(window.count('peer-49', 50)).toBeLessThanOrEqual(1)
  })
})
