import { modelIn, type TadeEvent, UNRECORDED } from '@tade/core'
import type { FromEvent, Level, Measure } from './port.ts'

// What may be sent, worked out in pure functions: where a DSN points, what a
// journal event is worth sending as, and what is taken out of everything
// before it goes. The SDK does the protocol; this is the policy, which is the
// part Tade has to decide for itself.
//
// Everything here is a value in and a value out, so what Tade would send can
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
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  // A key somebody pasted into Tade is whatever shape its issuer chose, and
  // Tade now holds keys for anything that asks: a short prefix and a long
  // random tail is what nearly all of them look like, so the shape goes
  // rather than the list of issuers we happened to think of.
  /\b[A-Za-z][A-Za-z0-9]{1,11}_[A-Za-z0-9]{24,}\b/g,
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
 * and Tade's own words about what happened. Anything else — what you said,
 * what an agent wrote, what a task is called — stays on your machine, and a
 * new key sends nothing until someone puts it here on purpose.
 */
const KEPT = new Set([
  // What the approval policy did, and how hard a call was: never the command.
  'adapter',
  'approvals',
  'approved',
  // Whether a commit said whose it was. A boolean, never the commit's words.
  'attributed',
  'because',
  'by',
  'change',
  'check',
  'code',
  // Which paired device an away-view line was about: a 16-hex id Tade minted,
  // never the label, which is a person's own words about their own phone.
  'device',
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
  // Whether the money on a `usage` event was priced or estimated. See `priced`.
  'priced',
  'problem',
  'project',
  'provider',
  'ran',
  'reopened',
  'reason',
  'required',
  'rule',
  'runner',
  'schedule',
  'start',
  'state',
  'status',
  'stopped',
  'tier',
  'to',
  'tool',
  'warning',
  'watch',
  'where',
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
 * A number from an event's detail, or nothing. Detail is `unknown`, and a
 * count that arrived as a string is not a count we are willing to chart.
 */
function count(detail: Readonly<Record<string, unknown>>, key: string): number | null {
  const value = detail[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The few values of an event's detail that may be a metric's dimensions.
 *
 * Narrower than `KEPT` on purpose, and the reason is cardinality rather than
 * privacy: a dimension is a series, so a value that can be a written sentence
 * — `because`, `message`, `reason` — makes a new series every time somebody
 * words something differently, and the chart it was added for stops loading.
 * Everything here is an enum, a name from a registry, or a flag. What was
 * actually said still reaches the log line beside it, which is where prose
 * belongs.
 */
const DIMENSIONS: Readonly<Record<string, readonly string[]>> = {
  // `model` and not `modelId`: the name is the model, the spelling is the
  // route, and a series per route is what `provider` is for.
  run_started: ['adapter', 'model', 'approvals'],
  turn_done: ['status'],
  tool_call: ['tool', 'tier', 'approved'],
  permission_granted: ['tool', 'tier'],
  permission_denied: ['tool', 'tier'],
  task_done: ['by', 'rule'],
  queue_held: ['start'],
  queue_started: ['reopened'],
  check_ran: ['check', 'state', 'required', 'where', 'runner'],
  commit_seen: ['attributed'],
}

/** What an event is counted as: its name, and the dimensions it is worth splitting by. */
const COUNTED: Readonly<Record<string, string>> = {
  run_started: 'tade.agent.runs',
  turn_done: 'tade.agent.turns',
  tool_call: 'tade.tool.calls',
  permission_granted: 'tade.approvals',
  permission_denied: 'tade.approvals',
  task_done: 'tade.task.done',
  queue_held: 'tade.queue.held',
  queue_started: 'tade.queue.started',
  check_ran: 'tade.check.runs',
  commit_seen: 'tade.commits',
  failed: 'tade.failed',
}

/**
 * What this event is worth as numbers: one counter for the fact that it
 * happened, and whatever it measured beside it.
 *
 * Deliberately not emitted for `run_exited`. An exit is the event most often
 * missing — the journal that produced `runtime.ts` had 100 `run_started` and
 * 35 `run_exited` — so a runtime counted here would undercount by two thirds.
 * How long agents ran is derived by `runtimeFrom` and reported on a beat, the
 * same way the window reads it.
 */
function measuresOf(
  event: TadeEvent,
  detail: Readonly<Record<string, string | number | boolean>>,
  project: string | undefined,
): Measure[] {
  const name = COUNTED[event.type]
  if (!name) return []
  const at = Date.parse(event.ts)
  const about: Record<string, string | number | boolean> = {}
  if (project) about.project = project
  for (const key of DIMENSIONS[event.type] ?? []) {
    const value = detail[key]
    // `adapter` is the harness's own id: said as `harness`, which is the word
    // every other metric splits by and the one a person reads.
    if (value !== undefined) about[key === 'adapter' ? 'harness' : key] = value
  }
  if (event.type === 'permission_granted') about.decision = 'granted'
  if (event.type === 'permission_denied') about.decision = 'denied'
  const measures: Measure[] = [{ at, name, kind: 'counter', value: 1, about }]

  // What a commit did, which is the whole reason it is written down: the
  // counter above says one happened, these say how big it was.
  if (event.type === 'commit_seen') {
    for (const [key, metric] of [
      ['added', 'tade.lines.added'],
      ['removed', 'tade.lines.removed'],
      ['files', 'tade.files.changed'],
    ] as const) {
      const value = count(event.detail, key)
      if (value !== null) measures.push({ at, name: metric, kind: 'distribution', value, about })
    }
  }
  // How long a check took. Only where it finished: a run still going has no
  // duration, and one that was cancelled has no duration worth charting.
  if (event.type === 'check_ran') {
    const ms = count(event.detail, 'ms')
    if (ms !== null && ms >= 0) {
      measures.push({
        at,
        name: 'tade.check.ms',
        kind: 'distribution',
        value: ms,
        unit: 'millisecond',
        about,
      })
    }
  }
  return measures
}

/**
 * What a journal event is worth sending as. Tade's own trouble — a crash it
 * caught, a warning it wrote down — is an issue to fix. What agents did is
 * lines to read beside it and numbers to watch; what anybody said is neither.
 */
export function fromEvent(event: TadeEvent, home: string): FromEvent {
  if (NEVER.has(event.type) || event.urgency === 'trace') return {}
  const detail = about(event.detail, home)
  const task = event.task ?? undefined
  const project = task?.split('/')[0]
  if (event.type === 'warning') {
    const raw = typeof event.detail.message === 'string' ? event.detail.message : 'something'
    // Scrubbed before it is shaped, not after: a fingerprint is sent like
    // everything else, and one built from the raw words would carry out the
    // credential the message itself just had taken out of it.
    const message = scrub(raw, home)
    return {
      trouble: {
        error: message,
        where: 'tade',
        level: 'warning',
        ...(task ? { task } : {}),
        ...(project ? { project } : {}),
        fingerprint: ['tade', 'warning', shapeOf(message)],
        about: detail,
      },
    }
  }
  if (event.type === 'usage') {
    const measures: Measure[] = []
    const tokens = Number(event.detail.tokens ?? 0)
    const cost = Number(event.detail.usd ?? 0)
    const by = typeof event.detail.by === 'string' ? event.detail.by : 'agent'
    // The model's own name, not the spelling it was reached by: a dimension is
    // a series, and one model spelled three ways is three of them.
    const said = modelIn(event).name
    const model = said === UNRECORDED ? '' : said
    // Whether the money is priced or guessed. A harness declares which it can
    // do (`spend.usd`), and the two must never add up into one figure without
    // saying so: pi prices each turn against its own catalog, Claude Code
    // estimates, and a chart that sums them silently reports a number nobody
    // can defend.
    const priced = typeof event.detail.priced === 'string' ? event.detail.priced : ''
    const on = { by, ...(model ? { model } : {}), ...(priced ? { priced } : {}) }
    if (Number.isFinite(tokens) && tokens > 0) {
      measures.push({
        at: Date.parse(event.ts),
        name: 'tade.tokens',
        kind: 'distribution',
        value: tokens,
        unit: 'token',
        about: on,
      })
    }
    if (Number.isFinite(cost) && cost > 0) {
      measures.push({
        at: Date.parse(event.ts),
        name: 'tade.cost',
        kind: 'distribution',
        value: cost,
        unit: 'usd',
        about: on,
      })
    }
    return { measures }
  }
  // Split by project, never by task. A task id is a slug made from the title
  // somebody wrote, so it is both unbounded as a series and the one thing
  // about the work that is not Tade's to send. It stays on the log line, where
  // it is read beside the trouble rather than charted.
  const measures = measuresOf(event, detail, project)
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
