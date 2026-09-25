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
//
// Which is why there are two figures and not one. Wall clock answers how long
// an agent was *there*, which is what an agent sitting finished in its lane
// until somebody closes the window burns; working time answers how long a
// model was actually working, which is what pairs with what it cost. Both are
// true, they answer different questions, and reading one as the other is what
// sent somebody looking for this file.
//
// Working time is the same kind of fold, one level down: the span between the
// `turn_started` a harness said and the `turn_done` that answers it, added up
// inside the run that holds them. Nothing keeps a stopwatch here either.
//
// And it is `unknown` rather than zero for everything that ran before Tade
// wrote turn beginnings down. `turn_done` has always been journalled and
// `turn_started` has not, so the journal this was written from held 7,090
// turns that each had an end and no beginning: their working time is not
// nought, it is unanswerable, and a `0s` in that column would be a lie told
// four times a second. A run is marked unknown the moment a turn ends in it
// that we never saw begin — which is every run of an older journal that did
// any work at all, and none of a newer one. The journal is append-only and
// nothing rewrites it, so the only cure is time.

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
  // The two ends of a turn, which is the whole of how long a model worked.
  // Both, and never one: an end with no beginning is what makes a run's
  // working time unknown, so a reader that took only the starts would report
  // an older journal as having worked for no time rather than as unanswerable.
  'turn_started',
  'turn_done',
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
  /**
   * Of `ms`, how much was spent inside a turn: a model actually working,
   * rather than an agent sitting in its lane waiting to be read.
   *
   * Never more than `ms`, because a turn is clipped to the run that holds it —
   * so the worst a lost `turn_done` can do is make working time look like wall
   * clock, which is the figure beside it and no worse than having neither.
   *
   * It counts only the runs that could say. What the ones that could not would
   * have added is not here and is not nought: `workingUnknown` is how many
   * they were, and a surface that draws this figure without saying so is
   * drawing a number that quietly means something else.
   */
  workingMs: number
  /**
   * How many of `runs` have no turn beginnings recorded, so what they spent
   * working cannot be known. Every run of a journal written before Tade wrote
   * `turn_started` down, and none of one written since.
   */
  workingUnknown: number
}

export function noRuntime(): Runtime {
  return { ms: 0, runs: 0, running: false, workingMs: 0, workingUnknown: 0 }
}

/**
 * What may honestly be said about a bucket's working time — the same question
 * `pricedOf` answers about its money, and for the same reason: a column that
 * mixes what was measured with what was not is the one thing these pages may
 * never draw.
 *
 * `unrecorded` means there is nothing to say at all, and a surface says that
 * rather than drawing the `0s` it would otherwise add up to. `partly` means
 * the figure is a floor: some runs in it could say and others could not, which
 * is what a window spanning the day this was built looks like, and what a run
 * whose last turn never got an end looks like afterwards.
 */
export type Worked = 'recorded' | 'partly' | 'unrecorded'

export function workedOf(runtime: Runtime): Worked {
  if (runtime.runs <= 0) return 'unrecorded'
  // Every run could say, whatever the figure came to. Nought here is a fact:
  // nothing was ever asked of those runs, and they worked for no time.
  if (runtime.workingUnknown <= 0) return 'recorded'
  if (runtime.workingUnknown >= runtime.runs) return 'unrecorded'
  // A floor of nought is not a floor. Where the runs that could say worked no
  // time at all, the whole of what this bucket has to say is that most of it
  // cannot — and `≥0s` is exactly the zero all of this was written to stop
  // drawing. The real journal this was built against is this case: 135 runs of
  // 228 with no turn beginnings, and 93 that never took a turn.
  return runtime.workingMs > 0 ? 'partly' : 'unrecorded'
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
  /**
   * When the turn in flight began, or null between turns. One at a time: a
   * harness that says a turn began while one already is, is saying again that
   * the one we know about is still going — pi does exactly that every time its
   * socket reconnects mid-turn — so the first beginning is kept, the way a
   * second `run_started` keeps the first. Two open at once would let working
   * time climb past the wall clock it is a part of.
   */
  turnAt: number | null
  /** What the turns that have ended in it add up to, already clipped. */
  worked: number
  /** Whether any turn has been seen to begin in it. */
  sawTurn: boolean
  /** A turn ended that we never saw begin, so what it worked cannot be known. */
  unknown: boolean
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
    // A turn still in flight when the run ends worked right up to the end of
    // it: an agent killed mid-thought was thinking until it was killed.
    if (run.turnAt !== null) worked(run, run.turnAt, end)
    // Never more than the run itself. Turns fall inside their run by
    // construction, so this only ever bites on a clock that jumped — and a
    // part being larger than its whole is the one answer nobody could read.
    const working = Math.min(run.worked, ms)
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
      // A run that cannot say adds its count and not its time: nothing here
      // may age an unanswerable question into a nought.
      if (run.unknown) bucket.workingUnknown += 1
      else bucket.workingMs += working
    }
  }

  /** A turn's span, clipped to the window, added to the run that held it. */
  const worked = (run: Open, start: number, end: number): void => {
    const from = Math.max(start, since)
    const to = Math.min(end, now)
    if (to > from) run.worked += to - from
    run.turnAt = null
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
            turnAt: null,
            worked: 0,
            sawTurn: false,
            unknown: false,
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
      case 'turn_started': {
        const run = runFor(open, event)
        if (!run) break
        run.sawTurn = true
        // Kept, not restarted: a harness saying again that a turn is under way
        // is not a second turn, and taking it as one would throw away every
        // minute the turn had already spent.
        if (run.turnAt === null) run.turnAt = at
        break
      }
      case 'turn_done': {
        const run = runFor(open, event)
        if (!run) break
        if (run.turnAt !== null) worked(run, run.turnAt, at)
        // A turn that ended and never began. Every turn of a journal written
        // before Tade wrote beginnings down looks like this, which is the
        // whole of why this run's working time is unanswerable rather than
        // nought — and a later `turn_started` does not cure it, because the
        // turn whose length nobody can say has already happened.
        else if (!run.sawTurn) run.unknown = true
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

/**
 * Which open run an event inside a run belongs to: the one under its own id,
 * or — for a line that lost it — the one open for its task. The same fallback
 * `run_exited` takes, for the same reason: a turn attributed to nothing is a
 * turn whose time is lost.
 */
function runFor(open: Map<string, Open>, event: TadeEvent): Open | undefined {
  const found = open.get(keyOf(event))
  if (found) return found
  if (!event.task) return undefined
  for (const run of open.values()) if (run.task === event.task) return run
  return undefined
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
 * The other half of it: how much of that time a model was actually working.
 *
 * Said beside `runtimeSays` rather than inside it, because they are two facts
 * and a reader wants the second only once the first has stopped surprising
 * them. Said by core, for the reason the first is: `tade spend` and the window
 * read one fold and may never explain it differently.
 *
 * What cannot be known is said as that and never as a figure. A run whose
 * turns have ends and no beginnings is every run of a journal written before
 * this existed, and `0s` would read as an agent that did nothing — which is
 * the opposite of true, since a run only gets into this state by having
 * finished turns.
 */
export function workedSays(runtime: Runtime): string {
  if (runtime.runs <= 0) return ''
  const unknown = `${runtime.workingUnknown === runtime.runs ? 'These' : `${runtime.workingUnknown} of these`} runs began before Tade wrote down when a turn starts, so what they spent working cannot be known — it is not nought.`
  switch (workedOf(runtime)) {
    case 'recorded':
      return `${duration(runtime.workingMs)} of that was spent working: inside a turn, rather than sitting in a lane waiting to be read.`
    case 'partly':
      return `At least ${duration(runtime.workingMs)} of that was spent working — inside a turn, rather than sitting in a lane waiting to be read. ${unknown}`
    default:
      return unknown
  }
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
