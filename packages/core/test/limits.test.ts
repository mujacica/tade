import { describe, expect, it } from 'vitest'
import {
  type PlanSource,
  planLabel,
  planStandings,
  resetsIn,
  tightestWindow,
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

describe('the one window worth a line', () => {
  it('is the fullest across every account that could say', () => {
    const tight = tightestWindow(
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
    expect(tight?.window.used).toBe(91)
  })

  it('prefers the one that comes back soonest when two are as full as each other', () => {
    const tight = tightestWindow(
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
    expect(tight?.window.label).toBe('5h')
  })

  it('is nothing at all when nobody could say', () => {
    expect(tightestWindow(planStandings([source({ said: null })], NOW))).toBeNull()
    expect(tightestWindow([])).toBeNull()
  })
})

describe('whose plan it is', () => {
  it('names the account only where there is one', () => {
    expect(planLabel({ harness: 'claude-code', account: null })).toBe('claude-code')
    expect(planLabel({ harness: 'codex', account: 'work' })).toBe('codex @work')
  })
})
