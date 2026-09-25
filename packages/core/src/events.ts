import { z } from 'zod'

// The event log is the system's memory: append-only, and the journal that
// answers "what was I doing last Tuesday". Every event carries an urgency,
// and the attention policy decides which surfaces render it.

export const Urgency = z.enum(['blocking', 'notable', 'routine', 'trace'])
export type Urgency = z.infer<typeof Urgency>

/** Lower is more important. Used for ordering and for dropping under pressure. */
export const URGENCY_RANK: Record<Urgency, number> = {
  blocking: 0,
  notable: 1,
  routine: 2,
  trace: 3,
}

export const EventType = z.enum([
  // lanes
  'lane_opened',
  /** Picked up again on open, still running from a previous window. */
  'lane_adopted',
  'lane_exited',
  'lane_closed',
  'output',
  'input',
  // tasks
  'task_created',
  /** An agent that started without a branch got one, named for its work. */
  'task_named',
  'task_removed',
  /**
   * A change that spans repositories was named: its slug and the sentence
   * that asked for it, verbatim, written once when the plan is made. The
   * effort itself is the fold of the task files that name it — this is here
   * for the same reason `intent_spoken` is, because nothing else can recover
   * the sentence once those files are gone.
   */
  'effort_named',
  'state_change',
  /**
   * A task finished: its agent said so, a person marked it, or Tade saw its
   * own rule met. What work waiting on it waits for.
   */
  'task_done',
  // the queue
  /** Queued work started: what it waited on finished, its time came, or someone started it. */
  'queue_started',
  /** Queued work is held: what it waits on failed, stopped or went, or it could not start. */
  'queue_held',
  /** Someone changed queued work: paused it, resumed it, started it anyway, or chose to wait. */
  'queue_changed',
  /** A schedule came due: what it did then — or that it skipped runs Tade was closed for. */
  'schedule_fired',
  /** A schedule was made, renamed, paused, resumed or removed, and by whom. */
  'schedule_changed',
  /** A watch looked: how much it found, how much was new, where its next look starts — or why it could not. */
  'watch_checked',
  /** Something a watch found for the first time, and the work started on it or who was told. */
  'watch_found',
  // agents
  'run_started',
  /**
   * What a run turned out to be on, the moment its harness said so.
   *
   * `run_started` can only record what was *asked* for, and with nothing asked
   * for there is nothing to ask for: pi picks by what you are signed in to, so
   * 86 of the 161 runs in the journal this was written from named no model at
   * all and every hour they ran was time attributed to nothing. A harness says
   * which model it opened on before it does any work, and a run that never
   * bills says it and nothing else — so this is the only place it can be, and
   * a fact not written down when it was true is a question nobody can answer
   * later. Which harness, sign-in and provider it was on rides along with it,
   * as it does on `usage`: a model is the harness's own, and one read back
   * without the harness that ran it is a name nobody can hand anywhere.
   */
  'run_model',
  'run_exited',
  'tool_call',
  'permission_request',
  'permission_granted',
  'permission_denied',
  /**
   * A turn began: the moment a model started working, as its harness said so.
   *
   * How long an agent *ran* is the span its lane was open, which counts every
   * hour it sat finished waiting for somebody to read it — the honest answer
   * to "how long was it there" and the wrong answer to "how long was it
   * working". The second needs the beginnings of turns, and the journal that
   * produced this comment had 7,090 `turn_done` in it and not one thing saying
   * when any of them started, so the question could not be asked of a single
   * hour of history.
   *
   * All three harnesses already say it (`turn_started` on the wire) and the
   * supervisor already reads it to time its spans; what was missing was
   * writing it down. Nothing keeps a stopwatch: this is the beginning and
   * `turn_done` is the end, and `runtimeFrom` folds the pair.
   */
  'turn_started',
  'turn_done',
  'failed',
  /** What a turn consumed, in tokens and money. */
  'usage',
  /** A finished task was looked back over, so it is never looked at twice. */
  'reflected',
  // what was verified, and what was written
  /**
   * A check finished, against the commit it checked. The run itself is kept in
   * the worktree it ran in, which goes when the worktree does; this is the
   * line that outlives it, so "how often does `types` fail, and how long does
   * it take" stays answerable after the work is merged and cleaned up.
   */
  'check_ran',
  /**
   * A commit was seen for the first time, and what it changed. Written once
   * per commit, by sha, so a look that reads the same history twice counts it
   * once — and so the numbers survive the worktree being removed, which is
   * what re-reading `git log` every time would not.
   */
  'commit_seen',
  /**
   * Tade added its own files to a project's ignore rules, and which lines it
   * added. It edits a file that is not its own, once, the first time it works
   * there — so the one line saying it did is what makes that undoable rather
   * than mysterious.
   */
  'ignore_written',
  /**
   * The journal was compacted: what was dropped, what is left, and what the
   * file weighed before and after.
   *
   * Compaction removes lines from the one file that is the truth, so the line
   * saying it happened is what makes that readable rather than mysterious —
   * the same reason `ignore_written` exists. It is written after the fact and
   * only when something was actually dropped, so a journal with none of these
   * in it has never had anything taken out of it.
   */
  'journal_compacted',
  /**
   * What Tade has been told was changed: a setting written, a project opened
   * or closed. What it was before is in the line, because the config is one
   * file that is rewritten in place and nothing else remembers — so a change
   * made through a tool, by somebody who was not at the keyboard, is a line
   * anybody can read and undo rather than a value that is simply different
   * now. Who asked is on it, and where their own words were what allowed it,
   * so are they.
   */
  'config_changed',
  // you
  /** A line you said or typed to Tade, verbatim: what up and ctrl+r bring back. */
  'said',
  // the workbench itself
  'tade_opened',
  'tade_closing',
  'warning',
])
export type EventType = z.infer<typeof EventType>

export const DEFAULT_URGENCY: Record<EventType, Urgency> = {
  lane_opened: 'notable',
  lane_adopted: 'notable',
  lane_exited: 'notable',
  lane_closed: 'routine',
  output: 'trace',
  input: 'trace',
  task_created: 'notable',
  task_named: 'notable',
  task_removed: 'notable',
  effort_named: 'notable',
  state_change: 'notable',
  task_done: 'notable',
  queue_started: 'notable',
  // Not blocking: nothing is running into a wall, and the orchestrator is told
  // in words. Blocking would raise a pane for work that has none.
  queue_held: 'notable',
  queue_changed: 'notable',
  schedule_fired: 'notable',
  schedule_changed: 'notable',
  // Routine: it looks on a clock, and a look that found nothing is not news.
  // What it found is, and that is `watch_found`.
  watch_checked: 'routine',
  watch_found: 'notable',
  run_started: 'notable',
  // Routine rather than trace, for the reason `usage` is: it is read back out
  // of the journal to be added up, and trace is the first thing dropped when a
  // subscriber falls behind — which here would mean an agent's hours going to
  // the bucket for nothing recorded, silently.
  run_model: 'routine',
  run_exited: 'notable',
  tool_call: 'routine',
  permission_request: 'blocking',
  permission_granted: 'routine',
  permission_denied: 'routine',
  // Routine rather than notable, and never trace. Not notable, because a turn
  // beginning is not news — the window already draws the agent as busy, and an
  // earcon per turn start is a metronome. Never trace, for the reason `usage`
  // is not: it is read back out of the journal to be added up, and trace is
  // the first thing dropped when a subscriber falls behind — which here would
  // mean a turn whose end was written and whose beginning was not, and so an
  // agent's working time silently reading as unknown.
  turn_started: 'routine',
  turn_done: 'notable',
  failed: 'blocking',
  // Routine rather than trace: spend is read back out of the journal, and
  // trace is the first thing dropped when a subscriber falls behind.
  usage: 'routine',
  // Nobody needs to be told that Tade thought about something.
  reflected: 'trace',
  // Routine rather than trace, for the same reason `usage` is: both are read
  // back out of the journal to be added up, and trace is the first thing
  // dropped when a subscriber falls behind. A statistic with holes in it that
  // nothing announces is worse than no statistic.
  check_ran: 'routine',
  commit_seen: 'routine',
  // Routine, for the same reason `commit_seen` is: a fact written down once so
  // it can be read back, not something to interrupt anybody with. The change
  // itself is already in `git status` and in the diff, which is where somebody
  // sees it; what this line adds is who put it there.
  ignore_written: 'routine',
  // Notable rather than routine, which is where the other written-once facts
  // are: this one is fsync'd, because it is the record of a destructive act
  // and a window that crashed just after compacting must not come back with
  // the lines gone and nothing saying who took them.
  journal_compacted: 'notable',
  // Notable, unlike the other things written down once: the rest are facts
  // being recorded, and this is somebody changing how Tade behaves. A person
  // who did not make the change is the one who most needs to see it.
  config_changed: 'notable',
  said: 'routine',
  tade_opened: 'notable',
  tade_closing: 'notable',
  warning: 'notable',
}

/**
 * Names events were written under before the project was renamed. Tade never
 * writes one — it only reads them, because events.jsonl is append-only and is
 * the truth: a journal from before the rename still says when the window
 * opened and closed, and a reader that does not know the old word silently
 * loses those facts. That is not hypothetical — it is how runs from days
 * earlier stayed open and went on counting to now: nothing closed them,
 * because the closings were called something else, and a week of runtime
 * landed in a morning's total.
 *
 * An alias read rather than another `EventType`: what Tade writes stays one
 * list nobody can add an old name back to, and what it can read is the longer
 * one. Filters are widened for the same reason — asking for `tade_opened`
 * asks about window openings, whatever they were called when they happened.
 */
export const RENAMED_TYPES = {
  wilco_opened: 'tade_opened',
  wilco_closing: 'tade_closing',
} as const satisfies Record<string, EventType>

/** A name in the journal that Tade no longer writes. */
export type LegacyEventType = keyof typeof RENAMED_TYPES

/** Anything a reader may ask for: what is written now, and what once was. */
export type ReadableEventType = EventType | LegacyEventType

/** What a name in the journal means now. Anything current is itself. */
export function typeNow(type: string): EventType {
  return (RENAMED_TYPES as Record<string, EventType>)[type] ?? (type as EventType)
}

/**
 * Every name in the journal that reads as one of these types — for a filter
 * that matches on the stored word, like the index's `type IN (...)`.
 */
export function typeNames(types: readonly ReadableEventType[]): string[] {
  const wanted = new Set(types.map(typeNow))
  const names = new Set<string>(types)
  for (const [was, now] of Object.entries(RENAMED_TYPES)) if (wanted.has(now)) names.add(was)
  return [...names]
}

export const TadeEvent = z.object({
  /** Monotonic per log file, assigned on append. */
  seq: z.int().nonnegative(),
  ts: z.string(),
  type: EventType,
  urgency: Urgency,
  task: z.string().nullable().default(null),
  lane: z.string().nullable().default(null),
  run: z.string().nullable().default(null),
  detail: z.record(z.string(), z.unknown()).default({}),
})
export type TadeEvent = z.infer<typeof TadeEvent>

/** What callers pass to `append`: the log fills in seq, ts and the default urgency. */
export interface EventInput {
  type: EventType
  urgency?: Urgency
  task?: string | null
  lane?: string | null
  run?: string | null
  detail?: Record<string, unknown>
}

export interface EventFilter {
  /** Only events with `seq` greater than this. */
  since?: number
  task?: string
  lane?: string
  /** Matched by what a type means now, so an old name answers for the new one. */
  types?: readonly ReadableEventType[]
  /** Only events at least this urgent. */
  minUrgency?: Urgency
  limit?: number
}

export function matchesFilter(e: TadeEvent, f: EventFilter): boolean {
  if (f.since !== undefined && e.seq <= f.since) return false
  if (f.task !== undefined && e.task !== f.task) return false
  if (f.lane !== undefined && e.lane !== f.lane) return false
  if (f.types && !f.types.some((type) => typeNow(type) === typeNow(e.type))) return false
  if (f.minUrgency && URGENCY_RANK[e.urgency] > URGENCY_RANK[f.minUrgency]) return false
  return true
}
