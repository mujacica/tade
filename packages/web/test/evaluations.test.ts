import { evaluationsFrom, noSpend, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { evaluationsFor } from '../src/evaluations.ts'
import { EVERY, reach } from './fixtures.ts'

// The scorecards as one device may read them: folded over its own projects,
// money behind `spend`, the judge behind `findings`, and nothing before the
// journal has been read.

let seq = 0
const line = (over: Partial<TadeEvent> & Pick<TadeEvent, 'type'>): TadeEvent => ({
  seq: ++seq,
  ts: '2026-10-10T09:00:00.000Z',
  urgency: 'notable',
  task: null,
  lane: null,
  run: null,
  detail: {},
  ...over,
})

const journal: TadeEvent[] = [
  line({ type: 'task_created', task: 'shop/a' }),
  line({
    type: 'run_started',
    task: 'shop/a',
    run: 'r1',
    detail: { harness: 'pi', model: 'kimi' },
  }),
  line({ type: 'task_done', task: 'shop/a', detail: { rule: 'merged' } }),
  line({ type: 'task_created', task: 'blog/b' }),
  line({ type: 'run_started', task: 'blog/b', run: 'r2', detail: { harness: 'codex' } }),
]

/** What the window would hand over: the fold, over the projects asked about. */
const fold = (projects: ReadonlySet<string> | null) =>
  evaluationsFrom(journal, {
    since: 0,
    projects,
    spent: { 'shop/a': { ...noSpend(), tokens: 900, usd: 2, usdExact: 2, hasCost: true } },
    findings: [
      {
        tasks: ['shop/a'],
        question: 'test_missing',
        probability: 0.9,
        verdict: { was: 'confirmed' },
      },
    ],
  })

describe('the scorecards a device reads', () => {
  it('says nothing was read before the journal is, rather than a page of noughts', () => {
    const out = evaluationsFor(reach(EVERY), () => null)
    expect(out).toMatchObject({ read: false, total: null, calibration: null })
  })

  it('is folded over the projects this device reads, never filtered after the sum', () => {
    const all = evaluationsFor(reach(EVERY), fold)
    expect(all.total?.tasks).toBe(2)
    const one = evaluationsFor(reach(EVERY, ['blog']), fold)
    expect(one.total?.tasks).toBe(1)
    expect(one.by.harness.map((row) => row.key)).toEqual(['codex'])
  })

  it('carries the machine’s own words for every count out of a count', () => {
    const [pi] = evaluationsFor(reach(EVERY), fold).by.harness.filter((row) => row.key === 'pi')
    expect(pi?.landed).toEqual({ count: 1, of: 1, said: '1 of 1' })
    expect(pi?.redsHere).toBeNull()
  })

  it('withholds the money under spend, as not granted rather than nought', () => {
    const without = evaluationsFor(reach(EVERY.filter((one) => one !== 'spend')), fold)
    expect(without.granted.spend).toBe(false)
    expect(without.total?.cost).toBeNull()
    expect(without.total?.tokensPerLanded).toBeNull()
    expect(evaluationsFor(reach(['spend']), fold).total?.cost).toEqual([
      { said: '$2.00', kind: 'billed' },
    ])
  })

  it('withholds what the judge said under findings, and says which', () => {
    const without = evaluationsFor(reach(EVERY.filter((one) => one !== 'findings')), fold)
    expect(without.judge).toBe('not granted')
    expect(without.calibration).toBeNull()
    expect(without.total?.findings).toBeNull()
    const granted = evaluationsFor(reach(['findings']), fold)
    expect(granted.judge).toBe('read')
    expect(granted.calibration?.questions[0]).toMatchObject({
      question: 'test_missing',
      fired: 1,
      said: '1 of 1, too few to call',
    })
  })

  it('says no judge reads anything here apart from one that was not granted', () => {
    const none = (projects: ReadonlySet<string> | null) =>
      evaluationsFrom(journal, { since: 0, projects, spent: {}, findings: null })
    expect(evaluationsFor(reach(['findings']), none).judge).toBe('none here')
    expect(evaluationsFor(reach([]), none).judge).toBe('not granted')
  })
})
