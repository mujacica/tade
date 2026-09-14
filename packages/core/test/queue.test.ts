import { describe, expect, it } from 'vitest'
import type { Finished } from '../src/done.ts'
import type { EventType, WilcoEvent } from '../src/events.ts'
import type { StartCondition, TaskState } from '../src/model.ts'
import {
  checkPlan,
  describeQueueState,
  type PlannedAgent,
  type Queued,
  type QueueFacts,
  queueStateOf,
  readyToStart,
  startFrom,
} from '../src/queue.ts'

const NOW = Date.parse('2026-09-15T13:00:00Z')

let seq = 0
function event(
  type: EventType,
  task: string | null,
  detail: Record<string, unknown> = {},
): WilcoEvent {
  seq++
  return {
    seq,
    ts: new Date(NOW).toISOString(),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

function queued(task: string, start: Partial<StartCondition> = {}): Queued {
  return {
    task,
    project: task.split('/')[0] ?? '',
    start: { after: [], prompt: 'do it', touches: [], ...start },
  }
}

function facts(over: {
  tasks?: Record<string, TaskState | [TaskState, string]>
  finished?: string[]
  events?: WilcoEvent[]
}): QueueFacts {
  const finished = new Map<string, Finished>()
  for (const task of over.finished ?? []) finished.set(task, { at: '', by: 'agent', summary: '' })
  return {
    tasks: new Map(
      Object.entries(over.tasks ?? {}).map(([task, value]) => [
        task,
        Array.isArray(value) ? { state: value[0], reason: value[1] } : { state: value, reason: '' },
      ]),
    ),
    finished,
    events: over.events ?? [],
    now: NOW,
  }
}

const refunds = queued('shop/add-refunds', {
  after: [{ task: 'shop/fix-charge', why: 'both change src/charge.ts' }],
})

describe('where queued work stands', () => {
  it('waits for what it waits on, and is ready once that has finished', () => {
    const working = facts({ tasks: { 'shop/fix-charge': 'working' } })
    expect(queueStateOf(refunds, working)).toEqual({ kind: 'waiting', on: ['shop/fix-charge'] })
    const done = facts({ tasks: { 'shop/fix-charge': 'blocked' }, finished: ['shop/fix-charge'] })
    expect(queueStateOf(refunds, done)).toEqual({ kind: 'ready' })
  })

  it('is held when what it waits on fails, is stopped, or goes — not when it only looks done', () => {
    const failed = facts({ tasks: { 'shop/fix-charge': ['failed', 'agent exited with code 1'] } })
    expect(queueStateOf(refunds, failed)).toEqual({
      kind: 'held',
      on: 'shop/fix-charge',
      because: 'shop/fix-charge failed: agent exited with code 1',
    })
    // A stopped agent in a checkout reads as review: stopped is still not finished.
    const stopped = facts({
      tasks: { 'shop/fix-charge': 'review' },
      events: [
        event('run_started', 'shop/fix-charge'),
        event('run_exited', 'shop/fix-charge', { stopped: true }),
      ],
    })
    expect(queueStateOf(refunds, stopped)).toMatchObject({
      kind: 'held',
      because: 'shop/fix-charge was stopped before it finished',
    })
    // Started again, it is only waited on.
    const restarted = facts({
      tasks: { 'shop/fix-charge': 'working' },
      events: [...stopped.events, event('run_started', 'shop/fix-charge')],
    })
    expect(queueStateOf(refunds, restarted)).toMatchObject({ kind: 'waiting' })
    const gone = facts({ events: [event('task_removed', 'shop/fix-charge')] })
    expect(queueStateOf(refunds, gone)).toMatchObject({
      because: 'shop/fix-charge was removed before it finished',
    })
  })

  it('waits past a failure somebody chose to wait past, until it fails again', () => {
    const failure = [
      event('run_started', 'shop/fix-charge'),
      event('run_exited', 'shop/fix-charge', { code: 1 }),
      event('queue_changed', 'shop/add-refunds', { change: 'wait', by: 'you' }),
    ]
    const tasks = { 'shop/fix-charge': ['failed', 'tests failed'] as [TaskState, string] }
    expect(queueStateOf(refunds, facts({ tasks, events: failure }))).toMatchObject({
      kind: 'waiting',
    })
    const again = [...failure, event('run_exited', 'shop/fix-charge', { code: 1 })]
    expect(queueStateOf(refunds, facts({ tasks, events: again }))).toMatchObject({ kind: 'held' })
  })

  it('is started anyway when somebody says so, and holds when its own start fails', () => {
    const anyway = facts({
      tasks: { 'shop/fix-charge': 'failed' },
      events: [event('queue_changed', 'shop/add-refunds', { change: 'start', by: 'you' })],
    })
    expect(queueStateOf(refunds, anyway)).toEqual({ kind: 'ready' })
    const couldNot = facts({
      tasks: { 'shop/fix-charge': 'failed' },
      events: [
        ...anyway.events,
        event('queue_held', 'shop/add-refunds', { start: 'failed', because: 'max_parallel is 1' }),
      ],
    })
    expect(queueStateOf(refunds, couldNot)).toEqual({
      kind: 'held',
      on: null,
      because: 'max_parallel is 1',
    })
  })

  it('pauses on its own, or with its whole project, and waits for its time', () => {
    const later = queued('shop/release-notes', { at: '2026-09-15T18:00:00Z' })
    expect(queueStateOf(later, facts({}))).toEqual({
      kind: 'scheduled',
      at: Date.parse('2026-09-15T18:00:00Z'),
    })
    const paused = facts({
      events: [event('queue_changed', 'shop/release-notes', { change: 'pause' })],
    })
    expect(queueStateOf(later, paused)).toEqual({ kind: 'paused', all: false })
    const all = facts({
      events: [event('queue_changed', null, { change: 'pause', all: true, project: 'shop' })],
    })
    expect(queueStateOf(later, all)).toEqual({ kind: 'paused', all: true })
    // Another project's pause is not this one's.
    const elsewhere = facts({
      events: [event('queue_changed', null, { change: 'pause', all: true, project: 'search' })],
    })
    expect(queueStateOf(later, elsewhere)).toMatchObject({ kind: 'scheduled' })
  })

  it('starts what is ready in order, as far as each project has room', () => {
    const items = [queued('shop/a'), queued('shop/b'), queued('shop/c'), queued('search/d')]
    expect(readyToStart(items, facts({}), new Map([['shop', 2]]))).toEqual([
      'shop/a',
      'shop/b',
      'search/d',
    ])
    expect(readyToStart(items, facts({}), new Map([['shop', 0]]))).toEqual(['search/d'])
  })

  it('says where it stands in a few words', () => {
    const clock = (at: number) => new Date(at).toISOString().slice(11, 16)
    expect(describeQueueState({ kind: 'waiting', on: ['a', 'b'] }, clock)).toBe('after a and b')
    expect(describeQueueState({ kind: 'scheduled', at: NOW }, clock)).toBe('at 13:00')
    expect(describeQueueState({ kind: 'ready' }, clock)).toBe('next')
  })
})

describe('where queued work in a worktree begins', () => {
  it('builds on what it waited on, unless that was merged into the base', () => {
    const upstream = new Map([
      [
        'shop/fix-charge',
        {
          workspace: 'worktree' as const,
          branch: 'wilco/fix-charge',
          head: 'aaa',
          done: 'said' as const,
        },
      ],
      [
        'shop/bump-mailer',
        { workspace: 'worktree' as const, branch: '', head: 'bbb', done: 'committed' as const },
      ],
      [
        'shop/docs',
        {
          workspace: 'worktree' as const,
          branch: 'wilco/docs',
          head: 'ccc',
          done: 'merged' as const,
        },
      ],
    ])
    expect(
      startFrom([{ task: 'shop/fix-charge' }, { task: 'shop/bump-mailer' }], upstream, 'main'),
    ).toEqual(['wilco/fix-charge', 'bbb'])
    expect(startFrom([{ task: 'shop/docs' }], upstream, 'main')).toEqual(['main'])
    expect(startFrom([], upstream, null)).toEqual([])
  })
})

describe('a plan', () => {
  const agent = (name: string, over: Partial<PlannedAgent> = {}): PlannedAgent => ({
    name,
    said: name,
    prompt: name,
    after: [],
    touches: [],
    ...over,
  })
  const context = { workspace: 'checkout' as const, tasks: new Set(['shop/existing']) }

  it('is made in an order where every agent comes after what it waits on', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: 'all of it',
        agents: [
          agent('refund-emails', {
            after: [
              { agent: 'add-refunds', why: 'emails what refund() returns' },
              { agent: 'existing', why: 'already under way' },
            ],
          }),
          agent('add-refunds', { after: [{ agent: 'fix-charge', why: 'same file' }] }),
          agent('fix-charge'),
        ],
      },
      context,
    )
    if (!check.ok) throw new Error(check.problems.join('; '))
    expect(check.order.map((one) => one.name)).toEqual([
      'fix-charge',
      'add-refunds',
      'refund-emails',
    ])
    expect(check.waitsOn.get('refund-emails')).toEqual([
      { task: 'shop/add-refunds', why: 'emails what refund() returns' },
      { task: 'shop/existing', why: 'already under way' },
    ])
  })

  it('is refused whole for a wait on nothing, a cycle, or a rule the checkout cannot keep', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('a', { after: [{ agent: 'ghost', why: '' }] }),
          agent('b', { done: 'merged' }),
          agent('b'),
        ],
      },
      context,
    )
    expect(check.ok).toBe(false)
    if (check.ok) return
    expect(check.problems).toEqual([
      'b cannot finish when merged: agents in shop share one checkout. Use said, idle or manual',
      'b is in the plan twice',
      'a waits on ghost, which is neither in the plan nor a task in shop',
    ])
    const cycle = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('x', { after: [{ agent: 'y', why: '' }] }),
          agent('y', { after: [{ agent: 'x', why: '' }] }),
        ],
      },
      context,
    )
    expect(cycle).toEqual({
      ok: false,
      problems: ['x and y wait on each other, so none could start'],
    })
  })

  it('warns about two agents that run at once and change the same things', () => {
    const check = checkPlan(
      {
        project: 'shop',
        said: '',
        agents: [
          agent('fix-charge', { touches: ['src/charge.ts'] }),
          agent('bump-mailer', { touches: ['src/mail/', 'package.json'] }),
          agent('refund-emails', { touches: ['src/mail/refund.ts'] }),
          // Waits on fix-charge, so never at the same time: no warning.
          agent('add-refunds', {
            touches: ['src/charge.ts'],
            after: [{ agent: 'fix-charge', why: '' }],
          }),
        ],
      },
      context,
    )
    expect(check.ok && check.warnings).toEqual([
      'bump-mailer and refund-emails can run at the same time and both change src/mail/, in one checkout',
    ])
  })
})
