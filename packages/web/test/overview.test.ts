import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StillDocument, type StillElement } from '../scripts/still-dom.ts'
import { actsOf } from '../src/assets/acts.js'
import { nowScreen } from '../src/assets/pages/overview.js'
import {
  agentsOf,
  countsOf,
  DOTS,
  dotsOf,
  everyAgentCounted,
  kindOf,
  queueOf,
  sameDay,
  tilesOf,
  waitingOf,
} from '../src/assets/pages/overview-figures.js'
import { applyCopy, applySnapshot, emptyStore } from '../src/assets/store.js'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import { blocked, input, NOW, queued, reach, task } from './fixtures.ts'

// The overview (§10 T5 of the Duo plan): the four tiles, the agents waiting on
// you with their answers, every agent by machine and project with what it is
// doing, the queue, and the conversation — held here with no browser.
//
// **What this cannot see is how any of it looks**, which is the browser
// harness's (`scripts/browser-duo.ts`, at the full view's sizes). What it can
// see is that every figure is the projection's own count, grouped and worded
// and never decided again, that every machine's agents are on it, and that
// every agent leads to the full view.

/** A page's store, filled from the real projection. */
function held(over = {}) {
  const store = emptyStore()
  const made = projector(input({ reach: reach(), ...over }), NOW)
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return store
}

/** The item at `index`, or a failure saying there is none. */
function at<T>(list: readonly T[], index: number): T {
  const one = list[index]
  if (one === undefined) throw new Error(`nothing at ${index} of ${list.length}`)
  return one
}

/** Another machine's copy, held by `store`, and that machine seen up or not. */
function withCopy(
  store: ReturnType<typeof emptyStore>,
  machine: string,
  tasks: ReturnType<typeof task>[],
  state: 'up' | 'closed' = 'up',
) {
  const snapshot = projector(input({ reach: reach(), tasks, queue: [] }), NOW).snapshot()
  expect(applyCopy(store, { v: PROTOCOL_VERSION, machine, kind: 'whole', snapshot })).toBeNull()
  const seen = Array.isArray(store.machines) ? store.machines : []
  store.machines = [
    ...seen,
    { name: machine, way: 'to', state, since: new Date(NOW).toISOString() },
  ]
  return store
}

describe('the tiles', () => {
  it('count what works, what waits on you, what is queued and what finished, out of the fixture', () => {
    // Four tasks: three working, one held on an approval; one queued row
    // waiting on another task.
    const tiles = tilesOf(held(), NOW)
    expect(tiles.working).toMatchObject({ n: 3, under: 'running' })
    expect(tiles.wants).toMatchObject({ n: 1, under: '1 approval' })
    expect(tiles.queue).toMatchObject({ n: 1, under: '1 waiting' })
    expect(tiles.finished).toMatchObject({ n: 0, under: 'none yet' })
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
    const tiles = tilesOf(held({ tasks: [blocked(), asked, deciding] }), NOW)
    expect(tiles.wants.n).toBe(3)
    expect(tiles.wants.under).toBe('1 approval · 1 question · 1 to decide')
    expect(tiles.wants.dots.dots.every((one) => one.tone === 'wants')).toBe(true)
    expect(tilesOf(held({ tasks: [task()] }), NOW).wants.under).toBe('nothing waiting')
  })

  it('draws a stalled agent as a hollow mark among the working, and says so', () => {
    const quiet = task({ id: 'sentry/quiet', stalled: true })
    const tiles = tilesOf(held({ tasks: [task(), quiet] }), NOW)
    expect(tiles.working.n).toBe(2)
    expect(tiles.working.under).toBe('1 stalled')
    expect(tiles.working.dots.dots).toEqual([
      { tone: 'working', hollow: false },
      { tone: 'working', hollow: true },
    ])
    expect(tilesOf(held({ tasks: [] }), NOW).working.under).toBe('idle')
  })

  it('breaks the queue down by standing, ready first and filled, the rest hollow', () => {
    const tiles = tilesOf(
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
      NOW,
    )
    expect(tiles.queue.n).toBe(3)
    expect(tiles.queue.under).toBe('1 ready · 1 waiting · 1 scheduled')
    expect(tiles.queue.dots.dots.map((one) => one.hollow)).toEqual([false, true, true])
    expect(tilesOf(held({ queue: [] }), NOW).queue.under).toBe('empty')
  })

  it('counts what the journal says finished, on the reader’s today and no other day', () => {
    const today = task({ id: 'sentry/today', state: 'review', finished: true })
    const before = task({
      id: 'sentry/before',
      state: 'review',
      finished: true,
      movedAt: NOW - 3 * 24 * 60 * 60 * 1000,
    })
    // Finished is the journal's record, never a state that looks like it.
    const looks = task({ id: 'sentry/looks', state: 'review', finished: false })
    const tiles = tilesOf(held({ tasks: [today, before, looks] }), NOW)
    expect(tiles.finished).toMatchObject({ n: 1, under: 'still held' })
    expect(tiles.finished.dots.dots).toEqual([{ tone: 'done', hollow: false }])
  })

  it('reads a day as the reader’s own, and nothing it cannot read as today', () => {
    expect(sameDay(new Date(NOW).toISOString(), NOW)).toBe(true)
    expect(sameDay(new Date(NOW - 2 * 24 * 60 * 60 * 1000).toISOString(), NOW)).toBe(false)
    for (const at of [null, '', 'never', 42]) expect(sameDay(at as never, NOW)).toBe(false)
  })

  it('counts every machine that is up, and what was queued or finished on every machine', () => {
    const store = withCopy(held(), 'mac', [blocked(), task({ id: 'tade/x', project: 'tade' })])
    withCopy(store, 'box', [blocked()], 'closed')
    const tiles = tilesOf(store, NOW)
    // box is closed: what it said wanted you or worked is its last word, not now.
    expect(tiles.wants.n).toBe(2)
    expect(tiles.working.n).toBe(4)
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
    expect(over.dots.slice(0, 3).every((one) => one.tone === 'failed')).toBe(true)
  })
})

describe('the two lists', () => {
  it('waits on you with what the window marked, this machine’s first, then each up machine’s', () => {
    const store = withCopy(held(), 'mac', [blocked()])
    withCopy(store, 'box', [blocked()], 'closed')
    expect(waitingOf(store).map((one) => `${one.machine}|${one.task.id}`)).toEqual([
      '|sentry/blocked',
      'mac|sentry/blocked',
    ])
  })
})

describe('every agent, by machine and project', () => {
  const done = task({ id: 'sentry/done', state: 'review', finished: true, mark: 'done' })
  const stopped = task({ id: 'sentry/stopped', state: 'review', mark: 'stopped', lane: 'stopped' })
  const idle = task({ id: 'tade/idle', project: 'tade', state: 'blocked', mark: 'idle' })
  const early = task({ id: 'sentry/early', movedAt: NOW - 60 * 60 * 1000 })
  const late = task({ id: 'sentry/late', movedAt: NOW - 60 * 1000 })

  it('counts each mark the window drew, and says it leaving out what is nought', () => {
    const store = held({ tasks: [early, late, blocked(), done, stopped, idle], queue: [] })
    const counts = countsOf([...store.rows.tasks.values()])
    expect(counts.n).toBe(6)
    expect(counts.said).toBe('1 waiting on you · 2 working · 1 idle · 1 stopped · 1 finished')
    expect(countsOf([]).said).toBe('')
  })

  it('reads the window’s mark, and the state only for a row from a window before it', () => {
    expect(kindOf({ mark: 'idle', state: 'blocked' })).toBe('idle')
    expect(kindOf({ state: 'blocked' })).toBe('needs-you')
    expect(kindOf({ state: 'review', finished: true })).toBe('done')
    expect(kindOf({ state: 'queued' })).toBe('stopped')
  })

  it('groups by machine and project, the ones to look at the longest first, the resting folded', () => {
    const store = held({ tasks: [late, done, early, stopped, idle], queue: [] })
    const here = at(agentsOf(store), 0)
    expect(here.machine).toBe('')
    expect(here.counts.said).toBe('2 working · 1 idle · 1 stopped · 1 finished')
    expect(here.projects.map((one) => one.project)).toEqual(['sentry', 'tade'])
    const sentry = at(here.projects, 0)
    expect(sentry.active.map((one) => one.id)).toEqual(['sentry/early', 'sentry/late'])
    expect(sentry.resting.map((one) => one.id).sort()).toEqual(['sentry/done', 'sentry/stopped'])
    expect(sentry.restingSaid).toBe('1 stopped · 1 finished')
    expect(sentry.counts.said).toBe('2 working · 1 stopped · 1 finished')
  })

  it('draws every machine whose copy it holds, one that is not up as of its last word', () => {
    const store = withCopy(held({ tasks: [early], queue: [] }), 'mac', [blocked()])
    withCopy(store, 'box', [late], 'closed')
    const machines = agentsOf(store)
    expect(machines.map((one) => [one.machine, one.up])).toEqual([
      ['', true],
      ['box', false],
      ['mac', true],
    ])
    expect(at(machines, 1).state).toMatch(/^closed /)
    expect(at(machines, 2).counts.said).toBe('1 waiting on you')
    expect(everyAgentCounted(machines).n).toBe(3)
  })

  it('leaves queued work to the queue', () => {
    const waiting = task({ id: 'sentry/later', state: 'queued', mark: 'stopped' })
    const here = at(agentsOf(held({ tasks: [early, waiting], queue: [] })), 0)
    expect(here.counts.n).toBe(1)
  })
})

describe('the queue', () => {
  it('puts what starts next first, then what waits for a time, for others, or is held', () => {
    const store = held({
      tasks: [task({ id: 'sentry/b', state: 'queued', mark: 'stopped' })],
      queue: [
        queued({
          task: 'sentry/h',
          state: { kind: 'held', on: null, because: 'its plan was refused', changed: null, by: [] },
        }),
        queued(),
        queued({ task: 'sentry/b', state: { kind: 'ready' }, waitsOn: [] }),
      ],
    })
    const rows = queueOf(store)
    expect(rows.map((one) => one.row.task)).toEqual([
      'sentry/b',
      'sentry/away-auth-server',
      'sentry/h',
    ])
    expect(at(rows, 0).task?.id).toBe('sentry/b')
    expect(at(rows, 1).task).toBeNull()
  })

  it('holds every machine’s queued work, marked with its machine', () => {
    const store = withCopy(held({ queue: [] }), 'mac', [])
    const there = projector(input({ reach: reach(), tasks: [], queue: [queued()] }), NOW).snapshot()
    expect(
      applyCopy(store, { v: PROTOCOL_VERSION, machine: 'mac', kind: 'whole', snapshot: there }),
    ).toBeNull()
    expect(queueOf(store).map((one) => `${one.machine}|${one.row.task}`)).toEqual([
      'mac|sentry/away-auth-server',
    ])
  })
})

/* ── the screen, drawn ─────────────────────────────────────────────────────── */

const was = {
  document: Reflect.get(globalThis, 'document'),
  raf: Reflect.get(globalThis, 'requestAnimationFrame'),
}

beforeEach(() => {
  Object.defineProperty(globalThis, 'document', {
    value: new StillDocument(),
    configurable: true,
    writable: true,
  })
  Reflect.set(globalThis, 'requestAnimationFrame', (run: (at: number) => void) => {
    run(0)
    return 0
  })
})

afterEach(() => {
  Object.defineProperty(globalThis, 'document', {
    value: was.document,
    configurable: true,
    writable: true,
  })
  Reflect.set(globalThis, 'requestAnimationFrame', was.raf)
})

const ctx = {
  ask: () => Promise.resolve({ status: 200, body: { did: true, said: '' } }),
  sentence: () => '',
  revOf: () => 0,
}

function drawn(store: ReturnType<typeof emptyStore>) {
  const screen = nowScreen(ctx)
  screen.update({
    store,
    standing: 'live',
    asOf: NOW,
    frozen: false,
    now: NOW,
    where: { view: 'now' },
    may: { acts: actsOf({ device: 'phone', clear: false }) },
  })
  return screen.node as unknown as StillElement
}

describe('the overview, drawn', () => {
  it('is the tiles, the agents waiting on you, every agent, the queue and Tade, and nothing else', () => {
    const node = drawn(held())
    const headings = (node.querySelectorAll('h2') as StillElement[]).map((one) => one.textContent)
    expect(headings).toEqual(['WAITING ON YOU', 'AGENTS', 'QUEUE', 'TADE'])
    expect(node.querySelectorAll('.ov-tile')).toHaveLength(4)
    expect(node.querySelector('.talk textarea')).not.toBeNull()
  })

  it('opens every agent in the full view, another machine’s with its machine in front', () => {
    const node = drawn(withCopy(held(), 'mac', [blocked()]))
    const hrefs = (
      node.querySelectorAll('.ov-want-link, .ov-agent > a, .ov-queued > a') as StillElement[]
    ).map((one) => one.getAttribute('href'))
    expect(hrefs.length).toBeGreaterThan(2)
    for (const href of hrefs) expect(href).toMatch(/^\/draw\/\?agent=/)
    expect(hrefs).toContain(`/draw/?agent=${encodeURIComponent('@mac\u001fsentry/blocked')}`)
    // Nothing on it leads to a page that went.
    for (const link of node.querySelectorAll('a[href]') as StillElement[]) {
      const href = link.getAttribute('href') ?? ''
      expect(href, href).toMatch(/^(\/draw\/|#)/)
    }
  })

  it('puts the answers on an agent waiting on you, and the command they answer, whole', () => {
    const node = drawn(held({ tasks: [blocked()] }))
    const card = node.querySelector('.ov-want') as StillElement
    expect(card.querySelector('.ov-want-why')?.textContent).not.toBe('')
    expect(card.querySelector('.quick')).not.toBeNull()
  })

  it('says nothing needs you, in words, where nothing does', () => {
    const node = drawn(held({ tasks: [task()] }))
    expect((node.querySelector('.ov-clear') as StillElement).hidden).toBe(false)
    expect(node.querySelectorAll('.ov-want')).toHaveLength(0)
  })

  it('draws an agent’s state and why, since when, what it is doing now, and what it runs on', () => {
    const one = task({
      since: NOW - 12 * 60 * 1000,
      doing: { tool: 'Bash', about: 'pnpm test ./packages/web', at: NOW - 4_000, ok: null },
    })
    const node = drawn(held({ tasks: [one], queue: [] }))
    const row = node.querySelector('.ov-agent') as StillElement
    const text = (selector: string) => (row.querySelector(selector) as StillElement).textContent
    expect(text('.ov-agent-name')).toBe('away-projection')
    expect(text('.ov-agent-age')).toBe('12m')
    expect(row.querySelector('.ov-agent-age')?.getAttribute('aria-label')).toBe('working for 12m')
    expect(text('.ov-state-word')).toBe('working')
    expect(text('.ov-state-why')).toBe('4 files touched')
    expect(text('.ov-doing-tool')).toBe('Bash')
    expect(text('.ov-doing-about')).toBe('pnpm test ./packages/web')
    expect(text('.ov-doing-age')).toBe('running · 4s ago')
    expect(text('.ov-agent-ran')).toBe('claude-code · claude-opus-5')
    expect(node.querySelector('.ov-machine-name')?.textContent).toBe('This machine')
    expect(node.querySelector('.ov-project-name')?.textContent).toBe('sentry')
  })

  it('says what it does not know as a dash, and draws no doing line for an agent seen doing nothing', () => {
    const node = drawn(held({ tasks: [task({ harness: '', model: '' })], queue: [] }))
    const row = node.querySelector('.ov-agent') as StillElement
    expect((row.querySelector('.ov-agent-doing') as StillElement).hidden).toBe(true)
    expect(row.querySelector('.ov-agent-ran')?.textContent).toBe('— · —')
  })

  it('folds what is resting under its count, and keeps it open across a delta', () => {
    const done = task({ id: 'sentry/done', state: 'review', finished: true, mark: 'done' })
    const screen = nowScreen(ctx)
    const view = (store: ReturnType<typeof emptyStore>) => ({
      store,
      standing: 'live',
      asOf: NOW,
      frozen: false,
      now: NOW,
      where: { view: 'now' },
      may: { acts: actsOf({ device: 'phone', clear: false }) },
    })
    screen.update(view(held({ tasks: [task(), done], queue: [] })))
    const node = screen.node as unknown as StillElement
    const rest = node.querySelector('.ov-rest') as StillElement
    expect(rest.hidden).toBe(false)
    expect(rest.querySelector('.ov-rest-said')?.textContent).toBe('1 finished')
    rest.setAttribute('open', '')
    screen.update(view(held({ tasks: [task(), done], queue: [] })))
    expect(node.querySelector('.ov-rest')).toBe(rest)
    expect(rest.getAttribute('open')).toBe('')
  })

  it('draws the queue in its own words, and says nothing is queued where nothing is', () => {
    const node = drawn(held({ tasks: [task()] }))
    const row = node.querySelector('.ov-queued') as StillElement
    expect(row.querySelector('.ov-queued-said')?.textContent).toBe('after sentry/away-projection')
    expect(row.querySelector('.ov-queued-why')?.textContent).toMatch(/^sentry\/away-projection: /)
    const empty = drawn(held({ tasks: [task()], queue: [] }))
    expect((empty.querySelector('#queue .empty') as StillElement).hidden).toBe(false)
  })

  it('says no agent is on any machine, in words, where none is', () => {
    const node = drawn(held({ tasks: [], queue: [] }))
    const none = node.querySelector('#agents .empty') as StillElement
    expect(none.hidden).toBe(false)
    expect(none.textContent).toBe('No agent on any machine')
  })
})
