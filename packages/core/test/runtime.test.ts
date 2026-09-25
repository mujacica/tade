import { describe, expect, it } from 'vitest'
import type { ReadableEventType, TadeEvent } from '../src/events.ts'
import {
  duration,
  noRuntime,
  type Runtime,
  runtimeFrom,
  runtimeSays,
  workedOf,
  workedSays,
} from '../src/runtime.ts'
import { modelsSaid, startOfToday, UNRECORDED } from '../src/spend.ts'

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

  it('counts a run with no recorded model as unrecorded rather than dropping it', () => {
    const report = runtimeFrom([event('run_started', { ts: at(10) }), exited(0)], { now: NOW })
    // Its own bucket, which no model's name can collide with — and which the
    // page draws as *not recorded*, never as a model called `unknown`.
    expect(report.byModel[UNRECORDED]?.ms).toBe(10 * MINUTE)
    expect(report.byModel.unknown).toBeUndefined()
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

// How long a model was *working*, which is the other question the same fold
// answers. A run counts until it stopped, idle time included; the turns inside
// it are the part somebody was thinking. Every one of these is about the gap
// between those two, because reading either as the other is the bug this was
// written for.
describe('runtimeFrom, working time', () => {
  const turnStarted = (minutesAgo: number, over: Partial<TadeEvent> = {}) =>
    event('turn_started', { ts: at(minutesAgo), ...over })
  const turnDone = (minutesAgo: number, over: Partial<TadeEvent> = {}) =>
    event('turn_done', { ts: at(minutesAgo), detail: { status: 'ok' }, ...over })

  it('adds up the turns, and not the waiting between them', () => {
    // Twenty minutes open, eight of them spent thinking. The twelve in the
    // middle are an agent that had answered and was waiting to be read.
    const report = runtimeFrom(
      [started(30), turnStarted(25), turnDone(20), turnStarted(15), turnDone(12), exited(10)],
      { now: NOW },
    )
    expect(report.total.ms).toBe(20 * MINUTE)
    expect(report.total.workingMs).toBe(8 * MINUTE)
    expect(report.total.workingUnknown).toBe(0)
    expect(workedOf(report.total)).toBe('recorded')
    expect(report.byTask['checkout/refunds']?.workingMs).toBe(8 * MINUTE)
  })

  it('counts a turn that is still going up to now', () => {
    const report = runtimeFrom([started(30), turnStarted(10)], { now: NOW })
    expect(report.total.ms).toBe(30 * MINUTE)
    expect(report.total.workingMs).toBe(10 * MINUTE)
    expect(report.total.running).toBe(true)
  })

  it('counts a turn still open when the run ended up to where the run ended', () => {
    // An agent killed mid-thought was thinking until it was killed: there is
    // no `turn_done` for it and there never will be.
    const report = runtimeFrom([started(30), turnStarted(25), exited(10)], { now: NOW })
    expect(report.total.ms).toBe(20 * MINUTE)
    expect(report.total.workingMs).toBe(15 * MINUTE)
  })

  it('cannot say what a run worked when its turns have ends and no beginnings', () => {
    // Every run of every journal written before `turn_started` was recorded.
    // Not nought — a run only gets here by having *finished* turns — so the
    // count is what is reported and the figure is left out of.
    const report = runtimeFrom([started(30), turnDone(20), turnDone(15), exited(10)], { now: NOW })
    expect(report.total.ms).toBe(20 * MINUTE)
    expect(report.total.workingMs).toBe(0)
    expect(report.total.workingUnknown).toBe(1)
    expect(workedOf(report.total)).toBe('unrecorded')
  })

  it('does not cure an unanswerable run with a later beginning', () => {
    // A window that opened in the middle of a run written by an older Tade.
    // The turn nobody can time has already happened; what came after it does
    // not make its length knowable.
    const report = runtimeFrom(
      [started(40), turnDone(30), turnStarted(20), turnDone(15), exited(10)],
      { now: NOW },
    )
    expect(report.total.workingUnknown).toBe(1)
    expect(workedOf(report.total)).toBe('unrecorded')
  })

  it('knows a run that took no turns at all worked for no time', () => {
    // Nothing was asked of it. That is a nought somebody can defend, and it is
    // the one case that is not unknown.
    const report = runtimeFrom([started(30), exited(10)], { now: NOW })
    expect(report.total.workingMs).toBe(0)
    expect(report.total.workingUnknown).toBe(0)
    expect(workedOf(report.total)).toBe('recorded')
  })

  it('keeps the first of two beginnings for one turn', () => {
    // pi re-sends `turn_started` every time its socket reconnects mid-turn, so
    // that a window opening on a working agent does not take it for idle.
    // Taken as a second turn, every minute before the reconnect would vanish.
    const report = runtimeFrom(
      [started(30), turnStarted(25), turnStarted(20), turnDone(15), exited(10)],
      { now: NOW },
    )
    expect(report.total.workingMs).toBe(10 * MINUTE)
  })

  it('never counts more working time than the run it is part of', () => {
    // A clock that jumped, which is the only way a turn lands outside its run.
    // A part larger than its whole is the one answer nobody could read.
    const report = runtimeFrom([started(20), turnStarted(30), turnDone(15), exited(10)], {
      now: NOW,
    })
    expect(report.total.ms).toBe(10 * MINUTE)
    expect(report.total.workingMs).toBe(10 * MINUTE)
  })

  it('counts only the part of a turn inside the window asked about', () => {
    const report = runtimeFrom([started(40), turnStarted(30), turnDone(10), exited(5)], {
      since: Date.parse(at(20)),
      now: NOW,
    })
    expect(report.total.ms).toBe(15 * MINUTE)
    expect(report.total.workingMs).toBe(10 * MINUTE)
  })

  it('is a floor when some runs could say and others could not', () => {
    const other = { task: 'search/pagination', run: 'search/pagination/agent' }
    const report = runtimeFrom(
      [
        started(40),
        turnStarted(35),
        turnDone(30),
        exited(25),
        started(20, other),
        turnDone(15, other),
        exited(10, other),
      ],
      { now: NOW },
    )
    expect(report.total.runs).toBe(2)
    expect(report.total.workingMs).toBe(5 * MINUTE)
    expect(report.total.workingUnknown).toBe(1)
    expect(workedOf(report.total)).toBe('partly')
    // And each run keeps its own answer, so the page can say which is which.
    expect(workedOf(report.byTask['checkout/refunds'] as Runtime)).toBe('recorded')
    expect(workedOf(report.byTask['search/pagination'] as Runtime)).toBe('unrecorded')
  })

  it('leaves a turn that belongs to no open run alone', () => {
    const report = runtimeFrom([turnStarted(30), turnDone(20)], { now: NOW })
    expect(report.total).toEqual(noRuntime())
  })
})

describe('workedOf', () => {
  it('says nothing can be said where nothing ran', () => {
    expect(workedOf(noRuntime())).toBe('unrecorded')
  })
})

describe('workedSays', () => {
  const runtime = (over: Partial<Runtime>): Runtime => ({ ...noRuntime(), ...over })

  it('says nothing about a window nothing ran in', () => {
    expect(workedSays(noRuntime())).toBe('')
  })

  it('says how much of the time was spent working', () => {
    const said = workedSays(runtime({ ms: 120 * MINUTE, runs: 3, workingMs: 40 * MINUTE }))
    expect(said).toContain('40m')
    expect(said).toContain('working')
  })

  it('says a figure made of some runs is at least that much', () => {
    const said = workedSays(
      runtime({ ms: 120 * MINUTE, runs: 3, workingMs: 40 * MINUTE, workingUnknown: 1 }),
    )
    expect(said).toContain('At least 40m')
    expect(said).toContain('1 of these runs')
  })

  it('says nothing rather than a floor of nought', () => {
    // The runs that could say worked no time at all, so `At least 0s` is the
    // zero this was written to stop drawing — and the journal it was built
    // against is exactly this shape.
    const said = workedSays(runtime({ ms: 120 * MINUTE, runs: 3, workingUnknown: 2 }))
    expect(said).not.toContain('At least')
    expect(said).not.toContain('0s')
    expect(said).toContain('2 of these runs')
  })

  it('says what cannot be known as that, and never as a nought', () => {
    const said = workedSays(runtime({ ms: 120 * MINUTE, runs: 3, workingUnknown: 3 }))
    expect(said).toContain('cannot be known')
    expect(said).toContain('it is not nought')
    expect(said).not.toContain('0s')
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

// The hours go in the same buckets the dollars do, or a page that draws both
// on one row is drawing two different runs.
describe('what the hours were spent on', () => {
  it('counts the time by harness, by sign-in and by provider', () => {
    const report = runtimeFrom(
      [
        event('run_started', {
          ts: at(30),
          run: 'r1',
          detail: { adapter: 'claude-code', account: 'work', provider: 'anthropic' },
        }),
        event('run_exited', { ts: at(20), run: 'r1' }),
        event('run_started', {
          ts: at(20),
          run: 'r2',
          task: 'search/pagination',
          detail: { adapter: 'pi', provider: 'openrouter' },
        }),
        event('run_exited', { ts: at(15), run: 'r2' }),
      ],
      { now: NOW },
    )
    expect(report.byHarness['claude-code']?.ms).toBe(10 * MINUTE)
    expect(report.byHarness.pi?.ms).toBe(5 * MINUTE)
    expect(report.byAccount['claude-code@work']?.ms).toBe(10 * MINUTE)
    expect(report.byAccount.pi?.ms).toBe(5 * MINUTE)
    expect(report.byProvider.anthropic?.ms).toBe(10 * MINUTE)
    expect(report.byProvider.openrouter?.ms).toBe(5 * MINUTE)
  })

  it('times a run by what it turned out to be on, not by what was asked for', () => {
    // A route asks for `anthropic/claude-opus-5` and Claude Code answers
    // `claude-opus-5`. Timed by the ask and priced by the answer, one agent
    // was two model rows that never ran together — which is what sent somebody
    // looking at this page in the first place.
    const runs = [
      event('run_started', { ts: at(30), run: 'r1', detail: { model: 'anthropic/claude-opus-5' } }),
      event('run_exited', { ts: at(20), run: 'r1' }),
    ]
    const report = runtimeFrom(runs, { now: NOW, said: new Map([['r1', 'claude-opus-5']]) })
    expect(report.byModel['claude-opus-5']?.ms).toBe(10 * MINUTE)
    expect(report.byModel['anthropic/claude-opus-5']).toBeUndefined()
    // And with nothing said, what was asked for is still the honest answer —
    // under the model's own name, because that is the only name it has.
    expect(runtimeFrom(runs, { now: NOW }).byModel['claude-opus-5']?.ms).toBe(10 * MINUTE)
  })

  it('counts the hours under the provider the harness reaches, not the route', () => {
    // The same correction the money gets, and for the same reason: an hour
    // filed under a router Claude Code cannot reach is an hour drawn beside
    // money that is not there.
    const report = runtimeFrom(
      [
        event('run_started', {
          ts: at(30),
          run: 'r1',
          detail: { adapter: 'claude-code', provider: 'openrouter' },
        }),
        event('run_exited', { ts: at(20), run: 'r1' }),
      ],
      { now: NOW },
    )
    expect(report.byProvider.anthropic?.ms).toBe(10 * MINUTE)
    expect(report.byProvider.openrouter).toBeUndefined()
  })

  it('says nothing recorded for a run that named no harness', () => {
    const report = runtimeFrom([event('run_started', { ts: at(10) }), exited(0)], { now: NOW })
    expect(report.byHarness[UNRECORDED]?.ms).toBe(10 * MINUTE)
    expect(report.byProvider[UNRECORDED]?.ms).toBe(10 * MINUTE)
  })
})

// The other half of the same bug: the journal this was written from had 86 of
// its 161 runs recording no model at all — every one of them pi, which picks
// by what you are signed in to, so there was nothing to record at the start.
// Their hours went to the bucket for nothing recorded while their money went
// to a model row, and the two halves of one agent were never in one place.
describe('a run is timed by what it turned out to be on', () => {
  it('takes what it said while it ran over what it was asked for', () => {
    // A route asks for `anthropic/claude-opus-5` and Claude Code answers
    // `claude-opus-5`: one model, and it must be one row.
    const report = runtimeFrom(
      [
        started(30, { detail: { model: 'anthropic/claude-opus-5' } }),
        event('run_model', { ts: at(29), detail: { model: 'claude-opus-5' } }),
        exited(10),
      ],
      { now: NOW },
    )
    expect(report.byModel['claude-opus-5']?.ms).toBe(20 * MINUTE)
    expect(Object.keys(report.byModel)).toEqual(['claude-opus-5'])
  })

  it('gives a run started with no model the one its harness said', () => {
    // pi with nothing configured: `run_started` names nothing, and what it
    // picked arrives before its first turn.
    const report = runtimeFrom(
      [
        event('run_started', { ts: at(30) }),
        event('run_model', {
          ts: at(29),
          detail: { model: 'kimi-k2.6', modelId: 'openrouter/moonshotai/kimi-k2.6' },
        }),
        exited(10),
      ],
      { now: NOW },
    )
    expect(report.byModel['kimi-k2.6']?.ms).toBe(20 * MINUTE)
    expect(report.byModel[UNRECORDED]).toBeUndefined()
  })

  it('folds every spelling of one model into the row its money is in', () => {
    const report = runtimeFrom(
      [
        started(60, { run: 'r1', detail: { model: 'claude-opus-5' } }),
        exited(50, { run: 'r1' }),
        started(40, { run: 'r2', detail: { model: 'anthropic/claude-opus-5' } }),
        exited(30, { run: 'r2' }),
        started(20, { run: 'r3', detail: { model: 'openrouter/anthropic/claude-opus-5' } }),
        exited(10, { run: 'r3' }),
      ],
      { now: NOW },
    )
    expect(Object.keys(report.byModel)).toEqual(['claude-opus-5'])
    expect(report.byModel['claude-opus-5']?.ms).toBe(30 * MINUTE)
    expect(report.byModel['claude-opus-5']?.runs).toBe(3)
  })

  it('never lends one run the model of the next run under its id', () => {
    // A run id is a task's agent and is used again every time it is opened, so
    // `said` can only say what the last of them said. A `run_model` seen
    // inside the run being timed is evidence about that run and wins.
    const journal = [
      event('run_started', { ts: at(60) }),
      event('run_model', { ts: at(59), detail: { model: 'kimi-k2.6' } }),
      exited(50),
      event('run_started', { ts: at(40) }),
      event('run_model', { ts: at(39), detail: { model: 'claude-opus-5' } }),
      exited(30),
    ]
    const report = runtimeFrom(journal, { now: NOW, said: modelsSaid(journal) })
    expect(report.byModel['kimi-k2.6']?.ms).toBe(10 * MINUTE)
    expect(report.byModel['claude-opus-5']?.ms).toBe(10 * MINUTE)
  })

  it('still reads a journal written before any run said', () => {
    // Nothing but usage to go on, which is all an older journal has: the run
    // is timed by what its turns were priced at rather than by nothing.
    const usage = event('usage', { ts: at(20), detail: { model: 'openrouter/kimi-k2.6' } })
    const report = runtimeFrom([event('run_started', { ts: at(30) }), exited(10)], {
      now: NOW,
      said: modelsSaid([usage]),
    })
    expect(report.byModel['kimi-k2.6']?.ms).toBe(20 * MINUTE)
  })

  it('leaves a run nothing ever said about as not recorded', () => {
    // 32 of the 86 are this: pi runs that opened and never took a turn, so
    // nothing anywhere ever named a model. Not a model called `unknown`.
    const report = runtimeFrom([event('run_started', { ts: at(30) }), exited(10)], { now: NOW })
    expect(report.byModel[UNRECORDED]?.ms).toBe(20 * MINUTE)
    expect(report.byModel.unknown).toBeUndefined()
  })

  it('ignores a model said for a run that is not open', () => {
    const report = runtimeFrom(
      [event('run_model', { ts: at(40), detail: { model: 'kimi-k2.6' } }), started(30), exited(10)],
      { now: NOW },
    )
    expect(report.byModel['claude-opus-5']?.ms).toBe(20 * MINUTE)
    expect(report.byModel['kimi-k2.6']).toBeUndefined()
  })
})

describe('runtimeSays', () => {
  it('says nothing when nothing ran', () => {
    expect(runtimeSays(noRuntime())).toBe('')
  })

  it('says that many runs were added together, and that waiting is in it', () => {
    // `13d 3h` off a machine that has been on since breakfast reads as a bug
    // and is not one — and nothing on the page said so.
    const said = runtimeSays({ ...noRuntime(), ms: 13 * 24 * 60 * MINUTE, runs: 53, running: true })
    expect(said).toContain('13d')
    expect(said).toContain('53 runs added together')
    expect(said).toContain('idle time included')
  })

  it('does not say runs were added together when there was one', () => {
    const said = runtimeSays({ ...noRuntime(), ms: 90 * MINUTE, runs: 1, running: false })
    expect(said).toContain('1h 30m is one run')
    expect(said).not.toContain('added together')
  })
})
