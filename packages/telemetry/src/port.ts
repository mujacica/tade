import type { TadeEvent } from '@tade/core'

// Where Tade's own trouble goes.
//
// Everything here is about Tade itself — a crash in the window, a driver it
// could not use, how long its agents' turns took — never about your code or
// what you said about it. What is sent is the shape of what happened: types,
// names, counts and Tade's own words. What you typed, what an agent wrote and
// what it was working on are not Tade's to send, and `scrub` is where that is
// decided rather than at each call.
//
// A reporter never throws and never blocks: it queues, sends in the background,
// and gives up quietly. Nothing Tade does may fail because reporting did.

/** How bad something is. */
export type Level = 'fatal' | 'error' | 'warning' | 'info' | 'debug'

/** What goes beside anything reported: names, counts, and Tade's own words. */
export type Attributes = Readonly<Record<string, string | number | boolean>>

/** Something that went wrong in Tade, as an issue someone could fix. */
export interface Trouble {
  /** What was thrown, or what was said when nothing was. */
  error: unknown
  /** Where it happened, in a few words: `the window`, `a schedule`, `tade status`. */
  where: string
  level?: 'fatal' | 'error' | 'warning'
  /** What it was about, when it was about one task. */
  task?: string
  project?: string
  /**
   * What to group it by instead of its stack, for trouble that has none.
   * Keep the parts stable: a number or a path in one makes every one its own.
   */
  fingerprint?: readonly string[]
  /** More about it: names, counts and Tade's own words, never anybody's text. */
  about?: Attributes
}

/** A line about something that happened, for reading beside the trouble. */
export interface Note {
  at: number
  level: Level
  said: string
  about?: Attributes
}

/** A number worth watching over time. */
export interface Measure {
  at: number
  /** Dotted and lowercase: `tade.agents`. */
  name: string
  kind: 'counter' | 'gauge' | 'distribution'
  value: number
  /** What the number is in: `token`, `usd`, `millisecond`. */
  unit?: string
  about?: Attributes
}

/** Something Tade is doing, while it does it. Every one that starts must end. */
export interface Span {
  /** More about it, as it becomes known. */
  about(attributes: Attributes): void
  /** Something that happened inside it, which ends before this does. */
  inside(what: Work): Span
  /** It went wrong, with what went wrong. Ending is still yours to do. */
  wrong(error: unknown): void
  end(at?: number): void
}

/** Something to time. */
export interface Work {
  /** What it is, as a person would say it: `invoke_agent app/refunds`. */
  name: string
  /** What kind of work: `gen_ai.invoke_agent`, `tade.poll`. Sentry groups by these. */
  op: string
  attributes?: Attributes
  /** When it started, for work that is timed after the fact. Now, unless said. */
  startedAt?: number
}

/** What a reporter is given when it is opened. */
export interface ReporterOptions {
  /** Where to send, in whatever form the reporter takes. Empty means nowhere. */
  dsn: string
  /** Tade's version, so an issue says which one it happened in. */
  release: string
  /** Which Tade this is: `laptop`, `ci`. */
  environment: string
  /** What to send at all. */
  errors: boolean
  logs: boolean
  metrics: boolean
  /** How much of what Tade does is timed, 0 to 1. Agents' turns are always. */
  traces: number
  /** Time what agents do, as the work of a model: turns, tool calls, tokens. */
  agents: boolean
  /** Replaced with `~` wherever it appears, so no path says who you are. */
  home: string
  /** Where Tade itself is, so a stack frame in it is one you could fix. */
  root?: string
  /**
   * Somewhere to put what would have been sent, instead of sending it. For
   * tests and the conformance suite: nothing else has a reason to look.
   */
  sink?: (envelope: unknown) => void
  now?: () => number
}

/**
 * Where Tade's own trouble goes. Implementations are registered by name in
 * `REPORTERS`; nothing calls one directly.
 */
export interface Reporter {
  readonly id: string
  /** Whether anything is actually sent. False is a working reporter that sends nothing. */
  readonly on: boolean
  /** Something went wrong. */
  trouble(trouble: Trouble): void
  /** Something happened, worth reading later. */
  note(note: Note): void
  /** A number, now. */
  measure(measure: Measure): void
  /** Time something. The span it answers with must be ended. */
  doing(work: Work): Span
  /** Send what is queued, giving up after `ms`. Never throws. */
  flush(ms?: number): Promise<void>
  /** Send what is left and stop. Never throws. */
  close(): Promise<void>
}

export type MakeReporter = (options: ReporterOptions) => Promise<Reporter>

/** Every reporter there is, by name. Call sites never `new` one. */
export const REPORTERS: Record<string, MakeReporter> = {}

/** What a journal event becomes: trouble to fix, a line to read, or numbers to watch. */
export interface FromEvent {
  trouble?: Trouble
  note?: Note
  measures?: Measure[]
}

export type Reported = (event: TadeEvent) => void
