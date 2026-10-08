import { describe, expect, it } from 'vitest'
import { couldBeTicket, TICKET_MS, Tickets } from '../src/tickets.ts'

// The burn, which is the whole of this file's subject: one ticket, one attempt,
// whatever happened to the attempt.

const BASE = 'http://192.168.1.10:7654/pair'

describe('minting', () => {
  it('puts the ticket in the fragment and never in the query', () => {
    const ticket = new Tickets().mint(BASE, 0)
    expect(ticket.url).toBe(`${BASE}#t=${ticket.value}`)
    // The property that matters: a fragment is never sent to a server, so the
    // ticket is in no access log, no `Referer` and no error report.
    expect(ticket.url).not.toContain('?')
    expect(ticket.url.split('#')[0]).toBe(BASE)
  })

  it('is 160 bits, and a different 160 bits every time', () => {
    const tickets = new Tickets()
    const seen = new Set<string>()
    for (let at = 0; at < 200; at++) seen.add(tickets.mint(BASE, at).value)
    expect(seen.size).toBe(200)
    for (const value of seen) expect(couldBeTicket(value)).toBe(true)
  })

  it('is bounded, and drops the oldest rather than the newest', () => {
    const tickets = new Tickets(TICKET_MS, 2)
    const first = tickets.mint(BASE, 0)
    const second = tickets.mint(BASE, 1)
    const third = tickets.mint(BASE, 2)
    const outstanding = tickets.outstanding(3).map((one) => one.value)
    expect(outstanding).toEqual([third.value, second.value])
    // The one that went is also burned, so it is `used` rather than `unknown`
    // — a dropped ticket is still a ticket this program minted.
    expect(tickets.claim(first.value, 3)).toEqual({ ok: false, why: 'used' })
  })
})

describe('one ticket, one attempt', () => {
  it('cannot be claimed twice — a replay finds nothing', () => {
    const tickets = new Tickets()
    const ticket = tickets.mint(BASE, 0)
    expect(tickets.claim(ticket.value, 1).ok).toBe(true)
    // The captured request, sent again a second later. This is the whole of
    // what "single use" has to mean.
    expect(tickets.claim(ticket.value, 2)).toEqual({ ok: false, why: 'used' })
    expect(tickets.claim(ticket.value, 50_000)).toEqual({ ok: false, why: 'used' })
  })

  it('cannot be claimed twice concurrently, because the claim is the burn', () => {
    // Two requests arriving with the same captured ticket. The burn happens on
    // the claim and not on the answer, so there is no window in which both are
    // waiting on a keypress — which is what a check-then-ask-then-delete
    // ordering would have left open for the length of a person's attention.
    const tickets = new Tickets()
    const ticket = tickets.mint(BASE, 0)
    const both = [tickets.claim(ticket.value, 1), tickets.claim(ticket.value, 1)]
    expect(both.filter((one) => one.ok)).toHaveLength(1)
    expect(both.filter((one) => !one.ok)).toHaveLength(1)
  })

  it('is burned by a refusal, by nobody answering, and by a throw', () => {
    // All three are the same code path on purpose: the caller claims, and
    // whatever happens next cannot put it back. There is nothing to get wrong
    // in a `finally`, because there is no `finally`.
    for (const _what of ['refused', 'nobody answered', 'threw']) {
      const tickets = new Tickets()
      const ticket = tickets.mint(BASE, 0)
      expect(tickets.claim(ticket.value, 1).ok).toBe(true)
      expect(tickets.claim(ticket.value, 2).ok).toBe(false)
    }
  })

  it('expires, and presenting an expired one still burns it', () => {
    const tickets = new Tickets()
    const ticket = tickets.mint(BASE, 0)
    expect(tickets.claim(ticket.value, TICKET_MS + 1)).toEqual({ ok: false, why: 'expired' })
    // Not `expired` twice: it was spent by being presented, which is the
    // honest answer and also the one that cannot be probed for timing.
    expect(tickets.claim(ticket.value, TICKET_MS + 2)).toEqual({ ok: false, why: 'used' })
  })

  it('is gone from the store once it has expired, with nothing presented', () => {
    const tickets = new Tickets()
    tickets.mint(BASE, 0)
    expect(tickets.outstanding(TICKET_MS - 1)).toHaveLength(1)
    expect(tickets.outstanding(TICKET_MS + 1)).toHaveLength(0)
  })

  it('tells a replay from a guess, in the journal and not on the wire', () => {
    const tickets = new Tickets()
    const ticket = tickets.mint(BASE, 0)
    tickets.claim(ticket.value, 1)
    // Two different things to read back: a `used` is somebody replaying what
    // they captured, an `unknown` is somebody guessing. The phone is told the
    // same thing either way — that is `server.ts`'s job and its own test.
    expect(tickets.claim(ticket.value, 2)).toEqual({ ok: false, why: 'used' })
    expect(tickets.claim('A'.repeat(27), 2)).toEqual({ ok: false, why: 'unknown' })
  })

  it('is cleared when the panel closes, and every cleared one reads as used', () => {
    const tickets = new Tickets()
    const ticket = tickets.mint(BASE, 0)
    tickets.clear()
    expect(tickets.outstanding(1)).toHaveLength(0)
    expect(tickets.claim(ticket.value, 1)).toEqual({ ok: false, why: 'used' })
  })
})

describe('what could be a ticket at all', () => {
  it('refuses anything that is not exactly one, before anything is compared', () => {
    // The length and the alphabet, so a body carrying a megabyte of `A`s is
    // refused before it reaches a constant-time comparison against every
    // outstanding ticket.
    for (const bad of [
      '',
      'A'.repeat(26),
      'A'.repeat(28),
      'A'.repeat(100_000),
      `${'A'.repeat(26)}+`,
      `${'A'.repeat(26)}/`,
      `${'A'.repeat(26)}=`,
      null,
      42,
      {},
      ['A'.repeat(27)],
    ])
      expect(couldBeTicket(bad), JSON.stringify(bad)?.slice(0, 40)).toBe(false)
    expect(couldBeTicket('A'.repeat(27))).toBe(true)
  })

  it('refuses a claim of a value that is not even a ticket’s shape', () => {
    const tickets = new Tickets()
    tickets.mint(BASE, 0)
    expect(tickets.claim('', 1).ok).toBe(false)
    expect(tickets.claim('A'.repeat(1000), 1).ok).toBe(false)
  })
})
