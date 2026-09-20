import { describe, expect, it } from 'vitest'
import type { TadeEvent } from '../src/events.ts'
import { statsFrom } from '../src/stats.ts'

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
