import { describe, expect, it } from 'vitest'
import {
  type BatchFacts,
  batchDue,
  culpritOf,
  type Look,
  type Narrowing,
  nextToTry,
  RETRY_MS,
  SETTLE_MS,
  withLook,
} from '../src/batches.ts'

// When the full checks run for a batch, and whose commit broke a red one.
// Pure: facts in, an answer out — the window applies it.

const due = (over: Partial<BatchFacts> = {}): BatchFacts => ({
  head: 'c3',
  rollup: 'unknown',
  checks: 4,
  batched: false,
  running: false,
  stillMs: SETTLE_MS,
  tried: null,
  now: 1_000_000,
  ...over,
})

describe('a batch', () => {
  it('runs once HEAD has settled and nothing has answered for it', () => {
    expect(batchDue(due())).toEqual({ run: true })
  })

  it('never runs at a HEAD that is green already, or that a batch already answered', () => {
    expect(batchDue(due({ rollup: 'pass' }))).toMatchObject({ run: false })
    // Red included: the same tree asks the same question, and the next commit
    // is what changes the answer.
    expect(batchDue(due({ batched: true, rollup: 'fail' }))).toMatchObject({
      run: false,
      because: 'a batch already ran at this HEAD',
    })
  })

  it('runs where only somebody else’s run went red at HEAD, in a tree that may hold anything', () => {
    // An agent's run in the shared checkout reads whatever is on disk; a batch
    // reads exactly the commit, so its answer is still worth having.
    expect(batchDue(due({ rollup: 'fail' }))).toEqual({ run: true })
  })

  it('waits for a run already going, and for HEAD to sit still', () => {
    expect(batchDue(due({ running: true }))).toMatchObject({ run: false })
    expect(batchDue(due({ stillMs: SETTLE_MS - 1 }))).toMatchObject({
      run: false,
      because: 'HEAD moved a moment ago',
    })
  })

  it('tries again at a HEAD it could not run at, but not at once', () => {
    const tried = { head: 'c3', at: 1_000_000 - RETRY_MS + 1 }
    expect(batchDue(due({ tried }))).toMatchObject({ run: false })
    expect(batchDue(due({ tried: { head: 'c3', at: 1_000_000 - RETRY_MS } }))).toEqual({
      run: true,
    })
    expect(batchDue(due({ tried: { head: 'c2', at: 1_000_000 } }))).toEqual({ run: true })
  })

  it('has nothing to run without a commit or without checks', () => {
    expect(batchDue(due({ head: null }))).toMatchObject({ run: false })
    expect(batchDue(due({ checks: 0 }))).toMatchObject({ run: false })
  })
})

/**
 * Narrow over `commits`, answering each look from `red`: true where the tests
 * fail, or the look itself — and `n` is how many times that commit was looked at.
 */
function narrow(
  commits: string[],
  red: (commit: string, n: number) => boolean | 'cannot' | Look,
  failing?: string[],
) {
  let narrowing: Narrowing = { commits, tried: {}, ...(failing ? { failing } : {}) }
  const order: string[] = []
  for (;;) {
    const next = nextToTry(narrowing)
    if (next === null) break
    order.push(next)
    const said = red(next, order.filter((one) => one === next).length)
    const look: Look =
      typeof said === 'object'
        ? said
        : said === 'cannot'
          ? { tried: 'cannot' }
          : said
            ? { tried: 'red', ...(failing ? { named: failing } : {}) }
            : { tried: 'green' }
    narrowing = withLook(narrowing, next, look)
  }
  return { order, culprit: culpritOf(narrowing) }
}

describe('whose commit broke a red batch', () => {
  const commits = ['base', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'head']
  const brokenAt = (at: string) => (commit: string) =>
    commits.indexOf(commit) >= commits.indexOf(at)

  it('is the first commit the failing tests fail at, found by halving', () => {
    for (const at of ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'head']) {
      const { order, culprit } = narrow(commits, brokenAt(at))
      expect(culprit).toEqual({ commit: at })
      // HEAD, the base, then at most log2 of the rest, then the one it came
      // to a second time before it is named.
      expect(order.slice(0, 2)).toEqual(['head', 'base'])
      expect(order.at(-1)).toBe(at)
      expect(order.filter((one) => one === at)).toHaveLength(2)
      expect(order.length).toBeLessThanOrEqual(2 + 3 + 1)
    }
  })

  it('cannot tell when the commit it came to passes on a second look', () => {
    // The tests fail at c3 and after, but only the first time each is run.
    const { order, culprit } = narrow(commits, (commit, n) => brokenAt('c3')(commit) && n === 1)
    expect(order).toEqual(['head', 'base', 'c3', 'c1', 'c2', 'c3'])
    expect(culprit).toMatchObject({ commit: null, flaky: true })
    expect(culprit.commit === null && culprit.because).toMatch(
      /failed at c3 and then passed when they ran there a second time/,
    )
  })

  it('cannot tell when the second look at the commit could not run', () => {
    const { culprit } = narrow(['base', 'c1', 'head'], (commit, n) =>
      commit === 'c1' && n === 2 ? 'cannot' : commit !== 'base',
    )
    expect(culprit).toMatchObject({ commit: null })
    expect(culprit.commit === null && culprit.because).toMatch(
      /could not be run a second time at c1/,
    )
  })

  it('names the commit when the same tests fail the same way at every look', () => {
    const failing = ['a.test.ts', 'b.test.ts']
    const { culprit } = narrow(commits, brokenAt('c4'), failing)
    expect(culprit).toEqual({ commit: 'c4' })
    // Named in another order is the same set.
    const shuffled = narrow(
      commits,
      (commit) =>
        brokenAt('c4')(commit)
          ? { tried: 'red', named: ['b.test.ts', 'a.test.ts', 'a.test.ts'] }
          : false,
      failing,
    )
    expect(shuffled.culprit).toEqual({ commit: 'c4' })
  })

  it('cannot tell, and stops, when the run at HEAD fails other tests than the batch did', () => {
    // 27 Nov: a hook timeout that hangs on the machine's load failed one set in
    // the batch and another when it ran again — and a commit was named.
    const { order, culprit } = narrow(
      commits,
      () => ({ tried: 'red', named: ['miniflare.test.ts'] }),
      ['miniflare.test.ts', 'worker.test.ts'],
    )
    expect(order).toEqual(['head'])
    expect(culprit).toMatchObject({ commit: null, flaky: true })
    expect(culprit.commit === null && culprit.because).toMatch(
      /did not fail the same way.*batch failed miniflare\.test\.ts, worker\.test\.ts, and at head miniflare\.test\.ts failed/,
    )
  })

  it('cannot tell when the failing set changes partway through the halving', () => {
    const failing = ['a.test.ts', 'b.test.ts']
    const { order, culprit } = narrow(
      commits,
      (commit) =>
        !brokenAt('c3')(commit)
          ? false
          : commit === 'head'
            ? { tried: 'red', named: failing }
            : { tried: 'red', named: ['a.test.ts'] },
      failing,
    )
    // HEAD, the base, then c3, where only one of the two fails: no further.
    expect(order).toEqual(['head', 'base', 'c3'])
    expect(culprit).toMatchObject({ commit: null, flaky: true })
    expect(culprit.commit === null && culprit.because).toMatch(/did not fail the same way/)
  })

  it('cannot tell when a red look names no failing test where the batch named some', () => {
    const { culprit } = narrow(
      commits,
      (commit) => (brokenAt('c2')(commit) ? { tried: 'red' } : false),
      ['a.test.ts'],
    )
    expect(culprit).toMatchObject({ commit: null, flaky: true })
    expect(culprit.commit === null && culprit.because).toMatch(/without naming which/)
  })

  it('compares nothing where a whole check ran again, which names no tests', () => {
    const { culprit } = narrow(commits, (commit) =>
      brokenAt('c5')(commit) ? { tried: 'red', named: ['anything.test.ts'] } : false,
    )
    expect(culprit).toEqual({ commit: 'c5' })
  })

  it('is nobody’s when the tests pass on their own at HEAD: that is a flake, not a commit', () => {
    const { order, culprit } = narrow(commits, () => false)
    expect(order).toEqual(['head'])
    expect(culprit).toMatchObject({ commit: null, flaky: true })
  })

  it('is nobody’s when they were already failing before any of these commits', () => {
    const { culprit } = narrow(commits, () => true)
    expect(culprit).toMatchObject({ commit: null })
    expect(culprit.commit === null && culprit.because).toMatch(/before any of these commits/)
  })

  it('says it cannot tell rather than guessing past a commit it could not run', () => {
    const { culprit } = narrow(['base', 'c1', 'c2', 'head'], (commit) =>
      commit === 'c1' ? 'cannot' : commit === 'c2' || commit === 'head',
    )
    // c2 is red and c1 could not be run: it is c1 or c2, and which is not known.
    expect(culprit).toMatchObject({ commit: null })
    expect(culprit.commit === null && culprit.because).toMatch(/could not be run/)
  })

  it('names the only commit there is', () => {
    expect(narrow(['base', 'head'], (commit) => commit === 'head').culprit).toEqual({
      commit: 'head',
    })
  })
})
