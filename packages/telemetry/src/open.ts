import type { WilcoEvent } from '@wilco/core'
import { noReporter } from './none.ts'
import { REPORTERS, type Reporter, type ReporterOptions } from './port.ts'
import { sentryReporter } from './sentry.ts'
import { fromEvent } from './shape.ts'

// Opening a reporter, and the three things that feed one: the journal, the
// process, and whatever else chooses to say something went wrong.

REPORTERS.sentry = sentryReporter
REPORTERS.none = () => noReporter()

/** What the config says about reporting, as a reporter is opened from it. */
export interface TelemetryConfig {
  driver: string
  dsn?: string | undefined
  errors: boolean
  logs: boolean
  metrics: boolean
  environment?: string | undefined
}

/**
 * The reporter this Wilco runs with. Nothing is sent unless somewhere to send
 * it was set, so the answer is `none` until someone asks for more.
 */
export function openReporter(
  config: TelemetryConfig,
  extras: {
    release: string
    home: string
    fetch?: typeof fetch
    now?: () => number
    everyMs?: number
  },
): Reporter {
  const dsn = (config.dsn ?? '').trim()
  const make = REPORTERS[config.driver]
  if (!dsn || !make) return noReporter()
  const options: ReporterOptions = {
    dsn,
    release: extras.release,
    environment: config.environment ?? 'laptop',
    errors: config.errors,
    logs: config.logs,
    metrics: config.metrics,
    home: extras.home,
    ...(extras.fetch ? { fetch: extras.fetch } : {}),
    ...(extras.now ? { now: extras.now } : {}),
    ...(extras.everyMs ? { everyMs: extras.everyMs } : {}),
  }
  return make(options)
}

/** A journal event, reported as whatever it is worth: an issue, a line, a number. */
export function saw(reporter: Reporter, event: WilcoEvent, home: string): void {
  if (!reporter.on) return
  const what = fromEvent(event, home)
  if (what.trouble) reporter.trouble(what.trouble)
  if (what.note) reporter.note(what.note)
  for (const measure of what.measures ?? []) reporter.measure(measure)
}

/**
 * Report what takes the process down, and keep what Node does about it: an
 * uncaught exception still ends Wilco, after whoever is holding the terminal
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
