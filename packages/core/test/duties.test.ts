import {
  BATCH_WAIT_MS,
  batchRank,
  compareRank,
  DONE_MS,
  DutiesBody,
  DutyBoard,
  type DutyClaim,
  dutyOf,
  FOUND_KEPT,
  GRACE_MS,
  grantedUntil,
  LEASE_MS,
  Lease,
  type MachineNamed,
  mergeDuty,
  type Rank,
  STAND_IN_MS,
  standsIn,
  watchesSaid,
} from '@tade/core'
import { describe, expect, it } from 'vitest'

// Whose each duty is when one repository is a project on several machines.
//
// The board is the hub's memory and the rest is pure, so each property the
// person asked for is held here as one: one machine has each duty, whatever
// order they ask in; the one the setting or the first opening names takes it
// back from whoever had it, but only once that one lets go, and with what it
// found; one that goes quiet gives its duty up within `LEASE_MS`, and one that
// said goodbye at once; and a machine that cannot ask the hub does nothing
// until the hub is known gone, and then only if it is the best left.

const hub: MachineNamed = { id: '00000000-0000-4000-8000-00000000000a', name: 'ipax' }
const mac: MachineNamed = { id: '00000000-0000-4000-8000-00000000000b', name: 'mac' }
const third: MachineNamed = { id: '00000000-0000-4000-8000-00000000000c', name: 'vps2' }

const duty = dutyOf('watch', 'github.com/acme/app', 'review.branch-checks')
const unsaid: Rank = { said: 'unsaid', opened: null }
const here: Rank = { said: 'here', opened: null }

function claim(rank: Rank, more: Partial<DutyClaim> = {}): DutyClaim {
  return { duty, rank, doing: false, ...more }
}

/** A board past its grace, so a grant is the rank's alone. */
function settled(): { board: DutyBoard; now: number } {
  return { board: new DutyBoard(hub, 0), now: GRACE_MS }
}

describe('the rank every machine computes alike', () => {
  it('puts the setting first, then the machine opened on first, then the hub, then the id', () => {
    const order = (a: Rank, b: Rank, ids = [mac.id, hub.id]) =>
      compareRank({ id: ids[0] ?? '', rank: a }, { id: ids[1] ?? '', rank: b }, hub.id)
    expect(order(here, unsaid)).toBeLessThan(0)
    expect(order(unsaid, { said: 'elsewhere', opened: 1 })).toBeLessThan(0)
    expect(order({ said: 'unsaid', opened: 5 }, { said: 'unsaid', opened: 9 })).toBeLessThan(0)
    expect(order({ said: 'unsaid', opened: 5 }, unsaid)).toBeLessThan(0)
    // Nothing else between them: the hub, the machine that never closes.
    expect(order(unsaid, unsaid)).toBeGreaterThan(0)
    expect(order(unsaid, unsaid, [mac.id, third.id])).toBeLessThan(0)
  })

  it('reads the setting as here, unsaid, or another machine', () => {
    expect(watchesSaid('here', 'here')).toBe('here')
    expect(watchesSaid(undefined, 'here')).toBe('unsaid')
    expect(watchesSaid('ipax', 'here')).toBe('elsewhere')
  })

  it('names a parting the same from either side', () => {
    expect(mergeDuty('github.com/acme/app', 'main', 'bbb', 'aaa')).toBe(
      mergeDuty('github.com/acme/app', 'main', 'aaa', 'bbb'),
    )
  })
})

describe('the hub’s board', () => {
  it('gives each duty to exactly one machine, the best ranked, whatever order they ask in', () => {
    const { board, now } = settled()
    const first = board.ask(hub, [claim(unsaid)], [], now)[0]
    const second = board.ask(mac, [claim(here)], [], now + 1)[0]
    // The hub asked first and holds it; the Mac, ranked first, is not given it from under it.
    expect(first?.yours).toBe(true)
    expect(second?.yours).toBe(false)
    expect(second?.holder?.id).toBe(hub.id)
    expect(second?.ranked.map((one) => one.name)).toEqual(['mac', 'ipax'])
  })

  it('hands it to a better-ranked machine only once the holder lets go, with what it found and where it got to', () => {
    const { board, now } = settled()
    board.ask(
      hub,
      [claim(unsaid, { doing: true, since: 'cursor-7', input: 'in', found: ['k1', 'k2'] })],
      [],
      now,
    )
    board.ask(mac, [claim(here)], [], now + 1)
    // The holder is told to yield after what it is doing; until it does, it is still its.
    const told = board.ask(hub, [claim(unsaid, { doing: true, found: ['k3'] })], [], now + 2)[0]
    expect(told?.yours).toBe(true)
    expect(told?.yield).toBe(true)
    expect(board.ask(mac, [claim(here)], [], now + 3)[0]?.yours).toBe(false)
    // It lets go: never two holding, and the next ask of the Mac's is a grant with the hand.
    board.ask(hub, [claim(unsaid)], [duty], now + 4)
    const granted = board.ask(mac, [claim(here)], [], now + 5)[0]
    expect(granted?.yours).toBe(true)
    expect(granted?.handed).toMatchObject({
      from: 'ipax',
      since: 'cursor-7',
      input: 'in',
      found: ['k3', 'k1', 'k2'],
    })
    // Once it says it has begun, the hand is not given again.
    const begun = board.ask(mac, [claim(here, { doing: true })], [], now + 6)[0]
    expect(begun?.handed).toBeUndefined()
    expect(board.holderOf(duty, now + 6)?.id).toBe(mac.id)
  })

  it('gives a duty up by itself within LEASE_MS of its holder going quiet, and at once on a goodbye', () => {
    const { board, now } = settled()
    board.ask(mac, [claim(here, { doing: true, found: ['k1'] })], [], now)
    expect(board.ask(hub, [claim(unsaid)], [], now + 1)[0]?.yours).toBe(false)
    // The Mac asleep: nothing from it, and the hub's own claim keeps going.
    expect(board.ask(hub, [claim(unsaid)], [], now + LEASE_MS - 1)[0]?.yours).toBe(false)
    const taken = board.ask(hub, [claim(unsaid)], [], now + LEASE_MS)[0]
    expect(taken?.yours).toBe(true)
    expect(taken?.handed?.found).toEqual(['k1'])

    const again = settled()
    again.board.ask(mac, [claim(here, { doing: true })], [], again.now)
    again.board.gone(mac.id)
    expect(again.board.ask(hub, [claim(unsaid)], [], again.now + 1)[0]?.yours).toBe(true)
  })

  it('grants nothing for GRACE_MS after it starts but to a machine already doing it', () => {
    const board = new DutyBoard(hub, 0)
    // The hub's own watch, just started, while the Mac may be standing in for it.
    expect(board.ask(hub, [claim(unsaid)], [], 1)[0]?.yours).toBe(false)
    // The Mac, which stood in, is the holder first and is told to yield to nobody ranked above it.
    const standing = board.ask(mac, [claim(here, { doing: true })], [], 2)[0]
    expect(standing?.yours).toBe(true)
    expect(standing?.yield).toBeUndefined()
    expect(board.ask(hub, [claim(unsaid)], [], GRACE_MS + 1)[0]?.yours).toBe(false)
  })

  it('remembers a duty done for good, and gives it to nobody else until DONE_MS', () => {
    const { board, now } = settled()
    const batch = dutyOf('batch', 'github.com/acme/app', 'a'.repeat(40))
    board.ask(mac, [{ duty: batch, rank: here, doing: true }], [], now)
    board.ask(mac, [{ duty: batch, rank: here, doing: false, done: true }], [], now + 1)
    const after = board.ask(hub, [{ duty: batch, rank: unsaid, doing: false }], [], now + 2)[0]
    expect(after?.yours).toBe(false)
    expect(after?.done?.name).toBe('mac')
    expect(
      board.ask(hub, [{ duty: batch, rank: unsaid, doing: false }], [], now + DONE_MS + 2)[0]
        ?.yours,
    ).toBe(true)
  })

  it('gives a batch to the hub where it has the commit, and to another machine only after BATCH_WAIT_MS', () => {
    const { board, now } = settled()
    const batch = dutyOf('batch', 'github.com/acme/app', 'b'.repeat(40))
    const asked = { duty: batch, rank: batchRank('unsaid'), doing: false }
    expect(board.ask(mac, [asked], [], now)[0]?.yours).toBe(false)
    expect(board.ask(hub, [asked], [], now + 1)[0]?.yours).toBe(true)
    const other = dutyOf('batch', 'github.com/acme/app', 'c'.repeat(40))
    const only = { duty: other, rank: batchRank('unsaid'), doing: false }
    expect(board.ask(mac, [only], [], now)[0]?.yours).toBe(false)
    expect(board.ask(mac, [only], [], now + BATCH_WAIT_MS)[0]?.yours).toBe(true)
  })

  it('gives a batch at once to a machine whose batches setting says here, ahead of the hub', () => {
    const { board, now } = settled()
    const batch = dutyOf('batch', 'github.com/acme/app', 'd'.repeat(40))
    const named = { duty: batch, rank: batchRank('here'), doing: false }
    expect(board.ask(mac, [named], [], now)[0]?.yours).toBe(true)
    const late = board.ask(
      hub,
      [{ duty: batch, rank: batchRank('unsaid'), doing: false }],
      [],
      now + 1,
    )
    expect(late[0]?.yours).toBe(false)
    expect(late[0]?.holder?.name).toBe('mac')
  })

  it('does not keep a batch waiting for a hub whose own batches setting names another machine', () => {
    const batch = dutyOf('batch', 'github.com/acme/app', 'e'.repeat(40))
    const board = new DutyBoard(
      hub,
      0,
      () => false,
      (one) => one !== batch,
    )
    const asked = { duty: batch, rank: batchRank('unsaid'), doing: false }
    expect(board.ask(mac, [asked], [], GRACE_MS)[0]?.yours).toBe(true)
    // Any other batch still waits for the hub as before.
    const other = dutyOf('batch', 'github.com/acme/app', 'f'.repeat(40))
    expect(board.ask(mac, [{ ...asked, duty: other }], [], GRACE_MS)[0]?.yours).toBe(false)
  })

  it('keeps at most FOUND_KEPT keys for a duty, newest first', () => {
    const { board, now } = settled()
    for (let n = 0; n < FOUND_KEPT + 30; n += 10) {
      const found = Array.from({ length: 10 }, (_, i) => `k${n + i}`)
      board.ask(hub, [claim(unsaid, { doing: true, found })], [], now + n)
    }
    board.ask(mac, [claim(here)], [], now + 499)
    board.ask(hub, [claim(unsaid)], [duty], now + 500)
    const hand = board.ask(mac, [claim(here)], [], now + 501)[0]?.handed
    expect(hand?.found).toHaveLength(FOUND_KEPT)
    expect(hand?.found[0]).toBe(`k${FOUND_KEPT + 20}`)
  })
})

describe('a machine that cannot ask the hub', () => {
  it('lets go of a grant before the hub could hand it on, by counting from when it asked', () => {
    // Asked at 1000, granted when the request arrived later: the asker stops a renew early.
    expect(grantedUntil(1_000)).toBeLessThan(1_000 + LEASE_MS)
  })

  it('does nothing while the hub is silent for less than STAND_IN_MS, and stands in once it said goodbye', () => {
    const ranked = [mac, hub]
    const silent = standsIn({
      me: mac.id,
      hub: { name: 'ipax', id: hub.id, state: 'silent', since: 0 },
      ranked,
      down: new Set(),
      now: STAND_IN_MS - 1,
    })
    expect(silent.stands).toBe(false)
    expect(silent.why).toContain('silent with no goodbye')
    const closed = standsIn({
      me: mac.id,
      hub: { name: 'ipax', id: hub.id, state: 'closed', since: 0 },
      ranked,
      down: new Set(),
      now: 1,
    })
    expect(closed).toMatchObject({ stands: true })
    expect(
      standsIn({
        me: mac.id,
        hub: { name: 'ipax', id: hub.id, state: 'silent', since: 0 },
        ranked,
        down: new Set(),
        now: STAND_IN_MS,
      }).why,
    ).toContain('both do until they can see each other')
  })

  it('leaves it to a machine the hub ranked before it, unless it knows that one is down', () => {
    const facts = {
      me: mac.id,
      hub: { name: 'ipax', id: hub.id, state: 'closed' as const, since: 0 },
      ranked: [third, mac, hub],
      now: 1,
    }
    expect(standsIn({ ...facts, down: new Set() })).toMatchObject({ stands: false })
    expect(standsIn({ ...facts, down: new Set([third.id]) })).toMatchObject({ stands: true })
  })
})

describe('the lease the turn is held under', () => {
  it('is one machine’s until it runs out unrenewed', () => {
    const lease = new Lease()
    expect(lease.ask('take', mac, 'k', 0).granted).toBe(true)
    expect(lease.ask('take', hub, 'j', 1)).toMatchObject({
      granted: false,
      holder: { name: 'mac' },
    })
    expect(lease.ask('take', hub, 'j', LEASE_MS)).toMatchObject({ granted: true })
  })
})

describe('what travels', () => {
  it('reads a claim and refuses one whose duty is not a duty’s name', () => {
    const body = { from: mac, claims: [claim(here)], letGo: [] }
    expect(DutiesBody.safeParse(body).success).toBe(true)
    expect(
      DutiesBody.safeParse({ ...body, claims: [{ ...claim(here), duty: 'watch two\nlines x' }] })
        .success,
    ).toBe(false)
  })
})
