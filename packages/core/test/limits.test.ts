import { describe, expect, it } from 'vitest'
import {
  nextPlan,
  PLAN_TIGHT,
  PLAN_WARM,
  type PlanSource,
  planLabel,
  planPressure,
  planReport,
  planShown,
  planStandings,
  resetsIn,
  tightestPlan,
} from '../src/limits.ts'

// What a plan has left is the only figure that means anything on a
// subscription, and the only one that is dangerous to get wrong: a percentage
// that belongs to a window which has already started over looks exactly like
// one that is true.

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

const source = (over: Partial<PlanSource> = {}): PlanSource => ({
  harness: 'claude-code',
  account: null,
  can: 'while-working',
  pays: 'plan',
  why: 'says it while one of its agents replies',
  said: {
    at: NOW - 5 * 60_000,
    windows: [
      { label: '5h', used: 62, resetsAt: NOW + 2 * HOUR },
      { label: '7d', used: 18, resetsAt: NOW + 40 * HOUR },
    ],
  },
  ...over,
})

describe('how a plan stands', () => {
  it('keeps every window the harness reported, in the order it named them', () => {
    const [standing] = planStandings([source()], NOW)
    expect(standing?.cannotTell).toBeNull()
    expect(standing?.windows.map((one) => one.label)).toEqual(['5h', '7d'])
    expect(standing?.windows[0]?.used).toBe(62)
    expect(standing?.at).toBe(NOW - 5 * 60_000)
  })

  it('says a harness that cannot report one cannot, in its own words', () => {
    const [standing] = planStandings(
      [source({ harness: 'pi', can: 'none', why: 'prices every turn instead', said: null })],
      NOW,
    )
    expect(standing?.windows).toEqual([])
    expect(standing?.at).toBeNull()
    expect(standing?.cannotTell).toBe('prices every turn instead')
  })

  it('never reads nothing said yet as nothing used', () => {
    const [standing] = planStandings([source({ said: null })], NOW)
    expect(standing?.cannotTell).toBe('says it while one of its agents replies')
    expect(standing?.windows).toEqual([])
  })

  it('has something to say even for a harness with no sentence of its own', () => {
    const [none] = planStandings([source({ can: 'none', why: null, said: null })], NOW)
    const [quiet] = planStandings([source({ why: null, said: null })], NOW)
    expect(none?.cannotTell?.length ?? 0).toBeGreaterThan(10)
    expect(quiet?.cannotTell?.length ?? 0).toBeGreaterThan(10)
  })

  it('drops a window that has started over since the harness last said', () => {
    const [standing] = planStandings(
      [
        source({
          said: {
            at: NOW - 6 * HOUR,
            windows: [
              { label: '5h', used: 96, resetsAt: NOW - HOUR },
              { label: '7d', used: 40, resetsAt: NOW + 40 * HOUR },
            ],
          },
        }),
      ],
      NOW,
    )
    // 96% belonged to a window that is gone; what is used of the new one was
    // never reported, so it is not shown at all.
    expect(standing?.windows.map((one) => one.label)).toEqual(['7d'])
  })

  it('says nobody knows when every window it named has started over', () => {
    const [standing] = planStandings(
      [
        source({
          said: { at: NOW - 6 * HOUR, windows: [{ label: '5h', used: 96, resetsAt: NOW - HOUR }] },
        }),
      ],
      NOW,
    )
    expect(standing?.windows).toEqual([])
    expect(standing?.cannotTell).toContain('started over')
  })

  it('keeps a window the harness gave no reset for, since only it knows what it covers', () => {
    const [standing] = planStandings(
      [source({ said: { at: NOW, windows: [{ label: '5h', used: 12, resetsAt: 0 }] } })],
      NOW,
    )
    expect(standing?.windows).toHaveLength(1)
    expect(resetsIn({ label: '5h', used: 12, resetsAt: 0 }, NOW)).toBeNull()
  })

  it('throws away a figure that is not a number', () => {
    const [standing] = planStandings(
      [
        source({
          said: {
            at: NOW,
            windows: [
              { label: '5h', used: Number.NaN, resetsAt: NOW + HOUR },
              { label: '7d', used: -1, resetsAt: NOW + HOUR },
            ],
          },
        }),
      ],
      NOW,
    )
    expect(standing?.windows).toEqual([])
  })
})

describe('the one plan worth a line', () => {
  it('is the account with the fullest window across every one that could say', () => {
    const tight = tightestPlan(
      planStandings(
        [
          source(),
          source({
            harness: 'codex',
            account: 'work',
            said: {
              at: NOW,
              windows: [
                { label: '5h', used: 91, resetsAt: NOW + HOUR },
                { label: '7d', used: 70, resetsAt: NOW + 40 * HOUR },
              ],
            },
          }),
        ],
        NOW,
      ),
    )
    expect(tight?.harness).toBe('codex')
    expect(tight?.account).toBe('work')
    expect(tight?.tightest.used).toBe(91)
  })

  it('brings that account\u2019s other windows with it, in the order it named them', () => {
    const tight = tightestPlan(planStandings([source()], NOW))
    // One account's, never the fullest of each: a session window of one
    // sign-in beside the week of another is two answers to one question.
    expect(tight?.windows.map((one) => one.label)).toEqual(['5h', '7d'])
    expect(tight?.tightest.label).toBe('5h')
  })

  it('leaves out a window that has already started over', () => {
    const tight = tightestPlan(
      planStandings(
        [
          source({
            said: {
              at: NOW - HOUR,
              windows: [
                { label: '5h', used: 62, resetsAt: NOW - 60_000 },
                { label: '7d', used: 18, resetsAt: NOW + 40 * HOUR },
              ],
            },
          }),
        ],
        NOW,
      ),
    )
    expect(tight?.windows.map((one) => one.label)).toEqual(['7d'])
    expect(tight?.tightest.label).toBe('7d')
  })

  it('prefers the one that comes back soonest when two are as full as each other', () => {
    const tight = tightestPlan(
      planStandings(
        [
          source({
            said: {
              at: NOW,
              windows: [
                { label: '5h', used: 80, resetsAt: NOW + HOUR },
                { label: '7d', used: 80, resetsAt: NOW + 40 * HOUR },
              ],
            },
          }),
        ],
        NOW,
      ),
    )
    expect(tight?.tightest.label).toBe('5h')
  })

  it('is nothing at all when nobody could say', () => {
    expect(tightestPlan(planStandings([source({ said: null })], NOW))).toBeNull()
    expect(tightestPlan([])).toBeNull()
  })
})

describe('whose plan it is', () => {
  it('names the account only where there is one', () => {
    expect(planLabel({ harness: 'claude-code', account: null })).toBe('claude-code')
    expect(planLabel({ harness: 'codex', account: 'work' })).toBe('codex @work')
  })
})

describe('moving between the sign-ins', () => {
  /** Two harnesses that can say, one that cannot, and one whose window has gone. */
  const four = () => [
    source(),
    source({
      harness: 'codex',
      account: 'work',
      said: { at: NOW, windows: [{ label: '5h', used: 91, resetsAt: NOW + HOUR }] },
    }),
    source({
      account: 'reviews',
      said: { at: NOW - 6 * HOUR, windows: [{ label: '5h', used: 41, resetsAt: NOW - HOUR }] },
    }),
    source({ harness: 'pi', can: 'none', pays: 'per-token', why: 'prices every turn', said: null }),
  ]

  it('shows the tightest until somebody moves, since it is the one about to stop them', () => {
    const shown = planShown(planStandings(four(), NOW), null)
    expect(shown?.harness).toBe('codex')
    expect(shown?.tightest.used).toBe(91)
  })

  it('shows the sign-in somebody moved to, with its own windows', () => {
    const shown = planShown(planStandings(four(), NOW), { harness: 'claude-code', account: null })
    expect(shown?.harness).toBe('claude-code')
    expect(shown?.windows.map((one) => one.label)).toEqual(['5h', '7d'])
    expect(shown?.tightest.used).toBe(62)
  })

  it('falls back to the tightest where the one chosen has nothing true to say', () => {
    // Every window it named has started over, and a share belonging to a window
    // that is gone is the one thing worse than somebody else's figure.
    for (const chosen of [
      { harness: 'claude-code', account: 'reviews' },
      { harness: 'pi', account: null },
      { harness: 'nothing-like-it', account: null },
    ]) {
      expect(planShown(planStandings(four(), NOW), chosen)?.harness).toBe('codex')
    }
  })

  it('goes round the ones that can say, in the order they were gathered', () => {
    const standings = planStandings(four(), NOW)
    // From the tightest, which is where it starts.
    const first = nextPlan(standings, null)
    expect(first).toEqual({ harness: 'claude-code', account: null })
    const second = nextPlan(standings, first)
    expect(second).toEqual({ harness: 'codex', account: 'work' })
    // Two of them can say, so the third press is back where it began — and the
    // ones that cannot say are never stopped on.
    expect(nextPlan(standings, second)).toEqual(first)
  })

  it('has nowhere to go when fewer than two sign-ins can say anything', () => {
    expect(nextPlan(planStandings([source()], NOW), null)).toBeNull()
    expect(nextPlan(planStandings([source(), source({ said: null })], NOW), null)).toBeNull()
    expect(nextPlan([], null)).toBeNull()
  })
})

describe('how worrying a window is', () => {
  it('is one rule, so the strip, the page and what is said cannot disagree', () => {
    expect(planPressure(0)).toBe('fine')
    expect(planPressure(PLAN_WARM - 1)).toBe('fine')
    expect(planPressure(PLAN_WARM)).toBe('warm')
    expect(planPressure(PLAN_TIGHT - 1)).toBe('warm')
    expect(planPressure(PLAN_TIGHT)).toBe('tight')
    expect(planPressure(140)).toBe('tight')
  })
})

describe('where every sign-in stands', () => {
  /** Two accounts across two harnesses, one reporting nothing, and a window that has reset. */
  const logins = () => [
    source({
      said: { at: NOW - 10 * 60_000, windows: [{ label: '5h', used: 94, resetsAt: NOW + HOUR }] },
    }),
    source({
      harness: 'codex',
      account: 'work',
      said: { at: NOW, windows: [{ label: '5h', used: 30, resetsAt: NOW + 2 * HOUR }] },
    }),
    source({
      account: 'reviews',
      said: { at: NOW - 6 * HOUR, windows: [{ label: '5h', used: 41, resetsAt: NOW - HOUR }] },
    }),
    source({
      harness: 'pi',
      can: 'none',
      pays: 'per-token',
      why: 'prices every turn instead',
      said: null,
    }),
  ]

  it('reads every sign-in, whether or not it has anything to say', () => {
    const report = planReport(logins(), NOW)
    expect(report.signIns.map((one) => one.label)).toEqual([
      'claude-code',
      'codex @work',
      'claude-code @reviews',
      'pi',
    ])
  })

  it('says what is used, what is left and when it comes back', () => {
    const [first] = planReport(logins(), NOW).signIns
    expect(first?.windows).toEqual([
      { label: '5h', used: 94, left: 6, resetsIn: HOUR, pressure: 'tight' },
    ])
    expect(first?.saidAgo).toBe(10 * 60_000)
  })

  it('never turns a sign-in that could not say into one with nothing used', () => {
    const report = planReport(logins(), NOW)
    const quiet = report.signIns.filter((one) => one.pressure === null)
    // Neither is `fine`, which would read as a plan somebody had looked at, and
    // neither has a figure. Each says why, in its harness's own words.
    expect(quiet.map((one) => one.label)).toEqual(['claude-code @reviews', 'pi'])
    expect(quiet.map((one) => one.windows)).toEqual([[], []])
    expect(quiet[0]?.cannotTell).toContain('started over')
    expect(quiet[1]?.cannotTell).toBe('prices every turn instead')
    // And no number anywhere in it is money.
    expect(JSON.stringify(report)).not.toContain('usd')
  })

  it('names the ones at their limit, fullest first', () => {
    const report = planReport(
      [
        ...logins(),
        source({
          account: 'deploys',
          said: { at: NOW, windows: [{ label: '7d', used: 99, resetsAt: NOW + 40 * HOUR }] },
        }),
      ],
      NOW,
    )
    expect(report.pressed.map((one) => one.label)).toEqual(['claude-code @deploys', 'claude-code'])
  })

  it('offers what else there is, by what is known and never by a guess', () => {
    const report = planReport(logins(), NOW)
    // The one with room first — a figure somebody can act on — then the ones
    // nothing can be said about, a sign-in paid per token ahead of the rest of
    // them because one that is not on a plan has no window to fill. The one at
    // its limit is not offered as somewhere to go.
    expect(report.instead.map((one) => one.label)).toEqual([
      'codex @work',
      'pi',
      'claude-code @reviews',
    ])
    expect(report.instead.map((one) => one.pays)).toEqual(['plan', 'per-token', 'plan'])
  })

  it('has nothing pressed and nothing to offer when there are no sign-ins', () => {
    expect(planReport([], NOW)).toEqual({ signIns: [], pressed: [], instead: [] })
  })
})
