import { describe, expect, it } from 'vitest'
import type { Finished } from '../src/done.ts'
import type { EventType, TadeEvent } from '../src/events.ts'
import type { StartCondition, TaskState } from '../src/model.ts'
import {
  collidesNow,
  describeQueueState,
  inWrittenOrder,
  orderFirst,
  type Queued,
  type QueueFacts,
  queueStanding,
  queueStateOf,
  type Reality,
  readyToStart,
  startFrom,
  writtenOrder,
} from '../src/queue.ts'

const NOW = Date.parse('2026-09-15T13:00:00Z')

let seq = 0
function event(
  type: EventType,
  task: string | null,
  detail: Record<string, unknown> = {},
): TadeEvent {
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

function queued(task: string, start: Partial<StartCondition> = {}, parked = false): Queued {
  return {
    task,
    project: task.split('/')[0] ?? '',
    parked,
    start: { after: [], prompt: 'do it', touches: [], ...start },
  }
}

function facts(over: {
  tasks?: Record<string, TaskState | [TaskState, string]>
  finished?: string[]
  events?: TadeEvent[]
  reality?: Record<string, Partial<Reality>>
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
    ...(over.reality
      ? {
          reality: new Map(
            Object.entries(over.reality).map(([project, seen]) => [
              project,
              { workspace: 'checkout', working: [], dirty: [], committed: [], ...seen },
            ]),
          ),
        }
      : {}),
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

  // Parking is the one thing here a person tells Tade rather than Tade
  // deriving it, and `deriveState` gives it precedence over every state but a
  // merge. The queue has to agree, or a task drawn as parked everywhere else
  // starts anyway — which is what this asserts, through the rule and through
  // the selector that reads it.
  it('holds work its person has parked, whatever else would have started it', () => {
    const parked = queued('shop/release-notes', {}, true)
    expect(queueStateOf(parked, facts({}))).toEqual({
      kind: 'paused',
      all: false,
      parked: true,
    })
    expect(queueStanding(parked, facts({}))).toMatchObject({ parked: true })
    expect(readyToStart([parked], facts({}), new Map())).toEqual([])
  })

  it('keeps a park when somebody has already said start it anyway', () => {
    // `start` is the answer to a hold, and it is read before everything the
    // journal and the tree say. A park is not one of those: it is newer than
    // any of it by construction, because picking the task up again is the only
    // way to undo it.
    const anyway = facts({
      events: [event('queue_changed', 'shop/release-notes', { change: 'start', by: 'you' })],
    })
    expect(queueStateOf(queued('shop/release-notes', {}, true), anyway)).toMatchObject({
      kind: 'paused',
      parked: true,
    })
    expect(queueStateOf(queued('shop/release-notes', {}, false), anyway)).toEqual({ kind: 'ready' })
  })

  it('holds a parked task waiting on nothing, in a project whose queue is running', () => {
    // The shape an intake's "proposed, waiting for a person" would be, and the
    // reason this is tested rather than assumed: every other hold here comes
    // from the journal or the tree, and this one comes from the task file.
    const items = [queued('shop/a'), queued('shop/proposed', {}, true), queued('shop/b')]
    expect(readyToStart(inWrittenOrder(items, []), facts({}), new Map([['shop', 3]]))).toEqual([
      'shop/a',
      'shop/b',
    ])
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

  it('starts what is ready in the order last written for it, and nothing else changes', () => {
    const items = [queued('shop/a'), queued('shop/b'), queued('shop/c')]
    const ordered = facts({
      events: [
        event('queue_changed', null, { change: 'order', by: 'you', order: ['shop/c'] }),
        event('queue_changed', null, { change: 'order', by: 'you', order: ['shop/b', 'shop/c'] }),
      ],
    })
    // The last line written wins, and what nobody named keeps its place behind.
    expect(writtenOrder(ordered.events)).toEqual(['shop/b', 'shop/c'])
    expect(inWrittenOrder(items, ordered.events).map((one) => one.task)).toEqual([
      'shop/b',
      'shop/c',
      'shop/a',
    ])
    expect(
      readyToStart(inWrittenOrder(items, ordered.events), ordered, new Map([['shop', 2]])),
    ).toEqual(['shop/b', 'shop/c'])
    // An order is a preference among what is ready: it never jumps a wait.
    const waiting = facts({
      tasks: { 'shop/fix-charge': 'working' },
      events: [...ordered.events],
    })
    const withWait = [refunds, ...items]
    expect(
      readyToStart(inWrittenOrder(withWait, waiting.events), waiting, new Map()),
    ).not.toContain('shop/add-refunds')
    // With nothing written it is arrival order, exactly as it was.
    expect(inWrittenOrder(items, []).map((one) => one.task)).toEqual(['shop/a', 'shop/b', 'shop/c'])
  })

  it('puts one piece of work first and leaves the rest as they were', () => {
    const items = [queued('shop/a'), queued('shop/b'), queued('shop/c')]
    expect(orderFirst(items, [], 'shop/c')).toEqual(['shop/c', 'shop/a', 'shop/b'])
    const already = [
      event('queue_changed', null, { change: 'order', by: 'you', order: ['shop/b'] }),
    ]
    expect(orderFirst(items, already, 'shop/a')).toEqual(['shop/a', 'shop/b', 'shop/c'])
  })

  it('says where it stands in a few words', () => {
    const clock = (at: number) => new Date(at).toISOString().slice(11, 16)
    expect(describeQueueState({ kind: 'waiting', on: ['a', 'b'] }, clock)).toBe('after a and b')
    expect(describeQueueState({ kind: 'scheduled', at: NOW }, clock)).toBe('at 13:00')
    expect(describeQueueState({ kind: 'ready' }, clock)).toBe('next')
    expect(describeQueueState({ kind: 'paused', all: false }, clock)).toBe('paused')
    expect(describeQueueState({ kind: 'paused', all: true }, clock)).toBe('paused with the queue')
    // "Paused" is the queue's word for a choice about the queue; a park is a
    // choice about the task, and a person who pressed Park reads its own word.
    expect(describeQueueState({ kind: 'paused', all: false, parked: true }, clock)).toBe('parked')
  })
})

describe('what the tree says when work is about to start', () => {
  // What it was planned to change, as somebody read the code an hour ago.
  const notes = queued('shop/notes-on-charge', { touches: ['src/charge.ts', 'docs/'] })

  it('holds work whose files an agent at work has already changed, and says whose', () => {
    const seen = facts({
      reality: {
        shop: {
          working: ['shop/fix-charge'],
          committed: [{ task: 'shop/fix-charge', paths: ['src/charge.ts', 'src/mail.ts'] }],
        },
      },
    })
    expect(queueStateOf(notes, seen)).toEqual({
      kind: 'held',
      on: null,
      because:
        'shop/fix-charge, which is working, has already changed src/charge.ts, which this was planned to change',
      changed: ['src/charge.ts'],
      by: ['shop/fix-charge'],
    })
    // The rule is still the rule: held work is not ready, so it can never
    // take the slot of work behind it.
    expect(readyToStart([notes], seen, new Map([['shop', 1]]))).toEqual([])
    // And the rule without the tree still says it would start, which is how
    // the window knows whose tree is worth a git call.
    expect(queueStanding(notes, seen)).toEqual({ kind: 'ready' })
  })

  it('holds on a file being changed now without saying whose it is', () => {
    const seen = facts({
      reality: { shop: { working: ['shop/fix-charge'], dirty: ['docs/refunds.md'] } },
    })
    expect(queueStateOf(notes, seen)).toMatchObject({
      kind: 'held',
      because:
        'docs/, which this was planned to change, is changed and not committed, while shop/fix-charge works in the same checkout',
      changed: ['docs/'],
      by: [],
    })
  })

  it('starts when nobody has touched its files', () => {
    const seen = facts({
      reality: {
        shop: {
          working: ['shop/fix-charge'],
          dirty: ['src/mail.ts'],
          committed: [{ task: 'shop/fix-charge', paths: ['src/mail.ts'] }],
        },
      },
    })
    expect(queueStateOf(notes, seen)).toEqual({ kind: 'ready' })
    expect(readyToStart([notes], seen, new Map())).toEqual(['shop/notes-on-charge'])
  })

  it('starts when the person says to, and never asks them twice', () => {
    const held = [
      event('queue_held', 'shop/notes-on-charge', {
        because: 'shop/fix-charge, which is working, has already changed src/charge.ts',
        changed: ['src/charge.ts'],
        by: ['shop/fix-charge'],
      }),
    ]
    const collides = {
      shop: {
        working: ['shop/fix-charge'],
        committed: [{ task: 'shop/fix-charge', paths: ['src/charge.ts'] }],
      },
    }
    expect(queueStateOf(notes, facts({ events: held, reality: collides }))).toMatchObject({
      kind: 'held',
    })
    const released = [
      ...held,
      event('queue_changed', 'shop/notes-on-charge', { change: 'start', by: 'you' }),
    ]
    expect(queueStateOf(notes, facts({ events: released, reality: collides }))).toEqual({
      kind: 'ready',
    })
  })

  it('stands on what was written until somebody looks again, and heals when they do', () => {
    const held = [
      event('queue_held', 'shop/notes-on-charge', {
        because: 'shop/fix-charge, which is working, has already changed src/charge.ts',
        changed: ['src/charge.ts'],
      }),
    ]
    // Nobody has looked at this project's tree: the last hold stands, so
    // every reader says the same thing about it.
    expect(queueStateOf(notes, facts({ events: held }))).toMatchObject({
      kind: 'held',
      changed: ['src/charge.ts'],
    })
    // A look that finds the files settled starts it: work never waits on a
    // person for a reason that has gone.
    expect(
      queueStateOf(notes, facts({ events: held, reality: { shop: { working: ['shop/fix'] } } })),
    ).toEqual({ kind: 'ready' })
  })

  it('is not held by what it waits on, by itself, or by a worktree of somebody else', () => {
    const after = queued('shop/add-refunds', {
      touches: ['src/charge.ts'],
      after: [{ task: 'shop/fix-charge', why: 'both change src/charge.ts' }],
    })
    const changed = {
      working: ['shop/fix-charge'],
      committed: [{ task: 'shop/fix-charge', paths: ['src/charge.ts'] }],
    }
    // What it waits on is what it builds on.
    expect(
      queueStateOf(after, facts({ finished: ['shop/fix-charge'], reality: { shop: changed } })),
    ).toEqual({ kind: 'ready' })
    // A worktree each: nothing is being changed under anybody, and what two
    // branches do to one file is a merge, not a reason to hold a start.
    expect(
      queueStateOf(notes, facts({ reality: { shop: { ...changed, workspace: 'worktree' } } })),
    ).toEqual({ kind: 'ready' })
    // Work that said nothing about what it touches cannot be checked.
    expect(queueStateOf(queued('shop/have-a-look'), facts({ reality: { shop: changed } }))).toEqual(
      {
        kind: 'ready',
      },
    )
    // And with nobody at work, the tree is nobody's business but the person's.
    expect(queueStateOf(notes, facts({ reality: { shop: { dirty: ['src/charge.ts'] } } }))).toEqual(
      { kind: 'ready' },
    )
  })
})

describe('where queued work in a worktree begins', () => {
  it('builds on what it waited on, unless that was merged into the base', () => {
    const upstream = new Map([
      [
        'shop/fix-charge',
        {
          workspace: 'worktree' as const,
          branch: 'tade/fix-charge',
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
          branch: 'tade/docs',
          head: 'ccc',
          done: 'merged' as const,
        },
      ],
    ])
    expect(
      startFrom(
        [{ task: 'shop/fix-charge' }, { task: 'shop/bump-mailer' }],
        upstream,
        'main',
        'shop',
      ),
    ).toEqual(['tade/fix-charge', 'bbb'])
    expect(startFrom([{ task: 'shop/docs' }], upstream, 'main', 'shop')).toEqual(['main'])
    expect(startFrom([], upstream, null, 'shop')).toEqual([])
  })

  it('holds two agents of one effort as readily as any other, in one checkout', () => {
    // An effort is a name for related work, not a lock on a file. Two agents
    // in one effort editing one file in one checkout is the same accident as
    // any other, so the tree evidence must not learn the word — and above all
    // must never read "same effort" as permission.
    const seen = {
      workspace: 'checkout' as const,
      working: ['shop/search-a'],
      dirty: ['src/index.ts'],
      committed: [],
    }
    const sibling = queued('shop/search-b', { touches: ['src/index.ts'] })
    expect(collidesNow(sibling, seen)).toMatchObject({
      paths: ['src/index.ts'],
      because:
        'src/index.ts, which this was planned to change, is changed and not committed, while shop/search-a works in the same checkout',
    })
  })

  it('never begins on a branch from another repository, however the wait reads', () => {
    // The upstream map is flat across every project, because a wait is. Repo
    // A's branch name handed to `git worktree add` in repo B fails in the good
    // case and in the bad one finds a ref of that name that is somebody else's
    // work entirely — so a cross-repo wait is a wait on *when*, and this
    // begins from its own base exactly as it would with no wait at all.
    const upstream = new Map([
      [
        'api/oauth-scopes',
        {
          workspace: 'worktree' as const,
          branch: 'tade/oauth-scopes',
          head: 'aaa',
          done: 'said' as const,
        },
      ],
      [
        'cli/bump',
        { workspace: 'worktree' as const, branch: 'tade/bump', head: 'bbb', done: 'said' as const },
      ],
    ])
    const after = [{ task: 'api/oauth-scopes' }, { task: 'cli/bump' }]
    expect(startFrom(after, upstream, 'main', 'cli')).toEqual(['tade/bump'])
    expect(startFrom([{ task: 'api/oauth-scopes' }], upstream, 'main', 'cli')).toEqual(['main'])
  })
})
