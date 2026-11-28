import { describe, expect, it } from 'vitest'
import { admit, REVISIONS_BEHIND, type Standing } from '../src/acts.ts'
import type { Origin, Surface } from '../src/surface.ts'
import { type Asked, CLOSE, PARK, STOP, type Verb } from '../src/verbs.ts'

// What has to be true of an *act*, asked as the cross-product.
//
// The same decision as `guard.test.ts` and for the same reason: a gate that
// could only be tested by making a request would have each of these asked once
// each, for whichever one somebody remembered. Every line of `admit` is a
// re-check — each was true when the device paired, or when the page drew the
// control — so what these say is that *stopping* being true is caught.

const ON: Surface = {
  enabled: true,
  bind: 'loopback',
  port: 7654,
  trustedHosts: ['studio.yak-bebop.ts.net'],
  publicName: null,
  passkeyMs: 0,
  acting: true,
  talking: false,
  installing: false,
  keepsView: false,
  pushing: false,
  pushDetails: false,
}

const HERE: Origin = { scheme: 'http', host: '127.0.0.1', listener: 'loopback' }
const TUNNEL: Origin = { scheme: 'https', host: 'studio.yak-bebop.ts.net', listener: 'loopback' }
const WIFI: Origin = { scheme: 'http', host: '192.168.1.10', listener: 'public' }

function standing(over: Partial<Standing> = {}): Standing {
  return {
    surface: ON,
    unlocked: true,
    rev: 100,
    origin: HERE,
    ...over,
  }
}

function park(over: Record<string, unknown> = {}): Asked {
  const got = PARK.read({
    task: 'tade/away-action-gate',
    parked: true,
    was: 'p0',
    key: 'abcdefgh12345678',
    rev: 100,
    ...over,
  })
  if (!got.ok) throw new Error('that body did not parse')
  return got.asked
}

describe('an act that is allowed', () => {
  it('goes through from this machine', () => {
    expect(admit(park(), standing())).toEqual({ ok: true })
  })

  it('goes through from a trusted https origin, which is the remote path', () => {
    expect(admit(park(), standing({ origin: TUNNEL }))).toEqual({ ok: true })
  })
})

describe('the capability, read at the act', () => {
  it('is refused when the setting was turned off a second ago', () => {
    // The **live** half of the setting. The route table was built when the
    // window started, so this is the only thing that can answer a person who
    // turned acting off and did not restart.
    const no = admit(park(), standing({ unlocked: false }))
    expect(no.ok).toBe(false)
    if (no.ok) return
    expect(no.refusal.error).toBe('locked')
    expect(no.refusal.status).toBe(403)
  })

  it('is refused when the surface says off, even if the live read says on', () => {
    // Both, because they are two readings of the same setting and the safe
    // answer is the stricter of them: a window handed a surface with acting
    // off must not be talked into an act by a reader that says otherwise.
    const no = admit(park(), standing({ surface: { ...ON, acting: false } }))
    expect(no.ok).toBe(false)
    if (!no.ok) expect(no.refusal.error).toBe('locked')
  })
})

describe('the project', () => {
  it('is asked only to be named: every paired device reaches every project', () => {
    expect(admit(park({ task: 'other/thing' }), standing())).toEqual({ ok: true })
  })
})

describe('the origin, re-asked at the act', () => {
  it('refuses plain http across a network', () => {
    // **The one check that is only ever a re-check**: the network a device is
    // on changes under it, so a phone that acts on the sofa reads and
    // does nothing else on somebody's wifi. A credential that crossed a
    // network in the clear never buys an act.
    const no = admit(park(), standing({ origin: WIFI }))
    expect(no.ok).toBe(false)
    if (!no.ok) {
      expect(no.refusal.error).toBe('locked')
      expect(no.why).toContain('not a trusted origin')
    }
  })

  it('refuses this machine’s name that came in on a public listener', () => {
    // The guard already refuses it at the door; this is the gate asking again
    // at the act, with the listener the origin carries, so neither half of
    // `thisMachine` is something a later door could lose on the way.
    const no = admit(park(), standing({ origin: { ...HERE, listener: 'public' } }))
    expect(no.ok).toBe(false)
    if (!no.ok) expect(no.refusal.error).toBe('locked')
    expect(admit(park(), standing({ origin: HERE })).ok).toBe(true)
  })

  it('refuses an https origin Tade was never told about', () => {
    // Somebody else's name resolving here. `trusted_hosts` is the only way an
    // origin off this machine is trusted, because no forwarded header is read.
    expect(
      admit(
        park(),
        standing({ origin: { scheme: 'https', host: 'evil.example', listener: 'public' } }),
      ).ok,
    ).toBe(false)
  })

  it('refuses a trusted name over plain http, which is the downgrade', () => {
    expect(
      admit(
        park(),
        standing({
          origin: { scheme: 'http', host: 'studio.yak-bebop.ts.net', listener: 'loopback' },
        }),
      ).ok,
    ).toBe(false)
  })
})

describe('how old the screen was', () => {
  it('allows a screen a few revisions behind, because every screen is', () => {
    expect(admit(park({ rev: 100 - REVISIONS_BEHIND }), standing()).ok).toBe(true)
  })

  it('refuses one further behind than that', () => {
    const no = admit(park({ rev: 100 - REVISIONS_BEHIND - 1 }), standing())
    expect(no.ok).toBe(false)
    if (!no.ok) {
      expect(no.refusal.error).toBe('stale')
      expect(no.refusal.status).toBe(409)
    }
  })

  it('refuses a screen ahead of the server, which is a claim nobody can make', () => {
    // A clock from the future is a client making something up, or a window
    // that restarted and lost its revisions. Never trusted, in either case.
    expect(admit(park({ rev: 101 }), standing()).ok).toBe(false)
  })
})

describe('the lifecycle verbs, at the gate', () => {
  function lifecycle(verb: Verb, body: Record<string, unknown>): Asked {
    const got = verb.read({ key: 'abcdefgh12345678', rev: 100, ...body })
    if (!got.ok) throw new Error(`that ${verb.name} body did not parse`)
    return got.asked
  }
  const stop = lifecycle(STOP, { task: 'tade/away-action-gate', was: 'p0', confirm: true })
  const close = lifecycle(CLOSE, { project: 'tade', was: 'o1.c0', confirm: true })

  it('goes through for a paired device, for an agent and for a project alike', () => {
    for (const asked of [stop, close]) {
      expect(admit(asked, standing()), asked.verb).toEqual({ ok: true })
    }
  })

  it('is read-only over a network in the clear', () => {
    const wifi = standing({ origin: WIFI })
    for (const asked of [stop, close]) {
      const no = admit(asked, wifi)
      expect(no.ok, asked.verb).toBe(false)
      if (!no.ok) expect(no.refusal.error).toBe('locked')
    }
  })
})
