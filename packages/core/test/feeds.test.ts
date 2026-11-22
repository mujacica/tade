import { describe, expect, it } from 'vitest'
import { EventType, type TadeEvent } from '../src/events.ts'
import {
  CHAIN_START,
  chainNext,
  FEED_TYPES,
  type FeedSummary,
  type FleetEvent,
  foreign,
  laterEpoch,
  namesElsewhere,
  ownLines,
  STAYS_HERE,
  type SyncSummary,
  stateHash,
  syncSaid,
  syncStateOf,
  travels,
} from '../src/feeds.ts'
import { MAX_DRIFT_MS, StampAhead, stampAhead } from '../src/hlc.ts'
import { SAMPLED_TYPES } from '../src/journal.ts'
import { queueStateOf, readyToStart } from '../src/queue.ts'

// The rules every machine's journal on every other machine is kept by:
// which kinds of line travel, the chain over them, which life of a journal is
// the later, the state hash two machines compare, the words for where they
// stand, task names across the fleet, and the queue reading its own lines only.

const EPOCH = { id: '0123456789abcdef', at: '2026-11-22T10:00:00.000Z' }
const MAC = '11111111-1111-4111-8111-111111111111'
const VPS = '22222222-2222-4222-8222-222222222222'

function feed(machine: string, seq: number, n: number, h = 'a'.repeat(64)): FeedSummary {
  return { machine, name: machine === MAC ? 'mac' : 'vps', epoch: EPOCH, seq, n, h }
}

function summary(over: Partial<SyncSummary> = {}): SyncSummary {
  return { feeds: [], notes: 'n', settings: {}, pinned: [], ...over }
}

describe('what travels', () => {
  it('names every kind of line exactly once, as travelling or staying with why', () => {
    for (const type of EventType.options) {
      const goes = FEED_TYPES.includes(type)
      const stays = STAYS_HERE[type] !== undefined
      expect(goes !== stays, `${type} travels or stays, and not both`).toBe(true)
    }
  })

  it('never carries what compaction drops, so the origin’s compaction never moves a cursor', () => {
    for (const type of SAMPLED_TYPES) expect(travels(type)).toBe(false)
    expect(travels('trace_nothing')).toBe(false)
    expect(travels('task_done')).toBe(true)
    // The bookkeeping of an exchange would be news about being copied.
    expect(travels('remote_synced')).toBe(false)
  })
})

describe('the chain', () => {
  it('is a hash of every line before it, so two copies agree on it only when they hold the same lines', () => {
    const one = chainNext(CHAIN_START, '{"seq":1}')
    expect(one).toMatch(/^[0-9a-f]{64}$/)
    expect(chainNext(one, '{"seq":2}')).not.toBe(
      chainNext(chainNext(CHAIN_START, '{"seq":1 }'), '{"seq":2}'),
    )
    expect(chainNext(CHAIN_START, '{"seq":1}')).toBe(one)
  })

  it('orders two lives of one journal by when each was minted, and by id in the same millisecond', () => {
    const later = { id: '00000000000000ff', at: '2026-11-23T10:00:00.000Z' }
    expect(laterEpoch(later, EPOCH)).toBeGreaterThan(0)
    expect(laterEpoch(EPOCH, later)).toBeLessThan(0)
    expect(laterEpoch({ ...EPOCH, id: 'ffffffffffffffff' }, EPOCH)).toBeGreaterThan(0)
    expect(laterEpoch(EPOCH, EPOCH)).toBe(0)
  })
})

describe('where two machines stand', () => {
  it('is in step exactly when the state hashes agree, and leaves out what either pinned', () => {
    const here = summary({
      feeds: [feed(MAC, 5, 3), feed(VPS, 9, 4)],
      settings: { a: '1', b: '2' },
      pinned: ['b'],
    })
    const there = summary({
      feeds: [feed(VPS, 9, 4), feed(MAC, 5, 3)],
      settings: { a: '1', b: '3' },
    })
    const state = syncStateOf(here, there, { forks: 0, conflicts: 0, at: 1 })
    expect(state.word).toBe('in step')
    expect(state.here).toBe(state.there)
    expect(stateHash(here, there.pinned)).toBe(stateHash(there, here.pinned))
    expect(syncSaid(state)).toBe('in step')
  })

  it('counts the lines one side lacks, within one life of a journal', () => {
    const here = summary({ feeds: [feed(MAC, 9, 7)] })
    const there = summary({ feeds: [feed(MAC, 5, 4), feed(VPS, 3, 2)] })
    const state = syncStateOf(here, there, { forks: 0, conflicts: 0, at: 1 })
    expect(state).toMatchObject({ word: 'apart', behind: 2, ahead: 3, differ: ['feeds'] })
    expect(syncSaid(state)).toBe('behind by 2 lines · ahead by 3 lines')
    const behind = syncStateOf(summary({ feeds: [feed(VPS, 3, 2)] }), there, {
      forks: 0,
      conflicts: 0,
      at: 1,
    })
    expect(behind).toMatchObject({ word: 'behind', behind: 4, ahead: 0 })
    expect(syncSaid(behind)).toBe('behind by 4 lines')
  })

  it('counts a whole later life as lines behind, and an earlier one as nothing', () => {
    const later = {
      ...feed(MAC, 2, 2),
      epoch: { id: 'ffffffffffffffff', at: '2026-11-24T00:00:00.000Z' },
    }
    const state = syncStateOf(
      summary({ feeds: [feed(MAC, 50, 40)] }),
      summary({ feeds: [later] }),
      {
        forks: 1,
        conflicts: 0,
        at: 1,
      },
    )
    expect(state).toMatchObject({ behind: 2, ahead: 0 })
    expect(syncSaid(state)).toBe('1 fork kept · behind by 2 lines')
  })

  it('says notes or settings that differ, and a conflict first', () => {
    const state = syncStateOf(
      summary({ notes: 'x', settings: { a: '1' } }),
      summary({ notes: 'y', settings: { a: '2' } }),
      {
        forks: 0,
        conflicts: 2,
        at: 1,
      },
    )
    expect(state.differ).toEqual(['notes', 'settings'])
    expect(syncSaid(state)).toBe('2 conflicts · notes and settings differ')
  })
})

function line(
  type: TadeEvent['type'],
  task: string | null,
  detail: Record<string, unknown> = {},
  seq = 1,
): TadeEvent {
  return {
    seq,
    ts: '2026-11-22T10:00:00.000Z',
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

const fromVps = (event: TadeEvent): FleetEvent => ({ ...event, machine: 'vps' })

describe('lines from another machine', () => {
  it('are told from this machine’s own, and left out of anything that compares numbers', () => {
    const own = line('task_done', 'shop/a')
    const theirs = fromVps(line('task_done', 'shop/b'))
    expect(foreign(own)).toBe(false)
    expect(foreign(theirs)).toBe(true)
    const mine = [own]
    expect(ownLines(mine)).toBe(mine)
    expect(ownLines([own, theirs])).toEqual([own])
  })

  it('never pause this machine’s queue, though their numbers are later than its own', () => {
    const work = {
      task: 'shop/refunds',
      project: 'shop',
      parked: false,
      start: { after: [], prompt: 'go', touches: [] },
    }
    const pause = line('queue_changed', null, { all: true, change: 'pause', project: 'shop' }, 900)
    const facts = (events: TadeEvent[]) => ({
      tasks: new Map([['shop/refunds', { state: 'queued' as const, reason: '' }]]),
      finished: new Map(),
      events,
      now: Date.parse('2026-11-22T10:00:00.000Z'),
    })
    expect(queueStateOf(work, facts([pause]))).toMatchObject({ kind: 'paused', all: true })
    expect(queueStateOf(work, facts([fromVps(pause)]))).toEqual({ kind: 'ready' })
    expect(readyToStart([work], facts([fromVps(pause)]), new Map())).toEqual(['shop/refunds'])
  })
})

describe('task names across the fleet', () => {
  it('are every name another machine made, except one that moved and those of the machine a take is from', () => {
    const lines: FleetEvent[] = [
      fromVps(line('task_created', 'shop/a')),
      fromVps(line('task_created', 'shop/b')),
      fromVps(line('task_moved', 'shop/b')),
      { ...line('task_created', 'shop/c'), machine: 'laptop' },
    ]
    expect([...namesElsewhere(lines)]).toEqual([
      ['shop/a', 'vps'],
      ['shop/c', 'laptop'],
    ])
    expect([...namesElsewhere(lines, 'vps')]).toEqual([['shop/c', 'laptop']])
  })
})

describe('a stamp from a clock far ahead', () => {
  it('is refused past the bound, and said with which machine’s clock is wrong', () => {
    const now = 1_000_000_000
    expect(stampAhead(null, now)).toBeNull()
    expect(stampAhead({ wall: now + MAX_DRIFT_MS, count: 0, machine: 'vps' }, now)).toBeNull()
    const said = stampAhead({ wall: now + 3 * 3_600_000, count: 0, machine: 'vps' }, now)
    expect(said).toContain('3 hours ahead')
    expect(said).toContain('vps’s clock is wrong')
    expect(new StampAhead('queue.holds', said ?? '').message).toContain(
      'queue.holds was not written',
    )
  })
})
