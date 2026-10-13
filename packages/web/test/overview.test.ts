import { describe, expect, it } from 'vitest'
import { shortClockOf } from '../src/assets/figures.js'
import {
  boardOf,
  DOTS,
  dotsOf,
  failedOf,
  gaugesOf,
  moneyOf,
  projectRowsOf,
  TOP,
  workingOf,
} from '../src/assets/pages/overview-figures.js'
import { applySnapshot, emptyStore } from '../src/assets/store.js'
import { projector } from '../src/reading.ts'
import {
  blocked,
  EVERY,
  input,
  NOW,
  plan,
  project,
  queued,
  reach,
  spend,
  task,
} from './fixtures.ts'

// The overview's figures — the board, the money, the plan windows and the
// projects' grid — held here with no browser.
//
// **What this cannot see is how any of it looks**, which is the browser
// harness's (`scripts/browser.ts`). What it can see is that every figure is the
// projection's own count, grouped and worded and never decided again; that a
// figure nobody could read is a dash with *which* dash; and that nothing a
// device was not granted turns into a nought.

/** A page's store, filled from the real projection. */
function held(over = {}, granted = EVERY) {
  const store = emptyStore()
  const made = projector(input({ reach: reach(granted), ...over }), NOW)
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return store
}

const green = { state: 'pass' as const, failed: [], missing: [], overridden: false }
const red = { state: 'fail' as const, failed: ['tests'], missing: [], overridden: false }

describe('the board', () => {
  it('counts what needs you, what works, what waits and the checks, out of the fixture', () => {
    // Four tasks: three working, one held on an approval; one queued row
    // waiting on another task; one request proposed from outside.
    const board = boardOf(held())
    expect(board.wants.n).toBe(1)
    expect(board.wants.approvals).toBe(1)
    expect(board.wants.under).toBe('1 approval · 1 request')
    expect(board.working.n).toBe(3)
    expect(board.working.under).toBe('running')
    expect(board.queue.n).toBe(1)
    expect(board.queue.under).toBe('1 waiting')
    expect(board.checks.n).toBe(0)
    expect(board.checks.under).toBe('4 not run')
  })

  it('says a request in the inbox in the line, and never adds it to what needs you', () => {
    const board = boardOf(held({ tasks: [task()] }))
    expect(board.wants.n).toBe(0)
    expect(board.wants.dots.dots).toEqual([])
    expect(board.wants.under).toBe('1 request')
  })

  it('tells approvals, questions and the rest apart, and says nothing waiting when nothing is', () => {
    const asked = task({
      id: 'sentry/asked',
      state: 'blocked',
      reason: { kind: 'clause', said: 'asked: which one?' },
      question: true,
      mark: 'needs-you',
    })
    const deciding = task({
      id: 'sentry/deciding',
      state: 'blocked',
      reason: { kind: 'clause', said: 'ended its turn on a choice' },
      mark: 'needs-you',
    })
    const board = boardOf(held({ tasks: [blocked(), asked, deciding], intake: [] }))
    expect(board.wants.n).toBe(3)
    expect(board.wants.under).toBe('1 approval · 1 question · 1 to decide')
    expect(board.wants.dots.dots.every((one) => one.tone === 'wants')).toBe(true)

    expect(boardOf(held({ tasks: [task()], intake: [] })).wants.under).toBe('nothing waiting')
  })

  it('draws a stalled agent as a hollow mark, says so, and leaves it out of the figure', () => {
    const quiet = task({ id: 'sentry/quiet', stalled: true })
    const board = boardOf(held({ tasks: [task(), quiet] }))
    expect(board.working.n).toBe(1)
    expect(board.working.stalled).toBe(1)
    expect(board.working.under).toBe('1 stalled')
    expect(board.working.dots.dots).toEqual([
      { tone: 'working', hollow: false },
      { tone: 'working', hollow: true },
    ])
    expect(boardOf(held({ tasks: [] })).working.under).toBe('idle')
  })

  it('breaks the queue down by standing, ready first and filled, the rest hollow', () => {
    const board = boardOf(
      held({
        queue: [
          queued(),
          queued({ task: 'sentry/b', state: { kind: 'ready' }, waitsOn: [] }),
          queued({
            task: 'sentry/c',
            state: { kind: 'scheduled', at: Date.parse('2026-10-08T18:00:00.000Z') },
            waitsOn: [],
          }),
        ],
      }),
    )
    expect(board.queue.n).toBe(3)
    expect(board.queue.ready).toBe(1)
    expect(board.queue.under).toBe('1 ready · 1 waiting · 1 scheduled')
    expect(board.queue.dots.dots.map((one) => one.hollow)).toEqual([false, true, true])
    expect(boardOf(held({ queue: [] })).queue.under).toBe('empty')
  })

  it('counts what the snapshot left out of the queue, and says it is not here', () => {
    const store = held()
    store.pages.queue = { total: 3, omitted: 2, next: null, restarted: false }
    const board = boardOf(store)
    expect(board.queue.n).toBe(3)
    expect(board.queue.under).toBe('1 waiting · 2 not on this page')
  })

  it('puts the red checks in the figure, and green only where nothing is unknown', () => {
    const tasks = [
      task({ id: 'sentry/a', checks: red }),
      task({ id: 'sentry/b', checks: green }),
      task({ id: 'sentry/c' }),
    ]
    const board = boardOf(held({ tasks }))
    expect(board.checks.n).toBe(1)
    expect(board.checks.under).toBe('1 green · 1 not run')
    expect(board.checks.dots.dots.map((one) => one.tone)).toEqual(['failed', 'done', 'unknown'])

    const all = boardOf(held({ tasks: [task({ checks: green })] }))
    expect(all.checks.under).toBe('all green')
    expect(boardOf(held({ tasks: [] })).checks.under).toBe('no work')
  })
})

describe('a mark per thing', () => {
  it('draws one per thing in the order given, and nothing for nought or nonsense', () => {
    expect(
      dotsOf([
        { n: 2, tone: 'wants' },
        { n: 0, tone: 'working' },
        { n: Number.NaN, tone: 'failed' },
        { n: -3, tone: 'done' },
        { n: 1, tone: 'queued', hollow: true },
      ]),
    ).toEqual({
      dots: [
        { tone: 'wants', hollow: false },
        { tone: 'wants', hollow: false },
        { tone: 'queued', hollow: true },
      ],
      more: 0,
    })
  })

  it('fills its places exactly, and past them says how many more in the last one', () => {
    expect(dotsOf([{ n: DOTS, tone: 'working' }])).toMatchObject({ more: 0 })
    expect(dotsOf([{ n: DOTS, tone: 'working' }]).dots).toHaveLength(DOTS)
    const over = dotsOf([
      { n: 3, tone: 'failed' },
      { n: 12, tone: 'done' },
    ])
    expect(over.dots).toHaveLength(DOTS - 1)
    expect(over.more).toBe(15 - (DOTS - 1))
    // The ones it draws are the first ones: red is never what gets cut.
    expect(over.dots.slice(0, 3).every((one) => one.tone === 'failed')).toBe(true)
  })
})

describe('the money', () => {
  it('is the fold over every task, since when, and the tokens', () => {
    const paid = moneyOf(held())
    // Four tasks at the fixture's $1.25 each, 15,400 tokens each.
    expect(paid.value).toBe('$5.00')
    expect(paid.under).toBe(`since ${shortClockOf('2026-10-08T00:00:00.000Z')} · 62k tokens`)
  })

  it('names the projects most of it went to, largest first, at most a few, none at nought', () => {
    const store = held({
      projects: [
        project(),
        project({ name: 'tade' }),
        project({ name: 'folio' }),
        project({ name: 'rotwall' }),
        project({ name: 'quiet' }),
      ],
      tasks: [
        task({ id: 'sentry/a', spend: spend(2) }),
        task({ id: 'tade/a', project: 'tade', spend: spend(9) }),
        task({ id: 'folio/a', project: 'folio', spend: spend(4) }),
        task({ id: 'rotwall/a', project: 'rotwall', spend: spend(1) }),
        task({ id: 'quiet/a', project: 'quiet', spend: spend(0) }),
      ],
    })
    const top = moneyOf(store).top
    expect(top.map((one) => one.key)).toEqual(['tade', 'folio', 'sentry'])
    expect(top).toHaveLength(TOP)
    expect(top[0]).toMatchObject({ value: 9, said: '$9.00', href: '/p/tade', tone: 'queued' })
  })

  it('is a floor where the snapshot left tasks out', () => {
    const store = held()
    store.pages.tasks = { total: 9, omitted: 5, next: null, restarted: false }
    expect(moneyOf(store).value).toBe('≥$5.00')
  })

  it('is a dash and the words for it when this device was not granted it — never a nought', () => {
    const paid = moneyOf(held({}, []))
    expect(paid.value).toBeNull()
    expect(paid.under).toBe('not granted')
    expect(paid.top).toEqual([])
  })

  it('is a dash and the words for it where nobody wrote any down', () => {
    const paid = moneyOf(held({ tasks: [task({ spend: spend(0) })] }))
    expect(paid.value).toBeNull()
    expect(paid.under).toBe('not recorded')
  })
})

describe('the plan windows', () => {
  it('are every window, fullest first, with whose, how full and when it starts over', () => {
    const store = held({
      plans: [
        plan(),
        plan({
          harness: 'codex',
          account: 'me@example.invalid',
          windows: [
            { label: '5h', used: 93, resetsAt: Date.parse('2026-10-08T15:00:00.000Z') },
            { label: 'week', used: 10, resetsAt: 0 },
          ],
        }),
      ],
    })
    const gauges = gaugesOf(store, NOW)
    expect(gauges.map((one) => [one.who, one.window, one.share, one.pressure])).toEqual([
      ['codex', '5h', 93, 'tight'],
      ['claude-code', '5h', 42, 'fine'],
      ['codex', 'week', 10, 'fine'],
    ])
    expect(gauges[0]?.said).toBe('93%')
    expect(gauges[0]?.under).toBe('5h · codex\nresets in 30m')
    expect(gauges[1]?.under).toBe('5h · claude-code\nresets in 3h 30m')
    // A window whose harness did not say when it starts over says nothing about it.
    expect(gauges[2]?.under).toBe('week · codex')
  })

  it('says not granted, none reported and cannot tell as three dashes, never a gauge at nought', () => {
    expect(gaugesOf(held({}, []), NOW)).toMatchObject([
      { share: null, said: null, under: 'not granted to this device' },
    ])
    expect(gaugesOf(held({ plans: [] }), NOW)).toMatchObject([
      { share: null, under: 'none reported' },
    ])
    const told = gaugesOf(
      held({ plans: [plan({ windows: [], cannotTell: 'the harness reports no plan' })] }),
      NOW,
    )
    expect(told).toMatchObject([{ share: null, window: null, under: 'claude-code · cannot tell' }])
  })

  it('leaves out an account that pays per token, which has no window to run out of', () => {
    const store = held({ plans: [plan({ pays: 'per-token', windows: [] })] })
    expect(gaugesOf(store, NOW)).toMatchObject([{ share: null, under: 'none reported' }])
  })
})

describe('the projects’ grid', () => {
  it('is busiest first, with the projection’s own counts and the shape of all its work', () => {
    const rows = projectRowsOf(held())
    expect(rows.map((one) => one.name)).toEqual(['sentry', 'tade'])
    expect(rows[0]).toMatchObject({ wants: 1, working: 2, queued: 0, href: '/p/sentry' })
    expect(rows[0]?.shape).toEqual([1, 2, 0, 0])
    expect(rows[1]).toMatchObject({ wants: 0, working: 1 })
  })

  it('says the checks as counts, red first, green only where nothing is unknown', () => {
    const said = (tasks: ReturnType<typeof task>[]) =>
      projectRowsOf(held({ projects: [project()], tasks }))[0]?.checks
    expect(said([task({ id: 'sentry/a', checks: red }), task({ id: 'sentry/b' })])).toMatchObject({
      said: '1 red',
      tone: 't-failed',
    })
    expect(said([task({ checks: green })])).toMatchObject({ said: 'all green', tone: 't-done' })
    expect(said([task({ id: 'sentry/a', checks: green }), task({ id: 'sentry/b' })])).toMatchObject(
      { said: '1/2 green', tone: '' },
    )
    expect(said([])).toMatchObject({ said: 'no work', tone: '' })
  })

  it('says its money, and the dash’s own word where this device may not read it', () => {
    expect(projectRowsOf(held())[0]).toMatchObject({ spend: '$3.75', spendWhy: '' })
    expect(projectRowsOf(held({}, []))[0]).toMatchObject({ spend: null, spendWhy: 'not granted' })
  })
})

describe('the lists under the board', () => {
  it('reads failed off the window’s own mark, and working off deriveState’s state', () => {
    const store = held({
      tasks: [
        task(),
        task({ id: 'sentry/broke', state: 'failed', reason: { kind: 'clause', said: 'red' } }),
        task({ id: 'sentry/done', state: 'review', finished: true }),
      ],
    })
    expect(failedOf(store).map((one) => one.id)).toEqual(['sentry/broke'])
    expect(workingOf(store).map((one) => one.id)).toEqual(['sentry/away-projection'])
  })
})
