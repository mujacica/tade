import { randomUUID } from 'node:crypto'
import type { Measure, Note, Reporter, ReporterOptions, Trouble } from './port.ts'
import {
  auth,
  type Dsn,
  envelope,
  type Item,
  logItems,
  metricItems,
  readDsn,
  troubleEvent,
  type Where,
} from './shape.ts'

// Sending Wilco's own trouble to Sentry, over its envelope endpoint.
//
// Plain requests rather than an SDK, for the same reason the Sentry extension
// reads Sentry with plain requests: it is one implementation, it needs nothing
// installed, and what it would send can be read in a test. Nothing here is
// allowed to matter — a send that fails, a Sentry that is down, a DSN that is
// wrong: all of it is dropped quietly, because a window that crashed while
// reporting a crash is the worst thing this could be.

/** How much is held while Sentry is unreachable. Dropped oldest first. */
const TROUBLE_MAX = 50
const NOTE_MAX = 500
const MEASURE_MAX = 500
/** The same trouble again within this is the same trouble: a loop sends one. */
const AGAIN_MS = 60_000
const SEND_MS = 15_000
const EVERY_MS = 5_000

/** A run of Wilco as one trace, so everything it sent reads together. */
function traceId(): string {
  return randomUUID().replace(/-/g, '')
}

export function sentryReporter(options: ReporterOptions): Reporter {
  const dsn: Dsn | null = options.dsn ? readDsn(options.dsn) : null
  const send = options.fetch ?? globalThis.fetch.bind(globalThis)
  const now = options.now ?? Date.now
  const trace = traceId()
  const troubles: Trouble[] = []
  const notes: Note[] = []
  const measures: Measure[] = []
  const said = new Map<string, number>()
  let quietUntil = 0
  let sending: Promise<void> | null = null
  let timer: NodeJS.Timeout | null = null
  let closed = false

  const where = (): Where => ({
    release: options.release,
    environment: options.environment,
    home: options.home,
    trace,
    now: now(),
    id: traceId(),
  })

  /** The clock runs only while there is something to send. */
  function start(): void {
    if (timer || closed || !dsn) return
    timer = setInterval(() => void flush(), options.everyMs ?? EVERY_MS)
    timer.unref?.()
  }

  function stop(): void {
    if (timer) clearInterval(timer)
    timer = null
  }

  function keep<T>(queue: T[], item: T, most: number): void {
    queue.push(item)
    while (queue.length > most) queue.shift()
    start()
  }

  async function post(items: readonly Item[]): Promise<void> {
    if (!dsn || items.length === 0) return
    const body = envelope({ sent_at: new Date(now()).toISOString(), dsn: options.dsn }, items)
    try {
      const answer = await send(dsn.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-sentry-envelope',
          'x-sentry-auth': auth(dsn, options.release),
          'user-agent': `wilco/${options.release}`,
        },
        body,
        signal: AbortSignal.timeout(SEND_MS),
      })
      if (answer.status === 429) {
        // Told to wait: hold everything until then rather than hammering.
        const after = Number(answer.headers.get('retry-after') ?? '')
        const limits = /^(\d+)/.exec(answer.headers.get('x-sentry-rate-limits') ?? '')
        const seconds = Number.isFinite(after) && after > 0 ? after : Number(limits?.[1] ?? 60)
        quietUntil = now() + Math.min(seconds, 3_600) * 1000
      }
    } catch {
      // Unreachable, refused, or too slow. Nothing Wilco does depends on this.
    }
  }

  async function drain(): Promise<void> {
    if (!dsn || now() < quietUntil) return
    const going = troubles.splice(0, troubles.length)
    const lines = notes.splice(0, notes.length)
    const numbers = measures.splice(0, measures.length)
    // One event to an envelope, which is what Sentry keeps them as.
    for (const trouble of going) {
      await post([{ header: { type: 'event' }, payload: troubleEvent(trouble, where()) }])
    }
    const items: Item[] = []
    if (lines.length > 0) {
      items.push({
        header: {
          type: 'log',
          item_count: lines.length,
          content_type: 'application/vnd.sentry.items.log+json',
        },
        payload: logItems(lines, where()),
      })
    }
    if (numbers.length > 0) {
      items.push({
        header: {
          type: 'trace_metric',
          item_count: numbers.length,
          content_type: 'application/vnd.sentry.items.trace-metric+json',
        },
        payload: metricItems(numbers, where()),
      })
    }
    if (items.length > 0) await post(items)
    if (troubles.length === 0 && notes.length === 0 && measures.length === 0) stop()
  }

  function flush(ms?: number): Promise<void> {
    if (!dsn) return Promise.resolve()
    sending = (sending ?? Promise.resolve()).then(drain).catch(() => {})
    const going = sending
    if (ms === undefined) return going
    return Promise.race([
      going,
      new Promise<void>((done) => {
        const timeout = setTimeout(done, ms)
        timeout.unref?.()
      }),
    ])
  }

  return {
    id: 'sentry',
    on: dsn !== null,
    trouble(trouble) {
      if (!dsn || closed || !options.errors) return
      // A crash loop is one issue: the same thing again within the minute waits.
      const key = (trouble.fingerprint ?? [trouble.where, String(trouble.error)]).join('|')
      const last = said.get(key)
      if (last !== undefined && now() - last < AGAIN_MS) return
      said.set(key, now())
      if (said.size > 200) said.delete(said.keys().next().value ?? '')
      keep(troubles, trouble, TROUBLE_MAX)
      // What took the process down has one moment to be sent, and this is it.
      if (trouble.level === 'fatal') void flush()
    },
    note(note) {
      if (!dsn || closed || !options.logs) return
      keep(notes, note, NOTE_MAX)
    },
    measure(measure) {
      if (!dsn || closed || !options.metrics) return
      keep(measures, measure, MEASURE_MAX)
    },
    flush,
    async close() {
      if (closed) return
      closed = true
      await flush(2_000)
      stop()
    },
  }
}
