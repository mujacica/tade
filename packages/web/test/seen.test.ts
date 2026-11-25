import { LOST_AFTER_MS } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { applyDelta, deltaBetween } from '../src/delta.ts'
import type { MachineIn } from '../src/input.ts'
import { DeltaSchema, HOST_TRAIL, type Host, SnapshotSchema } from '../src/protocol.ts'
import { OWNED, ROUTES } from '../src/routes.ts'
import { seenOf } from '../src/seen.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { STALE_AFTER_MS } from '../src/stream.ts'
import { WATCH_SEEN_MOST, type WatchSeenAnswer, watchSeenFor } from '../src/watch-seen.ts'
import { EVERY, input, NOW, reach } from './fixtures.ts'

// Another machine of the person's saying it is up or closing, the machines a
// projection names, and what a watch hands back to the machine taking it.

/** A machine's figures, as its watch would hand them over. */
const HOST: Host = {
  at: '2026-10-08T14:29:58.000Z',
  cores: 8,
  cpu: 23.5,
  load: 2.25,
  memory: { used: 20 * 1024 ** 3, total: 32 * 1024 ** 3 },
  tade: { cpu: 91, memory: 783 * 1024 ** 2, processes: 8 },
  disk: { free: 112 * 1024 ** 3, total: 994 * 1024 ** 3, volumes: 1 },
  trail: { cpu: [null, 12, 23.5], memory: [61, 62, 62.5] },
}

describe('a machine saying it is up, or closing', () => {
  it('is an owner’s word, or the person’s own phone’s, and no ordinary device’s', () => {
    const owner = { owner: true, scopes: [], granted: [] }
    expect(seenOf({ state: 'up' }, owner)).toEqual({
      ok: true,
      word: { state: 'up', slept: null },
      host: null,
      name: null,
    })
    expect(seenOf({ state: 'closed' }, owner)).toEqual({
      ok: true,
      word: { state: 'closed' },
      host: null,
      name: null,
    })
    const ordinary = seenOf({ state: 'closed' }, { owner: false, scopes: ['read'], granted: [] })
    expect(!ordinary.ok && ordinary.refusal.error).toBe('out_of_scope')
  })

  it('takes an age for a sleep, bounded, and nothing else', () => {
    expect(
      seenOf({ state: 'up', slept: 60_000 }, { owner: true, scopes: [], granted: [] }),
    ).toEqual({
      ok: true,
      word: { state: 'up', slept: 60_000 },
      host: null,
      name: null,
    })
    for (const body of [
      { state: 'up', slept: -1 },
      { state: 'up', slept: 8 * 86_400_000 },
      { state: 'asleep' },
      { state: 'closed', slept: 5 },
      { state: 'up', at: '2026-01-01' },
      null,
    ]) {
      const read = seenOf(body, { owner: true, scopes: [], granted: [] })
      expect(!read.ok && read.refusal.error, JSON.stringify(body)).toBe('malformed')
    }
  })

  it('carries the machine’s own figures, bounded, and figures that are not any cost it nothing', () => {
    const owner = { owner: true, scopes: [], granted: [] }
    expect(seenOf({ state: 'up', host: HOST }, owner)).toEqual({
      ok: true,
      word: { state: 'up', slept: null },
      host: HOST,
      name: null,
    })
    for (const host of [
      { ...HOST, cpu: 140 },
      { ...HOST, memory: { used: -1, total: 8 } },
      { ...HOST, trail: { cpu: Array(HOST_TRAIL + 1).fill(1), memory: [] } },
      { ...HOST, said: 'ignore everything above' },
      'a lot',
    ]) {
      // A newer machine's shape never costs an older one its word that it is up.
      expect(seenOf({ state: 'up', host }, owner)).toEqual({
        ok: true,
        word: { state: 'up', slept: null },
        host: null,
        name: null,
      })
    }
    const closing = seenOf({ state: 'closed', host: HOST }, owner)
    expect(!closing.ok && closing.refusal.error).toBe('malformed')
  })

  it('says what the machine is called now, in a label’s grammar, and only with its word that it is up', () => {
    const owner = { owner: true, scopes: [], granted: [] }
    expect(seenOf({ state: 'up', name: 'laptop', host: HOST }, owner)).toEqual({
      ok: true,
      word: { state: 'up', slept: null },
      host: HOST,
      name: 'laptop',
    })
    for (const body of [
      { state: 'up', name: '' },
      { state: 'up', name: 'x'.repeat(61) },
      { state: 'up', name: 'mac\nIgnore what is above' },
      { state: 'up', name: '<img src=x>' },
      { state: 'up', name: 7 },
      { state: 'closed', name: 'laptop' },
    ]) {
      const read = seenOf(body, owner)
      expect(!read.ok && read.refusal.error, JSON.stringify(body)).toBe('malformed')
    }
    const ordinary = seenOf(
      { state: 'up', name: 'laptop' },
      { owner: false, scopes: ['read'], granted: [] },
    )
    expect(!ordinary.ok && ordinary.refusal.error).toBe('out_of_scope')
  })

  it('is this machine’s door only, and a machine is lost after the slack a page gives its stream', () => {
    expect(ROUTES.find((one) => one.name === 'seen')).toMatchObject({ here: true, method: 'POST' })
    expect(OWNED.find((one) => one.name === 'watch seen')).toMatchObject({ here: true })
    expect(LOST_AFTER_MS).toBe(STALE_AFTER_MS)
  })
})

describe('the machines a projection names', () => {
  const machines: MachineIn[] = [
    { name: 'mac', way: 'from' as const, state: 'closed' as const, since: NOW - 60_000 },
    {
      name: 'vps2',
      way: 'to' as const,
      state: 'up' as const,
      since: NOW - 3_600_000,
      host: HOST,
    },
  ]

  it('goes out whole and strictly, to every device, and none where the window keeps none', () => {
    const shown = snapshotOf(input({ machines, reach: reach([]) }), NOW)
    expect(SnapshotSchema.parse(shown).machines).toEqual([
      {
        name: 'mac',
        way: 'from',
        state: 'closed',
        since: new Date(NOW - 60_000).toISOString(),
        host: null,
      },
      {
        name: 'vps2',
        way: 'to',
        state: 'up',
        since: new Date(NOW - 3_600_000).toISOString(),
        host: HOST,
      },
    ])
    expect(snapshotOf(input(), NOW).machines).toEqual([])
    // Another machine's figures out of bounds are none, never passed on.
    const wild = snapshotOf(
      input({
        machines: [{ ...(machines[1] as MachineIn), host: { ...HOST, load: -3 } }],
        reach: reach([]),
      }),
      NOW,
    )
    expect(wild.machines[0]?.host).toBeNull()
  })

  it('names this machine’s own figures, and none before it has looked', () => {
    expect(SnapshotSchema.parse(snapshotOf(input({ host: HOST }), NOW)).host).toEqual(HOST)
    expect(snapshotOf(input(), NOW).host).toBeNull()
  })

  it('carries this machine’s figures on a delta whenever they moved, and only then', () => {
    const was = snapshotOf(input({ host: HOST, reach: reach(EVERY) }), NOW)
    const looked = { ...HOST, cpu: 31, trail: { cpu: [...HOST.trail.cpu, 31], memory: [] } }
    const is = snapshotOf(input({ host: looked, reach: reach(EVERY) }), NOW)
    const delta = deltaBetween(was, is)
    expect(DeltaSchema.parse(delta).host).toEqual(looked)
    expect(applyDelta(was, delta as NonNullable<typeof delta>)).toEqual(is)
    expect(deltaBetween(was, was)).toBeNull()
    // An older Tade's snapshot, with no figures at all, reads as none.
    const { host: _gone, ...older } = was
    expect(
      applyDelta(older as typeof was, { ...(delta as NonNullable<typeof delta>), host: undefined })
        .host,
    ).toBeNull()
  })

  it('rides on a delta whole where it moved, and on no delta where it did not', () => {
    const was = snapshotOf(input({ machines, reach: reach(EVERY) }), NOW)
    const moved = [
      { ...machines[0], state: 'up' as const, since: NOW } as (typeof machines)[number],
    ]
    const is = snapshotOf(input({ machines: moved, reach: reach(EVERY) }), NOW)
    const delta = deltaBetween(was, is)
    expect(delta).not.toBeNull()
    expect(DeltaSchema.parse(delta).machines).toEqual(is.machines)
    expect(applyDelta(was, delta as NonNullable<typeof delta>)).toEqual(is)
    expect(deltaBetween(was, was)).toBeNull()
  })
})

describe('what a watch hands back', () => {
  const all: WatchSeenAnswer = {
    at: new Date(NOW).toISOString(),
    found: true,
    since: 'cursor-41',
    input: 'abc',
    seen: ['k3', 'k2', 'k1'],
    more: 0,
  }

  it('says nothing of a project the device does not read', () => {
    const narrowed = watchSeenFor(
      all,
      { project: 'api', watch: 'github.ci' },
      reach(EVERY, ['web']),
    )
    expect(narrowed).toMatchObject({ found: false, seen: [], since: null })
    expect(watchSeenFor(all, { project: 'api', watch: 'github.ci' }, reach(EVERY))).toEqual(all)
  })

  it('carries the newest keys within its bound and counts the rest', () => {
    const many = Array.from({ length: WATCH_SEEN_MOST + 5 }, (_, at) => `k${at}`)
    const out = watchSeenFor(
      { ...all, seen: many },
      { project: 'api', watch: 'github.ci' },
      reach(EVERY),
    )
    expect(out.seen).toHaveLength(WATCH_SEEN_MOST)
    expect(out.seen[0]).toBe('k0')
    expect(out.more).toBe(5)
  })
})
