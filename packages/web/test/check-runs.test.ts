import { describe, expect, it } from 'vitest'
import { SnapshotSchema } from '../src/protocol.ts'
import { checkTreesOf, snapshotOf, tracksOf } from '../src/snapshot.ts'
import { checkRun, checkTree, EVERY, input, NOW, project, reach } from './fixtures.ts'

// What ran in each tree, as a project row carries it: the history the checks
// page draws, and how long a check has answered what it answers now. **History,
// never a rollup** — what is red at the head is still `ChecksOut`'s to say, so
// nothing here is ever read as a pass of the commit in hand.

const at = (minute: number) => new Date(Date.parse('2026-10-08T09:00:00.000Z') + minute * 60_000)

describe('a project’s run records', () => {
  it('carry its checkout first and each worktree with runs of its own, and no empty one', () => {
    const snapshot = snapshotOf(input({ reach: reach(EVERY) }), NOW)
    SnapshotSchema.parse(snapshot)
    const sentry = snapshot.projects.find((one) => one.name === 'sentry')
    expect(sentry?.checks?.map((tree) => tree.task)).toEqual([null, 'sentry/away-projection'])
  })

  it('are null, never empty, for a project nothing has read and for a closed one', () => {
    const snapshot = snapshotOf(
      input({
        projects: [project(), project({ name: 'tade' }), project({ name: 'old', open: false })],
      }),
      NOW,
    )
    const by = new Map(snapshot.projects.map((one) => [one.name, one.checks]))
    // `tade` has no checkout record in the input: not looked, which is not nothing ran.
    expect(by.get('tade')).toBeNull()
    expect(by.get('old')).toBeNull()
    expect(
      snapshotOf(input({ checks: null }), NOW).projects.every((one) => one.checks === null),
    ).toBe(true)
  })

  it('is a checkout with no checks at all where its record holds no runs', () => {
    expect(checkTreesOf([checkTree({ runs: [] })], 'sentry', reach(EVERY))).toEqual([
      { task: null, checks: [] },
    ])
  })
})

describe('a check’s track', () => {
  const tracks = tracksOf(checkTree().runs, reach(EVERY))
  const of = (check: string) => tracks.find((one) => one.check === check)

  it('lists the checks in the order they first ran', () => {
    expect(tracks.map((one) => one.check)).toEqual(['format', 'tests', 'types'])
  })

  it('says each run as pass, fail or other, oldest first, with its time and length', () => {
    expect(of('tests')?.runs).toEqual([
      { at: at(1).toISOString(), state: 'pass', ms: 90_000 },
      { at: at(31).toISOString(), state: 'pass', ms: 90_000 },
      { at: at(60).toISOString(), state: 'fail', ms: 90_000 },
      { at: at(90).toISOString(), state: 'other', ms: null },
      // Timed out is a fail, as the rollup counts it.
      { at: at(120).toISOString(), state: 'fail', ms: 90_000 },
      { at: at(150).toISOString(), state: 'fail', ms: 90_000 },
    ])
  })

  it('is red since the first fail after the last pass, and a skipped run breaks no row', () => {
    expect(of('tests')?.streak).toEqual({
      state: 'fail',
      since: at(60).toISOString(),
      runs: 3,
      atLeast: false,
    })
  })

  it('says a row that reaches the oldest run kept began then or earlier', () => {
    expect(of('format')?.streak).toEqual({
      state: 'pass',
      since: at(0).toISOString(),
      runs: 2,
      atLeast: true,
    })
  })

  it('keeps a run with no time on the strip with no moment, and has no streak with no answer', () => {
    expect(of('types')).toEqual({
      check: 'types',
      required: true,
      runs: [{ at: null, state: 'pass', ms: null }],
      by: 'sentry/away-projection',
      streak: null,
    })
    const said = tracksOf(
      [checkRun({ state: 'skipped' }), checkRun({ state: 'cancelled' })],
      reach(EVERY),
    )
    expect(said[0]?.streak).toBeNull()
    expect(said[0]?.runs.map((one) => one.state)).toEqual(['other', 'other'])
  })

  it('carries every run the record keeps, the oldest first, and counts none as left out', () => {
    const many = Array.from({ length: 200 }, (_, n) =>
      checkRun({ minute: n, state: n < 2 ? 'passed' : 'failed' }),
    )
    const [track] = tracksOf(many, reach(EVERY))
    expect(track?.runs).toHaveLength(200)
    expect(track?.runs[0]?.at).toBe(at(0).toISOString())
    expect(track?.runs.at(-1)?.at).toBe(at(199).toISOString())
    expect(track).not.toHaveProperty('more')
    expect(track?.streak).toMatchObject({ state: 'fail', since: at(2).toISOString(), runs: 198 })
  })

  it('is required as its newest run says, and rounds a length to whole milliseconds', () => {
    const [track] = tracksOf(
      [checkRun({ required: true, ms: 10.4 }), checkRun({ minute: 1, required: false, ms: -3 })],
      reach(EVERY),
    )
    expect(track?.required).toBe(false)
    expect(track?.runs.map((one) => one.ms)).toEqual([10, 0])
  })
})

describe('who asked for a check’s newest run', () => {
  it('is said as the record says it, a task’s id or Tade’s own word', () => {
    const tracks = tracksOf(
      [checkRun({ by: 'sentry/fix' }), checkRun({ check: 'format', by: 'you' })],
      reach(EVERY),
    )
    expect(tracks.map((one) => one.by)).toEqual(['sentry/fix', 'you'])
    expect(tracksOf([checkRun({ by: null })], reach(EVERY))[0]?.by).toBeNull()
  })

  it('is left out where it names a task in a project this device may not read', () => {
    const narrow = reach(EVERY, ['sentry'])
    const [mine, theirs] = [
      tracksOf([checkRun({ by: 'sentry/fix' })], narrow)[0]?.by,
      tracksOf([checkRun({ by: 'secret/plan' })], narrow)[0]?.by,
    ]
    expect(mine).toBe('sentry/fix')
    expect(theirs).toBeNull()
  })
})
