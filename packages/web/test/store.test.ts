import { IDLE_REASON as CORE_IDLE, WAITING_STATES } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  applyDelta,
  applySnapshot,
  asOf,
  emptyStore,
  intakeOf,
  intakeWaiting,
  omitted,
  queueIn,
  rowsOf,
  SPEAKS,
  talkOf,
  taskAt,
  WAITING,
  wantingIds,
  wantsYou,
} from '../src/assets/store.js'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import { input, NOW, queued, reach, task } from './fixtures.ts'

// What the page holds, tested against **the real projection** rather than a
// hand-written frame.
//
// That matters more here than anywhere else in the package: the merge is only
// correct if it is the inverse of what `deltaBetween` produces, and a fixture
// delta written by hand is a fixture of what somebody thought it produces. So
// every delta in this file comes out of a real `projector` being beaten, which
// is also what makes this a test of the protocol's own claim — *a delta is a
// shallow merge keyed by a stable id, and a row arriving for the first time
// comes whole*.
//
// The second thing held here is the honesty of a fold. The snapshot is budgeted
// and says how much it left out, so a sum over what arrived is a **floor** —
// and a page that quietly under-reported somebody's week would look complete
// doing it.

const held = () => {
  const store = emptyStore()
  const made = projector(input(), NOW)
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return { store, made }
}

describe('what is said before anything was read', () => {
  it('is neither talking off nor no agents', () => {
    // `undefined` and not `null`: a page with no snapshot yet said *talking to
    // Tade is not turned on* off its own empty store.
    expect(talkOf(emptyStore())).toBeUndefined()
    const { store } = held()
    expect(talkOf(store)).not.toBeUndefined()
  })
})

describe('the protocol this page speaks', () => {
  it('is the one the machine speaks', () => {
    expect(SPEAKS).toBe(PROTOCOL_VERSION)
  })

  it('refuses a version it does not know, and says so rather than guessing', () => {
    // A client served a protocol it cannot read has one correct move, and it
    // cannot make that move if it has to infer the version from the shape.
    const store = emptyStore()
    const said = applySnapshot(store, { v: 99, fresh: {}, pages: {} })
    expect(said).toContain('version 99')
    expect(said).toContain('Reload')
    expect(store.had).toBe(false)
  })

  it('refuses a delta before any snapshot, rather than holding half a task', () => {
    // A shallow merge applied to an absent row is how a page ends up drawing
    // a task with a state and no name.
    const store = emptyStore()
    expect(
      applyDelta(store, { v: SPEAKS, rev: 1, at: '', fresh: null, set: {}, del: {} }),
    ).toContain('no snapshot')
  })
})

describe('taking a snapshot', () => {
  it('holds every collection, keyed the way the wire keys it', () => {
    const { store, made } = held()
    const snapshot = made.snapshot()
    for (const name of ['projects', 'tasks', 'queue', 'findings', 'notes', 'plans']) {
      expect(rowsOf(store, name), name).toEqual(snapshot[name as 'tasks'])
    }
    expect(store.rev).toBe(snapshot.fresh.rev)
  })

  it('replaces rather than merges, which is what makes a resync recoverable', () => {
    // Over the budget the server stops sending deltas and owes one `resync`; a
    // snapshot is what answers it, so it must not leave a row the new tree
    // does not have.
    const { store, made } = held()
    const fewer = projector(input({ tasks: [task()] }), NOW)
    expect(applySnapshot(store, fewer.snapshot())).toBeNull()
    expect(rowsOf(store, 'tasks')).toHaveLength(1)
    void made
  })
})

describe('merging a delta', () => {
  it('applies what a real projector produced, field by field', () => {
    const { store, made } = held()
    const moved = made.beat(
      input({
        tasks: [
          task({ state: 'blocked', reason: { kind: 'approval', tool: 'Bash', also: 0 } }),
          ...input().tasks.slice(1),
        ],
      }),
      NOW + 1000,
    )
    expect(moved).not.toBeNull()
    expect(applyDelta(store, moved)).toBeNull()
    const changed = taskAt(store, 'sentry', 'away-projection')
    expect(changed.state).toBe('blocked')
    // And the fields the delta did not carry are **still there**: a shallow
    // merge that dropped them would be a page holding half a task.
    expect(changed.branch).toBe('tade/away-projection')
    expect(changed.harness).toBe('claude-code')
    expect(store.rev).toBe(moved?.rev)
  })

  it('takes a row it has never seen whole', () => {
    const { store, made } = held()
    const more = made.beat(
      input({ tasks: [...input().tasks, task({ id: 'tade/new-one', project: 'tade' })] }),
      NOW + 1000,
    )
    expect(applyDelta(store, more)).toBeNull()
    const fresh = taskAt(store, 'tade', 'new-one')
    expect(fresh.name).toBe('new-one')
    expect(fresh.state).toBe('working')
    expect(fresh.checks).toBeDefined()
  })

  it('forgets a row the projection dropped', () => {
    const { store, made } = held()
    const fewer = made.beat(input({ tasks: input().tasks.slice(1) }), NOW + 1000)
    expect(applyDelta(store, fewer)).toBeNull()
    expect(taskAt(store, 'sentry', 'away-projection')).toBeNull()
  })

  it('costs one assignment for a tick, and moves no row', () => {
    // Time alone sends nothing: a beat on which nothing happened differs only
    // in `fresh.at`, and `deltaBetween` answers null to that. A `tick` is the
    // server's clock moving on, and it is **not a revision**.
    const { store, made } = held()
    const before = rowsOf(store, 'tasks')
    const tick = made.tick(NOW + 5000)
    expect(applyDelta(store, tick)).toBeNull()
    expect(rowsOf(store, 'tasks')).toEqual(before)
    expect(store.fresh.at).toBe(tick.fresh?.at)
    expect(store.rev).toBe(tick.rev)
  })

  it('keeps every collection sorted however a row arrived', () => {
    const { store, made } = held()
    const added = made.beat(
      input({ tasks: [...input().tasks, task({ id: 'sentry/aaa-first' })] }),
      NOW + 1000,
    )
    expect(applyDelta(store, added)).toBeNull()
    const ids = rowsOf(store, 'tasks').map((one: { id: string }) => one.id)
    expect(ids).toEqual([...ids].sort())
  })
})

describe('what wants you', () => {
  it('is the projection’s own flag, ordered by who is waiting on a keypress', () => {
    const store = emptyStore()
    const made = projector(
      input({
        tasks: [
          task({ id: 'a/review', state: 'review' }),
          task({ id: 'a/failed', state: 'failed' }),
          task({ id: 'a/blocked', state: 'blocked' }),
          task({ id: 'a/working', state: 'working' }),
        ],
      }),
      NOW,
    )
    applySnapshot(store, made.snapshot())
    // Review is the window's *done*, and failed its own red mark: neither is
    // the window's *needs you*, which is a decision waiting on a keypress.
    expect(wantsYou(store).map((one: { id: string }) => one.id)).toEqual(['a/blocked'])
    expect(wantingIds(store).has('a/working')).toBe(false)
  })

  it('is nothing at all where nothing is stopped', () => {
    const store = emptyStore()
    applySnapshot(store, projector(input({ tasks: [task()] }), NOW).snapshot())
    expect(wantsYou(store)).toEqual([])
  })
  it('is what the window marked, and the page derives nothing of its own', () => {
    // The window's mark rides on every row (`markOf`): a finished agent idle at
    // its prompt is `done` there whatever `deriveState` said, so it is never
    // counted here — and the page applies no second copy of the rule over it.
    const tasks = [
      task({ id: 'a/idle', state: 'blocked', reason: { kind: 'clause', said: CORE_IDLE } }),
      task({
        id: 'a/finished',
        state: 'blocked',
        reason: { kind: 'clause', said: CORE_IDLE },
        finished: true,
      }),
      task({
        id: 'a/dirty',
        state: 'blocked',
        reason: { kind: 'clause', said: 'turn ended with 2 uncommitted files' },
      }),
      task({ id: 'a/failed', state: 'failed' }),
      task({ id: 'a/review', state: 'review' }),
      task({ id: 'a/working', state: 'working' }),
    ]
    const made = projector(input({ tasks }), NOW).snapshot()
    const marks = Object.fromEntries(made.tasks.map((row) => [row.id, row.mark]))
    expect(marks['a/finished']).toBe('done')
    expect(marks['a/idle']).toBe('idle')
    expect(marks['a/review']).toBe('done')
    const store = emptyStore()
    applySnapshot(store, made)
    expect(wantsYou(store).map((one: { id: string }) => one.id)).toEqual(['a/dirty'])
    // What arrived is what is drawn: the page does not put a row's flag right.
    const odd = {
      ...made,
      tasks: made.tasks.map((row) => ({ ...row, wantsYou: row.id === 'a/idle' })),
    }
    const again = emptyStore()
    applySnapshot(again, odd)
    expect(wantsYou(again).map((one: { id: string }) => one.id)).toEqual(['a/idle'])
  })
})

describe('the queue', () => {
  it('puts a written preference first and everything without one after it', () => {
    // A written `order` is only ever a preference among the ready, so a row
    // with none sorts **after** every row with one rather than ahead of them.
    const store = emptyStore()
    applySnapshot(
      store,
      projector(
        input({
          queue: [
            queued({ task: 'sentry/c', order: null }),
            queued({ task: 'sentry/a', order: 2 }),
            queued({ task: 'sentry/b', order: 1 }),
          ],
        }),
        NOW,
      ).snapshot(),
    )
    expect(queueIn(store, null).map((one: { task: string }) => one.task)).toEqual([
      'sentry/b',
      'sentry/a',
      'sentry/c',
    ])
  })

  it('narrows to one project, and to all of them', () => {
    const store = emptyStore()
    applySnapshot(
      store,
      projector(
        input({
          queue: [queued({ task: 'sentry/a' }), queued({ task: 'tade/b', project: 'tade' })],
        }),
        NOW,
      ).snapshot(),
    )
    expect(queueIn(store, 'tade')).toHaveLength(1)
    expect(queueIn(store, null)).toHaveLength(2)
  })
})

describe('what a paired device holds', () => {
  it('is every row and figure the machine has: nothing is kept back from a device', () => {
    const store = emptyStore()
    applySnapshot(store, projector(input(), NOW).snapshot())
    expect(rowsOf(store, 'notes').length).toBeGreaterThan(0)
    expect(omitted(store, 'notes')).toBe(0)
    expect(taskAt(store, 'sentry', 'away-projection').spend).not.toBeNull()
  })
})

describe('what was left out', () => {
  it('is the projection’s own count, and nought where nothing was', () => {
    const { store } = held()
    expect(omitted(store, 'tasks')).toBe(0)
    expect(omitted(store, 'nothing-like-this')).toBe(0)
  })
})

describe('the clock an age is counted against', () => {
  it('is the device’s own while the stream is live, so ages tick', () => {
    const { store } = held()
    expect(asOf(store, 'live', NOW + 99_000)).toEqual({ at: NOW + 99_000, frozen: false })
  })

  it('is the server’s last word whenever it is not, so ages stop', () => {
    // The one rule the freshness line exists for. An age counting up against a snapshot
    // nothing can refresh is a page lying about somebody's morning.
    const { store } = held()
    for (const standing of ['stale', 'reconnecting', 'unreachable', 'closed']) {
      const clock = asOf(store, standing, NOW + 99_000)
      expect(clock.frozen, standing).toBe(true)
      expect(clock.at, standing).toBe(Date.parse(store.fresh.at))
    }
  })

  it('is the device’s own when there is no snapshot to freeze against', () => {
    expect(asOf(emptyStore(), 'unreachable', NOW)).toEqual({ at: NOW, frozen: false })
  })
})

/** One row of a collection by its key, or null: what the deleted pages' selectors read. */
const rowAt = (store: ReturnType<typeof emptyStore>, collection: string, key: string) =>
  store.rows[collection]?.get(key) ?? null
const intakeAt = (store: ReturnType<typeof emptyStore>, item: string) =>
  rowAt(store, 'intake', item)
const runAt = (store: ReturnType<typeof emptyStore>, run: string) => rowAt(store, 'runs', run)
const workflowAt = (store: ReturnType<typeof emptyStore>, name: string) =>
  rowAt(store, 'workflows', name)
const sourcesOf = (store: ReturnType<typeof emptyStore>) => rowsOf(store, 'sources')
const runsOf = (store: ReturnType<typeof emptyStore>) => rowsOf(store, 'runs')
const workflowsOf = (store: ReturnType<typeof emptyStore>) => rowsOf(store, 'workflows')

describe('the factory floor, as the page holds it', () => {
  const held = () => {
    const store = emptyStore()
    applySnapshot(store, projector(input({ reach: reach() }), NOW).snapshot())
    return store
  }

  it('keys every one of the four by the id the protocol decides', () => {
    // A key that drifted from `KEYED` would make a delta merge one row's text
    // into another's, which is the one failure a shallow merge has.
    const store = held()
    for (const [collection, id] of [
      ['intake', 'github:1402'],
      ['sources', 'github'],
      ['runs', 'shop-1402'],
      ['workflows', 'reproduce-and-fix'],
    ] as const) {
      expect([...store.rows[collection].keys()], collection).toContain(id)
    }
  })

  it('reads the requests newest first, which is how an inbox is read', () => {
    const store = held()
    const rows = intakeOf(store)
    expect(rows).toHaveLength(1)
    expect(intakeAt(store, 'github:1402')?.state).toBe('proposed')
    expect(intakeAt(store, 'nothing')).toBeNull()
  })

  it('counts what is waiting on somebody, and holds the list to the domain’s', () => {
    // `WAITING_STATES` in `@tade/core`, copied because a browser cannot import
    // a `.ts` file — and held equal to it, like the queue's own words, because
    // a second reading of *is this mine to answer* is a second state machine.
    expect([...WAITING].sort()).toEqual([...WAITING_STATES].sort())
    expect(intakeWaiting(held())).toHaveLength(1)
  })

  it('narrows the requests to one project where a screen asks for one', () => {
    expect(intakeOf(held(), 'sentry')).toHaveLength(1)
    expect(intakeOf(held(), 'tade')).toHaveLength(0)
  })

  it('reads the doors in the order the wire sent them', () => {
    expect(sourcesOf(held()).map((one) => one.source)).toEqual(['cli', 'github'])
  })

  it('merges a delta into each of them rather than replacing the row', () => {
    // The shallow merge the protocol describes, over the four new collections:
    // a changed field lands and everything else on the row stays.
    const store = held()
    applyDelta(store, {
      v: SPEAKS,
      rev: 99,
      at: '2026-10-09T15:00:00.000Z',
      fresh: null,
      set: {
        intake: { 'github:1402': { state: 'accepted' } },
        sources: { github: { state: 'quiet' } },
        runs: { 'shop-1402': { finished: 2 } },
        workflows: { 'reproduce-and-fix': { runs: 9 } },
      },
      del: {},
    })
    expect(intakeAt(store, 'github:1402')?.state).toBe('accepted')
    // And the rest of the row is still there, which is what a merge means.
    expect(intakeAt(store, 'github:1402')?.source).toBe('github')
    expect(sourcesOf(store).find((one) => one.source === 'github')?.state).toBe('quiet')
    expect(runAt(store, 'shop-1402')?.finished).toBe(2)
    expect(workflowAt(store, 'reproduce-and-fix')?.runs).toBe(9)
  })

  it('drops a row a delta deleted, out of each of them', () => {
    const store = held()
    applyDelta(store, {
      v: SPEAKS,
      rev: 100,
      at: '2026-10-09T15:00:00.000Z',
      fresh: null,
      set: {},
      del: {
        intake: ['github:1402'],
        runs: ['shop-1402'],
        workflows: ['reproduce-and-fix'],
      },
    })
    expect(intakeOf(store)).toEqual([])
    expect(runsOf(store)).toEqual([])
    expect(workflowsOf(store)).toEqual([])
  })
})
