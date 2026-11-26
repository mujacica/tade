import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { fleetSpendFrom, HEARD_LATELY_MS, type MachineLines } from '../src/fleet-spend.ts'
import { pricedOf, spendFrom } from '../src/spend.ts'

// Every machine's spend, a row each and a bottom line across them
// (ONE-AWAY-VIEW §2.6): each folded by itself, one machine one row whatever
// relayed it, a line once, a day placed by each machine's own clock, and a
// total that says it is a floor — and which machine makes it one.

const NOW = Date.parse('2026-11-26T12:00:00.000Z')
const MIDNIGHT = Date.parse('2026-11-26T00:00:00.000Z')
const MAC = '11111111-1111-4111-8111-111111111111'
const IPAX = '22222222-2222-4222-8222-222222222222'

function usage(seq: number, usd: number, over: Partial<TadeEvent> = {}): TadeEvent {
  return {
    seq,
    ts: '2026-11-26T10:00:00.000Z',
    type: 'usage',
    urgency: 'routine',
    task: 'tade/one',
    lane: null,
    run: `r${seq}`,
    ...over,
    detail: { model: 'claude-opus-5', input: 100, output: 50, tokens: 150, usd },
  } as TadeEvent
}

const here = (events: readonly TadeEvent[]): MachineLines => ({
  name: 'mac',
  id: MAC,
  here: true,
  events,
  heardAt: NOW,
})

const there = (events: readonly TadeEvent[], over: Partial<MachineLines> = {}): MachineLines => ({
  name: 'ipax',
  id: IPAX,
  here: false,
  events,
  heardAt: NOW - 1_000,
  ...over,
})

describe('every machine’s spend', () => {
  it('is a row each, this machine first, and a bottom line that adds every machine', () => {
    const fleet = fleetSpendFrom(
      [there([usage(1, 0.5), usage(2, 0.25)]), here([usage(1, 1)])],
      { since: MIDNIGHT },
      NOW,
    )
    expect(fleet.rows.map((row) => [row.name, row.spend.usd])).toEqual([
      ['mac', 1],
      ['ipax', 0.75],
    ])
    expect(fleet.total.usd).toBe(1.75)
    expect(fleet.total.tokens).toBe(450)
    expect(fleet.atLeast).toEqual([])
  })

  it('folds each machine by itself, as its own journal would', () => {
    const lines = [usage(1, 0.5), usage(2, 0.25, { task: 'other/two' })]
    const fleet = fleetSpendFrom([there(lines)], { since: MIDNIGHT }, NOW)
    expect(fleet.rows[0]?.spend).toEqual(spendFrom(lines, { since: MIDNIGHT }).total)
  })

  it('adds each kind of money to its own kind, so the total still says what it is made of', () => {
    const fleet = fleetSpendFrom([here([usage(1, 1)]), there([usage(1, 0.5)])], { since: 0 }, NOW)
    for (const kind of ['usd', 'usdExact', 'usdEstimated', 'usdListed', 'usdOnPlan'] as const) {
      expect(fleet.total[kind], kind).toBeCloseTo(
        fleet.rows.reduce((sum, row) => sum + row.spend[kind], 0),
        10,
      )
    }
    expect(pricedOf(fleet.total)).toBe(pricedOf(spendFrom([usage(1, 1)], { since: 0 }).total))
  })

  it('counts a line handed over twice once, and one machine heard under two names once', () => {
    const lines = [usage(1, 0.5), usage(2, 0.25)]
    const fleet = fleetSpendFrom(
      [
        here([usage(1, 1)]),
        there([...lines, ...lines]),
        there(lines, { name: 'the-vps', heardAt: NOW - 30_000 }),
        // A copy of this machine kept here is never a second row of it.
        { ...here([usage(1, 1)]), here: false, name: 'laptop', heardAt: NOW },
      ],
      { since: 0 },
      NOW,
    )
    expect(fleet.rows.map((row) => row.name)).toEqual(['mac', 'ipax'])
    expect(fleet.total.usd).toBe(1.75)
  })

  it('places a line by that machine’s own clock, so a day is the door’s day', () => {
    // Written at 23:59:30 yesterday by a clock two minutes slow: here it was 00:01:30 today.
    const late = usage(1, 2, { ts: '2026-11-25T23:59:30.000Z' })
    expect(fleetSpendFrom([there([late])], { since: MIDNIGHT }, NOW).total.usd).toBe(0)
    expect(
      fleetSpendFrom([there([late], { skewMs: 120_000 })], { since: MIDNIGHT }, NOW).total.usd,
    ).toBe(2)
  })

  it('is a floor where a machine was not heard lately, never heard, or held work back — and says which', () => {
    const fleet = fleetSpendFrom(
      [
        here([usage(1, 1)]),
        there([usage(1, 1)], { heardAt: NOW - HEARD_LATELY_MS - 1 }),
        there([], { name: 'box', id: '33333333-3333-4333-8333-333333333333', heardAt: null }),
        there([usage(1, 1)], {
          name: 'lab',
          id: '44444444-4444-4444-8444-444444444444',
          partial: true,
        }),
      ],
      { since: 0 },
      NOW,
    )
    expect(fleet.atLeast).toEqual([
      { name: 'box', why: 'never heard' },
      { name: 'ipax', why: 'not heard lately' },
      { name: 'lab', why: 'partial' },
    ])
    expect(fleet.total.usd).toBe(3)
  })

  it('names a fork a restore left, and counts nothing of it', () => {
    const fleet = fleetSpendFrom(
      [there([usage(1, 1)], { forkedAt: '2026-11-20T09:00:00.000Z' })],
      { since: 0 },
      NOW,
    )
    expect(fleet.rows[0]?.forkedAt).toBe('2026-11-20T09:00:00.000Z')
    expect(fleet.total.usd).toBe(1)
  })
})

describe('a line counted once, whatever the relays', () => {
  /** A small deterministic generator, so a failing case can be run again. */
  function random(seed: number): () => number {
    let at = seed
    return () => {
      at = (at * 1_103_515_245 + 12_345) % 2_147_483_648
      return at / 2_147_483_648
    }
  }

  it('gives the same total however each machine’s lines are repeated, shuffled and relayed', () => {
    const machines = [MAC, IPAX, '33333333-3333-4333-8333-333333333333']
    const truth = machines.map((_, at) =>
      Array.from({ length: 5 + at }, (_, seq) => usage(seq + 1, (seq + 1) * (at + 1) * 0.01)),
    )
    const expected = fleetSpendFrom(
      truth.map((events, at) => ({
        name: `m${at}`,
        id: machines[at] as string,
        here: at === 0,
        events,
        heardAt: NOW,
      })),
      { since: 0 },
      NOW,
    ).total
    for (let seed = 1; seed <= 50; seed++) {
      const next = random(seed)
      const entries: MachineLines[] = []
      truth.forEach((events, at) => {
        // Each machine relayed one to three times, its lines repeated and shuffled each time.
        const relays = 1 + Math.floor(next() * 3)
        for (let relay = 0; relay < relays; relay++) {
          const lines = [...events, ...events.filter(() => next() < 0.5)].sort(() => next() - 0.5)
          entries.push({
            name: `m${at}-via-${relay}`,
            id: machines[at] as string,
            here: at === 0 && relay === 0,
            events: lines,
            heardAt: NOW,
          })
        }
      })
      const total = fleetSpendFrom(
        entries.sort(() => next() - 0.5),
        { since: 0 },
        NOW,
      ).total
      expect(total.usd, `seed ${seed}`).toBeCloseTo(expected.usd, 10)
      expect(total.tokens, `seed ${seed}`).toBe(expected.tokens)
    }
  })
})
