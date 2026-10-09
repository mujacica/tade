import { describe, expect, it } from 'vitest'
import { applyDelta, deltaBetween, revise, same, tick } from '../src/delta.ts'
import { measureDelta, measureOf } from '../src/measure.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, input, NOW, reach, task } from './fixtures.ts'

const at = (ms: number) => NOW + ms

describe('a beat on which only the clock moved', () => {
  it('sends nothing at all', () => {
    const one = input({ reach: reach(EVERY) })
    expect(deltaBetween(snapshotOf(one, NOW), snapshotOf(one, at(2_000)))).toBeNull()
  })

  it('does not advance the revision either', () => {
    const one = input({ reach: reach(EVERY) })
    const first = revise(null, one, NOW)
    expect(first.rev).toBe(12)
    const next = revise(first.snapshot, one, at(2_000))
    expect(next.kind).toBe('unchanged')
    expect(next.rev).toBe(12)
  })

  it('stays quiet over sixty beats of nothing happening', () => {
    // Paced by the beat and not by a sleep: what is being counted is deltas
    // per beat, so the beats are the clock.
    const one = input({ reach: reach(EVERY) })
    let held = revise(null, one, NOW).snapshot
    let sent = 0
    for (let beat = 1; beat <= 60; beat += 1) {
      const been = revise(
        held,
        { ...one, lifetime: { ...one.lifetime, rev: 12 } },
        at(beat * 2_000),
      )
      if (been.kind === 'changed') sent += 1
      held = been.snapshot
    }
    expect(sent).toBe(0)
  })

  it('carries the clock on its own when a client needs it moved', () => {
    const many = Array.from({ length: 200 }, (_, n) =>
      task({ id: `sentry/t${String(n).padStart(3, '0')}`, project: 'sentry' }),
    )
    const whole = snapshotOf(
      input({ reach: reach(EVERY), tasks: many }),
      NOW,
      {},
      {
        projects: 40,
        tasks: 400,
        tasksPerProject: 400,
        queue: 200,
        findings: 100,
        notes: 200,
        plans: 20,
        text: 600,
        warnings: 10,
      },
    )
    const beat = tick(whole, at(2_000))
    expect(beat.rev).toBe(whole.fresh.rev)
    expect(beat.set).toEqual({})
    expect(beat.del).toEqual({})
    expect(beat.fresh?.at).toBe(new Date(at(2_000)).toISOString())
    const ticked = measureDelta(beat)
    expect(ticked.timeOnly).toBe(true)
    // **The whole point, as an equality rather than a threshold**: the same
    // tick over two hundred tasks and over four is the same number of bytes.
    // A threshold says the same thing only for as long as nobody changes the
    // fixture, and the one that was here was calibrated against a fixture
    // with a single warning in it.
    const few = tick(snapshotOf(input({ reach: reach(EVERY) }), NOW), at(2_000))
    expect(ticked.bytes).toBe(measureDelta(few).bytes)
    expect(measureOf(whole).bytes).toBeGreaterThan(50 * ticked.bytes)
    // And bounded, because the freshness is on every frame: the only part of
    // it that is not a fixed-size field is status's warnings, which is what
    // `BUDGET.warnings` is a budget for.
    expect(ticked.bytes).toBeLessThan(1_000)
    expect(applyDelta(whole, beat)).toEqual({ ...whole, fresh: beat.fresh })
  })
})

describe('what changed', () => {
  const was = snapshotOf(input({ reach: reach(EVERY) }), NOW)

  it('is the changed fields of a row the client already has', () => {
    const moved = input({
      reach: reach(EVERY),
      tasks: [
        task({ state: 'review', reason: { kind: 'clause', said: '2 commits, tests unknown' } }),
      ],
      projects: [],
      queue: [],
      findings: [],
      notes: [],
      plans: [],
    })
    const before = snapshotOf({ ...moved, tasks: [task()] }, NOW)
    const after = snapshotOf(moved, NOW)
    const delta = deltaBetween(before, after)
    expect(Object.keys(delta?.set.tasks ?? {})).toEqual(['sentry/away-projection'])
    expect(delta?.set.tasks?.['sentry/away-projection']).toEqual({
      state: 'review',
      reason: '2 commits, tests unknown',
      wantsYou: true,
    })
  })

  it('is the whole of a row the client has never seen', () => {
    const after = snapshotOf(
      input({ reach: reach(EVERY), tasks: [...input().tasks, task({ id: 'tade/new' })] }),
      NOW,
    )
    const delta = deltaBetween(was, after)
    const added = delta?.set.tasks?.['tade/new']
    expect(added?.id).toBe('tade/new')
    expect(Object.keys(added ?? {}).length).toBeGreaterThan(20)
  })

  it('names a row that has gone, so the client can forget it', () => {
    const after = snapshotOf(
      input({
        reach: reach(EVERY),
        tasks: input().tasks.filter((one) => one.id !== 'tade/window'),
      }),
      NOW,
    )
    const delta = deltaBetween(was, after)
    expect(delta?.del.tasks).toEqual(['tade/window'])
  })

  it('carries a page whose counts moved', () => {
    const after = snapshotOf(input({ reach: reach(EVERY), notes: [] }), NOW)
    expect(deltaBetween(was, after)?.pages?.notes?.total).toBe(0)
  })

  it('carries a change to what the device may read', () => {
    const after = snapshotOf(input({ reach: reach(['notes']) }), NOW)
    expect(deltaBetween(was, after)?.you?.reads).toEqual(['notes'])
  })

  it('carries a new epoch rather than dropping it, though a client re-snapshots on one', () => {
    const one = input({ reach: reach(EVERY) })
    const after = snapshotOf(
      { ...one, lifetime: { ...one.lifetime, epoch: 'b2c3d4e5-0000-4000-8000-000000000000' } },
      NOW,
    )
    expect(deltaBetween(was, after)?.fresh?.epoch).toBe('b2c3d4e5-0000-4000-8000-000000000000')
  })
})

describe('applying a delta', () => {
  // The property the whole stream rests on, and the reason `applyDelta` lives
  // here rather than only in the browser.
  it('gives back exactly the projection it was diffed from', () => {
    const steps = [
      input({ reach: reach(EVERY) }),
      input({ reach: reach(EVERY), tasks: [...input().tasks, task({ id: 'tade/new' })] }),
      input({
        reach: reach(EVERY),
        tasks: [task({ state: 'merged', reason: { kind: 'clause', said: 'review merged' } })],
      }),
      input({ reach: reach(['notes']), notes: [] }),
      input({ reach: reach(EVERY), projects: [], tasks: [], queue: [], findings: [], plans: [] }),
    ]
    let held = snapshotOf(steps[0]!, NOW)
    for (const [n, step] of steps.slice(1).entries()) {
      const next = snapshotOf(step, at((n + 1) * 2_000))
      const delta = deltaBetween(held, next)
      expect(delta, 'every step here changes something').not.toBeNull()
      expect(applyDelta(held, delta!)).toEqual(next)
      held = next
    }
  })

  it('refuses a frame from a protocol it does not know, by throwing', () => {
    const snapshot = snapshotOf(input(), NOW)
    const beat = tick(snapshot, NOW)
    expect(() => applyDelta(snapshot, { ...beat, v: 2 as never })).toThrow(/protocol/)
    expect(() => deltaBetween(snapshot, { ...snapshot, v: 2 as never })).toThrow(/protocol/)
  })
})

describe('the revision', () => {
  it('starts where the server says and advances only on a change', () => {
    const one = input({ reach: reach(EVERY) })
    const first = revise(null, one, NOW)
    expect(first.kind).toBe('first')
    expect(first.snapshot.fresh.rev).toBe(12)

    const changed = revise(first.snapshot, { ...one, notes: [] }, at(2_000))
    expect(changed.kind).toBe('changed')
    expect(changed.rev).toBe(13)
    expect(changed.snapshot.fresh.rev).toBe(13)
    if (changed.kind === 'changed') expect(changed.delta.rev).toBe(13)
  })

  it('is not a journal sequence number and is not derived from one', () => {
    // Compaction rewrites `events.jsonl` in place and a byte offset into it
    // can point at different content after a restart while still looking
    // valid. Nothing here reads either, which is why the away view is immune
    // to both — and this is the test that says so out loud.
    const one = input({ reach: reach(EVERY) })
    const held = revise(null, one, NOW).snapshot
    const after = revise(held, { ...one, notes: [] }, at(2_000))
    expect(after.rev).toBe(13)
    expect(JSON.stringify(after.snapshot)).not.toContain('"seq"')
  })
})

describe('structural equality', () => {
  it('does not depend on the order two objects were built in', () => {
    expect(same({ a: 1, b: [1, { c: null }] }, { b: [1, { c: null }], a: 1 })).toBe(true)
    expect(same({ a: 1 }, { a: 1, b: undefined })).toBe(true)
    expect(same({ a: 1 }, { a: '1' })).toBe(false)
    expect(same([1, 2], [2, 1])).toBe(false)
    expect(same(null, undefined)).toBe(false)
  })
})
