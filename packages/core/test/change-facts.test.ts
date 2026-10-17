import { describe, expect, it } from 'vitest'
import { type FindingFacts, findingsFor, sizeOf } from '../src/change-facts.ts'

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

describe('what its own commits changed', () => {
  it('adds them up, and says it cannot where git could not count one', () => {
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
