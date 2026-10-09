import { describe, expect, it } from 'vitest'
import {
  applyDelta,
  applySnapshot,
  asOf,
  checksFold,
  checksWord,
  emptyStore,
  GRANTS,
  mayRead,
  notesOf,
  omitted,
  projectAt,
  projectsOf,
  queueIn,
  reviewsOf,
  rowsOf,
  SPEAKS,
  spendFold,
  spendSince,
  taskAt,
  tasksIn,
  wantingIds,
  wantsYou,
} from '../src/assets/store.js'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { GRANTS as REACH } from '../src/reach.ts'
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
    expect(wantsYou(store).map((one: { id: string }) => one.id)).toEqual([
      'a/blocked',
      'a/failed',
      'a/review',
    ])
    expect(wantingIds(store).has('a/working')).toBe(false)
  })

  it('is nothing at all where nothing is stopped', () => {
    const store = emptyStore()
    applySnapshot(store, projector(input({ tasks: [task()] }), NOW).snapshot())
    expect(wantsYou(store)).toEqual([])
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

describe('folding the money', () => {
  it('counts a task with no spend row as unknown, never as nought', () => {
    const fold = spendFold([
      { spend: { ...zero, usd: 1, usdExact: 1, hasCost: true } },
      { spend: null },
    ])
    expect(fold.usd).toBe(1)
    expect(fold.unknown).toBe(1)
    expect(fold.hasCost).toBe(true)
  })

  it('is a floor whenever the snapshot left tasks out', () => {
    expect(spendFold([], false).partial).toBe(false)
    expect(spendFold([], true).partial).toBe(true)
  })

  it('keeps the three kinds of dollar claim apart', () => {
    const fold = spendFold([
      { spend: { ...zero, usd: 1, usdExact: 1, hasCost: true } },
      { spend: { ...zero, usd: 2, usdEstimated: 2, usdOnPlan: 9, hasCost: true } },
    ])
    expect(fold.usd).toBe(3)
    expect(fold.usdExact).toBe(1)
    expect(fold.usdEstimated).toBe(2)
    // A plan's equivalent is folded **beside** the money and never into it.
    expect(fold.usdOnPlan).toBe(9)
    expect(fold.usd).not.toBe(12)
  })

  it('says nothing was reported where nothing was', () => {
    const fold = spendFold([{ spend: { ...zero } }])
    expect(fold.hasCost).toBe(false)
    expect(fold.usd).toBe(0)
  })
})

const zero = {
  usd: 0,
  usdExact: 0,
  usdEstimated: 0,
  usdListed: 0,
  usdOnPlan: 0,
  tokens: 0,
  tokensUnpriced: 0,
  tokensOnPlanUnrated: 0,
  hasCost: false,
}

describe('folding the checks', () => {
  const checks = (state: string, over = {}) => ({
    checks: { state, failed: [], missing: [], overridden: false, ...over },
  })

  it('is red the moment anything is red', () => {
    expect(checksWord(checksFold([checks('pass'), checks('fail')]))).toBe('fail')
  })

  it('is never green while anything is unknown', () => {
    // A check nobody ran here is not a check that passed, and three greens
    // plus an unknown folded into "green" is the claim `deriveState` refuses.
    expect(checksWord(checksFold([checks('pass'), checks('unknown')]))).toBe('unknown')
    expect(checksWord(checksFold([]))).toBe('unknown')
    expect(checksWord(checksFold([checks('pass'), checks('pass')]))).toBe('pass')
  })

  it('gathers the names once each, sorted', () => {
    const fold = checksFold([
      checks('fail', { failed: ['types'], missing: ['tests'] }),
      checks('fail', { failed: ['types', 'format'] }),
    ])
    expect(fold.failed).toEqual(['format', 'types'])
    expect(fold.missing).toEqual(['tests'])
  })

  it('counts an overruled run, which is still recorded red', () => {
    expect(checksFold([checks('fail', { overridden: true })]).overridden).toBe(1)
  })
})

describe('the reviews', () => {
  it('separates what is offered from what is finished and nobody asked about', () => {
    const store = emptyStore()
    applySnapshot(
      store,
      projector(
        input({
          tasks: [
            task({ id: 'a/offered' }),
            task({ id: 'a/quiet', review: null, ahead: 2 }),
            task({ id: 'a/nothing', review: null, ahead: 0 }),
          ],
        }),
        NOW,
      ).snapshot(),
    )
    const { offered, unoffered } = reviewsOf(store)
    expect(offered.map((one: { id: string }) => one.id)).toEqual(['a/offered'])
    expect(unoffered.map((one: { id: string }) => one.id)).toEqual(['a/quiet'])
  })
})

describe('the notes', () => {
  it('reads newest first, which is the one collection read that way', () => {
    const { store } = held()
    const ids = notesOf(store).map((one: { id: string }) => one.id)
    expect(ids).toEqual([...ids].sort().reverse())
  })
})

describe('what this device was granted', () => {
  it('asks about exactly the readings the machine can grant', () => {
    // A word here the machine does not grant is a page asking a question
    // nobody can answer yes to; one the machine grants that is missing here is
    // a reading the page silently treats as withheld, for ever.
    expect([...GRANTS].sort()).toEqual([...REACH].sort())
  })

  it('is what the machine put in the snapshot, and nothing by default', () => {
    const store = emptyStore()
    applySnapshot(store, projector(input(), NOW).snapshot())
    // The fixtures' device was granted nothing, which is the floor: names and
    // counts, and not one figure or word of anybody's own.
    for (const grant of ['spend', 'notes', 'findings', 'reviews', 'titles', 'intent']) {
      expect(mayRead(store, grant), grant).toBe(false)
    }
  })

  it('is what a granted device holds', () => {
    const store = emptyStore()
    applySnapshot(store, projector(input({ reach: reach(['spend', 'notes']) }), NOW).snapshot())
    expect(mayRead(store, 'spend')).toBe(true)
    expect(mayRead(store, 'notes')).toBe(true)
    expect(mayRead(store, 'findings')).toBe(false)
  })

  it('is nothing at all before a snapshot, rather than throwing', () => {
    expect(mayRead(emptyStore(), 'spend')).toBe(false)
  })

  it('withholds a figure as a null, and says how many rows it kept back', () => {
    // The shape that makes the two nothings tellable apart from the page: the
    // count is a name-and-count fact and goes out always; the rows are content
    // and need a grant.
    const store = emptyStore()
    applySnapshot(store, projector(input(), NOW).snapshot())
    expect(rowsOf(store, 'notes')).toEqual([])
    expect(omitted(store, 'notes')).toBeGreaterThan(0)
    expect(taskAt(store, 'sentry', 'away-projection').spend).toBeNull()
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
    // The one rule §5.10 exists for. An age counting up against a snapshot
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

  it('reads the period the money covers off the snapshot, never off the device', () => {
    // The window folds from its own midnight and the phone is somewhere else,
    // so the page may not work this out: it reads the instant the server sent
    // and says that. With no snapshot there is nothing to say.
    const { store } = held()
    expect(spendSince(store)).toBe(store.fresh.spendSince)
    expect(spendSince(emptyStore())).toBeNull()
  })
})

describe('the projects and the tasks in them', () => {
  it('finds one by name, and answers nothing for one that is not there', () => {
    const { store } = held()
    expect(projectAt(store, 'sentry')?.name).toBe('sentry')
    expect(projectAt(store, 'nope')).toBeNull()
    expect(projectsOf(store).map((one: { name: string }) => one.name)).toEqual(['sentry', 'tade'])
    expect(tasksIn(store, 'tade')).toHaveLength(1)
    expect(tasksIn(store, 'nope')).toEqual([])
  })
})
