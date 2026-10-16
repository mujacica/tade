import { describe, expect, it } from 'vitest'
import {
  cardOf,
  conflictsSaid,
  deskPage,
  figureSaid,
  findingsSaid,
  leadSaid,
  sizeSaid,
  wholeOf,
} from '../src/assets/pages/landing-shape.js'
import { applySnapshot, emptyStore, rowsOf } from '../src/assets/store.js'
import type { FindingIn, TaskIn } from '../src/input.ts'
import { projector } from '../src/reading.ts'
import { EVERY, input, NOW, reach, task } from './fixtures.ts'

// What the landing desk draws, against **real projected rows**: where each
// piece of work stands is the machine's (core's `landingOf`, folded per device
// in `landing.ts`), so this holds that the page sorts by the machine's number,
// says the machine's sentence, and decides nothing — and that a figure nothing
// could say is a dash with its word, never a nought.

const minutes = (n: number) => NOW - n * 60_000
const green = { state: 'pass' as const, failed: [], missing: [], overridden: false }
const none = (over: Partial<TaskIn> = {}) =>
  task({ state: 'review', finished: true, review: null, conflicts: [], checks: green, ...over })

function finding(over: Partial<FindingIn> = {}): FindingIn {
  return {
    key: 'k',
    question: 'test_missing',
    project: 'sentry',
    tasks: ['sentry/answered'],
    at: NOW,
    probability: 0.9,
    file: 'src/a.ts',
    stillThere: true,
    account: { did: 'not real', said: 'covered', at: new Date(NOW).toISOString() },
    verdict: null,
    ...over,
  }
}

/** The tasks a device granted these holds, after the projection and the store. */
function stored(tasks: TaskIn[], granted = EVERY, findings: FindingIn[] | null = []) {
  const store = emptyStore()
  applySnapshot(store, projector(input({ reach: reach(granted), tasks, findings }), NOW).snapshot())
  return rowsOf(store, 'tasks')
}

const desk = [
  none({ id: 'sentry/big', size: { commits: 3, added: 300, removed: 20 }, movedAt: minutes(5) }),
  none({ id: 'sentry/small', size: { commits: 1, added: 4, removed: 1 }, movedAt: minutes(50) }),
  none({ id: 'sentry/answered', movedAt: minutes(90) }),
  none({
    id: 'sentry/red',
    checks: { state: 'fail', failed: ['types'], missing: [], overridden: false },
    movedAt: minutes(200),
  }),
  none({ id: 'sentry/unlooked', size: null, checks: { ...green, state: 'unknown' } }),
  task({ id: 'sentry/busy', state: 'working', review: null }),
]

describe('the desk, as a device reads it', () => {
  it('is in the machine’s order: ready smallest first, then the person’s, then the agents’', () => {
    const page = deskPage(stored(desk, EVERY, [finding()]), NOW)
    expect(page.total).toBe(5)
    expect(page.groups.ready.map((one) => one.name)).toEqual(['small', 'big'])
    expect(page.groups.yours.map((one) => one.name)).toEqual(['answered', 'unlooked'])
    expect(page.groups.theirs.map((one) => one.name)).toEqual(['red'])
    // Core's own sentence, and the work still being done is not on the desk at all.
    expect(page.groups.yours[0]?.why).toBe(
      'its agent answered 1 finding, and it waits on your verdict',
    )
    expect(page.groups.theirs[0]?.why).toBe('types failed at its head')
    expect(page.parts.map((one) => one.n)).toEqual([2, 2, 1])
  })

  it('says what a ready change is in place of a reason, and its figures beside it', () => {
    const [small] = deskPage(stored(desk), NOW).groups.ready
    expect(small?.why).toBe('green at its head · 1 commit · nothing open')
    expect(small?.facts.map((one) => [one.label, one.value])).toEqual([
      ['Checks', 'green'],
      ['Findings', 'none open'],
      ['Collisions', 'none'],
      ['Changed', '+4 −1'],
      ['Cost', '$1.25'],
    ])
    expect(small?.waitedSaid).toBe('50m')
    expect(small?.href).toBe('/t/sentry/small')
  })

  it('is nothing at all without the findings, and says so rather than ordering without the judge', () => {
    const page = deskPage(
      stored(
        desk,
        EVERY.filter((one) => one !== 'findings'),
      ),
      NOW,
    )
    expect(page.total).toBe(0)
    expect(wholeOf(true, false, false, page)?.title).toBe('Findings not granted')
  })

  it('says a judge nobody could ask as no judge, never as none found', () => {
    const page = deskPage(stored(desk, EVERY, null), NOW)
    const fact = page.groups.ready[0]?.facts.find((one) => one.label === 'Findings')
    expect(fact).toMatchObject({ value: null, under: 'no judge here' })
  })
})

describe('each figure, said', () => {
  it('draws a dash and its word for what nobody looked at, never nought', () => {
    const [unlooked] = deskPage(stored(desk), NOW).groups.yours.filter(
      (one) => one.name === 'unlooked',
    )
    expect(unlooked?.facts.slice(0, 1)).toEqual([
      { label: 'Checks', value: null, under: 'not looked' },
    ])
    expect(conflictsSaid(null)).toEqual({ value: null, under: 'not looked' })
    expect(sizeSaid(null)).toEqual({ value: null, under: 'not looked' })
    expect(sizeSaid({ commits: 2, added: null, removed: 1 })).toEqual({
      value: '2 commits',
      under: 'lines not counted',
    })
  })

  it('counts findings by what became of them, open before anything waiting on a verdict', () => {
    expect(findingsSaid({ open: 1, answered: 2, confirmed: 1, dismissed: 0 })).toMatchObject({
      value: '2 open',
    })
    expect(findingsSaid({ open: 0, answered: 2, confirmed: 0, dismissed: 3 })).toMatchObject({
      value: '2 to judge',
    })
  })

  it('withholds the cost from a device not granted it, in the money rule’s own word', () => {
    const rows = stored(desk, EVERY)
    const small = rows.find((one) => one.id === 'sentry/small')
    expect(cardOf(small, NOW, { spend: false }).facts.at(-1)).toMatchObject({
      value: null,
      under: 'not granted',
    })
  })
})

describe('the page’s words', () => {
  it('leads with what is ready, then what waits on the person, and says itself in a sentence', () => {
    const page = deskPage(stored(desk, EVERY, [finding()]), NOW)
    expect(figureSaid(page)).toEqual({ word: '2 ready', tone: 't-done' })
    expect(leadSaid(page)).toBe(
      '5 pieces of work on the desk: 2 ready to land, 2 waiting on you, 1 waiting on its agent.',
    )
    expect(figureSaid(null)).toEqual({ word: '', tone: null })
  })

  it('is one of four states where there is nothing else to draw, and never a blank', () => {
    expect(wholeOf(false, false, false, null)).toBeNull()
    expect(wholeOf(false, true, false, null)?.kind).toBe('error')
    expect(wholeOf(true, false, true, deskPage([], NOW))?.title).toBe('Nothing waiting to land')
    expect(wholeOf(true, false, true, deskPage(stored(desk), NOW))).toBeNull()
  })
})
