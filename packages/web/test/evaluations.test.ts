import { evaluationsFrom, noSpend, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { CARDS_MOST, EvaluationsAnswerSchema, evaluationsFor } from '../src/evaluations.ts'
import { reach } from './fixtures.ts'

// The scorecards a paired device reads: folded over every project, the money
// and the judge's precision in them, and nothing before the journal has been read.

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
    const out = evaluationsFor(reach(), () => null)
    expect(out).toMatchObject({ read: false, total: null, calibration: null })
  })

  it('is folded over every project', () => {
    const all = evaluationsFor(reach(), fold)
    expect(all.total?.tasks).toBe(2)
    expect(all.by.harness.map((row) => row.key).sort()).toEqual(['codex', 'pi'])
  })

  it('carries the machine’s own words for every count out of a count', () => {
    const [pi] = evaluationsFor(reach(), fold).by.harness.filter((row) => row.key === 'pi')
    expect(pi?.landed).toEqual({ count: 1, of: 1, said: '1 of 1' })
    expect(pi?.redsHere).toBeNull()
  })

  it('carries the money and what the judge said', () => {
    const out = evaluationsFor(reach(), fold)
    expect(out.total?.cost).toEqual([{ said: '$2.00', kind: 'billed' }])
    expect(out.judge).toBe('read')
    expect(out.calibration?.questions[0]).toMatchObject({
      question: 'test_missing',
      fired: 1,
      said: '1 of 1, too few to call',
    })
  })

  it('says no judge reads anything here', () => {
    const none = (projects: ReadonlySet<string> | null) =>
      evaluationsFrom(journal, { since: 0, projects, spent: {}, findings: null })
    expect(evaluationsFor(reach(), none).judge).toBe('none here')
  })
})

describe('the scorecards, as another machine of the person’s reads them', () => {
  it('is an answer that reads for its shape, read or not', () => {
    for (const out of [evaluationsFor(reach(), fold), evaluationsFor(reach(), () => null)]) {
      const read = EvaluationsAnswerSchema.safeParse(JSON.parse(JSON.stringify(out)))
      expect(read.success, JSON.stringify(read.error?.issues)).toBe(true)
    }
  })

  it('keeps what it reads and lets be what a newer Tade adds, and refuses what is not a count', () => {
    const out = JSON.parse(JSON.stringify(evaluationsFor(reach(), fold)))
    const read = EvaluationsAnswerSchema.parse({ ...out, newer: 'a field from later' })
    expect(read.total?.tasks).toBe(2)
    expect(read.by.harness.map((row) => row.key).sort()).toEqual(['codex', 'pi'])
    expect('newer' in read).toBe(false)
    // Its races are not read: a scorecard is all another machine draws of it.
    expect('races' in read).toBe(false)
    const odd = { ...out, total: { ...out.total, tasks: -1 } }
    expect(EvaluationsAnswerSchema.safeParse(odd).success).toBe(false)
    const many = { ...out, by: { ...out.by, model: Array(CARDS_MOST + 1).fill(out.total) } }
    expect(EvaluationsAnswerSchema.safeParse(many).success).toBe(false)
  })
})
