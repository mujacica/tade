import { type RacerFacts, racesIn, wonFrom } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { emptyOf, racesOf } from '../src/assets/pages/evaluations-shape.js'
import { evaluationsFor } from '../src/evaluations.ts'

// The races on the away view's Evaluations page, against a real answer: the
// machine's fold through `evaluationsFor`, per device. What was asked is
// `intent`'s, the money `spend`'s, and the judge's part `findings`' — taken out
// *before* the order, so a device without it is not shown an order made of it.

const racer = (task: string, over: Partial<RacerFacts> = {}): RacerFacts => ({
  task: `shop/${task}`,
  race: 'dark',
  project: 'shop',
  said: 'add a dark mode',
  harness: 'pi',
  model: null,
  created: '2026-10-16T09:00:00.000Z',
  state: 'review',
  finished: true,
  checks: 'pass',
  failed: [],
  findings: { open: 0, answered: 0, confirmed: 0, dismissed: 0 },
  strayed: false,
  size: { commits: 1, added: 10, removed: 0 },
  usd: 0.5,
  ...over,
})

// The bigger change kept to what was asked; the smaller one strayed.
const entrants = [
  racer('dark-1', {
    harness: 'codex',
    model: 'gpt-5-codex',
    size: { commits: 2, added: 90, removed: 3 },
  }),
  racer('dark-2', { strayed: true, usd: null }),
]
const races = () => racesIn(entrants)

describe('the races, as a device reads them', () => {
  it('carries every figure, in the order the facts put them', () => {
    const [race] = evaluationsFor(undefined, races).races
    expect(race?.said).toBe('add a dark mode')
    expect(race?.spent).toBe('≥ $0.50 so far')
    expect(race?.racers.map((one) => [one.task, one.place, one.usd])).toEqual([
      ['shop/dark-1', 1, '$0.50'],
      ['shop/dark-2', 2, '—'],
    ])
    expect(race?.racers[0]?.runsOn).toBe('codex · gpt-5-codex')
    expect(race?.racers[1]?.says).toContain('strayed from what was asked')
  })

  it('is drawn in the machine’s words, picked or not', () => {
    const won = wonFrom([
      {
        seq: 1,
        ts: '2026-10-16T10:00:00.000Z',
        type: 'race_won',
        task: 'shop/dark-1',
        lane: null,
        run: null,
        urgency: 'notable',
        detail: { race: 'dark', project: 'shop', by: 'orchestrator', why: 'kept to the ask' },
      },
    ])
    const answer = evaluationsFor(undefined, () => racesIn(entrants, won))
    const [race] = racesOf(answer)
    expect(race?.head).toBe('dark in shop')
    expect(race?.said).toBe('asked: add a dark mode')
    expect(race?.spent).toBe('≥ $0.50 so far')
    expect(race?.decided).toBe('dark-1 picked by the orchestrator, on your word')
    expect(race?.entrants.map((one) => [one.mark, one.name, one.tone])).toEqual([
      ['✓', 'dark-1', 'done'],
      ['·', 'dark-2', 'quiet'],
    ])
    expect(race?.entrants[1]?.under).toMatch(/closed, branch kept$/)
    expect(emptyOf(answer, 'races')).toBeNull()
    expect(
      emptyOf(
        evaluationsFor(undefined, () => []),
        'races',
      )?.title,
    ).toBe('No race yet')
  })
})
