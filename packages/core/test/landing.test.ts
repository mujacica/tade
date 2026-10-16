import { describe, expect, it } from 'vitest'
import {
  conflictsFor,
  deskSays,
  type FindingFacts,
  findingsFor,
  type LandingFacts,
  landingDesk,
  landingOf,
  linesOf,
  onTheDesk,
  sizeOf,
} from '../src/landing.ts'

function facts(over: Partial<LandingFacts> = {}): LandingFacts {
  return {
    task: 'app/one',
    state: 'review',
    finished: true,
    wantsYou: false,
    review: null,
    checks: 'pass',
    failed: [],
    missing: [],
    findings: { open: 0, answered: 0, confirmed: 0, dismissed: 0 },
    conflicts: [],
    size: { commits: 2, added: 10, removed: 4 },
    waitingSince: 1_000,
    ...over,
  }
}

describe('what belongs on the desk', () => {
  it('is finished work, work stopped for review, and every review still open', () => {
    expect(onTheDesk({ state: 'review', finished: false, review: null })).toBe(true)
    expect(onTheDesk({ state: 'working', finished: true, review: null })).toBe(true)
    expect(onTheDesk({ state: 'working', finished: false, review: 'open' })).toBe(true)
    expect(onTheDesk({ state: 'blocked', finished: false, review: 'draft' })).toBe(true)
  })

  it('is never queued, parked or merged work, nor a review that settled', () => {
    expect(onTheDesk({ state: 'working', finished: false, review: null })).toBe(false)
    expect(onTheDesk({ state: 'queued', finished: false, review: 'open' })).toBe(false)
    expect(onTheDesk({ state: 'parked', finished: true, review: null })).toBe(false)
    expect(onTheDesk({ state: 'merged', finished: true, review: 'merged' })).toBe(false)
    expect(onTheDesk({ state: 'review', finished: true, review: 'closed' })).toBe(false)
  })
})

describe('what became of the findings', () => {
  const finding = (over: Partial<FindingFacts>): FindingFacts => ({
    tasks: ['app/one'],
    stillThere: true,
    account: null,
    verdict: null,
    ...over,
  })

  it('counts each finding once, by what became of it, and only for its own tasks', () => {
    expect(
      findingsFor(
        [
          finding({}),
          finding({ account: { did: 'fixed' } }),
          finding({ verdict: { was: 'confirmed' } }),
          finding({ verdict: { was: 'false positive' }, stillThere: false }),
          finding({ tasks: ['app/two'] }),
        ],
        'app/one',
      ),
    ).toEqual({ open: 1, answered: 1, confirmed: 1, dismissed: 1 })
  })

  it('drops what a later reading no longer raises, unless somebody judged it a false positive', () => {
    expect(
      findingsFor(
        [
          finding({ stillThere: false }),
          finding({ stillThere: false, account: { did: 'fixed' } }),
          finding({ stillThere: false, verdict: { was: 'confirmed' } }),
        ],
        'app/one',
      ),
    ).toEqual({ open: 0, answered: 0, confirmed: 0, dismissed: 0 })
  })
})

describe('where a piece of work stands', () => {
  it('is ready when it is green, nothing is open and nobody is waited on', () => {
    expect(landingOf(facts())).toEqual({ tier: 'ready', why: null, also: 0 })
    // A dismissed finding is a judged one: nothing is left to read.
    expect(
      landingOf(facts({ findings: { open: 0, answered: 0, confirmed: 0, dismissed: 2 } })).tier,
    ).toBe('ready')
  })

  it('waits on the person for an answer, a verdict, a check nobody ran, or a draft', () => {
    expect(landingOf(facts({ wantsYou: true, state: 'blocked', finished: false }))).toEqual({
      tier: 'yours',
      why: 'its agent is waiting on your answer',
      also: 0,
    })
    expect(
      landingOf(facts({ findings: { open: 0, answered: 2, confirmed: 0, dismissed: 0 } })).why,
    ).toBe('its agent answered 2 findings, and they wait on your verdict')
    expect(landingOf(facts({ checks: 'unknown', missing: ['tests'] })).why).toBe(
      'tests has not run at its head',
    )
    expect(landingOf(facts({ checks: 'unknown' })).why).toBe(
      'no required check has run at its head',
    )
    expect(landingOf(facts({ checks: null })).why).toBe('nothing has looked at its checks yet')
    expect(landingOf(facts({ review: 'draft' })).why).toBe('its review is still a draft')
  })

  it('waits on its agent while it works, a check is red, a finding is open or it would collide', () => {
    expect(landingOf(facts({ state: 'working', finished: false, review: 'open' })).why).toBe(
      'its agent is still working',
    )
    expect(landingOf(facts({ checks: 'fail', failed: ['types', 'tests', 'format'] })).why).toBe(
      'types, tests and 1 more failed at its head',
    )
    expect(landingOf(facts({ checks: 'fail' })).why).toBe('a required check failed at its head')
    expect(
      landingOf(facts({ findings: { open: 1, answered: 0, confirmed: 0, dismissed: 0 } })).why,
    ).toBe('1 finding nobody has answered')
    expect(
      landingOf(facts({ findings: { open: 0, answered: 0, confirmed: 1, dismissed: 0 } })).why,
    ).toBe('1 confirmed finding still in it')
    expect(landingOf(facts({ conflicts: [{ with: 'app/two', files: 3 }] })).why).toBe(
      'it would conflict with two in 3 files',
    )
    expect(landingOf(facts({ conflicts: [{ with: null, files: 1 }] })).why).toBe(
      'it no longer merges into its base cleanly (1 file)',
    )
  })

  it("is the agent's while anything is its agent's, and counts every other reason behind it", () => {
    const both = landingOf(facts({ checks: 'fail', failed: ['tests'], review: 'draft' }))
    expect(both).toEqual({ tier: 'theirs', why: 'tests failed at its head', also: 1 })
  })

  it('never takes a judge that could not be read for a judge that found nothing wrong', () => {
    // Unread findings add no reason and take none away: the checks still decide.
    expect(landingOf(facts({ findings: null })).tier).toBe('ready')
    expect(landingOf(facts({ findings: null, checks: 'fail' })).tier).toBe('theirs')
  })
})

describe('the order of the desk', () => {
  it('is ready smallest first, then the person’s and the agents’, longest waiting first', () => {
    const desk = landingDesk([
      facts({ task: 'app/red', checks: 'fail', waitingSince: 50 }),
      facts({ task: 'app/big', size: { commits: 9, added: 400, removed: 20 }, waitingSince: 10 }),
      facts({ task: 'app/draft', review: 'draft', waitingSince: 300 }),
      facts({ task: 'app/small', size: { commits: 1, added: 2, removed: 1 }, waitingSince: 900 }),
      facts({ task: 'app/unsized', size: null }),
      facts({ task: 'app/answer', wantsYou: true, waitingSince: 200 }),
    ])
    expect(desk.map((row) => row.facts.task)).toEqual([
      'app/small',
      'app/big',
      'app/unsized',
      'app/answer',
      'app/draft',
      'app/red',
    ])
  })

  it('goes by name where nothing else tells two apart, so it never shuffles', () => {
    const desk = landingDesk([
      facts({ task: 'app/b', waitingSince: null }),
      facts({ task: 'app/a', waitingSince: null }),
    ])
    expect(desk.map((row) => row.facts.task)).toEqual(['app/a', 'app/b'])
  })

  it('says how many lines changed only where git counted both halves', () => {
    expect(linesOf({ commits: 1, added: 3, removed: 2 })).toBe(5)
    expect(linesOf({ commits: 1, added: null, removed: 2 })).toBeNull()
    expect(linesOf(null)).toBeNull()
  })

  it('says itself in one clause, and nothing where nothing is on it', () => {
    expect(deskSays([{ tier: 'ready' }, { tier: 'ready' }, { tier: 'theirs' }])).toBe(
      '2 ready to land, 1 waiting on its agent',
    )
    expect(deskSays([])).toBeNull()
  })
})

describe('the facts it is folded from', () => {
  it('names the other side of each collision, its base as null, and nobody looking as null', () => {
    const forecast = [
      { kind: 'branches' as const, tasks: ['app/one', 'app/two'], files: ['a.ts', 'b.ts'] },
      { kind: 'base' as const, tasks: ['app/one'], base: 'main', files: ['c.ts'] },
      { kind: 'hunks' as const, tasks: ['app/three', 'app/two'], files: ['d.ts'] },
    ]
    expect(conflictsFor(forecast, 'app/one')).toEqual([
      { with: 'app/two', files: 2 },
      { with: null, files: 1 },
    ])
    expect(conflictsFor([], 'app/one')).toEqual([])
    expect(conflictsFor(undefined, 'app/one')).toBeNull()
  })

  it('adds up its own commits, and says it cannot where git could not count one', () => {
    expect(
      sizeOf([
        { files: 2, added: 3, removed: 1 },
        // git writes no `0 deletions(-)`: a stat line with a half missing changed none of it.
        { files: 1, added: 10, removed: null },
      ]),
    ).toEqual({ commits: 2, added: 13, removed: 1 })
    // A merge prints no stat line at all, and then nobody can say.
    expect(sizeOf([{ files: null, added: null, removed: null }])).toEqual({
      commits: 1,
      added: null,
      removed: null,
    })
    expect(sizeOf([])).toEqual({ commits: 0, added: 0, removed: 0 })
    expect(sizeOf(null)).toBeNull()
  })
})
