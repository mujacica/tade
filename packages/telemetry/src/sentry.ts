import type { Event, Span as SentrySpan, StackFrame } from '@sentry/node'
import { noSpan } from './none.ts'
import type { Attributes, Reporter, ReporterOptions, Span, Work } from './port.ts'
import { readDsn, scrub, shapeOf } from './shape.ts'

// Tade's own trouble, in Sentry's own SDK.
//
// The SDK rather than the envelope protocol by hand, because what is wanted
// here is not a request: it is a tracer — spans for what Tade does, `gen_ai`
// spans for what its agents do, logs beside them, and all the parts nobody
// should write twice (sampling, batching, back-off, release health).
//
// It is loaded only when there is a DSN, so a Tade that reports nothing pays
// nothing for the choice. Nothing is instrumented automatically: Tade's own
// work is named where it happens, which is the part worth reading, and the
// hooks Node's ESM loader would need are left alone.

/** How long anything reported may be: enough to read, never a document. */
const VALUE_MAX = 200

/** What the SDK is told, and what it is told not to do. */
async function start(options: ReporterOptions): Promise<typeof import('@sentry/node')> {
  const Sentry = await import('@sentry/node')
  Sentry.init({
    dsn: options.dsn,
    release: options.release,
    environment: options.environment,
    enableLogs: options.logs,
    // Agents' turns are few and worth every one; Tade's own work is constant.
    tracesSampler: ({ attributes, name }) => {
      const op = String(attributes?.['sentry.op'] ?? '')
      if (op.startsWith('gen_ai.')) return options.agents ? 1 : 0
      return name === '' ? 0 : options.traces
    },
    // Nothing automatic: no http or file instrumentation, and none of the ESM
    // loader hooks it would need — a window must not have its terminal written
    // over by somebody else's deprecation warning.
    defaultIntegrations: false,
    registerEsmLoaderHooks: false,
    integrations: [
      Sentry.dedupeIntegration(),
      Sentry.linkedErrorsIntegration(),
      Sentry.functionToStringIntegration(),
      // The lines around a frame, so an agent sent to fix it can read it.
      Sentry.contextLinesIntegration(),
    ],
    beforeSend: (event) => (options.errors ? clean(event, options) : null),
    beforeSendTransaction: (event) => clean(event, options),
    beforeSendLog: (log) => (options.logs ? log : null),
    ...(options.sink
      ? {
          transport: () => ({
            send: async (envelope: unknown) => {
              options.sink?.(envelope)
              return {}
            },
            flush: async () => true,
          }),
        }
      : {}),
  })
  return Sentry
}

/**
 * What leaves, once: the machine's name and its paths gone, and source lines
 * kept only for Tade's own files — the frames of anything else are somebody
 * else's code, which is not Tade's to send anywhere.
 */
function clean<T extends Event>(event: T, options: ReporterOptions): T {
  event.server_name = undefined
  const root = options.root ?? ''
  for (const one of event.exception?.values ?? []) {
    for (const frame of one.stacktrace?.frames ?? []) keepOwn(frame, options.home, root)
    if (one.value) one.value = scrub(one.value, options.home).slice(0, VALUE_MAX * 4)
  }
  if (typeof event.message === 'string') event.message = scrub(event.message, options.home)
  return event
}

function keepOwn(frame: StackFrame, home: string, root: string): void {
  const file = frame.abs_path ?? frame.filename ?? ''
  // Tade installed is itself inside a `node_modules`, so what matters is
  // whether there is another one under it: that is somebody else's code.
  const own =
    root !== '' && file.startsWith(root) && !file.slice(root.length).includes('node_modules')
  frame.in_app = own
  if (!own) {
    frame.pre_context = undefined
    frame.context_line = undefined
    frame.post_context = undefined
  }
  if (frame.filename) frame.filename = scrub(frame.filename, home)
  if (frame.abs_path) frame.abs_path = scrub(frame.abs_path, home)
}

/** A span of the SDK's, as the port has one. */
function wrap(Sentry: typeof import('@sentry/node'), span: SentrySpan): Span {
  return {
    about(attributes: Attributes) {
      span.setAttributes({ ...attributes })
    },
    inside(work: Work) {
      return wrap(
        Sentry,
        Sentry.withActiveSpan(span, () =>
          Sentry.startInactiveSpan({
            name: work.name,
            op: work.op,
            ...(work.attributes ? { attributes: { ...work.attributes } } : {}),
            ...(work.startedAt ? { startTime: work.startedAt } : {}),
          }),
        ),
      )
    },
    wrong(error: unknown) {
      span.setStatus({ code: 2, message: 'internal_error' })
      Sentry.captureException(error)
    },
    end(at?: number) {
      span.end(at)
    },
  }
}

export async function sentryReporter(options: ReporterOptions): Promise<Reporter> {
  const dsn = options.dsn ? readDsn(options.dsn) : null
  if (!dsn) {
    const { noReporter } = await import('./none.ts')
    return { ...noReporter(), id: 'sentry' }
  }
  const Sentry = await start(options)
  const now = options.now ?? Date.now
  // One session for this run of Tade: what makes "how often does it crash" a
  // question with an answer.
  Sentry.startSession()
  let closed = false

  return {
    id: 'sentry',
    on: true,
    trouble(trouble) {
      if (closed || !options.errors) return
      Sentry.withScope((scope) => {
        scope.setTag('where', trouble.where)
        if (trouble.task) scope.setTag('task', trouble.task)
        if (trouble.project) scope.setTag('project', trouble.project)
        if (trouble.fingerprint) scope.setFingerprint([...trouble.fingerprint])
        scope.setLevel(trouble.level ?? 'error')
        scope.setContext('tade', { ...(trouble.about ?? {}) })
        const error = trouble.error
        if (error instanceof Error) Sentry.captureException(error)
        else {
          // Nothing with a stack to group by: what it says is what it is.
          const said = typeof error === 'string' ? error : JSON.stringify(error)
          scope.setFingerprint([...(trouble.fingerprint ?? ['tade', shapeOf(said ?? '')])])
          Sentry.captureMessage(`${trouble.where}: ${scrub(said ?? 'something', options.home)}`)
        }
      })
    },
    note(note) {
      if (closed || !options.logs) return
      const said = scrub(note.said, options.home).slice(0, VALUE_MAX * 4)
      const about = { ...(note.about ?? {}) }
      if (note.level === 'error') Sentry.logger.error(said, about)
      else if (note.level === 'warning') Sentry.logger.warn(said, about)
      else if (note.level === 'debug') Sentry.logger.debug(said, about)
      else Sentry.logger.info(said, about)
    },
    measure(measure) {
      if (closed || !options.metrics) return
      const at = { ...(measure.about ?? {}), ...(measure.unit ? { unit: measure.unit } : {}) }
      if (measure.kind === 'counter') Sentry.metrics.count(measure.name, measure.value, at)
      else if (measure.kind === 'gauge') Sentry.metrics.gauge(measure.name, measure.value, at)
      else Sentry.metrics.distribution(measure.name, measure.value, at)
    },
    doing(work) {
      // Whether it is worth keeping is the sampler's to say, in one place.
      if (closed) return noSpan
      return wrap(
        Sentry,
        Sentry.startInactiveSpan({
          name: work.name,
          op: work.op,
          ...(work.attributes ? { attributes: { ...work.attributes } } : {}),
          ...(work.startedAt ? { startTime: work.startedAt } : {}),
        }),
      )
    },
    async flush(ms = 2_000) {
      await Sentry.flush(ms).catch(() => false)
    },
    async close() {
      if (closed) return
      closed = true
      Sentry.endSession()
      await Sentry.close(2_000).catch(() => false)
      void now
    },
  }
}
