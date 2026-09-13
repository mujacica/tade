import type { Json } from './api.ts'

// What Sentry says, written for whoever reads it next: the orchestrator
// deciding what to fix, a person scanning a list, or an agent that has to fix
// the thing from a context file with nothing else to go on.
//
// Every field is treated as possibly missing. Sentry's shapes differ between
// platforms, versions and self-hosted installs, and a formatter that throws on
// one it did not expect turns a partial answer into no answer at all.

const str = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : ''
const num = (value: unknown): number | null => {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : null
}
const obj = (value: unknown): Json =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {}
const arr = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

/** A moment as a person reads it: `2026-09-14 08:11 UTC`. */
export function when(value: unknown): string {
  const date = new Date(str(value))
  return Number.isNaN(date.getTime())
    ? ''
    : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`
}

/** How long ago, roughly: `3h ago`, `2d ago`. */
export function ago(value: unknown, now: number): string {
  const at = new Date(str(value)).getTime()
  if (Number.isNaN(at)) return ''
  const minutes = Math.max(0, Math.round((now - at) / 60_000))
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)}h ago`
  return `${Math.round(minutes / 1440)}d ago`
}

export function shortIdOf(issue: Json): string {
  return str(issue.shortId) || str(issue.id)
}

/** One line per issue: what it is, how often, how many people, how recently, where to look. */
export function issueList(issues: readonly Json[], now: number): string {
  if (issues.length === 0) return 'No issues match.'
  return issues
    .map((issue) => {
      const count = num(issue.count)
      const users = num(issue.userCount)
      const parts = [
        `- **${shortIdOf(issue)}** ${str(issue.title)}`,
        [
          str(issue.level),
          count !== null ? `${count} event${count === 1 ? '' : 's'}` : '',
          users ? `${users} user${users === 1 ? '' : 's'}` : '',
          issue.firstSeen ? `first ${ago(issue.firstSeen, now)}` : '',
          issue.lastSeen ? `last ${ago(issue.lastSeen, now)}` : '',
          str(issue.culprit) ? `in ${str(issue.culprit)}` : '',
        ]
          .filter((part) => part !== '')
          .join(' · '),
        str(issue.permalink),
      ]
      return parts.filter((part) => part !== '').join('\n  ')
    })
    .join('\n')
}

interface Frame {
  filename: string
  function: string
  line: number | null
  column: number | null
  inApp: boolean
  context: [number, string][]
}

function framesOf(stacktrace: unknown): Frame[] {
  return arr(obj(stacktrace).frames).map((raw) => {
    const frame = obj(raw)
    return {
      filename: str(frame.filename) || str(frame.absPath) || str(frame.module) || '?',
      function: str(frame.function) || '?',
      line: num(frame.lineNo),
      column: num(frame.colNo),
      inApp: frame.inApp === true,
      context: arr(frame.context).flatMap((pair) =>
        Array.isArray(pair) && typeof pair[0] === 'number'
          ? [[pair[0], str(pair[1])] as [number, string]]
          : [],
      ),
    }
  })
}

/** The exceptions in an event, outermost first, each with its frames oldest first. */
function exceptionsOf(event: Json): { type: string; value: string; frames: Frame[] }[] {
  const entries = arr(event.entries).map(obj)
  const exception = entries.find((entry) => entry.type === 'exception')
  const values = exception ? arr(obj(exception.data).values).map(obj) : []
  if (values.length > 0) {
    return values
      .map((value) => ({
        type: str(value.type),
        value: str(value.value),
        frames: framesOf(value.stacktrace),
      }))
      .reverse()
  }
  const threads = entries.find((entry) => entry.type === 'threads')
  const crashed = threads
    ? arr(obj(threads.data).values)
        .map(obj)
        .find((thread) => thread.crashed === true || obj(thread.stacktrace).frames)
    : null
  return crashed
    ? [{ type: 'thread', value: str(crashed.name), frames: framesOf(crashed.stacktrace) }]
    : []
}

function where(frame: Frame): string {
  return `${frame.filename}${frame.line !== null ? `:${frame.line}` : ''}${frame.column !== null ? `:${frame.column}` : ''}`
}

/** The issue and its event, written to be worked from. */
export function issueDetails(issue: Json, event: Json, links: { trace: string | null }): string {
  const count = num(issue.count)
  const users = num(issue.userCount)
  const tags = arr(event.tags).map(obj)
  const tag = (key: string) => str(tags.find((one) => one.key === key)?.value)
  const trace = str(obj(obj(event.contexts).trace).trace_id)
  const release = str(obj(event.release).version) || tag('release')
  const lines: string[] = [
    `# ${shortIdOf(issue)}: ${str(issue.title) || str(event.title)}`,
    '',
    ...[
      str(issue.culprit) ? `- Culprit: ${str(issue.culprit)}` : '',
      `- Level: ${str(issue.level) || '?'} · Status: ${str(issue.status) || '?'}${str(issue.substatus) ? ` (${str(issue.substatus)})` : ''}`,
      count !== null
        ? `- Seen ${count} time${count === 1 ? '' : 's'}${users ? ` by ${users} user${users === 1 ? '' : 's'}` : ''}`
        : '',
      issue.firstSeen
        ? `- First seen ${when(issue.firstSeen)} · last seen ${when(issue.lastSeen)}`
        : '',
      release ? `- Release: ${release}` : '',
      tag('environment') ? `- Environment: ${tag('environment')}` : '',
      trace ? `- Trace: ${trace}${links.trace ? ` (${links.trace})` : ''}` : '',
      str(issue.permalink) ? `- In Sentry: ${str(issue.permalink)}` : '',
    ].filter((line) => line !== ''),
  ]

  const exceptions = exceptionsOf(event)
  const last = exceptions.at(-1)
  if (last) {
    lines.push(
      '',
      '## Exception',
      '',
      '```',
      ...exceptions.map((one) => `${one.type}${one.value ? `: ${one.value}` : ''}`),
      '```',
    )
    const relevant = [...last.frames].reverse().find((frame) => frame.inApp) ?? last.frames.at(-1)
    if (relevant) {
      lines.push('', '## Most relevant frame', '', `${where(relevant)} in ${relevant.function}`)
      if (relevant.context.length > 0) {
        const width = String(Math.max(...relevant.context.map(([n]) => n))).length
        lines.push(
          '',
          '```',
          ...relevant.context.map(
            ([n, code]) =>
              `${n === relevant.line ? '>' : ' '} ${String(n).padStart(width)} | ${code}`,
          ),
          '```',
        )
      }
    }
    for (const one of exceptions) {
      if (one.frames.length === 0) continue
      lines.push(
        '',
        `## Stack trace${exceptions.length > 1 ? ` (${one.type})` : ''}, most recent call last`,
        '',
        '```',
      )
      const frames = one.frames.slice(-40)
      if (one.frames.length > frames.length)
        lines.push(`  … ${one.frames.length - frames.length} older frames`)
      for (const frame of frames)
        lines.push(`  ${frame.inApp ? '' : '(library) '}${where(frame)} in ${frame.function}`)
      lines.push('```')
    }
  } else if (str(event.message)) {
    lines.push('', '## Message', '', str(event.message))
  }

  const request = obj(
    obj(
      arr(event.entries)
        .map(obj)
        .find((entry) => entry.type === 'request'),
    )?.data,
  )
  if (str(request.url))
    lines.push('', '## Request', '', `${str(request.method)} ${str(request.url)}`.trim())

  const crumbs = arr(
    obj(
      obj(
        arr(event.entries)
          .map(obj)
          .find((entry) => entry.type === 'breadcrumbs'),
      ).data,
    ).values,
  ).map(obj)
  if (crumbs.length > 0) {
    lines.push('', '## What happened before (last 15 breadcrumbs)', '')
    for (const crumb of crumbs.slice(-15)) {
      const data = obj(crumb.data)
      const detail =
        str(crumb.message) ||
        [str(data.method), str(data.url), str(data.status_code)].filter(Boolean).join(' ')
      lines.push(
        `- ${str(crumb.timestamp).slice(11, 19)} ${str(crumb.category) || str(crumb.type)}${str(crumb.level) && crumb.level !== 'info' ? ` [${str(crumb.level)}]` : ''}: ${detail}`,
      )
    }
  }

  const shown = tags
    .filter((one) => !['release', 'environment'].includes(str(one.key)))
    .slice(0, 20)
  if (shown.length > 0) {
    lines.push(
      '',
      '## Tags',
      '',
      shown.map((one) => `${str(one.key)}=${str(one.value)}`).join(' · '),
    )
  }
  return lines.join('\n')
}

interface SpanNode {
  op: string
  description: string
  duration: number | null
  project: string
  errors: number
  children: SpanNode[]
}

function spanOf(raw: Json): SpanNode {
  return {
    op: str(raw.op) || (raw.is_transaction ? 'transaction' : ''),
    description: str(raw.description) || str(raw.name) || str(raw.transaction) || str(raw.title),
    duration:
      num(raw.duration) ??
      (num(raw.end_timestamp) !== null && num(raw.start_timestamp) !== null
        ? ((num(raw.end_timestamp) ?? 0) - (num(raw.start_timestamp) ?? 0)) * 1000
        : null),
    project: str(raw.project_slug),
    errors: arr(raw.errors).length + (raw.issue_id ? 1 : 0),
    children: arr(raw.children).map((child) => spanOf(obj(child))),
  }
}

/** A trace as an indented tree of spans with how long each took, the slow and failing ones visible. */
export function traceTree(
  traceId: string,
  roots: readonly Json[],
  link: string,
  limit = 60,
): string {
  const lines = [`# Trace ${traceId}`, '', `In Sentry: ${link}`, '']
  let shown = 0
  let total = 0
  const walk = (node: SpanNode, depth: number) => {
    total++
    if (shown < limit) {
      shown++
      const ms = node.duration !== null ? ` — ${Math.round(node.duration)}ms` : ''
      const errors = node.errors > 0 ? ` · ${node.errors} error${node.errors === 1 ? '' : 's'}` : ''
      lines.push(
        `${'  '.repeat(depth)}- ${[node.op, node.description].filter(Boolean).join(' ')}${ms}${node.project ? ` [${node.project}]` : ''}${errors}`,
      )
    }
    for (const child of node.children) walk(child, depth + 1)
  }
  for (const root of roots) walk(spanOf(root), 0)
  if (total === 0)
    return `No spans were found for trace ${traceId}. It may be older than 14 days, or not sampled.`
  if (total > shown) lines.push(`- … ${total - shown} more spans`)
  return lines.join('\n')
}

/** Rows from an Explore dataset as a compact table. */
export function rowsTable(rows: readonly Json[], fields: readonly string[], limit = 50): string {
  if (rows.length === 0) return 'Nothing matched.'
  const out = [`| ${fields.join(' | ')} |`, `| ${fields.map(() => '---').join(' | ')} |`]
  for (const row of rows.slice(0, limit)) {
    out.push(
      `| ${fields.map((field) => str(row[field]).replace(/\|/g, '\\|').replace(/\s+/g, ' ').slice(0, 160)).join(' | ')} |`,
    )
  }
  if (rows.length > limit) out.push(`\n…and ${rows.length - limit} more rows`)
  return out.join('\n')
}

/** A time series in a sentence and a sparkline: where it started, peaked, and is now. */
export function seriesSummary(
  label: string,
  points: readonly { at: number; value: number }[],
): string {
  if (points.length === 0) return `No data for ${label}.`
  const values = points.map((point) => point.value)
  const max = Math.max(...values)
  const min = Math.min(...values)
  const bars = '▁▂▃▄▅▆▇█'
  const spark = values
    .map((value) => bars[max === min ? 0 : Math.round(((value - min) / (max - min)) * 7)] ?? '▁')
    .join('')
  const peak = points[values.indexOf(max)]
  const round = (value: number) =>
    Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  return [
    `${label}: now ${round(values.at(-1) ?? 0)}, peak ${round(max)}${peak ? ` at ${new Date(peak.at).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}, low ${round(min)}`,
    spark,
  ].join('\n')
}

/** What Seer found, from either shape it has been known to answer in. */
export function rootCauseText(autofix: Json | null): string {
  if (!autofix) return 'Seer has not looked at this issue yet.'
  const status = str(autofix.status).toLowerCase()
  const parts: string[] = [`Seer: ${status || 'unknown'}`]
  for (const block of arr(autofix.blocks).map(obj)) {
    for (const artifact of arr(block.artifacts).map(obj)) {
      const data = artifact.data
      const text = typeof data === 'string' ? data : JSON.stringify(data, null, 2)
      if (text) parts.push('', `## ${str(artifact.key).replace(/_/g, ' ') || 'finding'}`, '', text)
    }
  }
  for (const step of arr(autofix.steps).map(obj)) {
    for (const cause of arr(step.causes).map(obj)) {
      parts.push('', `## ${str(cause.title) || 'root cause'}`, '', str(cause.description))
    }
    const solution = arr(step.solution).map(obj)
    if (solution.length > 0) {
      parts.push(
        '',
        '## solution',
        '',
        ...solution.map(
          (one) =>
            `- ${str(one.title)}${str(one.code_snippet_and_analysis) ? `: ${str(one.code_snippet_and_analysis)}` : ''}`,
        ),
      )
    }
  }
  if (parts.length === 1 && status === 'processing')
    parts.push('It is still working; ask again in a minute or two.')
  return parts.join('\n')
}
