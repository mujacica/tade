import { evaluationsFrom, noSpend, type TadeEvent } from '@tade/core'
import { describe, expect, it } from 'vitest'
import {
  cardsOf,
  EVAL_TABS,
  emptyOf,
  judgeOf,
  leadOf,
  mergedSaid,
} from '../src/assets/pages/evaluations-shape.js'
import { evaluationsFor } from '../src/evaluations.ts'
import { EVERY, reach } from './fixtures.ts'

// What the Evaluations page draws, against **a real answer**: the machine's
// fold, per device, through `evaluationsFor` — so this holds that the page says
// the machine's words for every count out of a count, a rate only from five,
// and a missing figure as which kind of missing, never as nought.

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

const journal: TadeEvent[] = ['a', 'b', 'c', 'd', 'e', 'f'].flatMap((name, at) => [
  line({ type: 'task_created', task: `shop/${name}` }),
  line({
    type: 'run_started',
    task: `shop/${name}`,
    run: `r${at}`,
    detail: { harness: at < 5 ? 'claude-code' : 'pi' },
  }),
  ...(at < 4
    ? [
        line({
          type: 'task_done',
          task: `shop/${name}`,
          ts: '2026-10-10T11:00:00.000Z',
          detail: { rule: 'merged' },
        }),
      ]
    : []),
])

const answer = (granted = EVERY, findings = true) =>
  evaluationsFor(reach(granted), (projects) =>
    evaluationsFrom(journal, {
      since: 0,
      projects,
      spent: { 'shop/a': { ...noSpend(), tokens: 10, usd: 8, usdExact: 8, hasCost: true } },
      findings: findings
        ? [
            {
              tasks: ['shop/a'],
              question: 'test_missing',
              probability: 0.92,
              verdict: { was: 'false positive' },
            },
          ]
        : null,
    }),
  )

describe('the Evaluations page', () => {
  it('offers a tab per grouping, the races, and the judge', () => {
    expect(EVAL_TABS.map((one) => one.id)).toEqual([
      'harness',
      'model',
      'persona',
      'template',
      'races',
      'judge',
    ])
  })

  it('leads with the whole of it, in the machine’s own words', () => {
    const lead = leadOf(answer())
    expect(lead.find((one) => one.key === 'landed')).toMatchObject({
      value: '4',
      under: '4 of 6 · 67% of 6 agents',
    })
    expect(lead.find((one) => one.key === 'push')).toMatchObject({
      value: null,
      under: 'no push seen',
    })
    expect(lead.find((one) => one.key === 'cost')).toMatchObject({ value: '$8.00' })
    expect(lead.find((one) => one.key === 'done')?.value).toBe('2h 0m')
    expect(mergedSaid(answer())).toBe('merges from the journal')
  })

  it('says the money is not granted rather than drawing it as nothing', () => {
    const lead = leadOf(answer(EVERY.filter((one) => one !== 'spend')))
    expect(lead.find((one) => one.key === 'cost')).toMatchObject({
      value: null,
      under: 'not granted',
    })
  })

  it('draws each harness as what landed, with every other figure under it', () => {
    const [claude, pi] = cardsOf(answer(), 'harness')
    expect(claude).toMatchObject({ label: 'claude-code', value: 4, said: '4 of 5 · 80% landed' })
    expect(claude?.under).toContain('$8.00 per landed')
    expect(claude?.under).toContain('1 finding · 0 confirmed · 1 wrong · 0 open')
    expect(pi).toMatchObject({ label: 'pi', value: 0, said: '0 of 1 landed' })
  })

  it('draws the judge’s precision per question, toned by what its verdicts say', () => {
    const judged = judgeOf(answer())
    expect(judged.state).toBe('read')
    expect(judged.questions?.[0]).toMatchObject({
      label: 'test_missing',
      said: '0 of 1, too few to call',
      tone: 'quiet',
    })
    expect(judged.bands?.map((band) => band.label)).toEqual(['0.9–1.0'])
  })

  it('says which nothing it is: not read yet, no judge here, or not granted', () => {
    expect(
      emptyOf(
        evaluationsFor(reach(EVERY), () => null),
        'harness',
      )?.kind,
    ).toBe('loading')
    expect(emptyOf(answer(EVERY, false), 'judge')?.title).toBe('No judge reads anything here')
    expect(emptyOf(answer(EVERY.filter((one) => one !== 'findings')), 'judge')?.title).toBe(
      'Not granted to this device',
    )
    expect(emptyOf(answer(), 'harness')).toBeNull()
  })
})
