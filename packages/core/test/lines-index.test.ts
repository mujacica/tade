import { describe, expect, it } from 'vitest'
import type { Finished } from '../src/done.ts'
import type { EventType, TadeEvent } from '../src/events.ts'
import { followWait } from '../src/fleet-waits.ts'
import { linesOf, linesTyped, ownOf } from '../src/lines-index.ts'
import type { TaskState } from '../src/model.ts'
import { choicesFor, type Queued, type QueueFacts, queueStateOf } from '../src/queue.ts'

// The queue's rules read every line about one task, once per piece of queued
// work and once per wait, several times a beat — over the whole journal, that
// was half the window's thread under load. These hold them to the lines the
// index has to read, counted, never timed: a count is the same on a loaded
// machine and an idle one.

let seq = 0
function line(
  type: EventType,
  task: string | null,
  detail: Record<string, unknown> = {},
): TadeEvent {
  seq++
  return {
    seq,
    ts: '2026-11-25T13:00:00.000Z',
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

/** An array that counts how many of its lines were read, by index. */
function counted(events: TadeEvent[]): { events: TadeEvent[]; reads: () => number } {
  let reads = 0
  const proxy = new Proxy(events, {
    get(target, key, receiver) {
      if (typeof key === 'string' && /^\d+$/.test(key)) reads++
      return Reflect.get(target, key, receiver)
    },
  })
  return { events: proxy, reads: () => reads }
}

/** A journal the shape of a real one: many tasks, most lines about none of the queue, a few foreign. */
function journal(tasks: number): TadeEvent[] {
  const events: TadeEvent[] = []
  for (let i = 0; i < tasks; i++) {
    const task = `p/t${i}`
    events.push(line('run_started', task))
    for (let k = 0; k < 20; k++) events.push(line('watch_checked', null, { watch: `w${k}` }))
    if (i % 3 === 0) events.push(line('run_exited', task, { code: 1 }))
    if (i % 7 === 0) events.push(line('queue_changed', task, { change: 'pause' }))
    if (i % 11 === 0) events.push(line('task_removed', task))
    if (i % 13 === 0)
      events.push({
        ...line('queue_changed', null, { change: 'pause', all: true }),
        machine: 'vps',
      } as TadeEvent)
  }
  events.push(line('queue_changed', null, { change: 'pause', all: true, project: 'q' }))
  return events
}

function queue(count: number, tasks: number): Queued[] {
  return Array.from({ length: count }, (_, i) => ({
    task: `p/queued${i}`,
    project: 'p',
    parked: false,
    start: {
      after: [0, 1, 2].map((k) => ({ task: `p/t${(i * 3 + k) % tasks}`, why: '' })),
      prompt: 'go',
      touches: [],
    },
  }))
}

function factsOver(events: readonly TadeEvent[], tasks: number): QueueFacts {
  const states = new Map<string, { state: TaskState; reason: string }>()
  for (let i = 0; i < tasks; i++) {
    if (i % 11 !== 0)
      states.set(`p/t${i}`, { state: i % 3 === 0 ? 'failed' : 'working', reason: '' })
  }
  return {
    tasks: states,
    finished: new Map<string, Finished>(),
    events,
    now: Date.parse('2026-11-25T13:00:00Z'),
  }
}

describe('the lines of a journal by task', () => {
  it('hands back every line about a task and of a type, in the journal’s order', () => {
    const events = journal(30)
    expect(linesOf(events, 'p/t7')).toEqual(events.filter((e) => e.task === 'p/t7'))
    expect(linesTyped(events, 'queue_changed')).toEqual(
      events.filter((e) => e.type === 'queue_changed'),
    )
    expect(linesOf(events, 'nobody')).toEqual([])
    expect(ownOf(events)).toEqual(events.filter((e) => !('machine' in e)))
  })

  it('is the array itself where nothing in it is foreign', () => {
    const events = [line('run_started', 'a'), line('run_exited', 'a')]
    expect(ownOf(events)).toBe(events)
  })

  it('reads a line once, however many pieces of queued work ask, and only the new ones once it grows', () => {
    const tasks = 400
    const plain = journal(tasks)
    const { events, reads } = counted(plain)
    const items = queue(160, tasks)
    for (const item of items) queueStateOf(item, factsOver(events, tasks))
    // One pass to index the journal and one to set its own lines apart from
    // the foreign ones; every ask after that reads the index. A scan per rule
    // per wait per item was 160 × 11 passes — 18 million reads here.
    expect(reads()).toBeLessThanOrEqual(2 * plain.length)
    // Asking again reads a line a time to see the array is still the one
    // indexed — a few per piece of queued work, never the journal.
    const first = reads()
    for (const item of items) queueStateOf(item, factsOver(events, tasks))
    expect(reads() - first).toBeLessThanOrEqual(2 * items.length)
    const added = [
      line('run_started', 'p/t5'),
      line('queue_changed', 'p/queued1', { change: 'start' }),
    ]
    events.push(...added)
    const before = reads()
    for (const item of items) queueStateOf(item, factsOver(events, tasks))
    expect(reads() - before).toBeLessThanOrEqual(2 * items.length + 2 * added.length)
  })

  it('answers as a journal read from the start does, as it grows', () => {
    const tasks = 60
    const events = journal(tasks)
    const items = queue(40, tasks)
    const states = () => items.map((item) => queueStateOf(item, factsOver(events, tasks)))
    const fresh = () => items.map((item) => queueStateOf(item, factsOver([...events], tasks)))
    expect(states()).toEqual(fresh())
    events.push(
      line('run_started', 'p/t3'),
      line('queue_changed', 'p/queued4', { change: 'start' }),
    )
    events.push({ ...line('task_removed', 'p/t9'), machine: 'vps' } as TadeEvent)
    events.push(line('queue_changed', null, { change: 'resume', all: true, project: 'q' }))
    expect(states()).toEqual(fresh())
  })

  it('indexes an array again that got shorter or was rewritten at its end', () => {
    const events = [line('queue_changed', 'a', { change: 'pause' })]
    expect(choicesFor('a', events).paused).toBe(true)
    events.pop()
    expect(choicesFor('a', events).paused).toBe(false)
    events.push(line('queue_changed', 'a', { change: 'start' }))
    expect(choicesFor('a', events).anyway).toBe(true)
    events[0] = line('queue_changed', 'a', { change: 'pause' })
    expect(choicesFor('a', events)).toMatchObject({ anyway: false, paused: true })
  })

  it('follows a move through the index of each journal', () => {
    const own = [line('task_moved', 'p/a', { to: 'vps', as: 'p/a2' })]
    const there = [
      { ...line('task_taken', 'p/a2', { was: 'p/a', from: 'mac' }), machine: 'vps' } as TadeEvent,
    ]
    const fleet = { self: 'mac', machines: [{ name: 'vps', heardAt: 1, lines: there }] }
    expect(followWait('p/a', fleet, own)).toMatchObject({ kind: 'there', task: 'p/a2' })
    own.push(line('task_moved', 'p/a', { to: 'ipax', as: 'p/a3' }))
    expect(followWait('p/a', fleet, own)).toMatchObject({
      kind: 'unseen',
      machine: 'ipax',
      task: 'p/a3',
    })
  })
})
