import type { EventType, Urgency } from './events.ts'

// What a writer hands the journal, beside `events.ts` rather than in it
// because it is a different question — not what a line is, but what a caller
// must say to write one.

interface EventBase {
  urgency?: Urgency
  task?: string | null
  lane?: string | null
  run?: string | null
}

/**
 * What callers pass to `append`: the log fills in seq, ts and the default urgency.
 *
 * **A warning's words are its `message`**, and the type holds every writer to
 * it, because nothing else would: telemetry sends `message` as the issue's
 * title and `attention` reads it, and the away view once wrote its warnings
 * under `warning`, which both read past — every one reached Sentry as
 * `tade: something`, one issue for all of them, saying none of them.
 */
export type EventInput =
  | (EventBase & { type: 'warning'; detail: { message: string } & Record<string, unknown> })
  | (EventBase & { type: Exclude<EventType, 'warning'>; detail?: Record<string, unknown> })
