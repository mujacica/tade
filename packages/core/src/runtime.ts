import { type ReadableEventType, type TadeEvent, typeNow } from './events.ts'
import { accountBucket, modelIn, type RunFacts, runFactsOf, UNRECORDED } from './spend.ts'

// How long the agents have been running, which is the other half of what they
// cost.
//
// Status is a query, so this is one too: nothing keeps a stopwatch anywhere.
// A run is the span between the `run_started` the workers wrote and the
// `run_exited` that answers it, and one still open is counted up to `now` —
// an agent that is working right now is running right now, and a number that
// only moves when it stops is no use while you watch it.
//
// Three things end a run nobody wrote an exit for, because an exit is the
// thing most often missing: the journal that produced this comment had 100
// `run_started` in it, 35 `run_exited` and 64 `lane_exited`.
//
// A window boundary. A window closing stops watching, and one opening
// relaunches whatever was working — and writes a new `run_started` for it.
// Counting the hours Tade was shut as runtime would add a night's sleep to
// every agent, every morning. Boundaries are read by what they mean rather
// than by the word they were written under (`typeNow`): a journal from before
// the rename says `wilco_closing`, and not knowing that word left runs from
// days earlier open, each clipping ten hours into every day since and turning
// a morning's work into `7d 13h`.
//
// The lane going. An agent is the process in its lane, so a lane that has
// exited cannot still be running, whatever was or was not written for the run.
// Only the run's own lane counts, never its task's other lanes: a task can
// have a terminal open beside its agent, and ending a run because a sibling
// lane closed would shorten a run that is genuinely still going.
//
// And the ceiling below, for a boundary we never saw at all.
//
// The orchestrator is not in here. It has no run of its own — it lives as long
// as the window does — and folding the time you had Tade open into "how long
// the agents ran" would make the one number nobody could read.
//
// What it counts is wall clock from start to exit: an agent that spent eight
// hours waiting for you to answer ran for eight hours, and agents working at
// once add up, so twenty of them over a morning is legitimately days. That is
// what "how long the agents ran" means here — it is not an estimate of effort.

/**
 * How long a run with nothing written after it may go on counting.
 *
 * A run is only still open here if nothing said otherwise: no exit, no lane
 * gone, no window boundary. Tade writes a boundary every time it opens, so an
 * honestly open run is one that started in the window that is open now — and a
 * day is longer than any window session, with room to spare. Past that the
 * likelier story is a boundary we could not read (a rename, a journal written
 * by an older Tade, a filtered read that dropped one) than an agent that has
 * worked a full day without a single event of its own.
 *
 * So it stops counting there rather than climbing for ever. Undercounting by
 * hours is a number you can argue with; a run that counts to `now` for ever
 * quietly becomes most of the total and nothing on the panel says why. This
 * can never shorten a run we have evidence for: a run whose exit was written
 * is timed by its exit however long it lasted, and one still open is counted
 * in full for its first day.
 */
const OPEN_RUN_CEILING = 24 * 60 * 60 * 1000

/**
 * What runtime is read from. One list, so a second reader cannot quietly read
 * less than the first — and the names these had before the rename come with
 * them, because `EventFilter` matches on what a type means now.
 */
export const RUNTIME_EVENTS: readonly ReadableEventType[] = [
  'run_started',
  // What it turned out to be on, which is what it is timed by. One or two
  // lines per run, so reading them costs nothing next to the usage stream —
  // and without them a run that never billed is an hour attributed to nothing.
  'run_model',
  'run_exited',
  'lane_exited',
  'task_removed',
  'tade_opened',
  'tade_closing',
]

export interface Runtime {
  /** Wall clock, in milliseconds, inside the window asked about. */
  ms: number
  /** How many runs that time is made of. */
  runs: number
  /** Whether a run is still going, so `ms` is still counting up. */
  running: boolean
}

export function noRuntime(): Runtime {
  return { ms: 0, runs: 0, running: false }
}

export interface RuntimeWindow {
  /** Only count time at or after this. Everything ever, left out. */
  since?: number
  /** Now, which is where a run still going is counted to. */
  now: number
  /**
   * What each run turned out to be running on, as its own usage reported it
   * (`modelsSaid`). A route asks for `anthropic/claude-opus-5` and Claude Code
   * answers `claude-opus-5`, so a run timed by what was *asked for* lands on a
   * different model row from the money it spent — one agent, drawn as two.
   *
   * For a journal written before `run_model` existed, which is the only thing
   * this is still for: a run id is a task's agent and is used again every time
   * that agent is opened, so the best this can say is what the last run under
   * that id said. A `run_model` seen inside the run being timed is better and
   * wins over it; what was asked for is the fallback under both.
   */
  said?: ReadonlyMap<string, string>
}

export interface RuntimeReport {
  /** Every agent's time added up, so two running at once count as two. */
  total: Runtime
  byProject: Record<string, Runtime>
  byTask: Record<string, Runtime>
  /**
   * What it ran on, by the model's own name (`modelIdentity`) so its hours and
   * its money are one row: what it said while it ran, then what its usage
   * said, then what `run_started` asked for.
   */
  byModel: Record<string, Runtime>
  /** The harness it ran in, as `run_started` recorded it. */
  byHarness: Record<string, Runtime>
  /** The sign-in it ran as: `claude-code`, `claude-code@work`. */
  byAccount: Record<string, Runtime>
  /** The provider its model was reached through, where the run recorded one. */
  byProvider: Record<string, Runtime>
}

/** A run that has begun and not yet ended. */
interface Open {
  task: string | null
  model: string
  /** Which harness, sign-in and provider it was started on. */
  facts: RunFacts
  at: number
  /** The lane it lives in, whose going ends it. */
  lane: string | null
}

export function runtimeFrom(events: readonly TadeEvent[], window: RuntimeWindow): RuntimeReport {
  const since = window.since ?? 0
  const now = window.now
  const report: RuntimeReport = {
    total: noRuntime(),
    byProject: {},
    byTask: {},
    byModel: {},
    byHarness: {},
    byAccount: {},
    byProvider: {},
  }
  const said = window.said
  const open = new Map<string, Open>()

  const close = (key: string, end: number, running: boolean): void => {
    const run = open.get(key)
    if (!run) return
    open.delete(key)
    // Only the part of it that falls inside the window is this window's.
    const from = Math.max(run.at, since)
    const to = Math.min(end, now)
    if (to <= from) return
    const ms = to - from
    const project = (run.task ?? '').split('/')[0] || 'elsewhere'
    const buckets = [
      report.total,
      into(report.byProject, project),
      into(report.byModel, run.model),
      into(report.byHarness, run.facts.harness),
      into(report.byAccount, accountBucket(run.facts)),
      into(report.byProvider, run.facts.provider),
    ]
    if (run.task) buckets.push(into(report.byTask, run.task))
    for (const bucket of buckets) {
      bucket.ms += ms
      bucket.runs += 1
      if (running) bucket.running = true
    }
  }

  for (const event of events) {
    const at = Date.parse(event.ts)
    if (!Number.isFinite(at)) continue
    switch (typeNow(event.type)) {
      case 'run_started': {
        // A second start with no exit between is the same run seen twice:
        // keep the first, or the time before it would vanish.
        const key = keyOf(event)
        // An agent is a lane with pi in it, named `<task>/agent` — the same
        // name as its run — so the run id is the lane to watch when the start
        // did not name one itself.
        if (!open.has(key)) {
          open.set(key, {
            task: event.task,
            model: (event.run ? said?.get(event.run) : undefined) ?? modelOf(event),
            facts: runFactsOf(event),
            at,
            lane: event.lane ?? event.run,
          })
        }
        break
      }
      case 'run_model': {
        // What it turned out to be on, said while this run was open — so a run
        // id used again by the next agent of the same task cannot lend this one
        // its model, which is the most `said` can do for an older journal.
        const run = open.get(keyOf(event))
        const { name } = modelIn(event)
        if (run && name !== UNRECORDED) run.model = name
        break
      }
      case 'run_exited':
        // By run id, and by task for an exit that lost it: a run left open
        // would otherwise count to now for ever.
        if (open.has(keyOf(event))) close(keyOf(event), at, false)
        else if (event.task) closeTask(open, event.task, (key) => close(key, at, false))
        break
      case 'lane_exited':
        // By lane and only by lane: the process the run was is gone.
        if (event.lane) closeLane(open, event.lane, (key) => close(key, at, false))
        break
      case 'task_removed':
        if (event.task) closeTask(open, event.task, (key) => close(key, at, false))
        break
      case 'tade_closing':
      case 'tade_opened':
        for (const key of [...open.keys()]) close(key, at, false)
        break
    }
  }
  // Whatever is still open is still running — for as long as a run with
  // nothing written after it can honestly be believed to be.
  for (const [key, run] of [...open]) {
    const ceiling = run.at + OPEN_RUN_CEILING
    if (ceiling < now) close(key, ceiling, false)
    else close(key, now, true)
  }
  return report
}

/** The key a run is tracked under: its own id, or its task when it has none. */
function keyOf(event: TadeEvent): string {
  return event.run ?? `task:${event.task ?? ''}`
}

function closeTask(open: Map<string, Open>, task: string, close: (key: string) => void): void {
  for (const [key, run] of [...open]) if (run.task === task) close(key)
}

function closeLane(open: Map<string, Open>, lane: string, close: (key: string) => void): void {
  for (const [key, run] of [...open]) if (run.lane === lane) close(key)
}

/**
 * What the run said it would be on, folded to the model's own name — so the
 * hours of `anthropic/claude-opus-5` and the money of `claude-opus-5` land on
 * one row rather than on two models that never ran together.
 *
 * `UNRECORDED` where the start named nothing, which is where an agent started
 * before its harness had said puts its hours until a `run_model` says. Drawn
 * as *not recorded*, never as a model called `unknown`.
 */
function modelOf(event: TadeEvent): string {
  return modelIn(event).name
}

function into(buckets: Record<string, Runtime>, key: string): Runtime {
  const found = buckets[key] ?? noRuntime()
  buckets[key] = found
  return found
}

/**
 * What a runtime total means, said rather than left to be worked out.
 *
 * `13d 3h` off a machine that has been on for a day and a half reads as a bug,
 * and it is not one: twenty agents over an afternoon is legitimately more than
 * a week, because each of them ran for the whole of its own afternoon. And a
 * run is wall clock from start to stop, so an agent that finished in twenty
 * minutes and sat in its lane until somebody closed the window counted every
 * hour of the wait — which is the honest answer to "how long was it running",
 * and the wrong answer to a question nobody asked it.
 *
 * So both are said, in one sentence, wherever the figure is: the number is
 * defensible and the reading of it was not. One sentence and not two, and said
 * by core rather than by each surface, because the window and `tade spend` are
 * reading the same fold and may never explain it differently.
 */
export function runtimeSays(runtime: Runtime): string {
  if (runtime.ms <= 0) return ''
  const counts = 'counts until it stopped, idle time included'
  if (runtime.runs <= 1) return `${duration(runtime.ms)} is one run, and a run ${counts}.`
  return `${duration(runtime.ms)} is ${runtime.runs} runs added together, not elapsed time: agents at once each count their own hours, and each ${counts}.`
}

/**
 * A span of time the way people say it: `4s`, `12m`, `1h 20m`, `2d 3h`. Two
 * units at most, because the third is never what you were asking.
 */
export function duration(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`
  const days = Math.floor(hours / 24)
  return hours % 24 === 0 ? `${days}d` : `${days}d ${hours % 24}h`
}
