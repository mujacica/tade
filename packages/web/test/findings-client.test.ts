import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ENOUGH,
  figureSaid,
  findingsPage,
  omittedSaid,
  precisionLine,
  precisionSaid,
  probabilityOf,
  readSaid,
  rowLine,
  tallyUnder,
  verdictAside,
  whoseOf,
} from '../src/assets/pages/findings-shape.js'
import type { FindingIn } from '../src/input.ts'
import { snapshotOf } from '../src/snapshot.ts'
import { EVERY, finding, input, NOW, reach } from './fixtures.ts'

// What the findings page draws, against **real projected rows** rather than
// shapes a test assembled: every whose-move, wait, order and figure goes
// through `snapshotOf`, so a field the projection renames is a red test here
// rather than a blank card on a phone. And the page's one rule of honesty, in
// each of its forms: **a probability is never a verdict** — it orders nothing,
// counts toward nothing, and a question's precision is out of verdicts alone.

const minutes = (n: number) => NOW - n * 60_000
const iso = (n: number) => new Date(minutes(n)).toISOString()

/** The rows a device granted everything is handed, for these findings. */
function rows(findings: FindingIn[]) {
  return snapshotOf(input({ reach: reach(EVERY), findings }), NOW).findings
}

/** The page over these findings, counted against the fixtures' own moment. */
const page = (findings: FindingIn[], known: (id: string) => boolean = () => true) =>
  findingsPage(rows(findings), NOW, known)

/** A finding the agent answered `answered` minutes ago and nobody has read. */
const yours = (key: string, answered: number, over: Partial<FindingIn> = {}) =>
  finding({
    key,
    at: minutes(answered + 30),
    account: { did: 'fixed', said: 'it was', at: iso(answered) },
    verdict: null,
    ...over,
  })

/** A finding the judge raised `raised` minutes ago that nobody has answered. */
const unanswered = (key: string, raised: number, over: Partial<FindingIn> = {}) =>
  finding({ key, at: minutes(raised), account: null, verdict: null, ...over })

/** A finding somebody wrote a verdict on `written` minutes ago. */
const read = (
  key: string,
  was: 'confirmed' | 'false positive',
  written: number,
  over: Partial<FindingIn> = {},
) =>
  finding({
    key,
    at: minutes(written + 60),
    account: { did: 'not real', said: 'no', at: iso(written + 30) },
    verdict: { was, at: iso(written) },
    ...over,
  })

describe('whose move a finding is', () => {
  it('is the agent’s until it answers, yours until a verdict, and then nobody’s', () => {
    const made = rows([
      unanswered('a', 10),
      yours('b', 10),
      read('c', 'confirmed', 10),
      read('d', 'false positive', 10),
    ])
    expect(made.map(whoseOf)).toEqual(['agent', 'yours', 'confirmed', 'wrong'])
  })

  it('counts each kind once, and the parts of the ring add up to every finding', () => {
    const made = page([
      unanswered('a', 10),
      yours('b', 10),
      yours('c', 20),
      read('d', 'confirmed', 10),
      read('e', 'false positive', 10),
    ])
    expect(made.counts).toEqual({ yours: 2, agent: 1, confirmed: 1, wrong: 1 })
    expect(made.parts.map((one) => [one.key, one.n, one.tone])).toEqual([
      ['yours', 2, 'wants'],
      ['agent', 1, 'working'],
      ['confirmed', 1, 'failed'],
      ['wrong', 1, 'done'],
    ])
    expect(made.parts.reduce((sum, one) => sum + one.n, 0)).toBe(made.total)
  })
})

describe('how long it has waited', () => {
  it('waits on you from when the agent answered, not from when the judge asked', () => {
    const [card] = page([yours('a', 25)]).groups[0]?.cards ?? []
    expect(card?.waited).toBe(25 * 60_000)
    expect(card?.waitedSaid).toBe('25m')
  })

  it('waits on the agent from the reading', () => {
    const [row] = page([unanswered('a', 90)]).agent
    expect(row?.waitedSaid).toBe('1h 30m')
  })

  it('is counted against the page’s clock, so a page that is not live does not count up', () => {
    const frozen = findingsPage(rows([yours('a', 25)]), minutes(15))
    expect(frozen.groups[0]?.cards[0]?.waitedSaid).toBe('10m')
  })

  it('says the oldest of each kind for the lead, and nothing for a kind with none', () => {
    const made = page([yours('a', 25), yours('b', 200), unanswered('c', 5)])
    expect(made.oldest).toEqual({ yours: '3h 20m', agent: '5m' })
    expect(tallyUnder(made, 'yours')).toBe('oldest 3h 20m')
    expect(tallyUnder(made, 'agent')).toBe('oldest 5m')
    expect(tallyUnder(made, 'confirmed')).toBe('')
    expect(tallyUnder(page([yours('a', 25)]), 'agent')).toBe('')
  })
})

describe('what waits on you, per project', () => {
  const made = () =>
    page([
      yours('s1', 30, { project: 'sentry' }),
      yours('t1', 300, { project: 'tade', tasks: ['tade/window'] }),
      yours('s2', 120, { project: 'sentry', probability: 0.99 }),
      yours('s3', 10, { project: 'sentry', probability: 0.01 }),
      unanswered('s4', 900, { project: 'sentry' }),
    ])

  it('is a group per project, the one whose oldest has waited longest first', () => {
    expect(made().groups.map((one) => [one.project, one.n, one.oldestSaid])).toEqual([
      ['tade', 1, '5h 0m'],
      ['sentry', 3, '2h 0m'],
    ])
  })

  it('orders each group by how long it has waited, never by the judge’s probability', () => {
    const sentry = made().groups.find((one) => one.project === 'sentry')
    expect(sentry?.cards.map((one) => [one.key, one.p])).toEqual([
      ['s2', '0.99'],
      ['s1', '0.47'],
      ['s3', '0.01'],
    ])
    // The same cards with the probabilities swapped come out in the same order.
    const swapped = page([
      yours('s1', 30, { project: 'sentry' }),
      yours('s2', 120, { project: 'sentry', probability: 0.01 }),
      yours('s3', 10, { project: 'sentry', probability: 0.99 }),
    ])
    expect(swapped.groups[0]?.cards.map((one) => one.key)).toEqual(['s2', 's1', 's3'])
  })

  it('leaves what waits on an agent out of it, in a list of its own', () => {
    const all = made()
    expect(all.groups.flatMap((one) => one.cards).some((one) => one.key === 's4')).toBe(false)
    expect(all.agent.map((one) => one.key)).toEqual(['s4'])
  })

  it('links the project, and the agent only while the store still has it', () => {
    const known = (id: string) => id === 'sentry/away-projection'
    const [tade, sentry] = page(
      [yours('s1', 30), yours('t1', 300, { project: 'tade', tasks: ['tade/window'] })],
      known,
    ).groups
    expect(tade?.href).toBe('/p/tade')
    expect(tade?.cards[0]?.href).toBeNull()
    expect(tade?.cards[0]?.name).toBe('window')
    expect(sentry?.cards[0]?.href).toBe('/t/sentry/away-projection')
  })

  it('carries the agent’s account as its own words, and what it says it did', () => {
    const [card] = page([finding()]).groups[0]?.cards ?? []
    expect(card?.did).toBe('not real')
    expect(card?.said?.words).toContain('nothing here builds a path')
    expect(card?.moved).toBe(false)
    const fixed = page([yours('a', 5, { stillThere: false })]).groups[0]?.cards[0]
    expect(fixed?.did).toBe('fixed it')
    expect(fixed?.moved).toBe(true)
  })

  it('says how many more tasks shared the change', () => {
    const [card] =
      page([yours('a', 5, { tasks: ['sentry/away-projection', 'sentry/pasted'] })]).groups[0]
        ?.cards ?? []
    expect([card?.name, card?.others]).toEqual(['away-projection', 1])
    expect(rowLine(card as never)).toBe(
      'sentry · away-projection +1 · packages/web/src/snapshot.ts',
    )
  })
})

describe('the judge’s probability', () => {
  it('is written to two places and drawn as a share of a hundred, never as a state', () => {
    expect(probabilityOf({ probability: 0.475 })).toEqual({ said: '0.47', share: 48 })
    expect(probabilityOf({ probability: 1 })).toEqual({ said: '1.00', share: 100 })
    expect(probabilityOf({ probability: Number.NaN })).toEqual({ said: '—', share: null })
  })
})

describe('what has its verdict', () => {
  it('is newest verdict first, and says which verdict and how long ago', () => {
    const made = page([read('old', 'confirmed', 300), read('new', 'false positive', 20)])
    expect(made.read.map((one) => one.key)).toEqual(['new', 'old'])
    expect(made.read.map(verdictAside)).toEqual(['false positive 20m ago', 'confirmed 5h 0m ago'])
  })

  it('is folded behind a press that says how many', () => {
    expect(readSaid(1, false)).toBe('Show 1 finding with a verdict')
    expect(readSaid(11, true)).toBe('Hide the 11 findings with a verdict')
  })
})

describe('each question’s precision', () => {
  it('holds the threshold equal to jev’s own', () => {
    const jev = readFileSync(
      new URL('../../extensions/jev/src/precision.ts', import.meta.url),
      'utf8',
    )
    expect(jev).toMatch(new RegExp(`export const ENOUGH = ${ENOUGH}\\b`))
  })

  it('is out of verdicts alone: what has none is counted as neither', () => {
    const made = page([
      read('a', 'confirmed', 10, { question: 'secrets' }),
      read('b', 'false positive', 10, { question: 'secrets' }),
      yours('c', 10, { question: 'secrets', probability: 0.99 }),
      unanswered('d', 10, { question: 'secrets', probability: 0.99 }),
    ])
    const [secrets] = made.questions
    expect(secrets).toMatchObject({ fired: 4, judged: 2, confirmed: 1, wrong: 1, open: 2 })
    expect(secrets?.precision).toBe(0.5)
    expect(secrets?.parts.map((one) => [one.key, one.n, one.tone])).toEqual([
      ['confirmed', 1, 'failed'],
      ['wrong', 1, 'done'],
      ['open', 2, 'unknown'],
    ])
  })

  it('is said as counts until there are enough verdicts, and as a rate from then', () => {
    expect([precisionSaid(2, 3), precisionLine(2, 3)]).toEqual(['2 of 3', 'confirmed'])
    expect([precisionSaid(3, ENOUGH), precisionLine(3, ENOUGH)]).toEqual([
      '60%',
      `3 of ${ENOUGH} confirmed`,
    ])
    const few = page([read('a', 'confirmed', 10), read('b', 'confirmed', 10)]).questions[0]
    expect([few?.figure, few?.enough]).toEqual(['2 of 2', false])
  })

  it('draws a question nobody has judged as unknown, never as nought', () => {
    const [none] = page([yours('a', 10), unanswered('b', 10)]).questions
    expect(none?.precision).toBeNull()
    expect([none?.figure, none?.under]).toEqual(['—', 'no verdict yet'])
  })

  it('puts the questions with something waiting on you first, then the ones that fired most', () => {
    const made = page([
      read('a', 'confirmed', 10, { question: 'loud' }),
      read('b', 'confirmed', 10, { question: 'loud' }),
      read('c', 'confirmed', 10, { question: 'loud' }),
      yours('d', 10, { question: 'waiting' }),
      read('e', 'confirmed', 10, { question: 'quiet' }),
    ])
    expect(made.questions.map((one) => [one.question, one.yours, one.fired])).toEqual([
      ['waiting', 1, 1],
      ['loud', 0, 3],
      ['quiet', 0, 1],
    ])
  })
})

describe('the words around it', () => {
  it('says in the bar how many want a verdict, in violet, and nothing before there is a page', () => {
    expect(figureSaid(null)).toEqual({ word: '', tone: null })
    expect(figureSaid(page([]))).toEqual({ word: '', tone: null })
    expect(figureSaid(page([yours('a', 5)]))).toEqual({
      word: '1 wants a verdict',
      tone: 't-wants',
    })
    expect(figureSaid(page([yours('a', 5), yours('b', 5)])).word).toBe('2 want a verdict')
    expect(figureSaid(page([unanswered('a', 5)]))).toEqual({
      word: 'nothing waits on you',
      tone: null,
    })
  })

  it('says what was not sent, and that every figure is of what was', () => {
    expect(omittedSaid(0, 100)).toBeNull()
    expect(omittedSaid(3, 100)).toBe(
      '3 more findings not sent to this device; every figure here is of the 100 it holds',
    )
  })

  it('crosses no finding to a device that was not granted them', () => {
    const made = snapshotOf(input({ reach: reach([]), findings: [finding()] }), NOW)
    expect(made.findings).toEqual([])
    expect(findingsPage(made.findings, NOW).total).toBe(0)
  })
})
