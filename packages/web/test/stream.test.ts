import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyDelta, revise } from '../src/delta.ts'
import { projector } from '../src/reading.ts'
import {
  cursorOf,
  deltaFrame,
  idFor,
  KEEP_ALIVE,
  overBudget,
  PEER_BYTES,
  PEER_FRAMES,
  RING,
  Ring,
  resumeFrom,
  STREAM_OPENING,
  snapshotFrame,
  sseFrame,
} from '../src/stream.ts'
import { input, NOW, task } from './fixtures.ts'

// The stream's protocol, as a table.
//
// Every interesting thing about reconnection is a decision about two numbers,
// so it is asked here once per row rather than through a socket once for the
// row somebody remembered. The sockets are `streaming.test.ts`, which proves
// the same rules survive a real connection.

const EPOCH = '7f3a9c21-0000-4000-8000-000000000000'

describe('a cursor off the wire', () => {
  it('reads the id this server writes', () => {
    expect(cursorOf(idFor(EPOCH, 4812))).toEqual({ epoch: EPOCH, rev: 4812 })
  })

  it('is null for everything that is not one', () => {
    // Attacker-controlled text: a browser echoes what it was sent, and
    // anything else sends whatever it likes. Null is "start again", which is
    // always safe — the worst a made-up cursor buys is a snapshot the device
    // was entitled to anyway.
    for (const said of [
      null,
      undefined,
      '',
      ':12',
      EPOCH,
      `${EPOCH}:`,
      `${EPOCH}:-1`,
      `${EPOCH}:1e9`,
      `${EPOCH}:12.5`,
      `${EPOCH}:${'9'.repeat(16)}`,
      `not-an-epoch!:12`,
      `${'a'.repeat(80)}:12`,
      `${EPOCH}:12\nevent: delta`,
    ]) {
      expect(cursorOf(said), String(said)).toBeNull()
    }
  })
})

describe('what to do about a cursor', () => {
  // DESIGN §10.5, one row each. The three answers that are not `replay` all
  // end with the client holding a whole projection, which is what makes every
  // failure here recoverable rather than merely handled.
  const table: {
    said: string
    cursor: Parameters<typeof resumeFrom>[0]
    rev: number
    held: number | null
    want: ReturnType<typeof resumeFrom>
  }[] = [
    {
      said: 'a new tab sends no cursor',
      cursor: null,
      rev: 40,
      held: 1,
      want: { kind: 'snapshot', why: 'no cursor' },
    },
    {
      said: 'another epoch is a restart, or another machine',
      cursor: { epoch: 'cafe-0000-4000-8000-000000000000', rev: 40 },
      rev: 40,
      held: 1,
      want: { kind: 'snapshot', why: 'another server' },
    },
    {
      said: 'a revision above ours is never trusted',
      cursor: { epoch: EPOCH, rev: 41 },
      rev: 40,
      held: 1,
      want: { kind: 'snapshot', why: 'from the future' },
    },
    {
      said: 'level with us: nothing to send',
      cursor: { epoch: EPOCH, rev: 40 },
      rev: 40,
      held: 1,
      want: { kind: 'replay', from: 41 },
    },
    {
      said: 'one behind, and the ring reaches it',
      cursor: { epoch: EPOCH, rev: 39 },
      rev: 40,
      held: 40,
      want: { kind: 'replay', from: 40 },
    },
    {
      said: 'exactly at the oldest edge of the ring',
      cursor: { epoch: EPOCH, rev: 20 },
      rev: 40,
      held: 21,
      want: { kind: 'replay', from: 21 },
    },
    {
      said: 'one past the edge is a gap, however full the ring is',
      cursor: { epoch: EPOCH, rev: 19 },
      rev: 40,
      held: 21,
      want: { kind: 'resync', why: 'too far behind' },
    },
    {
      said: 'behind, with an empty ring: nothing can catch it up',
      cursor: { epoch: EPOCH, rev: 39 },
      rev: 40,
      held: null,
      want: { kind: 'resync', why: 'too far behind' },
    },
    {
      said: 'level, with an empty ring: it is already right',
      cursor: { epoch: EPOCH, rev: 40 },
      rev: 40,
      held: null,
      want: { kind: 'replay', from: 41 },
    },
  ]

  for (const row of table) {
    it(row.said, () => {
      expect(resumeFrom(row.cursor, EPOCH, row.rev, row.held)).toEqual(row.want)
    })
  }

  it('answers a cursor from a server that never minted an epoch', () => {
    // `Streams.use` has not been called: every cursor is from another server,
    // which is the right answer and not a crash.
    expect(resumeFrom({ epoch: EPOCH, rev: 1 }, '', 0, null)).toEqual({
      kind: 'snapshot',
      why: 'another server',
    })
  })
})

describe('the ring', () => {
  const made = (rev: number) => ({ ...deltaAt(rev) })

  it('is bounded whatever is pushed into it', () => {
    const ring = new Ring()
    for (let rev = 1; rev <= 1_000; rev++) ring.add(made(rev))
    expect(ring.size).toBe(RING)
    expect(ring.held).toBe(1_000 - RING + 1)
  })

  it('holds nothing to begin with, and says so rather than guessing', () => {
    expect(new Ring().held).toBeNull()
    expect(new Ring().since(1)).toEqual([])
  })

  it('replays in order, from the revision asked for', () => {
    const ring = new Ring(4)
    for (const rev of [7, 8, 9]) ring.add(made(rev))
    expect(ring.since(8).map((delta) => delta.rev)).toEqual([8, 9])
    expect(ring.since(10)).toEqual([])
  })

  it('is empty after a clear, so nothing outlives the device it was for', () => {
    const ring = new Ring(4)
    ring.add(made(1))
    ring.clear()
    expect(ring.size).toBe(0)
    expect(ring.held).toBeNull()
  })
})

describe('a replayed run is the same answer as a fresh snapshot', () => {
  // The one property the whole stream rests on, asked over the ring rather
  // than over two deltas: a client that applies everything the ring handed it
  // holds exactly what a client that asked for a snapshot would.
  it('catches a client up to the row the server holds', () => {
    const first = input()
    const one = projector(first, NOW)
    let held = one.snapshot()
    const ring = new Ring()
    const moves = [
      { ...first, tasks: [...first.tasks, task({ id: 'tade/window', state: 'blocked' })] },
      { ...first, tasks: first.tasks.slice(1) },
      { ...first, warnings: ['git could not be reached'] },
    ]
    for (const [at, next] of moves.entries()) {
      const delta = one.beat(next, NOW + (at + 1) * 2_000)
      if (delta !== null) ring.add(delta)
    }
    for (const delta of ring.since(0)) held = applyDelta(held, delta)
    expect(held).toEqual(one.snapshot())
  })

  it('keeps a revision the ring never saw out of the client’s reach', () => {
    // A beat on which nothing changed sends nothing and advances nothing, so
    // a cursor cannot name a revision that exists only in a clock.
    const first = input()
    const was = revise(null, first, NOW)
    const again = revise(was.snapshot, { ...first, lifetime: { ...first.lifetime } }, NOW + 2_000)
    expect(again.kind).toBe('unchanged')
    expect(again.rev).toBe(was.rev)
  })
})

describe('what goes down the wire', () => {
  it('writes an event, an id and one line of JSON', () => {
    expect(sseFrame({ event: 'resync', data: { why: 'behind' }, id: 'a:1' })).toBe(
      'event: resync\nid: a:1\ndata: {"why":"behind"}\n\n',
    )
  })

  it('never lets a value invent a frame boundary', () => {
    const frame = sseFrame({ event: 'notice', data: { said: 'one\ntwo' }, id: 'a\n\nevent: delta' })
    // The id is flattened; the data cannot carry a raw newline at all, because
    // JSON escapes it — which is the reason `data` is JSON and not text.
    expect(frame.split('\n\n')).toHaveLength(2)
    expect(frame).toContain('data: {"said":"one\\ntwo"}')
  })

  it('stamps a snapshot and a delta with the same kind of cursor', () => {
    const snapshot = projector(input(), NOW).snapshot()
    expect(snapshotFrame(snapshot).id).toBe(idFor(snapshot.fresh.epoch, snapshot.fresh.rev))
    expect(deltaFrame(EPOCH, deltaAt(9)).id).toBe(`${EPOCH}:9`)
  })

  it('opens with a retry and enough padding to flush a proxy', () => {
    expect(STREAM_OPENING.startsWith('retry: 2000\n')).toBe(true)
    expect(STREAM_OPENING.length).toBeGreaterThan(2_000)
    expect(STREAM_OPENING.endsWith('\n\n')).toBe(true)
  })

  it('keeps alive in seventeen bytes', () => {
    expect(KEEP_ALIVE.length).toBeLessThan(20)
    expect(KEEP_ALIVE.startsWith(':')).toBe(true)
  })
})

describe('the budget', () => {
  it('is reached by either number, not by both', () => {
    expect(overBudget({ frames: 0, bytes: 0 })).toBe(false)
    expect(overBudget({ frames: PEER_FRAMES, bytes: PEER_BYTES })).toBe(false)
    expect(overBudget({ frames: PEER_FRAMES + 1, bytes: 0 })).toBe(true)
    expect(overBudget({ frames: 0, bytes: PEER_BYTES + 1 })).toBe(true)
  })
})

describe('no timer anywhere in the stream', () => {
  // The claim that makes "no unbounded timers" mechanical rather than a
  // sentence: everything time-based about a stream happens on the window's
  // own beat, so neither file may name a timer at all. A per-connection
  // interval is bounded by nothing and is invisible in a profile.
  it('names neither setInterval nor setTimeout', () => {
    for (const file of ['stream.ts', 'peers.ts']) {
      const text = readFileSync(join(import.meta.dirname, '..', 'src', file), 'utf8')
      expect(text, file).not.toMatch(/\bset(Interval|Timeout|Immediate)\s*\(/)
    }
  })
})

/** A delta at one revision. Only `rev` matters to the ring. */
function deltaAt(rev: number) {
  return {
    v: 1 as const,
    rev,
    at: new Date(NOW).toISOString(),
    fresh: null,
    set: {},
    del: {},
  }
}
