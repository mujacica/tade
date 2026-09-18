import type { TadeEvent } from '@tade/core'
import { noReporter } from './none.ts'
import { REPORTERS, type Reporter, type ReporterOptions } from './port.ts'
import { sentryReporter } from './sentry.ts'
import { fromEvent } from './shape.ts'

// Opening a reporter, and the things that feed one: the journal, the process,
// and whatever else chooses to say something went wrong.

REPORTERS.sentry = sentryReporter
REPORTERS.none = async () => noReporter()

/** What the config says about reporting, as a reporter is opened from it. */
export interface TelemetryConfig {
  driver: string
  dsn?: string | undefined
  errors: boolean
  logs: boolean
  metrics: boolean
  /** How much of what Tade does is timed, 0 to 1. Agents' turns are always. */
  traces: number
  /** Time what agents do, as the work of a model: turns, tool calls, tokens. */
  agents: boolean
  environment?: string | undefined
}

/** What a reporter needs that the config does not say. */
export interface TelemetryHere {
  release: string
  /** The person's home, replaced with `~` in everything sent. */
  home: string
  /** Where Tade itself is, so a stack frame in it is one you could fix. */
  root?: string
  /** Somewhere to put what would have been sent, for tests. */
  sink?: (envelope: unknown) => void
  now?: () => number
}

/**
 * The reporter this Tade runs with. Nothing is sent unless somewhere to send
 * it was set, so the answer is `none` until someone asks for more — and a
 * reporter that cannot be opened is never the reason Tade does not open.
 */
export async function openReporter(
  config: TelemetryConfig,
  here: TelemetryHere,
): Promise<Reporter> {
  const dsn = (config.dsn ?? '').trim()
  const make = REPORTERS[config.driver]
  if (!dsn || !make) return noReporter()
  const options: ReporterOptions = {
    dsn,
    release: here.release,
    environment: config.environment ?? 'laptop',
    errors: config.errors,
    logs: config.logs,
    metrics: config.metrics,
    traces: config.traces,
    agents: config.agents,
    home: here.home,
    ...(here.root ? { root: here.root } : {}),
    ...(here.sink ? { sink: here.sink } : {}),
    ...(here.now ? { now: here.now } : {}),
  }
  return make(options).catch(() => noReporter())
}

/** A journal event, reported as whatever it is worth: an issue, a line, a number. */
export function saw(reporter: Reporter, event: TadeEvent, home: string): void {
  if (!reporter.on) return
  const what = fromEvent(event, home)
  if (what.trouble) reporter.trouble(what.trouble)
  if (what.note) reporter.note(what.note)
  for (const measure of what.measures ?? []) reporter.measure(measure)
}

/**
 * Report what takes the process down, and keep what Node does about it: an
 * uncaught exception still ends Tade, after whoever is holding the terminal
 * has had it back and the crash has had its one chance to be sent.
 */
export function watchProcess(
  reporter: Reporter,
  opts: { where: string; onFatal?: () => void | Promise<void>; exit?: (code: number) => void },
): () => void {
  const exit = opts.exit ?? ((code: number) => process.exit(code))
  const crashed = (error: unknown) => {
    reporter.trouble({ error, where: opts.where, level: 'fatal' })
    void (async () => {
      await Promise.resolve(opts.onFatal?.()).catch(() => {})
      await reporter.flush(2_000)
      exit(1)
    })()
  }
  const rejected = (reason: unknown) => {
    // Node's own answer to an unhandled rejection is to take the process down
    // through the handler above; this only makes sure it is reported first.
    reporter.trouble({ error: reason, where: opts.where, level: 'error' })
    throw reason
  }
  process.on('uncaughtException', crashed)
  process.on('unhandledRejection', rejected)
  return () => {
    process.removeListener('uncaughtException', crashed)
    process.removeListener('unhandledRejection', rejected)
  }
}
