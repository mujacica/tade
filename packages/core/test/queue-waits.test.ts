import { describe, expect, it } from 'vitest'
import type { EventType, TadeEvent } from '../src/events.ts'
import type { StartCondition } from '../src/model.ts'
import {
  checkWaits,
  choicesFor,
  holdSaid,
  inheritWaits,
  type Queued,
  queueStateOf,
} from '../src/queue.ts'

// Changing queued work once it is made: what it waits on (`after`) and what
// it is told (`retell`). The waits are checked by a plan's rules across every
// task there is, and the journal reads them as answers that may only ever
// make a start later.

let seq = 0
function event(type: EventType, task: string | null, detail: Record<string, unknown> = {}) {
  seq++
  return {
    seq,
    ts: '2026-10-12T10:00:00Z',
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  } satisfies TadeEvent
}

const TASKS = new Set(['tade/a', 'tade/b', 'tade/c', 'tade/d', 'web/e'])

/** What each queued task waits on, as the task files would say. */
function waits(map: Record<string, string[]>) {
  return (task: string) => map[task] ?? []
}

function check(over: Partial<Parameters<typeof checkWaits>[0]>) {
  return checkWaits({
    task: 'tade/a',
    current: [],
    after: [],
    replace: false,
    tasks: TASKS,
    waits: waits({}),
    ...over,
  })
}

describe('a wait written on queued work', () => {
  it('reads a bare name in its own project and a qualified one anywhere, and keeps what it had', () => {
    expect(
      check({
        current: [{ task: 'tade/d', why: 'same file' }],
        after: [
          { task: 'b', why: 'builds on it' },
          { task: 'web/e', why: 'its API' },
          // Said twice is waited on once.
          { task: 'tade/b', why: 'again' },
        ],
      }),
    ).toEqual({
      ok: true,
      after: [
        { task: 'tade/d', why: 'same file' },
        { task: 'tade/b', why: 'builds on it' },
        { task: 'web/e', why: 'its API' },
      ],
    })
  })

  it('replaces what it waited on when told to, down to nothing', () => {
    const current = [{ task: 'tade/d', why: 'same file' }]
    expect(check({ current, after: [{ task: 'c', why: 'first' }], replace: true })).toEqual({
      ok: true,
      after: [{ task: 'tade/c', why: 'first' }],
    })
    expect(check({ current, after: [], replace: true })).toEqual({ ok: true, after: [] })
    // Adding nothing is not a change anybody meant.
    expect(check({ current, after: [] })).toEqual({
      ok: false,
      problems: ['say what tade/a waits on, or replace its waits with none'],
    })
  })

  it('refuses every wait it cannot keep at once, naming where to find the ones it can', () => {
    const answer = check({
      after: [
        { task: 'a', why: '' },
        { task: 'ghost', why: '' },
        { task: 'web/ghost', why: '' },
      ],
    })
    expect(answer).toEqual({
      ok: false,
      problems: [
        'tade/a cannot wait on itself',
        'tade/a cannot wait on ghost, which is not a task Tade has: wait only on one tade_queue or tade_status lists',
        'tade/a cannot wait on web/ghost, which is not a task Tade has: wait only on one tade_queue or tade_status lists',
      ],
    })
  })

  it('refuses a loop through existing queued work, and says which way it goes round', () => {
    // b already waits on a: a waiting on b would leave both waiting for ever.
    expect(
      check({ after: [{ task: 'b', why: '' }], waits: waits({ 'tade/b': ['tade/a'] }) }),
    ).toEqual({
      ok: false,
      problems: [
        'tade/a cannot wait on tade/b: tade/b already waits on tade/a, so neither could start',
      ],
    })
    // Through two others, across a project.
    expect(
      check({
        after: [{ task: 'b', why: '' }],
        waits: waits({ 'tade/b': ['web/e'], 'web/e': ['tade/c'], 'tade/c': ['tade/a'] }),
      }),
    ).toEqual({
      ok: false,
      problems: [
        'tade/a cannot wait on tade/b: tade/b already waits on tade/a through web/e and tade/c, so none of them could start',
      ],
    })
    // What it already waited on is not what closes the loop: a loop the files
    // already had is not this change's, and taking a wait away never makes one.
    expect(
      check({
        current: [{ task: 'tade/c', why: '' }],
        after: [{ task: 'd', why: '' }],
        waits: waits({ 'tade/d': ['tade/b'], 'tade/b': [] }),
      }).ok,
    ).toBe(true)
  })
})

describe('how the queue reads a wait or a retelling', () => {
  const item = (start: Partial<StartCondition>): Queued => ({
    task: 'tade/a',
    project: 'tade',
    parked: false,
    start: { after: [], prompt: 'do it', touches: [], ...start },
  })

  it('takes back a start-anyway, and answers no trouble it was held on', () => {
    const failed = event('failed', 'tade/b')
    const anyway = event('queue_changed', 'tade/a', { change: 'start' })
    const after = event('queue_changed', 'tade/a', { change: 'after' })
    expect(choicesFor('tade/a', [failed, anyway, after])).toEqual({
      paused: false,
      anyway: false,
      answeredAt: anyway.seq,
    })
    // A wait added on top of one that failed still holds on the failure: a
    // wait may only ever make a start later.
    const facts = {
      tasks: new Map([
        ['tade/b', { state: 'failed' as const, reason: 'tests' }],
        ['tade/c', { state: 'working' as const, reason: '' }],
      ]),
      finished: new Map(),
      events: [failed, event('queue_changed', 'tade/a', { change: 'after' })],
      now: 0,
    }
    expect(
      queueStateOf(
        item({
          after: [
            { task: 'tade/b', why: '' },
            { task: 'tade/c', why: '' },
          ],
        }),
        facts,
      ),
    ).toEqual({ kind: 'held', on: 'tade/b', because: 'tade/b failed: tests' })
  })

  it('says a hold again after a wait or a retelling, because each was an answer to it', () => {
    const held = { because: 'src/a.ts is changed and not committed', changed: ['src/a.ts'] }
    const first = event('queue_held', 'tade/a', { because: held.because, changed: held.changed })
    expect(holdSaid('tade/a', held, [first])).toBe(true)
    for (const change of ['after', 'retell', 'wait', 'start', 'resume']) {
      expect(holdSaid('tade/a', held, [first, event('queue_changed', 'tade/a', { change })])).toBe(
        false,
      )
    }
    // Pausing is not an answer to a hold.
    expect(
      holdSaid('tade/a', held, [first, event('queue_changed', 'tade/a', { change: 'pause' })]),
    ).toBe(true)
  })
})

describe('waits handed on by a removal', () => {
  const removed = 'tade/b'
  const instead = 'in place of tade/b, which was removed'

  it('puts what the removed task waited on where the wait on it was', () => {
    expect(
      inheritWaits({
        task: 'tade/a',
        current: [
          { task: 'tade/b', why: 'needs b' },
          { task: 'tade/d', why: 'shares a file' },
        ],
        removed,
        waits: [
          { task: 'tade/c', why: 'what b built on' },
          { task: 'web/e', why: '' },
        ],
      }),
    ).toEqual([
      // Its own reason, since it is the one waiting, and where the wait came from.
      { task: 'tade/c', why: `needs b; ${instead}` },
      { task: 'web/e', why: `needs b; ${instead}` },
      { task: 'tade/d', why: 'shares a file' },
    ])
  })

  it('keeps a wait it already had with its own reason, and never waits on itself', () => {
    expect(
      inheritWaits({
        task: 'tade/a',
        current: [
          { task: 'tade/b', why: '' },
          { task: 'tade/c', why: 'its own' },
        ],
        removed,
        waits: [
          { task: 'tade/c', why: 'b needed it' },
          { task: 'tade/a', why: '' },
          { task: 'tade/d', why: '' },
        ],
      }),
    ).toEqual([
      { task: 'tade/d', why: instead },
      { task: 'tade/c', why: 'its own' },
    ])
  })

  it('waits on nothing in its place where the removed task waited on nothing', () => {
    expect(
      inheritWaits({ task: 'tade/a', current: [{ task: 'tade/b', why: '' }], removed, waits: [] }),
    ).toEqual([])
  })

  it('leaves a start-anyway standing, and starts once what it took over has finished', () => {
    const anyway = event('queue_changed', 'tade/a', { change: 'start' })
    const handed = event('queue_changed', 'tade/a', {
      change: 'after',
      inherited: 'tade/b',
      after: [{ task: 'tade/c', why: instead }],
    })
    expect(choicesFor('tade/a', [anyway, handed]).anyway).toBe(true)
    // A wait somebody wrote is still newer than a start-anyway, and says the opposite.
    expect(
      choicesFor('tade/a', [anyway, handed, event('queue_changed', 'tade/a', { change: 'after' })])
        .anyway,
    ).toBe(false)

    const facts = (finished: boolean) => ({
      tasks: new Map([['tade/c', { state: 'working' as const, reason: '' }]]),
      finished: new Map(
        finished ? [['tade/c', { at: '2026-10-12T10:00:00Z', by: 'you', summary: '' }]] : [],
      ),
      events: [event('task_removed', 'tade/b'), handed],
      now: 0,
    })
    const item: Queued = {
      task: 'tade/a',
      project: 'tade',
      parked: false,
      start: { after: [{ task: 'tade/c', why: instead }], prompt: '', touches: [] },
    }
    // Nothing about the removal holds it: what it waits on now is what b did.
    expect(queueStateOf(item, facts(false))).toEqual({ kind: 'waiting', on: ['tade/c'] })
    expect(queueStateOf(item, facts(true))).toEqual({ kind: 'ready' })
  })
})
