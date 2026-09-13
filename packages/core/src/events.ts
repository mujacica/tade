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
  'task_removed',
  'state_change',
  // agents
  'run_started',
  'run_exited',
  'tool_call',
  'permission_request',
  'permission_granted',
  'permission_denied',
  'turn_done',
  'failed',
  /** What a turn consumed, in tokens and money. */
  'usage',
  /** A finished task was looked back over, so it is never looked at twice. */
  'reflected',
  // the workbench itself
  'wilco_opened',
  'wilco_closing',
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
  task_removed: 'notable',
  state_change: 'notable',
  run_started: 'notable',
  run_exited: 'notable',
  tool_call: 'routine',
  permission_request: 'blocking',
  permission_granted: 'routine',
  permission_denied: 'routine',
  turn_done: 'notable',
  failed: 'blocking',
  // Routine rather than trace: spend is read back out of the journal, and
  // trace is the first thing dropped when a subscriber falls behind.
  usage: 'routine',
  // Nobody needs to be told that Wilco thought about something.
  reflected: 'trace',
  wilco_opened: 'notable',
  wilco_closing: 'notable',
  warning: 'notable',
}

export const WilcoEvent = z.object({
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
export type WilcoEvent = z.infer<typeof WilcoEvent>

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
  types?: EventType[]
  /** Only events at least this urgent. */
  minUrgency?: Urgency
  limit?: number
}

export function matchesFilter(e: WilcoEvent, f: EventFilter): boolean {
  if (f.since !== undefined && e.seq <= f.since) return false
  if (f.task !== undefined && e.task !== f.task) return false
  if (f.lane !== undefined && e.lane !== f.lane) return false
  if (f.types && !f.types.includes(e.type)) return false
  if (f.minUrgency && URGENCY_RANK[e.urgency] > URGENCY_RANK[f.minUrgency]) return false
  return true
}
