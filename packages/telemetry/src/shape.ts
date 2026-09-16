import type { WilcoEvent } from '@wilco/core'
import type { FromEvent, Level, Measure, Note, Trouble } from './port.ts'

// What goes on the wire, worked out in pure functions: where a DSN points,
// what a journal event is worth sending as, what a stack looks like once the
// machine's own paths are out of it, and the envelope it all travels in.
//
// Everything here is a value in and a value out, so what Wilco would send can
// be read in a test instead of sniffed on a network.

/** A DSN taken apart: where to send, and what to sign with. */
export interface Dsn {
  /** The address envelopes are posted to. */
  url: string
  /** The public key, which is all a DSN carries: it can write, and read nothing. */
  key: string
  project: string
}

/** A DSN as Sentry writes it, or null when it is not one. */
export function readDsn(dsn: string): Dsn | null {
  let url: URL
  try {
    url = new URL(dsn.trim())
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter((part) => part !== '')
  const project = parts.at(-1) ?? ''
  if (!url.username || !/^\d+$/.test(project)) return null
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
  const prefix = parts.slice(0, -1).join('/')
  return {
    url: `${url.protocol}//${url.host}${prefix ? `/${prefix}` : ''}/api/${project}/envelope/`,
    key: url.username,
    project,
  }
}

/** What a request signs itself with. */
export function auth(dsn: Dsn, release: string): string {
  return `Sentry sentry_version=7, sentry_client=wilco/${release}, sentry_key=${dsn.key}`
}

/**
 * Things that are nobody else's business, gone before anything is sent: the
 * machine's own paths, and anything shaped like a credential. Not a promise
 * that secrets are impossible — that is what the allowed keys below are for —
 * but the last net under them.
 */
const SECRETS: readonly RegExp[] = [
  /\bsntry[su]_[A-Za-z0-9_-]{8,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bey[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{8,}/g,
  /\b(?:bearer|token|authorization)[=:]\s*\S+/gi,
]

/** Text with the machine's own paths and anything secret-looking taken out. */
export function scrub(text: string, home: string): string {
  let out = text
  if (home && home !== '/' && home !== '') out = out.split(home).join('~')
  for (const secret of SECRETS) out = out.replace(secret, '…')
  return out
}

/**
 * What a message groups by: the same trouble said about different things is
 * one issue. Numbers, quoted names and paths are what differ between two of
 * the same, so they go.
 */
export function shapeOf(message: string): string {
  return message
    .toLowerCase()
    .replace(/[`"'“”][^`"'“”]*[`"'“”]/g, '…')
    .replace(/[~/][\w./-]+/g, '…')
    .replace(/\b\d+\b/g, 'n')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
}

/**
 * The only keys of a journal event's detail that are ever sent: names, counts,
 * and Wilco's own words about what happened. Anything else — what you said,
 * what an agent wrote, what a task is called — stays on your machine, and a
 * new key sends nothing until someone puts it here on purpose.
 */
const KEPT = new Set([
  'because',
  'by',
  'change',
  'code',
  'done',
  'driver',
  'exit',
  'found',
  'fresh',
  'harness',
  'kind',
  'left',
  'message',
  'missed',
  'model',
  'problem',
  'project',
  'provider',
  'ran',
  'reason',
  'rule',
  'schedule',
  'start',
  'state',
  'status',
  'stopped',
  'to',
  'tool',
  'warning',
  'watch',
  'why',
  'workspace',
])

/** How long any one value may be: enough to read, never a document. */
const VALUE_MAX = 200

/** A journal event's detail, as the few values that may be sent. */
export function about(
  detail: Readonly<Record<string, unknown>>,
  home: string,
): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(detail)) {
    if (!KEPT.has(key)) continue
    if (typeof value === 'string') out[key] = scrub(value, home).slice(0, VALUE_MAX)
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value
    else if (typeof value === 'boolean') out[key] = value
  }
  return out
}

/** A stack frame, as Sentry draws one. */
export interface Frame {
  filename: string
  function?: string
  lineno?: number
  colno?: number
  in_app: boolean
}

const AT = /^\s*at\s+(?:(?<fn>.+?)\s+\()?(?<file>[^()]+?):(?<line>\d+):(?<col>\d+)\)?\s*$/

/**
 * A stack as frames, oldest first, which is the order Sentry draws them in.
 * Frames in `node_modules` or node's own internals are not Wilco's code, and
 * are marked so the ones you can do something about stand out.
 */
export function framesOf(stack: string, home: string): Frame[] {
  const frames: Frame[] = []
  for (const line of stack.split('\n')) {
    const found = AT.exec(line)?.groups
    if (!found?.file) continue
    const file = found.file.replace(/^file:\/\//, '')
    frames.push({
      filename: scrub(file, home),
      ...(found.fn ? { function: found.fn } : {}),
      lineno: Number(found.line),
      colno: Number(found.col),
      in_app: !file.includes('node_modules') && !file.startsWith('node:'),
    })
  }
  return frames.reverse()
}

/** What was thrown, as a kind and a sentence. */
export function saidOf(error: unknown): { type: string; value: string; stack: string } {
  if (error instanceof Error) {
    return { type: error.name || 'Error', value: error.message, stack: error.stack ?? '' }
  }
  if (typeof error === 'string') return { type: 'Error', value: error, stack: '' }
  return {
    type: 'Error',
    value: JSON.stringify(error)?.slice(0, VALUE_MAX) ?? 'something',
    stack: '',
  }
}

export interface Where {
  release: string
  environment: string
  home: string
  /** One trace for this window, so everything it sent reads as one run. */
  trace: string
  now: number
  id: string
}

/** One thing that went wrong, as the event Sentry keeps. */
export function troubleEvent(trouble: Trouble, where: Where): Record<string, unknown> {
  const said = saidOf(trouble.error)
  const message = scrub(said.value, where.home)
  const frames = framesOf(said.stack, where.home)
  const tags: Record<string, string> = {
    where: trouble.where,
    ...(trouble.task ? { task: trouble.task } : {}),
    ...(trouble.project ? { project: trouble.project } : {}),
  }
  return {
    event_id: where.id,
    timestamp: where.now / 1000,
    platform: 'node',
    level: trouble.level ?? 'error',
    logger: 'wilco',
    release: where.release,
    environment: where.environment,
    contexts: {
      runtime: { name: 'node', version: process.version },
      os: { name: process.platform },
      trace: { trace_id: where.trace, span_id: where.id.slice(0, 16) },
    },
    tags,
    extra: trouble.about ?? {},
    ...(trouble.fingerprint ? { fingerprint: [...trouble.fingerprint] } : {}),
    ...(frames.length > 0
      ? { exception: { values: [{ type: said.type, value: message, stacktrace: { frames } }] } }
      : { message: { formatted: `${trouble.where}: ${message}` } }),
  }
}

/** A value as Sentry's items type them. */
function typed(value: string | number | boolean): {
  value: string | number | boolean
  type: string
} {
  if (typeof value === 'boolean') return { value, type: 'boolean' }
  if (typeof value === 'number') {
    return Number.isInteger(value) ? { value, type: 'integer' } : { value, type: 'double' }
  }
  return { value, type: 'string' }
}

function attributes(
  about: Readonly<Record<string, string | number | boolean>> | undefined,
  where: Where,
): Record<string, { value: string | number | boolean; type: string }> {
  const out: Record<string, { value: string | number | boolean; type: string }> = {
    'sentry.release': typed(where.release),
    'sentry.environment': typed(where.environment),
  }
  for (const [key, value] of Object.entries(about ?? {})) out[key] = typed(value)
  return out
}

/** Lines to read, as the item a batch of logs travels in. */
export function logItems(notes: readonly Note[], where: Where): Record<string, unknown> {
  return {
    items: notes.map((note) => ({
      timestamp: note.at / 1000,
      trace_id: where.trace,
      level: note.level,
      body: scrub(note.said, where.home).slice(0, VALUE_MAX * 4),
      attributes: attributes(note.about, where),
    })),
  }
}

/** Numbers to watch, as the item a batch of them travels in. */
export function metricItems(measures: readonly Measure[], where: Where): Record<string, unknown> {
  return {
    items: measures.map((measure) => ({
      timestamp: measure.at / 1000,
      trace_id: where.trace,
      name: measure.name,
      type: measure.kind,
      value: measure.value,
      ...(measure.unit ? { unit: measure.unit } : {}),
      attributes: attributes(measure.about, where),
    })),
  }
}

/** One item of an envelope: what it is, and what is in it. */
export interface Item {
  header: Record<string, unknown>
  payload: unknown
}

/** An envelope, as bytes: a header line, then each item's header and body. */
export function envelope(header: Record<string, unknown>, items: readonly Item[]): string {
  const lines = [JSON.stringify(header)]
  for (const item of items) {
    const body = JSON.stringify(item.payload)
    lines.push(JSON.stringify({ ...item.header, length: Buffer.byteLength(body) }), body)
  }
  return `${lines.join('\n')}\n`
}

/** Events nobody needs to see twice, and events that are nobody's business. */
const NEVER = new Set(['output', 'input', 'said'])

/**
 * What a journal event is worth sending as. Wilco's own trouble — a crash it
 * caught, a warning it wrote down — is an issue to fix. What agents did is
 * lines to read beside it and numbers to watch; what anybody said is neither.
 */
export function fromEvent(event: WilcoEvent, home: string): FromEvent {
  if (NEVER.has(event.type) || event.urgency === 'trace') return {}
  const detail = about(event.detail, home)
  const task = event.task ?? undefined
  const project = task?.split('/')[0]
  if (event.type === 'warning') {
    const message = typeof event.detail.message === 'string' ? event.detail.message : 'something'
    return {
      trouble: {
        error: scrub(message, home),
        where: 'wilco',
        level: 'warning',
        ...(task ? { task } : {}),
        ...(project ? { project } : {}),
        fingerprint: ['wilco', 'warning', shapeOf(message)],
        about: detail,
      },
    }
  }
  const measures: Measure[] = []
  if (event.type === 'usage') {
    const tokens = Number(event.detail.tokens ?? 0)
    const cost = Number(event.detail.usd ?? 0)
    const by = typeof event.detail.by === 'string' ? event.detail.by : 'agent'
    const model = typeof event.detail.model === 'string' ? event.detail.model : ''
    const on = { by, ...(model ? { model } : {}) }
    if (Number.isFinite(tokens) && tokens > 0) {
      measures.push({
        at: Date.parse(event.ts),
        name: 'wilco.tokens',
        kind: 'distribution',
        value: tokens,
        unit: 'token',
        about: on,
      })
    }
    if (Number.isFinite(cost) && cost > 0) {
      measures.push({
        at: Date.parse(event.ts),
        name: 'wilco.cost',
        kind: 'distribution',
        value: cost,
        unit: 'usd',
        about: on,
      })
    }
    return { measures }
  }
  if (event.type === 'failed') {
    measures.push({
      at: Date.parse(event.ts),
      name: 'wilco.failed',
      kind: 'counter',
      value: 1,
      about: task ? { task } : {},
    })
  }
  const level: Level =
    event.type === 'failed' ? 'error' : event.urgency === 'blocking' ? 'warning' : 'info'
  return {
    note: {
      at: Date.parse(event.ts),
      level,
      said: `${event.type}${task ? ` ${task}` : ''}`,
      about: {
        type: event.type,
        ...(task ? { task } : {}),
        ...(project ? { project } : {}),
        ...detail,
      },
    },
    ...(measures.length > 0 ? { measures } : {}),
  }
}
