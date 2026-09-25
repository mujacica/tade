import { describe, expect, it } from 'vitest'
import { findingsOf, type OpenFinding, RUNGS, rungOf, sweepFindings, sweepOf } from '../src/loop.ts'
import { JEV_TABS, jevPage, readOf } from '../src/page.ts'
import { bandOf, ENOUGH, precisionOf, precisionSaid, worthOf } from '../src/precision.ts'
import { RUBRIC } from '../src/questions.ts'
import { type ReviewRecord, statusLine } from '../src/report.ts'
import type { Review } from '../src/reviews.ts'
import { standingsOf, stuckOf, stuckSays, stuckTally, type Whose } from '../src/stuck.ts'

// Measuring the rubric, and saying why nothing has closed.
//
// Three things are held here, and they are the three that were wrong:
//
//   · The page is about a **window**. It used to be about everything that had
//     ever been read, so the figure that mattered was the one that never moved.
//   · A rate is counted over findings, out of verdicts, and is not stated as a
//     percentage until enough verdicts are behind it. `0%` off one verdict is a
//     fact nobody has.
//   · A finding with no verdict is one of five different situations and every
//     one of them wants something different done. "Waiting on a verdict" is the
//     symptom; the page says the cause.

const DAY = 86_400_000
const NOW = Date.parse('2026-09-25T12:00:00Z')

/** One reading, as the record keeps it. */
function review(at: number, unit: string, over: Partial<Review> = {}): Review {
  return {
    at: new Date(at).toISOString(),
    project: 'shop',
    unit,
    tasks: [unit],
    base: 'main',
    head: 'head',
    version: 'jev-1.13.0',
    rubric: RUBRIC,
    files: 2,
    part: null,
    requests: 3,
    cost_usd: 0.002,
    answers: {},
    where: {},
    raised: [],
    account: {},
    verdict: {},
    ...over,
  }
}

function verdict(was: 'confirmed' | 'false positive', at: number) {
  return {
    was,
    by: 'orchestrator',
    said: 'read src/thing.ts and it is there',
    at: new Date(at).toISOString(),
    cited: 'src/thing.ts',
    rubric: RUBRIC,
  }
}

function account(did: 'fixed' | 'not real', at: number, by = 'shop/one') {
  return { did, by, said: 'covered already', at: new Date(at).toISOString(), rubric: RUBRIC }
}

function record(reviews: readonly Review[], over: Partial<ReviewRecord> = {}): ReviewRecord {
  return {
    reviews,
    looks: [],
    findings: [],
    finished: new Set<string>(),
    now: NOW,
    ...over,
  }
}

const nobody: Whose = { going: () => false, told: () => false }

describe('the page is about a window of time', () => {
  const reviews = [
    review(NOW - 2 * 3_600_000, 'shop/today', {
      answers: { test_missing: 0.9 },
      where: { test_missing: 'src/today.ts' },
      raised: ['test_missing'],
    }),
    review(NOW - 3 * DAY, 'shop/tuesday', {
      answers: { test_missing: 0.7 },
      where: { test_missing: 'src/tuesday.ts' },
      raised: ['test_missing'],
    }),
  ]

  it('counts what is inside it and nothing before it', () => {
    const today = readOf(record(reviews), { tab: 'overview', since: NOW - DAY }, nobody)
    expect(today.reviews).toHaveLength(1)
    expect(today.findings.map((one) => one.key)).toEqual(['shop/today:test_missing'])

    const week = readOf(record(reviews), { tab: 'overview', since: NOW - 7 * DAY }, nobody)
    expect(week.reviews).toHaveLength(2)
    expect(week.findings).toHaveLength(2)
  })

  it('reads a window with nothing in it as nothing, and says which window', () => {
    const said = jevPage(record(reviews), { tab: 'overview', since: NOW, window: 'today' }, nobody)
    expect(said).toContain('Nothing read today')
    const window = jevPage(
      record(reviews),
      { tab: 'overview', since: NOW, window: 'window' },
      nobody,
    )
    expect(window).toContain('Nothing read since this window opened')
  })

  it('folds an account written today onto a finding raised last week', () => {
    // The window applies to the *finding*, by when it was raised — a verdict
    // written this morning about Tuesday's reading belongs to Tuesday. Folding
    // findings over the window instead loses half of what was said about one,
    // and the page then reports an answered finding as unanswered.
    const answered = [
      ...reviews,
      review(NOW - 60_000, 'shop/tuesday', {
        verdict: { test_missing: verdict('confirmed', NOW) },
      }),
    ]
    const week = readOf(record(answered), { tab: 'overview', since: NOW - 7 * DAY }, nobody)
    const tuesday = week.findings.find((one) => one.unit === 'shop/tuesday')
    expect(tuesday?.verdict?.was).toBe('confirmed')
    const today = readOf(record(answered), { tab: 'overview', since: NOW - DAY }, nobody)
    expect(today.findings.map((one) => one.unit)).toEqual(['shop/today'])
  })

  it('offers every tab, and answers about one it has never heard of with the first', () => {
    expect(JEV_TABS[0]?.id).toBe('overview')
    const made = record(reviews)
    for (const tab of JEV_TABS) {
      expect(jevPage(made, { tab: tab.id, since: 0 }, nobody).length).toBeGreaterThan(0)
    }
  })
})

describe('precision, counted honestly', () => {
  /** One unit per finding, so each is its own key. */
  function fired(
    outcomes: readonly ('confirmed' | 'false positive' | 'open')[],
    question = 'test_missing',
    probability = 0.9,
  ): Review[] {
    return outcomes.map((was, at) =>
      review(NOW - at * 60_000, `shop/unit-${at}`, {
        answers: { [question]: probability },
        where: { [question]: 'src/thing.ts' },
        raised: [question],
        ...(was === 'open' ? {} : { verdict: { [question]: verdict(was, NOW) } }),
      }),
    )
  }

  const read = (reviews: readonly Review[]) =>
    precisionOf(findingsOf(reviews), reviews, { now: NOW, dayAt: (at) => at })

  it('counts a finding once however often the same question was raised about it', () => {
    // Two readings of one change, both raising the same question, are one
    // finding — one key, for ever. Counted per reading, a question raised on
    // twenty-one looks at one branch read as twenty-one mistakes.
    const twice = [
      review(NOW - 2 * 3_600_000, 'shop/one', {
        answers: { test_missing: 0.8 },
        raised: ['test_missing'],
      }),
      review(NOW - 3_600_000, 'shop/one', {
        answers: { test_missing: 0.9 },
        raised: ['test_missing'],
      }),
    ]
    expect(read(twice).total.fired).toBe(1)
  })

  it('never counts a finding nobody judged as either outcome', () => {
    const tally = read(fired(['confirmed', 'false positive', 'open', 'open'])).total
    expect(tally).toMatchObject({ fired: 4, judged: 2, confirmed: 1, wrong: 1, open: 2 })
    expect(tally.precision).toBeCloseTo(0.5)
  })

  it('says nothing has been judged rather than nought per cent', () => {
    const tally = read(fired(['open', 'open'])).total
    expect(tally.precision).toBeNull()
    expect(precisionSaid(tally)).toBe('none judged')
  })

  it(`states the counts under ${ENOUGH} verdicts and the rate at or over it`, () => {
    const few = read(fired(['confirmed', 'false positive', 'false positive'])).total
    expect(few.enough).toBe(false)
    expect(precisionSaid(few)).toBe('1 of 3, too few to call')

    const enough = read(
      fired(['confirmed', 'confirmed', 'confirmed', 'false positive', 'false positive']),
    ).total
    expect(enough.enough).toBe(true)
    expect(precisionSaid(enough)).toBe('3 of 5 · 60%')
  })

  it('calls a question wrong only once the verdicts say so, and never before', () => {
    const loud = read(fired(['false positive', 'false positive', 'false positive'])).total
    expect(worthOf(loud)).toBe('unproven')
    const proven = read(
      fired([
        'false positive',
        'false positive',
        'false positive',
        'false positive',
        'false positive',
      ]),
    ).total
    expect(worthOf(proven)).toBe('costs')
    expect(
      worthOf(
        read(fired(['confirmed', 'confirmed', 'confirmed', 'confirmed', 'false positive'])).total,
      ),
    ).toBe('earns')
  })

  it('puts a probability in the band it is in, on the band edge and at both ends', () => {
    expect(bandOf(0)).toBe(0)
    expect(bandOf(0.6)).toBe(6)
    expect(bandOf(0.69)).toBe(6)
    expect(bandOf(0.7)).toBe(7)
    expect(bandOf(1)).toBe(9)
  })

  it('splits by question and by band, and keeps the highest it ever fired at', () => {
    const reviews = [
      ...fired(['confirmed', 'false positive'], 'test_missing', 0.88),
      review(NOW - 10 * 60_000, 'shop/other', {
        answers: { did_what_was_asked: 0.62 },
        raised: ['did_what_was_asked'],
        verdict: { did_what_was_asked: verdict('false positive', NOW) },
      }),
    ]
    const found = read(reviews)
    const missing = found.byQuestion.find((row) => row.question === 'test_missing')
    expect(missing?.tally).toMatchObject({ fired: 2, judged: 2, confirmed: 1 })
    expect(missing?.highest).toBeCloseTo(0.88)
    expect(found.byBand[8]?.tally.fired).toBe(2)
    expect(found.byBand[6]?.tally).toMatchObject({ fired: 1, wrong: 1 })
    // Loudest first, so a question that fired once is not at the top of a page
    // about which of them are worth keeping.
    expect(found.byQuestion[0]?.question).toBe('test_missing')
  })

  it('counts a day by when the finding was raised, and the cost with it', () => {
    const found = precisionOf(
      findingsOf(fired(['confirmed'])),
      fired(['confirmed']),
      // One bucket per hour, so the test says nothing about a local midnight.
      { now: NOW, dayAt: (at) => at - (at % 3_600_000) },
    )
    expect(found.byDay).toHaveLength(1)
    expect(found.byDay[0]).toMatchObject({ read: 1, usd: 0.002 })
    expect(found.byDay[0]?.tally.confirmed).toBe(1)
  })
})

describe('a finding says why it has not closed', () => {
  const one = (over: Partial<OpenFinding> = {}): OpenFinding => ({
    key: 'shop/one:test_missing',
    unit: 'shop/one',
    question: 'test_missing',
    project: 'shop',
    tasks: ['shop/one'],
    at: NOW - 2 * DAY,
    probability: 0.9,
    file: 'src/thing.ts',
    rubric: RUBRIC,
    stillThere: true,
    account: null,
    verdict: null,
    ...over,
  })

  const asked: Whose = { going: () => false, told: () => true }
  const working: Whose = { going: () => true, told: () => false }

  it('is answered once somebody wrote a verdict, and only then', () => {
    expect(stuckOf(one({ verdict: verdict('confirmed', NOW) }), nobody)).toBe('answered')
    // An account is not an answer. An agent marking its own work a false
    // positive is the defendant grading the exam, so this stays open.
    expect(stuckOf(one({ account: account('not real', NOW) }), nobody)).not.toBe('answered')
  })

  it('tells an agent still working from one that is gone', () => {
    expect(stuckOf(one(), working)).toBe('agent-working')
    expect(stuckOf(one(), nobody)).toBe('agent-gone')
  })

  it('says a change nobody in particular wrote is nobody’s to account for', () => {
    // Read as a whole branch: twelve agents' commits under one key, against
    // twelve intents joined together. No one agent can account for the answer,
    // and one of the twelve still typing used to keep it out of every bucket.
    const branch = one({
      key: 'shop:main:test_missing',
      unit: 'shop:main',
      tasks: ['shop/one', 'shop/two'],
    })
    expect(stuckOf(branch, nobody)).toBe('shared-change')
    expect(stuckOf(one({ tasks: [] }), nobody)).toBe('nobody-to-ask')
  })

  it('tells an account nobody has been asked about from one somebody has', () => {
    const answered = one({ account: account('fixed', NOW - DAY) })
    expect(stuckOf(answered, { ...nobody, told: () => false })).toBe('waiting-to-be-told')
    expect(stuckOf(answered, asked)).toBe('told-not-judged')
  })

  it('says how many are stuck each way, and the reason where they share one', () => {
    const standings = standingsOf(
      [one(), one({ key: 'shop/two:test_missing', unit: 'shop/two', tasks: ['shop/two'] })],
      nobody,
      NOW,
    )
    expect(stuckTally(standings)).toEqual([{ stuck: 'agent-gone', count: 2 }])
    const says = stuckSays(standings) ?? ''
    expect(says).toContain('2 findings with no verdict')
    expect(says).toContain('2d')
    expect(says).toContain('its agent is gone')
  })

  it('says how many, not a reason, where the open ones disagree about why', () => {
    const standings = standingsOf(
      [one(), one({ key: 'shop/two:test_missing', unit: 'shop/two', tasks: ['shop/two'] })],
      { going: (task) => task === 'shop/two', told: () => false },
      NOW,
    )
    const says = stuckSays(standings) ?? ''
    expect(says).toContain('2 findings with no verdict')
    expect(says).not.toContain('gone')
  })

  it('draws the reason on the page beside the finding', () => {
    const reviews = [
      review(NOW - 2 * DAY, 'shop:main', {
        tasks: ['shop/one', 'shop/two'],
        answers: { did_what_was_asked: 0.9 },
        where: { did_what_was_asked: 'AGENTS.md' },
        raised: ['did_what_was_asked'],
      }),
    ]
    const said = jevPage(record(reviews), { tab: 'findings', since: 0 }, nobody)
    expect(said).toContain('shop:main:did_what_was_asked')
    expect(said).toContain('whole branch')
    expect(said).toContain('every agent in it is gone')
    // And the rule it must never break: nothing ages into an answer.
    expect(said).toContain('Nothing here becomes a false positive by getting old')
  })
})

describe('what the strip says about a look that failed', () => {
  // Purple text saying "a look failed" with nothing to press was the report, and
  // the reason there was nothing to press is that there was nothing to dismiss:
  // the line was counting every failed look in seven days, so one bad hour on
  // Tuesday warned until Tuesday week about a watch that had been looking
  // happily ever since.
  const look = (ago: number, problem: string | null) => ({
    at: NOW - ago,
    found: 0,
    fresh: 0,
    left: 0,
    problem,
  })

  it('says the last look’s trouble, and stops the moment a look works', () => {
    const failing = statusLine(record([], { looks: [look(60_000, 'TypeSafe answered 400')] }))
    expect(failing.text).toContain('TypeSafe answered 400')
    // `looks` is newest first, as the journal hands it over.
    const healed = statusLine(
      record([], { looks: [look(60_000, null), look(3_600_000, 'TypeSafe answered 400')] }),
    )
    expect(healed.text).not.toContain('400')
    expect(healed.text).toBe('0 read · 0 flagged')
  })

  it('says the front of a sentence rather than a provider’s JSON', () => {
    const said = statusLine(
      record([], {
        looks: [
          look(
            60_000,
            'TypeSafe answered 400: the state was longer than one ask takes: read it in pieces, or give it fewer files at a time',
          ),
        ],
      }),
    ).text
    expect(said).toContain('TypeSafe answered 400')
    expect(said).not.toContain('read it in pieces')
    expect(said.length).toBeLessThan(80)
  })

  it('counts today, not a week, so the figure it shows can go down', () => {
    const reviews = [
      review(NOW - 3 * DAY, 'shop/tuesday', {
        answers: { test_missing: 0.9 },
        raised: ['test_missing'],
      }),
    ]
    expect(statusLine(record(reviews)).text).toBe('0 read · 0 flagged')
  })
})

describe('the sweep asks again rather than going quiet', () => {
  const one = (at: number, over: Partial<OpenFinding> = {}): OpenFinding => ({
    key: `shop/one:test_missing`,
    unit: 'shop/one',
    question: 'test_missing',
    project: 'shop',
    tasks: ['shop/one'],
    at,
    probability: 0.9,
    file: 'src/thing.ts',
    rubric: RUBRIC,
    stillThere: true,
    account: null,
    verdict: null,
    ...over,
  })

  it('puts a wait on the rung it has passed, and on no more rungs than there are', () => {
    expect(rungOf(0)).toBe('')
    expect(rungOf(23 * 3_600_000)).toBe('')
    expect(rungOf(DAY)).toBe('1d')
    expect(rungOf(4 * DAY)).toBe('3d')
    expect(rungOf(40 * DAY)).toBe('7d')
    expect(new Set(RUNGS.map((rung) => rung.said)).size).toBe(RUNGS.length)
  })

  it('keeps the first rung’s key, so turning the ladder on re-asks nothing', () => {
    const fresh = sweepOf([one(NOW - 3_600_000, { account: account('fixed', NOW - 60_000) })], {
      now: NOW,
      after: 0,
      gone: () => false,
    })
    expect(sweepFindings(fresh, NOW).map((found) => found.key)).toEqual([
      'shop/one:test_missing#accounted',
    ])
  })

  it('is news again once a wait passes a rung', () => {
    const old = sweepOf([one(NOW - 5 * DAY, { account: account('fixed', NOW - 5 * DAY) })], {
      now: NOW,
      after: 0,
      gone: () => false,
    })
    expect(sweepFindings(old, NOW).map((found) => found.key)).toEqual([
      'shop/one:test_missing#accounted@3d',
    ])
  })

  it('asks about a change nobody in particular wrote, whoever is still at work', () => {
    // The hole this closes: `orphaned` asks whether *every* task in the unit is
    // gone, so one of twelve agents still typing kept a finding raised about a
    // whole branch out of both buckets — and out of everybody's sight for good.
    const branch = one(NOW - 2 * DAY, { unit: 'shop:main', tasks: ['shop/one', 'shop/two'] })
    const swept = sweepOf([branch], {
      now: NOW,
      after: 3_600_000,
      gone: () => false,
      owned: (finding) => finding.tasks.length === 1 && finding.tasks[0] === finding.unit,
    })
    expect(swept.unowned).toHaveLength(1)
    expect(swept.orphaned).toHaveLength(0)
    const found = sweepFindings(swept, NOW)
    expect(found[0]?.key).toBe('shop/one:test_missing#unowned@1d')
    expect(found[0]?.title).toContain("nobody's in particular")
  })

  it('never sweeps a finding out from under the agent it was raised about', () => {
    const fresh = sweepOf([one(NOW - 60_000)], { now: NOW, after: 3_600_000, gone: () => true })
    expect(fresh.orphaned).toHaveLength(0)
    expect(fresh.unresolved).toHaveLength(1)
  })

  it('offers nothing at all about a finding somebody has answered', () => {
    const judged = sweepOf([one(NOW - 5 * DAY, { verdict: verdict('confirmed', NOW) })], {
      now: NOW,
      after: 0,
      gone: () => true,
    })
    expect(judged.unresolved).toHaveLength(0)
    expect(sweepFindings(judged, NOW)).toEqual([])
  })
})
