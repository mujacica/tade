import { describe, expect, it } from 'vitest'
import {
  anyRoute,
  REACH_EVERY_MS,
  REACHING,
  reached,
  reachedResolver,
  reachSaid,
  shouldLook,
  WATCHES_LOOKING,
  WATCHES_PAUSED,
} from '../src/network.ts'

// Whether this machine can reach anything, as a table.
//
// Every question here is answered from what was observed, so all of it is a
// table and none of it needs a network — which is the point: the one thing
// this must never do is decide that a machine is offline because a service
// said something.

const lo = { address: '127.0.0.1', internal: true }

describe('a way off this machine', () => {
  it('is an interface that is neither loopback nor waiting for one', () => {
    expect(anyRoute({})).toBe(false)
    expect(anyRoute({ lo0: [lo] })).toBe(false)
    expect(anyRoute({ lo0: [lo], en0: [{ address: '192.168.1.24', internal: false }] })).toBe(true)
    expect(anyRoute({ en0: [{ address: '2a02:1:2::9', internal: false }] })).toBe(true)
  })

  it('is not an address an interface gave itself', () => {
    // What an interface has when it came up and got no configuration, which is
    // exactly the state a machine with the wifi off is in. Counting these is
    // how "there is a route" would come back true all night.
    expect(anyRoute({ en0: [{ address: '169.254.13.2', internal: false }] })).toBe(false)
    expect(anyRoute({ awdl0: [{ address: 'fe80::1c9a:ff:fe3d:1', internal: false }] })).toBe(false)
    expect(anyRoute({ utun0: [{ address: 'FE80::4', internal: false }] })).toBe(false)
    expect(
      anyRoute({
        en0: [{ address: '169.254.13.2', internal: false }],
        utun3: [{ address: '10.8.0.6', internal: false }],
      }),
    ).toBe(true)
  })

  it('answers about an interface with nothing on it', () => {
    expect(anyRoute({ en0: undefined, en1: [] })).toBe(false)
  })
})

describe('a name lookup that failed', () => {
  it('counts as a network where a resolver answered', () => {
    // A resolver saying "no such name" is a resolver that was reached, and a
    // machine that reached one is not offline however wrong the name was.
    expect(reachedResolver('ENOTFOUND')).toBe(true)
    expect(reachedResolver('NXDOMAIN')).toBe(true)
    expect(reachedResolver('ENODATA')).toBe(true)
    expect(reachedResolver('EBADNAME')).toBe(true)
  })

  it('counts as no network where nothing came back', () => {
    expect(reachedResolver('ETIMEOUT')).toBe(false)
    expect(reachedResolver('ECONNREFUSED')).toBe(false)
    expect(reachedResolver('ENETUNREACH')).toBe(false)
    // The resolver could not do its job, which is what a router answers with
    // its own uplink down.
    expect(reachedResolver('ESERVFAIL')).toBe(false)
    // Nothing said at all, which is what a deadline gives you.
    expect(reachedResolver(undefined)).toBe(false)
  })
})

describe('the reach', () => {
  it('starts online, having asked nobody anything', () => {
    expect(REACHING.online).toBe(true)
    expect(REACHING.since).toBeNull()
    expect(REACHING.hosts).toEqual([])
  })

  it('remembers when it went offline, and keeps that moment while it stays offline', () => {
    const went = reached(REACHING, { online: false }, 1_000)
    expect(went).toMatchObject({ online: false, since: 1_000, looked: 1_000 })
    const still = reached(went, { online: false }, 9_000)
    expect(still).toMatchObject({ online: false, since: 1_000, looked: 9_000 })
    expect(reached(still, { online: true }, 20_000).since).toBeNull()
  })

  it('keeps the hosts a watch could not reach, newest first and without repeats', () => {
    let reach = reached(REACHING, { online: false, host: 'github.com' }, 1)
    reach = reached(reach, { online: false, host: 'sentry.io' }, 2)
    reach = reached(reach, { online: false, host: 'github.com' }, 3)
    expect(reach.hosts).toEqual(['github.com', 'sentry.io'])
  })

  it('keeps a host it learnt from a look that found a network after all', () => {
    // One endpoint being down is not the machine being offline — and the host
    // is still the right one to ask about next time.
    const reach = reached(REACHING, { online: true, host: 'github.com' }, 5)
    expect(reach).toMatchObject({ online: true, since: null, hosts: ['github.com'] })
  })

  it('looks again at most once a minute while offline, and never while online', () => {
    const went = reached(REACHING, { online: false }, 1_000)
    expect(shouldLook(went, 1_000)).toBe(false)
    expect(shouldLook(went, 1_000 + REACH_EVERY_MS - 1)).toBe(false)
    expect(shouldLook(went, 1_000 + REACH_EVERY_MS)).toBe(true)
    expect(shouldLook(REACHING, 10_000_000)).toBe(false)
  })
})

describe('what a change of reach is worth saying', () => {
  it('says it on the edge, and only on the edge', () => {
    const went = reached(REACHING, { online: false }, 1_000)
    expect(reachSaid(REACHING, went)).toBe(WATCHES_PAUSED)
    // Ten hours of being offline is ten hours of saying nothing further.
    const still = reached(went, { online: false }, 2_000)
    expect(reachSaid(went, still)).toBeNull()
    const back = reached(still, { online: true }, 3_000)
    expect(reachSaid(still, back)).toBe(WATCHES_LOOKING)
    expect(reachSaid(back, reached(back, { online: true }, 4_000))).toBeNull()
  })

  it('says nothing that will have changed by the next time it is said', () => {
    // No host, no count, no clock: a sentence that changes every look is a
    // sentence that gets said every look, however carefully it is de-duplicated.
    for (const said of [WATCHES_PAUSED, WATCHES_LOOKING]) {
      expect(said).not.toMatch(/\d/)
    }
  })
})
