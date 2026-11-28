import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StillDocument, type StillElement } from '../scripts/still-dom.ts'
import { actsOf } from '../src/assets/acts.js'
import { nowScreen } from '../src/assets/pages/overview.js'
import {
  DOTS,
  dotsOf,
  sameDay,
  tilesOf,
  waitingOf,
  workingOf,
} from '../src/assets/pages/overview-figures.js'
import { applyCopy, applySnapshot, emptyStore } from '../src/assets/store.js'
import { PROTOCOL_VERSION } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import { blocked, input, NOW, queued, reach, task } from './fixtures.ts'

// The overview (§10 T5 of the Duo plan): the four tiles, the agents waiting on
// you with their answers, the agents working one line each, and the
// conversation — held here with no browser.
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

  it('works with what deriveState said is working, the longest at it first', () => {
    const early = task({ id: 'sentry/early', movedAt: NOW - 60 * 60 * 1000 })
    const late = task({ id: 'sentry/late', movedAt: NOW - 60 * 1000 })
    const done = task({ id: 'sentry/done', state: 'review', finished: true })
    const store = held({ tasks: [late, done, early] })
    expect(workingOf(store).map((one) => one.task.id)).toEqual(['sentry/early', 'sentry/late'])
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
  it('is the tiles, the agents waiting on you, the agents working and Tade, and nothing else', () => {
    const node = drawn(held())
    const headings = (node.querySelectorAll('h2') as StillElement[]).map((one) => one.textContent)
    expect(headings).toEqual(['WAITING ON YOU', 'WORKING', 'TADE'])
    expect(node.querySelectorAll('.ov-tile')).toHaveLength(4)
    expect(node.querySelector('.talk textarea')).not.toBeNull()
  })

  it('opens every agent in the full view, another machine’s with its machine in front', () => {
    const node = drawn(withCopy(held(), 'mac', [blocked()]))
    const hrefs = (node.querySelectorAll('.ov-want-link, .ov-agent > a') as StillElement[]).map(
      (one) => one.getAttribute('href'),
    )
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

  it('says no agent is working, in words, where none is', () => {
    const node = drawn(held({ tasks: [blocked()] }))
    const idle = node.querySelector('#working .empty') as StillElement
    expect(idle.hidden).toBe(false)
    expect(idle.textContent).toBe('No agent is working')
  })
})
