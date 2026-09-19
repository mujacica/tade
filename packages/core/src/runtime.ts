import type { TadeEvent } from './events.ts'

// How long the agents have been running, which is the other half of what they
// cost.
//
// Status is a query, so this is one too: nothing keeps a stopwatch anywhere.
// A run is the span between the `run_started` the workers wrote and the
// `run_exited` that answers it, and one still open is counted up to `now` —
// an agent that is working right now is running right now, and a number that
// only moves when it stops is no use while you watch it.
//
// Two things end a run nobody wrote an exit for. A window closing stops
// watching, and one opening relaunches whatever was working — and writes a new
// `run_started` for it. Counting the hours Tade was shut as runtime would add
// a night's sleep to every agent, every morning.
//
// The orchestrator is not in here. It has no run of its own — it lives as long
// as the window does — and folding the time you had Tade open into "how long
// the agents ran" would make the one number nobody could read.

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
}

export interface RuntimeReport {
  /** Every agent's time added up, so two running at once count as two. */
  total: Runtime
  byProject: Record<string, Runtime>
  byTask: Record<string, Runtime>
  /** What it ran on, as `run_started` recorded it. */
  byModel: Record<string, Runtime>
}

/** A run that has begun and not yet ended. */
interface Open {
  task: string | null
  model: string
  at: number
}

export function runtimeFrom(events: readonly TadeEvent[], window: RuntimeWindow): RuntimeReport {
  const since = window.since ?? 0
  const now = window.now
  const report: RuntimeReport = { total: noRuntime(), byProject: {}, byTask: {}, byModel: {} }
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
    const buckets = [report.total, into(report.byProject, project), into(report.byModel, run.model)]
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
    switch (event.type) {
      case 'run_started': {
        // A second start with no exit between is the same run seen twice:
        // keep the first, or the time before it would vanish.
        const key = keyOf(event)
        if (!open.has(key)) open.set(key, { task: event.task, model: modelOf(event), at })
        break
      }
      case 'run_exited':
        // By run id, and by task for an exit that lost it: a run left open
        // would otherwise count to now for ever.
        if (open.has(keyOf(event))) close(keyOf(event), at, false)
        else if (event.task) closeTask(open, event.task, (key) => close(key, at, false))
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
  // Whatever is still open is still running.
  for (const key of [...open.keys()]) close(key, now, true)
  return report
}

/** The key a run is tracked under: its own id, or its task when it has none. */
function keyOf(event: TadeEvent): string {
  return event.run ?? `task:${event.task ?? ''}`
}

function closeTask(open: Map<string, Open>, task: string, close: (key: string) => void): void {
  for (const [key, run] of [...open]) if (run.task === task) close(key)
}

function modelOf(event: TadeEvent): string {
  const model = event.detail.model
  return typeof model === 'string' && model !== '' ? model : 'unknown'
}

function into(buckets: Record<string, Runtime>, key: string): Runtime {
  const found = buckets[key] ?? noRuntime()
  buckets[key] = found
  return found
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
