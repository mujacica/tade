import type { WilcoEvent } from '@wilco/core'
import type { FromEvent, Level, Measure } from './port.ts'

// What may be sent, worked out in pure functions: where a DSN points, what a
// journal event is worth sending as, and what is taken out of everything
// before it goes. The SDK does the protocol; this is the policy, which is the
// part Wilco has to decide for itself.
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
