import { describe, expect, it } from 'vitest'
import { type Asking, allowed, type Guarding, proven } from '../src/guard.ts'
import { ROUTES } from '../src/routes.ts'
import type { Surface } from '../src/surface.ts'

// The passkey's gate (`proven`, the eighth layer of `allowed`), as the
// cross-product — beside `guard.test.ts` rather than inside it, which holds
// the seven before it. `passkey.test.ts` is the same gate over a real socket.

const NOW = Date.parse('2026-10-16T12:00:00Z')

const LAN: Surface = {
  enabled: true,
  bind: 'lan',
  port: 7654,
  trustedHosts: ['studio.yak-bebop.ts.net'],
  publicName: null,
  passkeyMs: 0,
  acting: true,
  talking: false,
  drafting: false,
  configuring: false,
  installing: false,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

const SESSION = {
  device: '00112233445566aa',
  scopes: ['read'] as const,
  host: '192.168.1.10:7654',
  csrf: 'x'.repeat(43),
  proved: null,
}

function guarding(over: Partial<Guarding> = {}): Guarding {
  return { surface: LAN, bound: ['192.168.1.10', '::1'], session: SESSION, now: NOW, ...over }
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
    listener: 'public',
    ...over,
  }
}

const READ = (() => {
  const found = ROUTES.find((one) => one.name === 'snapshot')
  if (found === undefined) throw new Error('no snapshot route')
  return found
})()

describe('a passkey before acting from the public listener', () => {
  // REMOTE-TADE.md §4.4, V5: a session is a bearer credential for thirty days,
  // so from the public name an act also needs a proof younger than the
  // setting — and reading never does. Every cell of {listener} × {setting} ×
  // {when it was last proved} × {read, act}, because the gate that is easy to
  // get wrong is the one somebody tests once.
  const NAME = 'tade.example.com'
  const PUBLIC: Surface = {
    ...LAN,
    bind: 'loopback',
    trustedHosts: [NAME, 'studio.yak-bebop.ts.net'],
    publicName: NAME,
  }
  const HOUR = 3_600_000
  const listeners = {
    // Caddy's socket: the internet.
    public: { host: NAME, origin: `https://${NAME}`, listener: 'public' as const },
    // `tailscale serve` on this box, which is behind the person's own tailnet.
    loopback: {
      host: 'studio.yak-bebop.ts.net',
      origin: 'https://studio.yak-bebop.ts.net',
      listener: 'loopback' as const,
    },
  }
  const proofs = {
    never: null,
    'an hour ago': NOW - HOUR,
    'thirteen hours ago': NOW - 13 * HOUR,
    'from the future': NOW + HOUR,
  }
  for (const [where, at] of Object.entries(listeners)) {
    for (const hours of [0, 12]) {
      for (const [when, proved] of Object.entries(proofs)) {
        for (const needs of ['read', 'steer'] as const) {
          const asks = where === 'public' && hours > 0 && needs !== 'read'
          const fresh = proved !== null && proved <= NOW && NOW - proved < 12 * HOUR
          const ok = !asks || fresh
          it(`${where}, ${hours} hours, proved ${when}, ${needs}: ${ok ? 'allowed' : 'unproven'}`, () => {
            const verdict = allowed(
              asking({ host: at.host, origin: at.origin, listener: at.listener }),
              { ...READ, needs },
              guarding({
                surface: { ...PUBLIC, passkeyMs: hours * HOUR },
                session: { ...SESSION, host: at.host, scopes: ['read', 'steer'], proved },
              }),
            )
            expect(verdict.ok).toBe(ok)
            if (!verdict.ok) {
              expect(verdict.refusal.error).toBe('unproven')
              expect(verdict.refusal.status).toBe(403)
            }
          })
        }
      }
    }
  }

  it('is asked after the scope and the origin, so it never says more than they would', () => {
    // A device not granted the act, or on a plaintext origin, hears that —
    // not that a passkey would help.
    const unproven = { ...SESSION, host: NAME, proved: null }
    const surface = { ...PUBLIC, passkeyMs: 12 * HOUR }
    const at = { host: NAME, origin: `https://${NAME}`, listener: 'public' as const }
    const scope = allowed(
      asking(at),
      { ...READ, needs: 'steer' },
      guarding({ surface, session: { ...unproven, scopes: ['read'] } }),
    )
    expect(!scope.ok && scope.refusal.error).toBe('out_of_scope')
    const plain = allowed(
      asking({ ...at, origin: `http://${NAME}` }),
      { ...READ, needs: 'steer' },
      guarding({ surface, session: { ...unproven, scopes: ['read', 'steer'] } }),
    )
    expect(!plain.ok && plain.refusal.error).toBe('locked')
  })

  it('is asked of the listener, never of the host a request names', () => {
    expect(proven({ scheme: 'https', host: NAME, listener: 'loopback' }, null, PUBLIC, NOW)).toBe(
      true,
    )
    const asked = { ...PUBLIC, passkeyMs: HOUR }
    expect(proven({ scheme: 'https', host: NAME, listener: 'public' }, null, asked, NOW)).toBe(
      false,
    )
    expect(proven({ scheme: 'https', host: NAME, listener: 'loopback' }, null, asked, NOW)).toBe(
      true,
    )
  })
})
