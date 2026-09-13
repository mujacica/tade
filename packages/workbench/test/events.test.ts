import { appendFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Urgency, WilcoEvent } from '@wilco/core'
import { describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { EventIndex } from '../src/event-index.ts'
import { EventLog, evictLeastUrgent } from '../src/events.ts'

function paths() {
  const dir = tmp('wilco-events-')
  return { dir, path: join(dir, 'events.jsonl'), indexPath: join(dir, 'events.db') }
}

const event = (urgency: Urgency, seq = 1): WilcoEvent => ({
  seq,
  ts: '2026-09-11T09:00:00.000Z',
  type: 'output',
  urgency,
  task: null,
  lane: null,
  run: null,
  detail: {},
})

describe('EventLog', () => {
  it('appends events with sequence numbers and default urgencies', async () => {
    const p = paths()
    const log = await EventLog.open(p)
    const a = await log.append({ type: 'lane_opened', lane: 'a/b/agent' })
    const b = await log.append({ type: 'output', lane: 'a/b/agent', detail: { bytes: 12 } })
    const c = await log.append({
      type: 'permission_request',
      task: 'a/b',
      detail: { tool: 'bash' },
    })
    expect([a.seq, b.seq, c.seq]).toEqual([1, 2, 3])
    expect([a.urgency, b.urgency, c.urgency]).toEqual(['notable', 'trace', 'blocking'])
    const lines = readFileSync(p.path, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(3)
    expect(JSON.parse(lines[2]!).detail.tool).toBe('bash')
    await log.close()
  })

  it('continues the sequence after reopening', async () => {
    const p = paths()
    const first = await EventLog.open(p)
    await first.append({ type: 'output' })
    await first.append({ type: 'output' })
    await first.close()

    const second = await EventLog.open(p)
    expect((await second.append({ type: 'output' })).seq).toBe(3)
    await second.close()
  })

  it('filters reads by task, type, urgency, sequence and limit', async () => {
    const p = paths()
    const log = await EventLog.open(p)
    await log.append({ type: 'output', task: 'app/x' })
    await log.append({ type: 'tool_call', task: 'app/x', detail: { tool: 'bash' } })
    await log.append({ type: 'permission_request', task: 'app/y' })
    await log.append({ type: 'turn_done', task: 'app/x' })

    expect((await log.read({ task: 'app/x' })).map((e) => e.seq)).toEqual([1, 2, 4])
    expect((await log.read({ types: ['permission_request'] })).map((e) => e.seq)).toEqual([3])
    expect((await log.read({ minUrgency: 'notable' })).map((e) => e.seq)).toEqual([3, 4])
    expect((await log.read({ since: 2 })).map((e) => e.seq)).toEqual([3, 4])
    expect((await log.read({ limit: 2 })).map((e) => e.seq)).toEqual([3, 4])
    await log.close()
  })

  it('reads identically with and without the index', async () => {
    const p = paths()
    const indexed = await EventLog.open(p)
    for (const t of ['output', 'tool_call', 'turn_done'] as const) {
      await indexed.append({ type: t, task: 'app/x' })
    }
    const viaIndex = await indexed.read({ task: 'app/x' })
    await indexed.close()

    const scanning = await EventLog.open({ ...p, indexPath: null })
    expect(scanning.index).toBeNull()
    expect(await scanning.read({ task: 'app/x' })).toEqual(viaIndex)
    await scanning.close()
  })

  describe('crash safety', () => {
    it('a torn final line is tolerated and reported, not fatal', async () => {
      const p = paths()
      const log = await EventLog.open(p)
      for (let i = 0; i < 10; i++) await log.append({ type: 'output' })
      await log.close()
      // Simulate SIGKILL mid-write: a half-written line at the end.
      appendFileSync(p.path, '{"seq":11,"ts":"2026-09-11T09:0')

      const reopened = await EventLog.open(p)
      const all = await reopened.read({})
      expect(all.filter((e) => e.type === 'output')).toHaveLength(10)
      const warning = all.find((e) => e.type === 'warning')
      expect(warning?.detail.message).toMatch(/unparseable line/)
      // The next append continues past the torn line.
      expect((await reopened.append({ type: 'output' })).seq).toBe(12)
      await reopened.close()
    })

    it('rebuilds the index from the log when it is missing or stale', async () => {
      const p = paths()
      const log = await EventLog.open(p)
      for (let i = 0; i < 25; i++) await log.append({ type: 'output', task: 'app/x' })
      const count = log.index?.count()
      expect(count).toBe(25)
      await log.close()

      rmSync(p.indexPath, { force: true })
      const rebuilt = await EventLog.open(p)
      expect(rebuilt.index?.count()).toBe(25)
      expect((await rebuilt.read({ task: 'app/x' })).length).toBe(25)
      await rebuilt.close()
    })

    it('survives a corrupt index database', async () => {
      const p = paths()
      const log = await EventLog.open(p)
      await log.append({ type: 'output' })
      await log.close()

      writeFileSync(p.indexPath, 'this is not a database')
      const reopened = await EventLog.open(p)
      expect((await reopened.read({})).length).toBe(1)
      await reopened.close()
    })
  })

  describe('backpressure', () => {
    it('drops trace before routine, and never drops blocking', () => {
      const queue = [event('trace', 1), event('routine', 2), event('trace', 3)]
      expect(evictLeastUrgent(queue, event('blocking', 4))).toBe('evicted')
      expect(queue.map((e) => e.seq)).toEqual([1, 2]) // the newest trace went first
      expect(evictLeastUrgent(queue, event('blocking', 5))).toBe('evicted')
      expect(queue.map((e) => e.seq)).toEqual([2])
      expect(evictLeastUrgent(queue, event('blocking', 6))).toBe('evicted')

      // A full queue of blocking events grows rather than losing one.
      const blocking = [event('blocking', 1), event('blocking', 2)]
      expect(evictLeastUrgent(blocking, event('blocking', 3))).toBe('overflow')
      expect(evictLeastUrgent(blocking, event('trace', 4))).toBe('rejected')
      expect(evictLeastUrgent(blocking, event('routine', 5))).toBe('rejected')
    })

    it('50 subscribers and 10k events: every blocking event is delivered, in order', async () => {
      const p = paths()
      const log = await EventLog.open({ ...p, subscriberQueue: 10 })
      const seen = Array.from({ length: 50 }, () => [] as WilcoEvent[])
      for (const bucket of seen) log.subscribe((e) => bucket.push(e))

      const appends: Array<Promise<unknown>> = []
      let blockingCount = 0
      for (let i = 0; i < 10_000; i++) {
        const blocking = i % 100 === 0
        if (blocking) blockingCount++
        appends.push(
          log.append({ type: blocking ? 'permission_request' : 'output', detail: { i } }),
        )
      }
      await Promise.all(appends)
      await new Promise((r) => setTimeout(r, 50))

      for (const bucket of seen) {
        expect(bucket.filter((e) => e.urgency === 'blocking')).toHaveLength(blockingCount)
        const seqs = bucket.map((e) => e.seq)
        expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
      }
      await log.close()
    }, 30_000)

    it('a subscriber that throws does not break the log', async () => {
      const p = paths()
      const log = await EventLog.open(p)
      log.subscribe(() => {
        throw new Error('bad subscriber')
      })
      const received: WilcoEvent[] = []
      log.subscribe((e) => received.push(e))
      await log.append({ type: 'output' })
      await new Promise((r) => setTimeout(r, 10))
      expect(received).toHaveLength(1)
      await log.close()
    })

    it('unsubscribe stops delivery', async () => {
      const p = paths()
      const log = await EventLog.open(p)
      const got: WilcoEvent[] = []
      const stop = log.subscribe((e) => got.push(e), { types: ['output'] })
      await log.append({ type: 'output' })
      await log.append({ type: 'tool_call' })
      await new Promise((r) => setTimeout(r, 10))
      stop()
      await log.append({ type: 'output' })
      await new Promise((r) => setTimeout(r, 10))
      expect(got).toHaveLength(1)
      await log.close()
    })
  })
})

describe('EventIndex', () => {
  it('is rebuildable from events with identical query results', () => {
    const p = paths()
    const index = EventIndex.open(p.indexPath)!
    const events: WilcoEvent[] = Array.from({ length: 100 }, (_, i) => ({
      ...event(i % 10 === 0 ? 'blocking' : 'trace', i + 1),
      task: i % 2 === 0 ? 'app/x' : 'app/y',
    }))
    index.insertMany(events)
    expect(index.count()).toBe(100)
    expect(index.maxSeq()).toBe(100)
    const before = index.query({ task: 'app/x', minUrgency: 'notable' })

    index.clear()
    expect(index.count()).toBe(0)
    index.insertMany(events)
    expect(index.query({ task: 'app/x', minUrgency: 'notable' })).toEqual(before)
    index.close()
  })
})
