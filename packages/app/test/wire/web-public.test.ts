import type { CertificateLook } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  BEHIND_EVERY_MS,
  CERTIFICATE_EVERY_MS,
  CERTIFICATE_RETRY_MS,
  PublicHealth,
} from '../../src/wire/web-public.ts'

// The public listener's health look, counted by what it asked for: the clock
// is the test's, and every look is a call it can count, so nothing here waits
// on a sleep (`frame.probe.test.ts` has why).

const DAY = 86_400_000
const NAME = 'tade.example.com'

function harness(answers: { cert?: () => CertificateLook; newer?: string | null } = {}) {
  let now = Date.UTC(2026, 9, 16)
  const looked: string[] = []
  let read = 0
  const news: string[] = []
  const health = new PublicHealth({
    look: () => async (name) => {
      looked.push(name)
      return answers.cert?.() ?? fine(now)
    },
    newer: async () => {
      read++
      return answers.newer ?? null
    },
    news: (said) => news.push(said),
    draw: () => {},
    now: () => now,
  })
  return {
    health,
    looked,
    reads: () => read,
    news,
    at: (ms: number) => {
      now = ms
    },
    later: (ms: number) => {
      now += ms
    },
    now: () => now,
  }
}

/** A ninety-day certificate with `left` days of it to go. */
function fine(now: number, left = 60): CertificateLook {
  return {
    at: now,
    seen: {
      validFrom: now + (left - 90) * DAY,
      validTo: now + left * DAY,
      issuer: "Let's Encrypt",
      authorized: true,
      error: null,
    },
  }
}

/** Every promise the beat started, settled. */
const settled = () => new Promise((done) => setImmediate(done))

describe('the public listener’s health look', () => {
  it('asks nothing while there is no public listener', async () => {
    const h = harness()
    for (let n = 0; n < 5; n++) h.health.beat()
    await settled()
    expect(h.looked).toEqual([])
    expect(h.reads()).toBe(0)
    expect(h.health.lines()).toEqual([])
  })

  it('looks once when it comes up, then twice a day, and reads the kept answer every quarter hour', async () => {
    const h = harness()
    h.health.up(NAME)
    h.health.beat()
    h.health.beat()
    await settled()
    expect(h.looked).toEqual([NAME])
    expect(h.reads()).toBe(1)
    for (let n = 0; n < 20; n++) {
      h.later(BEHIND_EVERY_MS / 10)
      h.health.beat()
      await settled()
    }
    expect(h.looked).toHaveLength(1)
    expect(h.reads()).toBe(3)
    h.later(CERTIFICATE_EVERY_MS)
    h.health.beat()
    await settled()
    expect(h.looked).toHaveLength(2)
  })

  it('tries a look that could not be made again in an hour, and a throw is one of those', async () => {
    let throws = true
    const h = harness({
      cert: () => {
        if (throws) throw new Error('ENOTFOUND')
        return fine(Date.UTC(2026, 9, 16))
      },
    })
    h.health.up(NAME)
    h.health.beat()
    await settled()
    expect(h.health.lines()[0]).toMatchObject({ loud: true })
    expect(h.health.lines()[0]?.said).toContain('could not look at https://tade.example.com')
    h.later(CERTIFICATE_RETRY_MS - 1)
    h.health.beat()
    await settled()
    expect(h.looked).toHaveLength(1)
    throws = false
    h.later(1)
    h.health.beat()
    await settled()
    expect(h.looked).toHaveLength(2)
  })

  it('draws the certificate quietly while it is fine, and says nothing in the strip', async () => {
    const h = harness()
    h.health.up(NAME)
    h.health.beat()
    await settled()
    expect(h.health.lines()).toEqual([
      { said: "certificate: 60 days left, until 2026-12-15, from Let's Encrypt", loud: false },
    ])
    expect(h.news).toEqual([])
  })

  it('says Tade being behind loudly, first, and in the strip once', async () => {
    const h = harness({ newer: '0.2.4 is out' })
    h.health.up(NAME)
    h.health.beat()
    await settled()
    const lines = h.health.lines()
    expect(lines[0]).toEqual({
      said: 'this Tade is out of date (0.2.4 is out) and answers the internet as tade.example.com: `tade update` moves it forward',
      loud: true,
    })
    expect(h.news).toHaveLength(1)
    // The next reads find the same answer: nothing more is said.
    for (let n = 0; n < 3; n++) {
      h.later(BEHIND_EVERY_MS)
      h.health.beat()
      await settled()
    }
    expect(h.news).toHaveLength(1)
  })

  it('says a failing renewal once, though its days count down, and again only after it was fine', async () => {
    let left = 10
    const h = harness({ cert: () => fine(Date.UTC(2026, 9, 16), left) })
    h.health.up(NAME)
    h.health.beat()
    await settled()
    expect(h.news).toHaveLength(1)
    expect(h.news[0]).toContain('renewing has been failing')
    left = 9
    h.later(CERTIFICATE_EVERY_MS)
    h.health.beat()
    await settled()
    expect(h.news).toHaveLength(1)
    left = 80
    h.later(CERTIFICATE_EVERY_MS)
    h.health.beat()
    await settled()
    left = 5
    h.later(CERTIFICATE_EVERY_MS)
    h.health.beat()
    await settled()
    expect(h.news).toHaveLength(2)
  })

  it('forgets everything when the listener goes, and draws nothing', async () => {
    const h = harness({ newer: '0.2.4 is out' })
    h.health.up(NAME)
    h.health.beat()
    await settled()
    h.health.up(null)
    expect(h.health.lines()).toEqual([])
    h.health.beat()
    await settled()
    expect(h.looked).toHaveLength(1)
  })

  it('never dials where the window was not handed a way to, and says it did not look', async () => {
    let read = 0
    const health = new PublicHealth({
      look: () => null,
      newer: async () => {
        read++
        return null
      },
      news: () => {},
      draw: () => {},
      now: () => 0,
    })
    health.up(NAME)
    health.beat()
    await settled()
    expect(read).toBe(1)
    expect(health.lines()).toEqual([{ said: 'certificate: not looked at', loud: false }])
  })
})
