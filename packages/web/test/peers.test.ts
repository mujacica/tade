import { describe, expect, it } from 'vitest'
import type { Sink } from '../src/peers.ts'
import { Streams } from '../src/peers.ts'
import type { Delta, Snapshot } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import {
  HEARTBEAT_MS,
  idFor,
  PEER_BYTES,
  PEER_FRAMES,
  PER_DEVICE,
  STALL_MS,
  TOTAL,
} from '../src/stream.ts'
import { input, NOW, reach } from './fixtures.ts'

// Who is listening, and when one of them stops being worth writing to.
//
// Over a fake sink rather than twenty sockets, which is the whole reason
// `peers.ts` imports no `node:` and reads no clock: the caps, the fan-out, the
// backpressure, the stall, the expiry and the revocation are each asked once
// here, in a millisecond. `streaming.test.ts` then proves the same rules
// survive a real connection, which is a different question and a smaller one.

const EPOCH = '7f3a9c21-0000-4000-8000-000000000000'

/** A sink that remembers, and that can be told to stop keeping up. */
function fake(): Sink & { wrote: string[]; ended: boolean; keeping: boolean } {
  const one = {
    wrote: [] as string[],
    ended: false,
    keeping: true,
    write(text: string): boolean {
      one.wrote.push(text)
      return one.keeping
    },
    end(): void {
      one.ended = true
    },
  }
  return one
}

/** The events a sink was sent, in order, ignoring comments and `retry`. */
function events(sink: { wrote: string[] }): string[] {
  return sink.wrote
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('event: '))
    .map((line) => line.slice('event: '.length))
}

const snapshotOf = (): Snapshot => projector(input({ reach: reach() }), NOW).snapshot()

function delta(rev: number): Delta {
  return { v: 1, rev, at: new Date(NOW).toISOString(), fresh: null, set: {}, del: {} }
}

function open(
  streams: Streams,
  over: {
    device?: string
    cursor?: { epoch: string; rev: number } | null
    rev?: number
    until?: number
    now?: number
  } = {},
) {
  const sink = fake()
  const opened = streams.open({
    device: over.device ?? 'aaaa0000bbbb1111',
    until: over.until ?? NOW + 86_400_000,
    cursor: over.cursor ?? null,
    sink,
    snapshot: snapshotOf,
    rev: over.rev ?? 0,
    now: over.now ?? NOW,
  })
  return { sink, opened }
}

function streams(over: ConstructorParameters<typeof Streams>[0] = {}): Streams {
  const made = new Streams(over)
  made.use(EPOCH)
  return made
}

describe('what a stream opens with', () => {
  it('hands a new tab the whole projection', () => {
    const live = streams()
    const { sink, opened } = open(live)
    expect(opened.kind).toBe('open')
    expect(events(sink)).toEqual(['snapshot'])
    expect(sink.wrote[0]?.startsWith('retry: 2000')).toBe(true)
  })

  it('hands a client that is level with us nothing at all', () => {
    // The tempting shape — always open with a snapshot — is a whole projection
    // down a phone's connection every time a tunnel blinks.
    const live = streams()
    const { sink } = open(live, { cursor: { epoch: EPOCH, rev: 7 }, rev: 7 })
    expect(events(sink)).toEqual([])
  })

  it('replays what the ring holds, and no snapshot', () => {
    const live = streams()
    const first = open(live)
    live.push('aaaa0000bbbb1111', delta(5), NOW)
    live.push('aaaa0000bbbb1111', delta(6), NOW)
    live.gone(first.opened.kind === 'open' ? first.opened.peer : (null as never))
    const back = open(live, { cursor: { epoch: EPOCH, rev: 4 }, rev: 6 })
    expect(events(back.sink)).toEqual(['delta', 'delta'])
    expect(back.sink.wrote.join('')).toContain(`id: ${idFor(EPOCH, 5)}`)
  })

  it('says it lost its place before redrawing, when there is a gap', () => {
    const live = streams({ ring: 2 })
    open(live)
    for (const rev of [5, 6, 7]) live.push('aaaa0000bbbb1111', delta(rev), NOW)
    const back = open(live, { cursor: { epoch: EPOCH, rev: 1 }, rev: 7 })
    // `resync` first: the page can say it fell behind rather than blinking.
    expect(events(back.sink)).toEqual(['resync', 'snapshot'])
  })

  it('resnapshots a cursor from another server, which is what a restart is', () => {
    const live = streams()
    const { sink } = open(live, { cursor: { epoch: 'dead-0000-4000-8000-000000000000', rev: 3 } })
    expect(events(sink)).toEqual(['snapshot'])
  })

  it('builds no projection at all for a reconnection the ring can answer', () => {
    const live = streams()
    open(live)
    live.push('aaaa0000bbbb1111', delta(5), NOW)
    let built = 0
    const sink = fake()
    live.open({
      device: 'aaaa0000bbbb1111',
      until: NOW + 1_000,
      cursor: { epoch: EPOCH, rev: 4 },
      sink,
      snapshot: () => {
        built++
        return snapshotOf()
      },
      rev: 5,
      now: NOW,
    })
    expect(built).toBe(0)
  })
})

describe('the caps', () => {
  it('tells the fifth stream of one device why, rather than hanging', () => {
    const live = streams()
    for (let at = 0; at < PER_DEVICE; at++) expect(open(live).opened.kind).toBe('open')
    const fifth = open(live)
    expect(fifth.opened.kind).toBe('too_many')
    expect(events(fifth.sink)).toEqual(['too_many'])
    expect(fifth.sink.ended).toBe(true)
    expect(live.count).toBe(PER_DEVICE)
  })

  it('counts per device, so one phone cannot shut another out', () => {
    const live = streams()
    for (let at = 0; at < PER_DEVICE; at++) open(live, { device: 'aaaa0000bbbb1111' })
    expect(open(live, { device: 'cccc2222dddd3333' }).opened.kind).toBe('open')
  })

  it('is full at the total, which the server answers before writing anything', () => {
    const live = streams({ perDevice: TOTAL })
    for (let at = 0; at < TOTAL; at++) open(live)
    expect(live.full).toBe(true)
  })

  it('keeps the ring bounded however long a device stays connected', () => {
    const live = streams({ ring: 8 })
    open(live)
    for (let rev = 1; rev <= 400; rev++) live.push('aaaa0000bbbb1111', delta(rev), NOW)
    // The oldest replayable revision is the proof: the ring dropped 392.
    const back = open(live, { cursor: { epoch: EPOCH, rev: 100 }, rev: 400 })
    expect(events(back.sink)).toEqual(['resync', 'snapshot'])
  })
})

describe('who gets what', () => {
  it('sends one device’s delta to that device only', () => {
    const live = streams()
    const mine = open(live, {
      device: 'aaaa0000bbbb1111',
      cursor: { epoch: EPOCH, rev: 0 },
      rev: 0,
    })
    const yours = open(live, {
      device: 'cccc2222dddd3333',
      cursor: { epoch: EPOCH, rev: 0 },
      rev: 0,
    })
    live.push('aaaa0000bbbb1111', delta(1), NOW)
    expect(events(mine.sink)).toEqual(['delta'])
    expect(events(yours.sink)).toEqual([])
  })

  it('says who is listening, and says nobody when nobody is', () => {
    const live = streams()
    expect(live.listening()).toEqual([])
    const one = open(live, { device: 'aaaa0000bbbb1111' })
    open(live, { device: 'aaaa0000bbbb1111' })
    open(live, { device: 'cccc2222dddd3333' })
    expect(live.listening().sort()).toEqual(['aaaa0000bbbb1111', 'cccc2222dddd3333'])
    live.gone(one.opened.kind === 'open' ? one.opened.peer : (null as never))
    expect(live.listening().sort()).toEqual(['aaaa0000bbbb1111', 'cccc2222dddd3333'])
  })
})

describe('the beat', () => {
  it('keeps a stream alive on which nothing has changed', () => {
    // The case the whole heartbeat exists for: a quiet morning is a stream
    // with no deltas, and a page that has heard nothing for a minute cannot
    // tell that from a laptop that went to sleep.
    const live = streams()
    const { sink } = open(live, { cursor: { epoch: EPOCH, rev: 0 }, rev: 0 })
    live.beat(NOW + HEARTBEAT_MS - 1)
    expect(sink.wrote.join('')).not.toContain(': keep-alive')
    live.beat(NOW + HEARTBEAT_MS)
    expect(sink.wrote.join('')).toContain(': keep-alive')
  })

  it('does not keep alive a stream that has just been written to', () => {
    const live = streams()
    const { sink } = open(live, { cursor: { epoch: EPOCH, rev: 0 }, rev: 0 })
    live.push('aaaa0000bbbb1111', delta(1), NOW + HEARTBEAT_MS)
    live.beat(NOW + HEARTBEAT_MS + 1)
    expect(sink.wrote.join('')).not.toContain(': keep-alive')
  })

  it('ends a stream whose session ran out while it was open', () => {
    const live = streams()
    const { sink } = open(live, { until: NOW + 1_000 })
    live.beat(NOW + 1_000)
    expect(events(sink)).toEqual(['snapshot', 'revoked'])
    expect(sink.ended).toBe(true)
    expect(live.count).toBe(0)
  })

  it('keeps a stream whose session was pushed forward', () => {
    const live = streams()
    const { sink } = open(live, { until: NOW + 1_000 })
    live.renewed('aaaa0000bbbb1111', NOW + 86_400_000)
    live.beat(NOW + 2_000)
    expect(events(sink)).toEqual(['snapshot'])
    expect(sink.ended).toBe(false)
  })

  it('does nothing at all when nobody is connected', () => {
    const live = streams()
    expect(() => live.beat(NOW + 10 * HEARTBEAT_MS)).not.toThrow()
    expect(live.count).toBe(0)
  })
})

describe('a client that stops reading', () => {
  it('stops being handed deltas once it is past the budget', () => {
    const live = streams()
    const { sink } = open(live, { cursor: { epoch: EPOCH, rev: 0 }, rev: 0 })
    sink.keeping = false
    // Each delta is small, so the frame count is what trips first — which is
    // the bound that matters when the layer underneath buffers for you.
    for (let rev = 1; rev <= 200; rev++) live.push('aaaa0000bbbb1111', delta(rev), NOW)
    const sent = events(sink).filter((name) => name === 'delta').length
    expect(sent).toBeGreaterThan(0)
    expect(sent).toBeLessThanOrEqual(PEER_FRAMES + 1)
  })

  it('sends the one resync it owes as soon as it drains', () => {
    const live = streams()
    const sink = fake()
    const opened = live.open({
      device: 'aaaa0000bbbb1111',
      until: NOW + 86_400_000,
      cursor: { epoch: EPOCH, rev: 0 },
      sink,
      snapshot: snapshotOf,
      rev: 0,
      now: NOW,
    })
    if (opened.kind !== 'open') throw new Error('it should have opened')
    sink.keeping = false
    for (let rev = 1; rev <= 200; rev++) live.push('aaaa0000bbbb1111', delta(rev), NOW)
    sink.keeping = true
    live.drained(opened.peer, NOW)
    expect(events(sink).at(-1)).toBe('resync')
    // Exactly one, however many deltas were dropped.
    expect(events(sink).filter((name) => name === 'resync')).toHaveLength(1)
  })

  it('is bounded by frames or by bytes, whichever comes first', () => {
    const live = streams()
    const sink = fake()
    live.open({
      device: 'aaaa0000bbbb1111',
      until: NOW + 86_400_000,
      cursor: { epoch: EPOCH, rev: 0 },
      sink,
      snapshot: snapshotOf,
      rev: 0,
      now: NOW,
    })
    sink.keeping = false
    // One enormous delta per push, so bytes trip before frames do.
    const fat: Delta = {
      ...delta(1),
      set: { notes: { big: { id: 'big', text: { words: 'x'.repeat(40_000), more: true } } } },
    }
    for (let rev = 1; rev <= 10; rev++) live.push('aaaa0000bbbb1111', { ...fat, rev }, NOW)
    const written = sink.wrote.join('').length
    // The opening padding is two kilobytes, so the ceiling is the budget plus
    // the frame that crossed it plus that.
    expect(written).toBeLessThan(PEER_BYTES + 60_000)
  })

  it('is closed when it has not read for thirty seconds, with no frame', () => {
    const live = streams()
    const { sink } = open(live, { cursor: { epoch: EPOCH, rev: 0 }, rev: 0 })
    sink.keeping = false
    live.push('aaaa0000bbbb1111', delta(1), NOW)
    live.beat(NOW + STALL_MS)
    expect(sink.ended).toBe(false)
    live.beat(NOW + STALL_MS + 1)
    expect(sink.ended).toBe(true)
    // No sentence on the way out: a client that has not read for thirty
    // seconds is not going to read the one explaining why it was closed, so
    // the last thing it was sent is the delta it never read.
    expect(events(sink)).toEqual(['delta'])
  })

  it('leaves every other client correct', () => {
    const live = streams()
    const slow = open(live, {
      device: 'aaaa0000bbbb1111',
      cursor: { epoch: EPOCH, rev: 0 },
      rev: 0,
    })
    const fast = open(live, {
      device: 'cccc2222dddd3333',
      cursor: { epoch: EPOCH, rev: 0 },
      rev: 0,
    })
    slow.sink.keeping = false
    for (let rev = 1; rev <= 200; rev++) {
      live.push('aaaa0000bbbb1111', delta(rev), NOW)
      live.push('cccc2222dddd3333', delta(rev), NOW)
    }
    live.beat(NOW + STALL_MS + 1)
    expect(slow.sink.ended).toBe(true)
    expect(fast.sink.ended).toBe(false)
    expect(events(fast.sink).filter((name) => name === 'delta')).toHaveLength(200)
  })
})

describe('revoking', () => {
  it('closes every stream of that device now, not on the next beat', () => {
    const live = streams()
    const one = open(live, { device: 'aaaa0000bbbb1111' })
    const two = open(live, { device: 'aaaa0000bbbb1111' })
    const other = open(live, { device: 'cccc2222dddd3333' })
    live.revoke('aaaa0000bbbb1111')
    expect(one.sink.ended).toBe(true)
    expect(two.sink.ended).toBe(true)
    expect(other.sink.ended).toBe(false)
    expect(events(one.sink).at(-1)).toBe('revoked')
    expect(live.count).toBe(1)
  })

  it('forgets that device’s ring, so nothing of it is replayed to a new pairing', () => {
    const live = streams()
    open(live)
    live.push('aaaa0000bbbb1111', delta(5), NOW)
    live.revoke('aaaa0000bbbb1111')
    const back = open(live, { cursor: { epoch: EPOCH, rev: 4 }, rev: 5 })
    expect(events(back.sink)).toEqual(['resync', 'snapshot'])
  })
})

describe('closing', () => {
  it('tells every stream why, and ends them', () => {
    const live = streams()
    const one = open(live, { device: 'aaaa0000bbbb1111' })
    const two = open(live, { device: 'cccc2222dddd3333' })
    live.closeAll('closing')
    for (const sink of [one.sink, two.sink]) {
      expect(sink.ended).toBe(true)
      expect(events(sink).at(-1)).toBe('notice')
      expect(sink.wrote.join('')).toContain('Tade is closing')
    }
    expect(live.count).toBe(0)
  })

  it('is safe twice', () => {
    const live = streams()
    open(live)
    live.closeAll('closing')
    expect(() => live.closeAll('off')).not.toThrow()
  })

  it('has its own sentence for being turned off at the machine', () => {
    const live = streams()
    const { sink } = open(live)
    live.closeAll('off')
    expect(sink.wrote.join('')).toContain('turned off at the machine')
  })
})

describe('a sink that throws on the way out', () => {
  it('does not stop the others being closed', () => {
    const live = streams()
    const angry = fake()
    angry.end = () => {
      throw new Error('the socket has gone')
    }
    live.open({
      device: 'aaaa0000bbbb1111',
      until: NOW + 1_000,
      cursor: null,
      sink: angry,
      snapshot: snapshotOf,
      rev: 0,
      now: NOW,
    })
    const other = open(live, { device: 'cccc2222dddd3333' })
    expect(() => live.closeAll('closing')).not.toThrow()
    expect(other.sink.ended).toBe(true)
  })
})
