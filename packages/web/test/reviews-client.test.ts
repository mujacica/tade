import { describe, expect, it } from 'vitest'
import {
  aheadSaid,
  CELLS,
  checksRowOf,
  figureSaid,
  forgeOf,
  HOLDS,
  heldSaid,
  holdOf,
  leadSaid,
  omittedSaid,
  reviewOf,
  reviewsPage,
  rowLine,
  settledSaid,
  stagesOf,
  textTone,
} from '../src/assets/pages/reviews-shape.js'
import { applySnapshot, emptyStore, reviewsOf } from '../src/assets/store.js'
import type { TaskIn } from '../src/input.ts'
import { projector } from '../src/reading.ts'
import { EVERY, input, NOW, reach, task } from './fixtures.ts'

// What the reviews page draws, against **real projected rows** rather than
// shapes a test assembled: every hold, order, count and word goes through the
// projection and the store's own split, so a field the projection renames is a
// red test here rather than a blank card on a phone. And the page's one rule of
// honesty, held in each of its forms: **a green is the rollup's green** — a
// check nobody ran is never drawn passing, the passes the rollup never named
// are never invented, and a review nothing could check is hatched, not green.

const minutes = (n: number) => NOW - n * 60_000
const green = { state: 'pass' as const, failed: [], missing: [], overridden: false }
const red = (failed: string[], missing: string[] = []) => ({
  state: 'fail' as const,
  failed,
  missing,
  overridden: false,
})
const unrun = (missing: string[]) => ({
  state: 'unknown' as const,
  failed: [],
  missing,
  overridden: false,
})
const unread = { state: 'unknown' as const, failed: [], missing: [], overridden: false }
const url = (n: number) => `https://github.invalid/acme/sentry/pull/${n}`

/** A review, open on its forge, that its agent moved `moved` minutes ago. */
const offered = (id: string, moved: number, over: Partial<TaskIn> = {}) =>
  task({ id, movedAt: minutes(moved), review: { state: 'open', url: url(1) }, ...over })

/** An agent blocked on an approval it asked for `waited` minutes ago. */
const asking = (id: string, waited: number, over: Partial<TaskIn> = {}) =>
  offered(id, 1, {
    state: 'blocked',
    reason: { kind: 'approval', tool: 'Bash', also: 0 },
    approval: { id: `req_${id}`, tool: 'Bash', sinceAt: minutes(waited) },
    ...over,
  })

/** The store a device granted everything holds, for these tasks. */
function stored(tasks: TaskIn[], granted = EVERY) {
  const store = emptyStore()
  applySnapshot(store, projector(input({ reach: reach(granted), tasks }), NOW).snapshot())
  return store
}

/** The page over these tasks, as the screen builds it: the store's split, then the shape. */
function page(tasks: TaskIn[], granted = EVERY, frozen = false) {
  const { offered: open, unoffered } = reviewsOf(stored(tasks, granted))
  return reviewsPage(open, unoffered, NOW, frozen)
}

/** One projected row, as the store holds it. */
function row(one: TaskIn, granted = EVERY) {
  return stored([one], granted).rows.tasks.get(one.id)
}

const ids = (cards: readonly { id: string }[]) => cards.map((one) => one.id)

describe('what holds a review', () => {
  it('is the first of: waiting on you, a red check, a draft, a check nobody ran — or nothing', () => {
    expect(holdOf(row(asking('a/you', 3, { checks: red(['tests']) })))).toBe('you')
    expect(holdOf(row(offered('a/red', 1, { checks: red(['tests']) })))).toBe('red')
    // A draft with a red check is held by the red: the red is real whatever the draft says.
    expect(
      holdOf(
        row(
          offered('a/both', 1, { checks: red(['lint']), review: { state: 'draft', url: url(2) } }),
        ),
      ),
    ).toBe('red')
    expect(
      holdOf(
        row(offered('a/draft', 1, { checks: unread, review: { state: 'draft', url: url(2) } })),
      ),
    ).toBe('draft')
    expect(
      holdOf(
        row(offered('a/greendraft', 1, { checks: green, review: { state: 'draft', url: url(2) } })),
      ),
    ).toBe('draft')
    expect(holdOf(row(offered('a/unrun', 1, { checks: unrun(['tests']) })))).toBe('unchecked')
    expect(holdOf(row(offered('a/unread', 1, { checks: unread })))).toBe('unchecked')
    expect(holdOf(row(offered('a/ready', 1, { checks: green })))).toBe('ready')
  })

  it('is settled once merged or closed, whatever its checks or its agent say', () => {
    for (const state of ['merged', 'closed'] as const) {
      const one = asking(`a/${state}`, 3, {
        checks: red(['tests']),
        review: { state, url: url(2) },
      })
      expect(holdOf(row(one))).toBe('settled')
    }
  })

  it('is nothing where nothing was offered', () => {
    expect(holdOf(row(task({ id: 'a/quiet', review: null, ahead: 2 })))).toBeNull()
  })

  it('takes waiting on you from the window’s own answer, and never from the state alone', () => {
    // `blocked` with nothing marked as wanting the person is not waiting on them.
    const one = offered('a/blocked', 1, { state: 'blocked', mark: 'working', checks: green })
    expect(row(one)?.wantsYou).toBe(false)
    expect(holdOf(row(one))).toBe('ready')
  })
})

describe('a review’s checks at its head', () => {
  it('names every failing check, then every one that never ran, and the counts in words', () => {
    const checks = checksRowOf(red(['lint', 'tests'], ['e2e']))
    expect(checks.cells.map((one) => [one.name, one.tone])).toEqual([
      ['lint', 'failed'],
      ['tests', 'failed'],
      ['e2e', 'unknown'],
    ])
    expect(checks.line).toBe('2 failing · 1 not run here')
    expect(checks.said).toBe('Checks: lint, tests failing; e2e not run here.')
  })

  it('draws one green cell where every required check passed, and invents no names for them', () => {
    const checks = checksRowOf(green)
    expect(checks.cells).toEqual([{ key: 'pass', name: 'every required check', ...CELLS.pass }])
    expect(checks.line).toBe('green at its head')
  })

  it('hatches a review nothing could check, and never draws it green', () => {
    const checks = checksRowOf(unread)
    expect(checks.cells.map((one) => one.tone)).toEqual(['unknown'])
    expect(checks.line).toBe('nothing ran at its head here')
    expect(checksRowOf(undefined).cells.map((one) => one.tone)).toEqual(['unknown'])
  })

  it('is green only where the rollup says pass, over every shape a rollup can take', () => {
    for (const state of ['pass', 'fail', 'unknown'] as const) {
      for (const failed of [[], ['lint']]) {
        for (const missing of [[], ['e2e']]) {
          const drawn = checksRowOf({ state, failed, missing, overridden: false })
          const greens = drawn.cells.filter((one) => one.tone === 'done')
          expect(greens.length, `${state} ${failed} ${missing}`).toBe(
            state === 'pass' && failed.length === 0 && missing.length === 0 ? 1 : 0,
          )
          expect(drawn.cells.length).toBeGreaterThan(0)
        }
      }
    }
  })

  it('keeps a red rollup red when it named nothing', () => {
    const checks = checksRowOf({ state: 'fail', failed: [], missing: [], overridden: false })
    expect(checks.cells.map((one) => one.tone)).toEqual(['failed'])
    expect(checks.line).toBe('1 failing')
  })

  it('says when a failing check was overruled', () => {
    expect(checksRowOf({ ...green, overridden: true }).overruled).toBe(true)
    expect(checksRowOf({ ...green, overridden: true }).said).toContain('overruled')
    expect(checksRowOf(green).overruled).toBe(false)
  })
})

describe('the forge', () => {
  it('gives the review’s number where its link ends in one', () => {
    expect(forgeOf({ state: 'open', url: url(412) })).toEqual({ href: url(412), number: '#412' })
    expect(
      forgeOf({ state: 'open', url: 'https://gitlab.invalid/acme/app/-/merge_requests/12/' }),
    ).toEqual({ href: 'https://gitlab.invalid/acme/app/-/merge_requests/12/', number: '#12' })
    expect(forgeOf({ state: 'open', url: 'https://forge.invalid/review/abc' })?.number).toBeNull()
  })

  it('links nothing that is not https, and nothing this device was not sent', () => {
    expect(forgeOf({ state: 'open', url: 'javascript:alert(1)' })).toBeNull()
    expect(forgeOf({ state: 'open', url: 'http://github.invalid/acme/sentry/pull/1' })).toBeNull()
    expect(forgeOf({ state: 'open', url: null })).toBeNull()
    expect(forgeOf(null)).toBeNull()
    // The link is withheld without the grant, and the card has no press.
    const one = reviewOf(row(offered('a/link', 1), []), NOW)
    expect(one.forge).toBeNull()
  })
})

describe('one review, as its card says it', () => {
  it('waits on you in the projection’s own words, counted from the approval', () => {
    const card = reviewOf(row(asking('a/you', 14)), NOW)
    expect(card.because).toBe('wants approval: Bash')
    expect(card.waitedSaid).toBe('14m')
    expect(card.asksYou).toBe(true)
    expect(card.holdMark).toMatchObject({ word: 'Waiting on you', tone: 't-wants' })
  })

  it('says what its agent is doing otherwise, which is who is on a red check', () => {
    const card = reviewOf(row(offered('a/red', 3, { checks: red(['tests']) })), NOW)
    expect(card.because).toBe('agent working')
    expect(card.waitedSaid).toBe('3m')
    expect(card.holdMark.tone).toBe('t-failed')
  })

  it('carries what was asked for only where the device was granted it', () => {
    const one = offered('a/words', 1, { title: 'Let an alert fire on a percentage' })
    expect(reviewOf(row(one), NOW).words).toBe('Let an alert fire on a percentage')
    expect(reviewOf(row(one, []), NOW).words).toBeNull()
  })

  it('freezes its age at the server’s last word when the page is not live', () => {
    const card = reviewOf(row(offered('a/frozen', 8)), NOW, true)
    expect(card.waitedSaid).toMatch(/^8m at \d\d:\d\d:\d\d$/)
  })

  it('says how far its branch is from its base, and nothing git could not say', () => {
    expect(aheadSaid(3, 1)).toBe('3 ahead · 1 behind')
    expect(aheadSaid(2, 0)).toBe('2 ahead')
    expect(aheadSaid(null, null)).toBeNull()
    const card = reviewOf(row(offered('a/far', 1, { ahead: 5, behind: 2 })), NOW)
    expect(card.distance).toBe('5 ahead · 2 behind')
    expect(rowLine(card)).toBe('tade/away-projection · 5 ahead · 2 behind · checks 1 not run here')
  })
})

describe('the page', () => {
  const tasks = [
    asking('a/asked-late', 3),
    asking('a/asked-early', 20),
    offered('a/red-new', 2, { checks: red(['tests']) }),
    offered('a/red-old', 40, { checks: red(['lint']) }),
    offered('a/draft', 5, { checks: unread, review: { state: 'draft', url: url(2) } }),
    offered('a/unrun', 9, { checks: unrun(['tests']) }),
    offered('a/ready-new', 4, { checks: green }),
    offered('a/ready-old', 60, { checks: green }),
    offered('a/merged-old', 600, { checks: green, review: { state: 'merged', url: url(2) } }),
    offered('a/merged-new', 100, { checks: green, review: { state: 'merged', url: url(2) } }),
    offered('a/closed', 300, { review: { state: 'closed', url: url(2) } }),
    task({ id: 'a/quiet-new', review: null, ahead: 2, movedAt: minutes(1) }),
    task({ id: 'a/quiet-old', review: null, ahead: 1, movedAt: minutes(30) }),
    task({ id: 'a/nothing', review: null, ahead: 0 }),
  ]
  const made = page(tasks)

  it('puts every review in exactly one place, and finished work nobody offered in its own', () => {
    const placed = [
      ...made.you,
      ...made.blocked,
      ...made.ready,
      ...made.settled,
      ...made.unoffered,
    ].map((one) => one.id)
    expect(new Set(placed).size).toBe(placed.length)
    expect(placed.sort()).toEqual(
      tasks
        .map((one) => one.id)
        .filter((id) => id !== 'a/nothing')
        .sort(),
    )
    expect(made.total).toBe(13)
  })

  it('orders what waits on you and what is ready by the longest wait', () => {
    expect(ids(made.you)).toEqual(['a/asked-early', 'a/asked-late'])
    expect(ids(made.ready)).toEqual(['a/ready-old', 'a/ready-new'])
    expect(ids(made.unoffered)).toEqual(['a/quiet-old', 'a/quiet-new'])
  })

  it('holds the red ones first, then the drafts, then what nobody checked', () => {
    expect(ids(made.blocked)).toEqual(['a/red-old', 'a/red-new', 'a/draft', 'a/unrun'])
  })

  it('puts what settled newest first, and counts merged apart from closed', () => {
    expect(ids(made.settled)).toEqual(['a/merged-new', 'a/closed', 'a/merged-old'])
    expect([made.merged, made.closed]).toEqual([2, 1])
  })

  it('draws the lead’s bar out of the same counts, every hold in order and none left out', () => {
    expect(made.parts.map((one) => [one.key, one.n])).toEqual([
      ['you', 2],
      ['red', 2],
      ['draft', 1],
      ['unchecked', 1],
      ['ready', 2],
    ])
    expect(made.parts.reduce((sum, one) => sum + one.n, 0)).toBe(made.open)
    expect(made.open).toBe(8)
    expect(made.held).toBe(6)
    expect(made.parts.map((one) => one.tone)).toEqual(Object.values(HOLDS).map((one) => one.tone))
  })

  it('says the lead in words', () => {
    expect(leadSaid(made)).toBe(
      '8 open reviews: 2 waiting on you, 2 checks failing, 1 draft, 1 not checked, 2 ready to merge.',
    )
    expect(heldSaid(made)).toBe('6 held · 2 free to merge')
    expect(stagesOf(made)).toEqual({
      before: { n: 2, under: 'commits, no review' },
      after: { n: 2, under: '1 closed' },
    })
  })

  it('leads its bar with what most wants the person', () => {
    expect(figureSaid(made)).toEqual({ word: '2 waiting on you', tone: 't-wants' })
    expect(figureSaid(page(tasks.filter((one) => !one.id.startsWith('a/asked'))))).toEqual({
      word: '2 failing',
      tone: 't-failed',
    })
    expect(figureSaid(page([offered('a/ready', 1, { checks: green })]))).toEqual({
      word: '1 ready',
      tone: 't-done',
    })
    expect(figureSaid(page([offered('a/unrun', 1, { checks: unread })]))).toEqual({
      word: '1 open',
      tone: null,
    })
    expect(figureSaid(page([task({ id: 'a/quiet', review: null, ahead: 1 })])).word).toBe(
      '1 not offered',
    )
    expect(figureSaid(page([]))).toEqual({ word: '', tone: null })
    expect(figureSaid(null)).toEqual({ word: '', tone: null })
  })

  it('says nothing is open when nothing is, rather than drawing a bar of nought', () => {
    const none = page([task({ id: 'a/quiet', review: null, ahead: 1 })])
    expect(none.open).toBe(0)
    expect(leadSaid(none)).toBe('Nothing is open for review.')
    expect(heldSaid(none)).toBe('nothing is offered for merge')
    expect(heldSaid(page([offered('a/ready', 1, { checks: green })]))).toBe(
      'nothing holds any of them',
    )
    expect(
      stagesOf(page([offered('a/m', 1, { review: { state: 'merged', url: url(2) } })])).after,
    ).toEqual({ n: 1, under: 'merged' })
  })
})

describe('the page’s own words', () => {
  it('folds what settled behind a press that says how many', () => {
    expect(settledSaid(1, false)).toBe('Show 1 merged or closed review')
    expect(settledSaid(3, true)).toBe('Hide 3 merged or closed reviews')
  })

  it('says what this device was not sent rather than cutting it in silence', () => {
    expect(omittedSaid(0)).toBeNull()
    expect(omittedSaid(1)).toBe('1 task not sent to this device, so any review of it is not here')
    expect(omittedSaid(4)).toContain('4 tasks not sent')
  })

  it('gives every hold a text tone the sheet colours, and the unknown one grey', () => {
    expect(Object.values(HOLDS).map((one) => textTone(one.tone))).toEqual([
      't-wants',
      't-failed',
      't-quiet',
      't-quiet',
      't-done',
    ])
  })
})
