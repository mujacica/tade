import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { sinceLastLook, statsFrom } from '../src/stats.ts'

// What the agents produced, read back out of the journal. Pure: events in, an
// account out, and the same events always give the same answer.

const event = (over: Partial<TadeEvent>): TadeEvent => ({
  seq: 1,
  ts: '2026-09-20T09:00:00.000Z',
  type: 'commit_seen',
  urgency: 'routine',
  task: null,
  lane: null,
  run: null,
  detail: {},
  ...over,
})

const commit = (over: Record<string, unknown>, ts?: string): TadeEvent =>
  event({
    type: 'commit_seen',
    ...(ts ? { ts } : {}),
    detail: { project: 'shop', attributed: true, added: 10, removed: 2, files: 1, ...over },
  })

describe('statsFrom', () => {
  it('answers nothing for a journal with nothing in it', () => {
    expect(statsFrom([])).toEqual({
      produced: { commits: 0, attributed: 0, added: 0, removed: 0, files: 0 },
      byProject: {},
      checks: [],
    })
  })

  it('adds the same numbers to the total and to the project, so they cannot disagree', () => {
    const report = statsFrom([commit({}), commit({ added: 5, removed: 1 })])
    expect(report.produced).toEqual({
      commits: 2,
      attributed: 2,
      added: 15,
      removed: 3,
      files: 2,
    })
    expect(report.byProject.shop).toEqual(report.produced)
  })

  it('counts a commit that belongs to nobody, and says how many there were', () => {
    const report = statsFrom([commit({}), commit({ attributed: false })])
    expect(report.produced.commits).toBe(2)
    expect(report.produced.attributed).toBe(1)
  })

  it('leaves out what happened before the window', () => {
    const report = statsFrom([commit({}, '2026-09-01T09:00:00.000Z'), commit({})], {
      since: Date.parse('2026-09-20T00:00:00.000Z'),
    })
    expect(report.produced.commits).toBe(1)
  })

  it('tallies each check, busiest first, and calls a timeout a failure', () => {
    const ran = (check: string, state: string, ms?: number) =>
      event({ type: 'check_ran', detail: { check, state, ...(ms === undefined ? {} : { ms }) } })
    const report = statsFrom([
      ran('types', 'passed', 1_000),
      ran('types', 'failed', 3_000),
      ran('types', 'timed out', 9_000),
      ran('format', 'passed', 200),
    ])
    expect(report.checks.map((one) => one.check)).toEqual(['types', 'format'])
    // A check that never finished is a check that did not pass.
    expect(report.checks[0]).toMatchObject({ runs: 3, passed: 1, failed: 2, other: 0 })
    // The middle of what was recorded, not the mean: one run that hung for
    // twenty minutes must not become "how long the suite takes".
    expect(report.checks[0]?.medianMs).toBe(3_000)
  })

  it('says nothing about how long a check takes when nothing was timed', () => {
    const report = statsFrom([
      event({ type: 'check_ran', detail: { check: 'e2e', state: 'skipped' } }),
    ])
    expect(report.checks[0]).toMatchObject({ runs: 1, other: 1, medianMs: null })
  })
})

describe('when something happened', () => {
  it('windows a commit by when it landed, not by when Tade noticed', () => {
    // A window that opens on Tuesday and catches up Monday's work writes those
    // events on Tuesday. Windowing them by the writing would put Monday's
    // commits in Tuesday's total, and every figure on the page with them.
    const monday = Date.parse('2026-09-19T15:00:00.000Z')
    const noticed = [
      commit({ sha: 'a', added: 4, at: monday }, '2026-09-20T09:00:00.000Z'),
      commit({ sha: 'b', added: 7 }, '2026-09-20T09:00:00.000Z'),
    ]
    const today = statsFrom(noticed, { since: Date.parse('2026-09-20T00:00:00.000Z') })
    expect(today.produced.commits).toBe(1)
    expect(today.produced.added).toBe(7)
    // And asked about Monday, it is Monday's.
    const both = statsFrom(noticed, { since: monday })
    expect(both.produced.commits).toBe(2)
  })
})

// Where a look at a project's commits starts, which is the whole of why the
// page said "nothing committed in this window" on a day full of commits.
describe('sinceLastLook', () => {
  const opened = (ts: string) => event({ type: 'tade_opened', ts })

  it('starts where the last commit it wrote down left off', () => {
    const written = [
      commit({ sha: 'a' }, '2026-09-20T09:00:00.000Z'),
      commit({ sha: 'b' }, '2026-09-20T11:00:00.000Z'),
    ]
    expect(sinceLastLook(written, [])).toBe(Date.parse('2026-09-20T11:00:00.000Z'))
  })

  it('starts at the window before this one when it has written down nothing', () => {
    // Tade appends `tade_opened` moments before it looks, so the newest one is
    // always "just now" — a floor taken from it lets nothing through, ever,
    // and everything committed while Tade was shut is lost for good.
    const opens = [opened('2026-09-19T08:00:00.000Z'), opened('2026-09-20T08:00:00.000Z')]
    expect(sinceLastLook([], opens)).toBe(Date.parse('2026-09-19T08:00:00.000Z'))
  })

  it('reads the opens in time order, however they arrive', () => {
    const opens = [opened('2026-09-20T08:00:00.000Z'), opened('2026-09-19T08:00:00.000Z')]
    expect(sinceLastLook([], opens)).toBe(Date.parse('2026-09-19T08:00:00.000Z'))
  })

  it('starts at this window on a first open, and counts nothing behind it', () => {
    // A project's first open must not dump years of somebody else's history
    // into today: a chart that spikes on the day you installed something is a
    // chart nobody trusts again.
    const first = opened('2026-09-20T08:00:00.000Z')
    expect(sinceLastLook([], [first])).toBe(Date.parse('2026-09-20T08:00:00.000Z'))
    expect(sinceLastLook([], [])).toBe(0)
  })
})
