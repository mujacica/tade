import { type ReadableEventType, type TadeEvent, typeNow } from '@tade/core'
import type { ActivityIn, ActivityKind } from '@tade/web'

// What one task has been doing, out of the journal the window already holds,
// as the away view's agent page takes it.
//
// **An allow-list over event types, and a second one over the fields read.**
// A journal line's `detail` carries whatever its writer put there — a
// permission request's `summary` is the command itself, a tool call's `input`
// is its arguments, `run_started` carries the working directory — so nothing
// here spreads a detail or reads one it was not told to. What crosses is a
// kind, a moment, and at most one *name* (a tool's, a check's, a state's),
// which `@tade/web` holds to looking like one before it goes in a sentence.
//
// **The newest stretch out of what the window holds, and the rest by number.**
// The window holds the journal's newest lines, so this walks them from the end
// and stops at `most` moments about this task, or after `SCAN` lines of
// anything — and says where it stopped: the number the moments before are read
// from, out of the journal itself and off the window's thread
// (`Workbench.eventsBefore`), as somebody scrolls the timeline on to the
// task's first moment (`momentsOf`). Its making is its first, so nothing is
// asked for before that.
//
// Pure: a function of the events, the task and the bounds.

/** How many journal lines one ask may look through, whatever they are about. */
export const SCAN = 5_000

/** Which event types are a moment worth telling, and as what. */
const KINDS: Readonly<Partial<Record<TadeEvent['type'], ActivityKind>>> = {
  task_created: 'made',
  state_change: 'state',
  run_started: 'started',
  run_exited: 'stopped',
  turn_done: 'turn',
  tool_call: 'used',
  permission_request: 'asked',
  permission_granted: 'allowed',
  permission_denied: 'refused',
  check_ran: 'checked',
  commit_seen: 'committed',
  task_done: 'finished',
  context_added: 'told',
  failed: 'failed',
}

/** The types a moment is made of, which a read further back asks the journal for. */
export const ACTIVITY_TYPES = Object.keys(KINDS) as ReadableEventType[]

/** The kinds that are about a name; every other kind carries none. */
const NAMED = new Set<ActivityKind>(['used', 'asked', 'allowed', 'refused', 'state', 'checked'])

/** The one name a moment is about, read out of the one field that holds it. */
function whatOf(event: TadeEvent, kind: ActivityKind): string {
  const field = kind === 'state' ? 'state' : kind === 'checked' ? 'check' : 'tool'
  const value = event.detail[field]
  return typeof value === 'string' ? value : ''
}

/** Whether it went well, where that is a question this kind can answer. */
function okOf(event: TadeEvent, kind: ActivityKind): boolean | null {
  if (kind === 'turn') return event.detail.status === 'ok'
  if (kind === 'checked') {
    if (event.detail.state === 'pass') return true
    if (event.detail.state === 'fail') return false
  }
  return null
}

/** One line as a moment, or null for a line that is not one or says no time. */
function momentOf(event: TadeEvent): ActivityIn | null {
  const kind = KINDS[typeNow(event.type) as TadeEvent['type']]
  if (kind === undefined) return null
  const when = Date.parse(event.ts)
  if (Number.isNaN(when)) return null
  return {
    id: String(event.seq),
    at: when,
    kind,
    what: NAMED.has(kind) ? whatOf(event, kind) : '',
    ok: okOf(event, kind),
  }
}

/**
 * One task's moments, and the cursor the ones before them are read from — a
 * journal line's number, which a compaction never moves or hands out again, as
 * text the page only hands back — or null at its first.
 */
export interface Moments {
  activity: ActivityIn[]
  earlier: string | null
}

/**
 * The newest moments of one task's life the window holds, at most `most` of
 * them, newest first, and where the ones before them are: the number of the
 * oldest here where `most` stopped it, else of the oldest line looked at.
 */
export function activityIn(
  events: readonly TadeEvent[],
  task: string,
  most: number,
  scan: number = SCAN,
): Moments {
  const activity: ActivityIn[] = []
  const stop = Math.max(0, events.length - scan)
  for (let at = events.length - 1; at >= stop; at -= 1) {
    const event = events[at]
    if (event === undefined || event.task !== task) continue
    const one = momentOf(event)
    if (one === null) continue
    activity.push(one)
    if (one.kind === 'made') return { activity, earlier: null }
    if (activity.length >= most) return { activity, earlier: one.id }
  }
  const from = events[stop]
  return { activity, earlier: from === undefined ? null : String(from.seq) }
}

/**
 * Lines read out of the journal before a number, newest first and at most
 * `most` of them, as moments: fewer than were asked for, or its making, is
 * its first.
 */
export function momentsOf(events: readonly TadeEvent[], most: number): Moments {
  const activity: ActivityIn[] = []
  for (const event of events) {
    const one = momentOf(event)
    if (one === null) continue
    activity.push(one)
    if (one.kind === 'made') return { activity, earlier: null }
  }
  const oldest = events.at(-1)
  return {
    activity,
    earlier: events.length < most || oldest === undefined ? null : String(oldest.seq),
  }
}
