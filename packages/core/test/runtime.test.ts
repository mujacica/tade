import { describe, expect, it } from 'vitest'
import type { ReadableEventType, TadeEvent } from '../src/events.ts'
import { duration, noRuntime, runtimeFrom } from '../src/runtime.ts'
import { startOfToday } from '../src/spend.ts'

// Runtime is a query, like every other status: the journal says when an agent
// started and when it ended, and the clock says the rest. Nothing keeps a
// stopwatch, so the only way this can be wrong is by reading the journal
// wrong — which is what these are for.

const NOW = Date.parse('2026-09-13T12:00:00.000Z')
const MINUTE = 60_000

let seq = 0
const at = (minutes: number) => new Date(NOW - minutes * MINUTE).toISOString()

const event = (
  // Old names included: a journal from before the rename is read, not refused.
  type: ReadableEventType,
  over: Partial<TadeEvent> & { detail?: Record<string, unknown> } = {},
): TadeEvent =>
  ({
    seq: ++seq,
    ts: at(0),
    type,
    urgency: 'notable',
    task: 'checkout/refunds',
    lane: null,
    run: 'checkout/refunds/agent',
    ...over,
    detail: { ...over.detail },
  }) as TadeEvent

const started = (minutesAgo: number, over: Partial<TadeEvent> = {}) =>
  event('run_started', { ts: at(minutesAgo), detail: { model: 'claude-opus-5' }, ...over })
const exited = (minutesAgo: number, over: Partial<TadeEvent> = {}) =>
  event('run_exited', { ts: at(minutesAgo), ...over })

describe('runtimeFrom', () => {
  it('has run for no time when nothing has run', () => {
    expect(runtimeFrom([], { now: NOW }).total).toEqual(noRuntime())
  })

  it('times a run from its start to its exit', () => {
    const report = runtimeFrom([started(30), exited(10)], { now: NOW })
    expect(report.total.ms).toBe(20 * MINUTE)
    expect(report.total.runs).toBe(1)
    expect(report.total.running).toBe(false)
    expect(report.byTask['checkout/refunds']?.ms).toBe(20 * MINUTE)
  })

  it('counts an agent that is still going up to now', () => {
    const report = runtimeFrom([started(15)], { now: NOW })
    expect(report.total.ms).toBe(15 * MINUTE)
    expect(report.total.running).toBe(true)
    expect(report.byTask['checkout/refunds']?.running).toBe(true)
  })

  it('adds the runs of one task together', () => {
    const report = runtimeFrom(
      [
        started(60),
        exited(50),
        started(20, { run: 'checkout/refunds/agent#2' }),
        exited(5, { run: 'checkout/refunds/agent#2' }),
      ],
      { now: NOW },
    )
    expect(report.byTask['checkout/refunds']?.ms).toBe(25 * MINUTE)
    expect(report.byTask['checkout/refunds']?.runs).toBe(2)
  })

  it('adds up across agents, so two at once count as two', () => {
    // Overlapping on purpose: the question is how much agent time was spent,
    // not how long the wall clock moved.
    const other = { task: 'search/pagination', run: 'search/pagination/agent' }
    const report = runtimeFrom([started(30), started(30, other), exited(0), exited(0, other)], {
      now: NOW,
    })
    expect(report.total.ms).toBe(60 * MINUTE)
    expect(report.byProject.checkout?.ms).toBe(30 * MINUTE)
    expect(report.byProject.search?.ms).toBe(30 * MINUTE)
  })

  it('attributes the time to what the run said it ran on', () => {
    const report = runtimeFrom(
      [
        started(30),
        exited(20),
        started(10, { run: 'r2', detail: { model: 'deepseek-v3' } }),
        exited(5, { run: 'r2' }),
      ],
      { now: NOW },
    )
    expect(report.byModel['claude-opus-5']?.ms).toBe(10 * MINUTE)
    expect(report.byModel['deepseek-v3']?.ms).toBe(5 * MINUTE)
  })

  it('counts a run with no recorded model as unknown rather than dropping it', () => {
    const report = runtimeFrom([event('run_started', { ts: at(10) }), exited(0)], { now: NOW })
    expect(report.byModel.unknown?.ms).toBe(10 * MINUTE)
  })

  it('counts only the part of a run inside the window', () => {
    // Started before midnight, still going: today's share is today's.
    const report = runtimeFrom([started(24 * 60)], {
      since: startOfToday(NOW),
      now: NOW,
    })
    expect(report.total.ms).toBe(NOW - startOfToday(NOW))
  })

  it('leaves out a run that ended before the window', () => {
    const report = runtimeFrom([started(120), exited(90)], { since: NOW - 60 * MINUTE, now: NOW })
    expect(report.total).toEqual(noRuntime())
  })

  it('ends a run at the window closing, never across the night', () => {
    // Nobody wrote an exit — Tade was closed while it worked. Counting to now
    // would add every hour Tade was shut to the agent's day.
    const report = runtimeFrom(
      [started(300), event('tade_closing', { ts: at(240), task: null, run: null })],
      { now: NOW },
    )
    expect(report.total.ms).toBe(60 * MINUTE)
    expect(report.total.running).toBe(false)
  })

  it('ends a run that outlived a crash at the next opening', () => {
    // No closing at all, so the next window opening is the evidence: whatever
    // was running then is relaunched, and writes its own start.
    const report = runtimeFrom(
      [
        started(300),
        event('tade_opened', { ts: at(120), task: null, run: null }),
        started(60, { run: 'checkout/refunds/agent#2' }),
      ],
      { now: NOW },
    )
    expect(report.total.ms).toBe(180 * MINUTE + 60 * MINUTE)
    expect(report.total.runs).toBe(2)
    expect(report.total.running).toBe(true)
  })

  it('ends a run at a window boundary written under its old name', () => {
    // Before the project was renamed the window wrote `wilco_closing`. The
    // journal is append-only, so those lines are still there and still mean a
    // window closed: not reading them left runs from September counting to
    // now, and a morning's work read as `7d 13h`.
    const report = runtimeFrom(
      [started(300), event('wilco_closing', { ts: at(240), task: null, run: null })],
      { now: NOW },
    )
    expect(report.total.ms).toBe(60 * MINUTE)
    expect(report.total.running).toBe(false)
  })

  it('ends a run at an opening written under its old name', () => {
    const report = runtimeFrom(
      [started(300), event('wilco_opened', { ts: at(120), task: null, run: null })],
      { now: NOW },
    )
    expect(report.total.ms).toBe(180 * MINUTE)
    expect(report.total.running).toBe(false)
  })

  it('reads a whole journal of old names as the window it was', () => {
    // The shape the real journal has: runs relaunched at every opening, and
    // never an exit written for them. Asked about the last hour, only the run
    // of the last hour is in it — not five days of runs still open.
    const day = 24 * 60
    const journal: TadeEvent[] = [
      started(3 * day, { run: 'wilco/agent-1/agent', task: 'wilco/agent-1' }),
      event('wilco_closing', { ts: at(3 * day - 30), task: null, run: null }),
      event('wilco_opened', { ts: at(2 * day), task: null, run: null }),
      started(2 * day, { run: 'wilco/agent-1/agent', task: 'wilco/agent-1' }),
      event('wilco_closing', { ts: at(2 * day - 45), task: null, run: null }),
      event('tade_opened', { ts: at(30), task: null, run: null }),
      started(30, { run: 'tade/agent-1/agent', task: 'tade/agent-1' }),
    ]
    const report = runtimeFrom(journal, { since: NOW - 60 * MINUTE, now: NOW })
    expect(report.total.ms).toBe(30 * MINUTE)
    expect(report.byTask['wilco/agent-1']).toBeUndefined()
  })

  it('ends a run whose lane exited, with no exit of its own written', () => {
    // An agent is the process in its lane: a lane that has gone cannot still
    // be running, and the journal has far more lane exits than run exits.
    const report = runtimeFrom(
      [
        started(60),
        event('lane_exited', { ts: at(20), lane: 'checkout/refunds/agent', run: null }),
      ],
      { now: NOW },
    )
    expect(report.total.ms).toBe(40 * MINUTE)
    expect(report.total.running).toBe(false)
  })

  it('ends a run by the lane its start named, not by its run id', () => {
    const report = runtimeFrom(
      [
        started(60, { run: 'r_1a2b', lane: 'checkout/refunds/agent' }),
        event('lane_exited', { ts: at(20), lane: 'checkout/refunds/agent', run: null }),
      ],
      { now: NOW },
    )
    expect(report.total.ms).toBe(40 * MINUTE)
  })

  it('never shortens a run because another lane of its task went', () => {
    // A task can have a terminal open beside its agent. That one closing says
    // nothing at all about the agent, which is still working.
    const report = runtimeFrom(
      [started(60), event('lane_exited', { ts: at(20), lane: 'checkout/refunds/1', run: null })],
      { now: NOW },
    )
    expect(report.total.ms).toBe(60 * MINUTE)
    expect(report.total.running).toBe(true)
  })

  it('never shortens a run by a lane that exited before it started', () => {
    // The relaunch order in the journal: the old lane goes, the window opens,
    // the run starts again. The new run is not ended by the old lane's exit.
    const report = runtimeFrom(
      [
        event('lane_exited', { ts: at(70), lane: 'checkout/refunds/agent', run: null }),
        event('tade_opened', { ts: at(69), task: null, run: null }),
        started(68),
      ],
      { now: NOW },
    )
    expect(report.total.ms).toBe(68 * MINUTE)
    expect(report.total.running).toBe(true)
  })

  it('stops counting a run left open longer than a day', () => {
    // Nothing ended it and no boundary followed it: past a day the likelier
    // story is a boundary we could not read than an agent working since
    // yesterday, and a run that counts for ever eats the whole total.
    const report = runtimeFrom([started(5 * 24 * 60)], { now: NOW })
    expect(report.total.ms).toBe(24 * 60 * MINUTE)
    expect(report.total.running).toBe(false)
  })

  it('leaves a run open for its first day alone', () => {
    const report = runtimeFrom([started(23 * 60)], { now: NOW })
    expect(report.total.ms).toBe(23 * 60 * MINUTE)
    expect(report.total.running).toBe(true)
  })

  it('never shortens a long run whose exit was written', () => {
    // The ceiling is about runs with nothing written after them. An agent that
    // genuinely ran for three days and said so is timed by what it said.
    const report = runtimeFrom([started(4 * 24 * 60), exited(24 * 60)], { now: NOW })
    expect(report.total.ms).toBe(3 * 24 * 60 * MINUTE)
  })

  it('ends a run whose task was removed', () => {
    const report = runtimeFrom([started(30), event('task_removed', { ts: at(20), run: null })], {
      now: NOW,
    })
    expect(report.total.ms).toBe(10 * MINUTE)
  })

  it('ends a run by its task when the exit lost the run id', () => {
    const report = runtimeFrom([started(30), exited(10, { run: null })], { now: NOW })
    expect(report.total.ms).toBe(20 * MINUTE)
  })

  it('treats a second start with no exit between as the same run', () => {
    const report = runtimeFrom([started(30), started(20), exited(10)], { now: NOW })
    expect(report.total.ms).toBe(20 * MINUTE)
    expect(report.total.runs).toBe(1)
  })

  it('ignores everything that is not a run, and lines with no readable time', () => {
    const report = runtimeFrom(
      [
        event('usage', { ts: at(30), detail: { usd: 1 } }),
        event('turn_done', { ts: at(20) }),
        started(10, { ts: 'not a time' }),
      ],
      { now: NOW },
    )
    expect(report.total).toEqual(noRuntime())
  })

  it('never counts a run backwards when a clock jumped', () => {
    const report = runtimeFrom([started(-10), exited(-20)], { now: NOW })
    expect(report.total.ms).toBe(0)
  })
})

describe('duration', () => {
  it('says a span the way a person would', () => {
    expect(duration(0)).toBe('0s')
    expect(duration(4_500)).toBe('4s')
    expect(duration(90_000)).toBe('1m')
    expect(duration(59 * MINUTE)).toBe('59m')
    expect(duration(60 * MINUTE)).toBe('1h')
    expect(duration(80 * MINUTE)).toBe('1h 20m')
    expect(duration(48 * 60 * MINUTE)).toBe('2d')
    expect(duration(51 * 60 * MINUTE)).toBe('2d 3h')
  })

  it('never says a negative span', () => {
    expect(duration(-5)).toBe('0s')
  })
})
