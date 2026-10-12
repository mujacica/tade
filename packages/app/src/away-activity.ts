import type { TadeEvent } from '@tade/core'
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
// **Bounded twice, and newest first.** The window holds the whole journal, so
// this walks it from the end and stops at `most + 1` lines about this task —
// the one more is what lets the page say *there was more* — or after `SCAN`
// lines of anything, so a task whose last word was a week of other tasks ago
// costs a fixed amount to ask about rather than a fold over everything.
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

/** The newest moments of one task's life, at most `most + 1` of them. */
export function activityIn(
  events: readonly TadeEvent[],
  task: string,
  most: number,
  scan: number = SCAN,
): ActivityIn[] {
  const out: ActivityIn[] = []
  const stop = Math.max(0, events.length - scan)
  for (let at = events.length - 1; at >= stop && out.length <= most; at -= 1) {
    const event = events[at]
    if (event === undefined || event.task !== task) continue
    const kind = KINDS[event.type]
    if (kind === undefined) continue
    const when = Date.parse(event.ts)
    if (Number.isNaN(when)) continue
    out.push({
      at: when,
      kind,
      what: NAMED.has(kind) ? whatOf(event, kind) : '',
      ok: okOf(event, kind),
    })
  }
  return out
}
