import { fileURLToPath } from 'node:url'
import {
  type BriefItem,
  boolean,
  type ExtensionContext,
  type Link,
  number,
  object,
  oneOf,
  string,
  type TadeExtension,
  type ToolContext,
} from '@tade/extensions-core'
import { type Json, SentryApi } from './api.ts'
import { findAccess, findCredentials, type SentryAccess } from './auth.ts'
import {
  issueDetails,
  issueList,
  rootCauseText,
  rowsTable,
  seriesSummary,
  shortIdOf,
  traceTree,
} from './format.ts'

// Sentry: the errors, traces, logs and metrics of the projects Tade works on.
//
// The orchestrator uses it to answer "what broke overnight" and "what should
// we fix", and hands a fix to an agent with everything Sentry knows written
// into its worktree. Agents get the same reading tools, so an agent fixing an
// issue can pull the trace around it or the logs from that request itself.
// Changing an issue in Sentry is the orchestrator's alone, and only when asked.

const ROOT = fileURLToPath(new URL('..', import.meta.url))

function access(ctx: ExtensionContext): SentryAccess | { problem: string } {
  return findAccess({
    settings: ctx.settings,
    env: ctx.env,
    folders: ctx.projects.map((project) => project.root),
    now: ctx.now(),
  })
}

function api(ctx: ExtensionContext): SentryApi {
  const found = access(ctx)
  if ('problem' in found) throw new Error(found.problem)
  return new SentryApi(found, ctx.fetch)
}

/** Which Sentry projects each Tade project reports to, as the config says. */
function mapping(ctx: ExtensionContext): Record<string, string[]> {
  const configured = ctx.settings.projects
  if (!configured || typeof configured !== 'object') return {}
  return Object.fromEntries(
    Object.entries(configured as Record<string, unknown>).map(([project, slugs]) => [
      project,
      (Array.isArray(slugs) ? slugs : [slugs]).map(String).filter((slug) => slug !== ''),
    ]),
  )
}

/**
 * The Sentry projects a call is about. A Tade project is looked up in the
 * mapping, and is its own slug when it has none; anything else is taken as a
 * Sentry slug; an agent's is its own project's; with one project, that one.
 */
function slugsFor(
  ctx: ToolContext | ExtensionContext,
  said: unknown,
): { tade: string | null; slugs: string[] } {
  const map = mapping(ctx)
  const wanted =
    typeof said === 'string' && said !== ''
      ? said
      : 'caller' in ctx && ctx.caller.kind === 'agent'
        ? ctx.caller.project
        : null
  if (wanted) {
    if (map[wanted]) return { tade: wanted, slugs: map[wanted] }
    if (ctx.projects.some((project) => project.name === wanted))
      return { tade: wanted, slugs: [wanted] }
    const owner = Object.entries(map).find(([, slugs]) => slugs.includes(wanted))?.[0] ?? null
    return { tade: owner, slugs: [wanted] }
  }
  const [only] = ctx.projects
  if (ctx.projects.length === 1 && only)
    return { tade: only.name, slugs: map[only.name] ?? [only.name] }
  const all = [...new Set(Object.values(map).flat())]
  if (all.length > 0) return { tade: null, slugs: all }
  throw new Error(`which project? ${ctx.projects.map((project) => project.name).join(', ')}`)
}

/** An issue as it was said: a numeric id, a short id, or a link to it. */
export function issueIdOf(said: string): string {
  const trimmed = said.trim()
  // Short ids are capitals however they were said; a number is unchanged by that.
  return (/\/issues\/([\w-]+)\/?/.exec(trimmed)?.[1] ?? trimmed).toUpperCase()
}

const DATASETS: Record<string, { dataset: string; fields: string[]; sort?: string }> = {
  errors: {
    dataset: 'errors',
    fields: [
      'issue',
      'title',
      'project',
      'timestamp',
      'level',
      'culprit',
      'count()',
      'last_seen()',
    ],
    sort: '-last_seen()',
  },
  spans: {
    dataset: 'spans',
    fields: [
      'id',
      'trace',
      'span.op',
      'span.description',
      'span.duration',
      'transaction',
      'project',
      'timestamp',
    ],
    sort: '-timestamp',
  },
  logs: { dataset: 'logs', fields: ['timestamp', 'severity', 'message', 'trace', 'project'] },
  metrics: {
    dataset: 'tracemetrics',
    fields: ['timestamp', 'metric.name', 'metric.type', 'value', 'project', 'trace'],
  },
}

const project = string(
  'the Tade project, or a Sentry project slug; left out, the project you are in',
)
const issue = string('the issue: its short id (SHOP-1A), its number, or a link to it')
const period = string('how far back: 1h, 24h, 14d, 90d')

function link(title: string, url: string): Link {
  return { title, url }
}

/** What an agent fixing an issue is told, however it came to be started. */
function fixPrompt(shortId: string, title: string): string {
  return [
    `Fix Sentry issue ${shortId}: ${title}.`,
    'Everything Sentry knows about it is in .tade/context.md: the stack trace, the frame in your code that matters, what happened before, the request and the trace.',
    'Find the cause rather than guarding the symptom, add a test that fails without the fix, and commit with',
    `"Fixes ${shortId}" in the message so Sentry resolves it when it is released.`,
    'sentry_issue, sentry_trace and sentry_events read more from Sentry if you need it.',
  ].join(' ')
}

/**
 * How far before one look the next starts. Sentry takes a moment to take an
 * event in, so an issue can be first seen just before a look and arrive after
 * it; Tade knows which issues it has found, so looking twice costs nothing.
 */
const OVERLAP_MS = 10 * 60_000

async function detailsOf(
  sentry: SentryApi,
  said: string,
): Promise<{ issue: Json; text: string; links: Link[] }> {
  const found = await sentry.issue(issueIdOf(said))
  const id = String(found.id ?? issueIdOf(said))
  const event = await sentry
    .event(id, 'recommended')
    .catch(() => sentry.event(id, 'latest').catch(() => ({})))
  const contexts = (event as Json).contexts as { trace?: { trace_id?: unknown } } | undefined
  const trace = typeof contexts?.trace?.trace_id === 'string' ? contexts.trace.trace_id : ''
  const traceUrl = trace ? sentry.webUrl(`/explore/traces/trace/${trace}/`) : null
  const links = [
    ...(typeof found.permalink === 'string' ? [link(shortIdOf(found), found.permalink)] : []),
    ...(traceUrl ? [link(`trace ${trace.slice(0, 8)}`, traceUrl)] : []),
  ]
  return { issue: found, text: issueDetails(found, event as Json, { trace: traceUrl }), links }
}

export const sentryExtension: TadeExtension = {
  name: 'sentry',
  title: 'Sentry',
  description:
    'Reads the errors, traces, logs and metrics your projects send to Sentry, and hands fixes to agents.',
  root: ROOT,
  settings: [
    {
      key: 'org',
      kind: 'string',
      means: 'the Sentry organization slug (or $SENTRY_ORG, or sentry-cli’s default)',
    },
    {
      key: 'url',
      kind: 'string',
      means: 'your Sentry, when it is not sentry.io: a self-hosted one, or a local one you run',
    },
    {
      key: 'token_env',
      kind: 'string',
      means: 'the environment variable the token is in, when it is not SENTRY_AUTH_TOKEN',
    },
    {
      key: 'projects',
      kind: 'map',
      means:
        'which Sentry project slugs each Tade project reports to; a project not listed is its own slug',
    },
    {
      key: 'brief',
      kind: 'boolean',
      means: 'mention new issues in the brief (true unless set false)',
    },
    {
      key: 'brief_query',
      kind: 'string',
      means:
        'which issues the brief counts, as a Sentry search (is:unresolved firstSeen:-24h unless set)',
    },
  ],
  ready: (ctx) => {
    const found = access(ctx)
    return 'problem' in found ? found.problem : null
  },
  tools: [
    {
      name: 'sentry_issues',
      description:
        "List a project's Sentry issues: unresolved ones by default, newest activity first. Use sort 'new' and a query like 'is:unresolved firstSeen:-24h' for what is new, 'freq' for what happens most, 'user' for what affects most people. Each comes with its short id, how often and how recently it happened, and its link. Use it to answer what broke, and to decide what to fix.",
      parameters: object({
        project,
        query: string(
          "a Sentry search: 'is:unresolved', 'is:unresolved level:error', 'is:regressed', 'firstSeen:-24h', 'release:1.4.2'",
        ),
        sort: oneOf(
          ['date', 'new', 'freq', 'user', 'trends'],
          'the order: last seen, first seen, events, users, trending',
        ),
        period,
        limit: number('how many, up to 100; 25 unless said'),
      }),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const sentry = api(ctx)
        const { slugs } = slugsFor(ctx, input.project)
        const query = input.query ? String(input.query) : 'is:unresolved'
        const page = await sentry.issues({
          projects: slugs,
          query,
          sort: input.sort ? String(input.sort) : 'date',
          period: input.period ? String(input.period) : '14d',
          limit: Number(input.limit) > 0 ? Number(input.limit) : 25,
        })
        const all = sentry.webUrl(`/issues/?query=${encodeURIComponent(query)}`)
        return {
          text: `${page.items.length}${page.next ? '+' : ''} issue${page.items.length === 1 ? '' : 's'} in ${slugs.join(', ')} matching \`${query}\`:\n\n${issueList(page.items, ctx.now())}`,
          links: [link('all of them in Sentry', all)],
          data: page.items,
        }
      },
    },
    {
      name: 'sentry_issue',
      description:
        'Everything Sentry knows about one issue: what it is, how often and for whom, the release and environment, the exception with its stack trace and the most relevant frame of your own code, what happened just before (breadcrumbs), the request, tags, and the trace id to follow with sentry_trace.',
      parameters: object({ issue }, ['issue']),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const details = await detailsOf(api(ctx), String(input.issue))
        return { text: details.text, links: details.links, data: details.issue }
      },
    },
    {
      name: 'sentry_events',
      description:
        "Query Sentry's Explore data: errors, spans (performance), logs, or metrics. Filter with a Sentry search in query — 'trace:<id>' for everything in one request, 'span.op:db' for database spans, 'severity:error' for error logs, 'metric.name:checkout.duration'. Gives a table of rows.",
      parameters: object(
        {
          dataset: oneOf(['errors', 'spans', 'logs', 'metrics'], 'which data'),
          query: string('a Sentry search to filter the rows'),
          project,
          period,
          limit: number('how many rows, up to 100; 50 unless said'),
        },
        ['dataset'],
      ),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const sentry = api(ctx)
        const kind = DATASETS[String(input.dataset)] ?? DATASETS.errors
        if (!kind) throw new Error('no such dataset')
        const { slugs } = slugsFor(ctx, input.project)
        const rows = await sentry.events({
          dataset: kind.dataset,
          fields: kind.fields,
          ...(input.query ? { query: String(input.query) } : {}),
          period: input.period ? String(input.period) : '24h',
          ...(kind.sort ? { sort: kind.sort } : {}),
          limit: Number(input.limit) > 0 ? Number(input.limit) : 50,
          projects: slugs,
        })
        return { text: rowsTable(rows, kind.fields), data: rows }
      },
    },
    {
      name: 'sentry_trace',
      description:
        'One trace as a tree of spans with how long each took and where errors happened: the request an issue happened in, end to end, across services. Give it the trace id from sentry_issue or from a log line.',
      parameters: object({ trace: string('the trace id: 32 hex characters') }, ['trace']),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const sentry = api(ctx)
        const id = String(input.trace).trim()
        const url = sentry.webUrl(`/explore/traces/trace/${id}/`)
        return {
          text: traceTree(id, await sentry.trace(id), url),
          links: [link(`trace ${id.slice(0, 8)}`, url)],
        }
      },
    },
    {
      name: 'sentry_stats',
      description:
        "How something moved over time: 'count()' of errors, 'p95(span.duration)' of a transaction, 'failure_rate()', 'count_unique(user)'. Says where it is now, its peak and low, with a sparkline. Use it to tell whether something got worse after a release.",
      parameters: object(
        {
          y_axis: string(
            "the aggregate: 'count()', 'p95(span.duration)', 'failure_rate()', 'count_unique(user)'",
          ),
          dataset: oneOf(['errors', 'spans', 'logs', 'metrics'], 'which data; spans unless said'),
          query: string('a Sentry search to narrow it'),
          project,
          period,
          interval: string('the size of each point: 5m, 1h, 1d'),
        },
        ['y_axis'],
      ),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const sentry = api(ctx)
        const kind = DATASETS[String(input.dataset ?? 'spans')] ?? DATASETS.spans
        const { slugs } = slugsFor(ctx, input.project)
        const points = await sentry.series({
          dataset: kind?.dataset ?? 'spans',
          yAxis: String(input.y_axis),
          ...(input.query ? { query: String(input.query) } : {}),
          period: input.period ? String(input.period) : '24h',
          interval: input.interval ? String(input.interval) : '1h',
          projects: slugs,
        })
        return { text: seriesSummary(String(input.y_axis), points), data: points }
      },
    },
    {
      name: 'sentry_root_cause',
      description:
        "What Sentry's Seer has worked out about an issue's root cause and fix. With start, asks Seer to begin when it has not; it takes a few minutes, so ask again later.",
      parameters: object(
        { issue, start: boolean('ask Seer to start, when it has not looked yet') },
        ['issue'],
      ),
      for: ['orchestrator', 'agent'],
      run: async (input, ctx) => {
        const sentry = api(ctx)
        const id = issueIdOf(String(input.issue))
        const numeric = String((await sentry.issue(id)).id ?? id)
        const state = await sentry.rootCause(numeric)
        if (!state && input.start === true) {
          await sentry.startRootCause(numeric)
          return {
            text: `Asked Seer to look at ${id}. It takes a few minutes; ask again for what it found.`,
          }
        }
        return { text: rootCauseText(state) }
      },
    },
    {
      name: 'sentry_update_issue',
      description:
        'Change an issue in Sentry: resolve it, ignore it, reopen it, or assign it. Only when the human has asked for exactly that.',
      parameters: object(
        {
          issue,
          status: oneOf(
            ['resolved', 'resolvedInNextRelease', 'unresolved', 'ignored'],
            'what it should become',
          ),
          assign: string('who to assign it to: an email, a username, or team:<slug>'),
        },
        ['issue'],
      ),
      for: ['orchestrator'],
      run: async (input, ctx) => {
        const sentry = api(ctx)
        const id = issueIdOf(String(input.issue))
        const numeric = String((await sentry.issue(id)).id ?? id)
        const change: Json = {
          ...(input.status ? { status: input.status } : {}),
          ...(typeof input.assign === 'string' ? { assignedTo: input.assign } : {}),
        }
        if (Object.keys(change).length === 0)
          throw new Error('say what to change: a status, or who to assign it to')
        const updated = await sentry.updateIssue(numeric, change)
        return {
          text: `${id} is now ${String(updated.status ?? input.status ?? 'updated')}${input.assign ? `, assigned to ${String(input.assign)}` : ''}.`,
        }
      },
    },
    {
      name: 'sentry_fix',
      description:
        "Start an agent on fixing a Sentry issue. It is given everything Sentry knows — the stack trace, the most relevant frame, breadcrumbs, request, tags, the trace — in its context file, the issue's link, and told to reproduce, fix, test, and commit with 'Fixes <SHORT-ID>' so Sentry resolves it on release. Add what you know that Sentry does not in note.",
      parameters: object(
        {
          issue,
          project: string('the Tade project the fix belongs in, when the issue does not say'),
          note: string(
            'what else the agent should know: what you or the human think the cause is, what not to touch',
          ),
        },
        ['issue'],
      ),
      for: ['orchestrator'],
      run: async (input, ctx) => {
        if (!ctx.tade) throw new Error('starting an agent needs the Tade window open')
        const sentry = api(ctx)
        const details = await detailsOf(sentry, String(input.issue))
        const shortId = shortIdOf(details.issue)
        const slug = String((details.issue.project as Json | undefined)?.slug ?? '')
        const tade = input.project ? String(input.project) : slugsFor(ctx, slug || null).tade
        if (!tade)
          throw new Error(
            `which project does ${shortId} belong in? ${ctx.projects.map((one) => one.name).join(', ')}`,
          )
        const started = await ctx.tade.startAgent({
          project: tade,
          title: `fix ${shortId}`,
          prompt: fixPrompt(shortId, String(details.issue.title ?? '')),
          context: [input.note ? `> ${String(input.note)}\n` : '', details.text]
            .filter(Boolean)
            .join('\n'),
          links: details.links,
        })
        return {
          text: `Started ${started.task} on ${shortId}, with the stack trace and breadcrumbs in its context.`,
          links: details.links,
          data: started,
        }
      },
    },
  ],
  actions: [
    {
      id: 'new',
      title: 'New Sentry issues',
      tool: 'sentry_issues',
      input: { query: 'is:unresolved firstSeen:-24h', sort: 'new', period: '24h' },
      project: true,
    },
    {
      id: 'unresolved',
      title: 'Unresolved Sentry issues',
      tool: 'sentry_issues',
      input: { sort: 'freq' },
      project: true,
    },
  ],
  watches: [
    {
      id: 'new-errors',
      title: 'New Sentry errors',
      means:
        'Looks for issues first seen in Sentry since its last look, and starts an agent on each with everything Sentry knows, to find the cause, fix it and test it.',
      every: '1h',
      input: object({
        query: string(
          "a Sentry search narrowing what counts, like 'level:error' or '!culprit:*vendor*'; every unresolved issue unless said",
        ),
      }),
      check: async (ctx) => {
        const sentry = api(ctx)
        const { slugs } = slugsFor(ctx, ctx.watching.name)
        // Nothing that was already there when it was turned on is new.
        const from = ctx.since && !Number.isNaN(Date.parse(ctx.since)) ? ctx.since : ctx.turnedOn
        const narrower = typeof ctx.input.query === 'string' ? ctx.input.query.trim() : ''
        const query = ['is:unresolved', narrower, `firstSeen:>=${from}`].filter(Boolean).join(' ')
        const page = await sentry.issues({
          projects: slugs,
          query,
          sort: 'new',
          period: '14d',
          limit: 25,
        })
        return {
          found: page.items.map((found) => ({
            key: String(found.id ?? shortIdOf(found)),
            title: `${shortIdOf(found)}: ${String(found.title ?? '')}`,
            ...(typeof found.permalink === 'string'
              ? { links: [link(shortIdOf(found), found.permalink)] }
              : {}),
          })),
          since: new Date(Math.max(Date.parse(from), ctx.now() - OVERLAP_MS)).toISOString(),
        }
      },
      agent: async (finding, ctx) => {
        const details = await detailsOf(api(ctx), finding.key)
        const shortId = shortIdOf(details.issue)
        return {
          title: `fix ${shortId}`,
          prompt: fixPrompt(shortId, String(details.issue.title ?? '')),
          context: details.text,
          links: details.links,
        }
      },
    },
  ],
  brief: async (ctx) => {
    if (ctx.settings.brief === false) return []
    const sentry = api(ctx)
    const query =
      typeof ctx.settings.brief_query === 'string'
        ? ctx.settings.brief_query
        : 'is:unresolved firstSeen:-24h'
    const map = mapping(ctx)
    const items: BriefItem[] = []
    for (const one of ctx.projects) {
      const slugs = map[one.name] ?? (Object.keys(map).length === 0 ? [one.name] : [])
      if (slugs.length === 0) continue
      const page = await sentry
        .issues({ projects: slugs, query, sort: 'new', period: '24h', limit: 100 })
        .catch(() => null)
      const count = page?.items.length ?? 0
      if (count === 0) continue
      items.push({
        said: `Sentry has ${count}${page?.next ? '+' : ''} new issue${count === 1 ? '' : 's'} in ${one.name}`,
        ask: `Look at the new Sentry issues in ${one.name} and tell me which are worth fixing first, and why`,
        links: [
          link(
            `new issues in ${one.name}`,
            sentry.webUrl(`/issues/?query=${encodeURIComponent(query)}`),
          ),
        ],
      })
    }
    return items
  },
  orchestrator: (ctx) => {
    const map = mapping(ctx)
    const mapped = Object.entries(map)
      .map(([tade, slugs]) => `${tade} → ${slugs.join(', ')}`)
      .join('; ')
    return [
      `Errors, traces, logs and metrics from Sentry${mapped ? ` (${mapped})` : ''}.`,
      'For "what broke" or "check Sentry", call sentry_issues (sort new, query is:unresolved firstSeen:-24h for what is new) and summarise: how many, the few that matter and why — frequency, users affected, how recent, whether it is in your own code.',
      'For one issue, sentry_issue. To decide what to fix, weigh events, users and recency, and say which you would fix first.',
      'To fix one, sentry_fix: it starts an agent with the stack trace and everything else in its context, so do not retell it.',
      'To have new errors fixed as they come, turn on the watch sentry.new-errors with tade_schedule, when asked to.',
      'Always give issues by short id with their link, so they can be opened.',
      'Never resolve, ignore or assign an issue unless asked to; that is sentry_update_issue.',
    ].join(' ')
  },
  agents: (ctx, project) => {
    const slugs = mapping(ctx)[project.name] ?? [project.name]
    return [
      `${project.name} reports its errors to Sentry (${slugs.join(', ')}).`,
      'If .tade/context.md is about a Sentry issue, it has the stack trace, the relevant frame, breadcrumbs and the trace id — start there.',
      'sentry_issue fetches an issue, sentry_trace the request around it, sentry_events the logs or spans (query trace:<id> for one request), sentry_stats how something moved over time.',
      'When a commit fixes a Sentry issue, put "Fixes <SHORT-ID>" in its message so Sentry resolves it on release.',
    ].join(' ')
  },
  linkers: (ctx) => {
    const found = access(ctx)
    if ('problem' in found) return []
    const slugs = [
      ...new Set([...Object.values(mapping(ctx)).flat(), ...ctx.projects.map((one) => one.name)]),
    ]
    const prefixes = slugs
      .map((slug) => slug.toUpperCase().replace(/[^A-Z0-9]+/g, '-'))
      .filter(Boolean)
    if (prefixes.length === 0) return []
    const sentry = new SentryApi(found, ctx.fetch)
    return [
      {
        pattern: `\\b(?:${prefixes.map((prefix) => prefix.replace(/[-]/g, '\\-')).join('|')})-[0-9A-Z]{1,10}\\b`,
        url: sentry.webUrl('/issues/?query=$&'),
      },
    ]
  },
  setup: (ctx) => {
    const found = findCredentials({
      settings: ctx.settings,
      env: ctx.env,
      folders: ctx.projects.map((project) => project.root),
      now: ctx.now(),
    })
    const variable = found.tokenVariable ?? 'SENTRY_AUTH_TOKEN'
    return {
      guide: [
        found.token
          ? `**Token:** found in ${found.token.from}. Tade reads it there and never keeps a copy.`
          : `**Token:** Tade needs one that can read your organization, and never stores it. Either run \`sentry-cli login\` (it keeps the token in \`~/.sentryclirc\`, where Tade reads it), or create a user auth token with the scopes \`org:read\`, \`project:read\`, \`event:read\` and \`event:write\`, and add \`export ${variable}=…\` to your shell's profile — then start Tade from a new terminal.`,
        found.org
          ? `**Organization:** ${found.org}.`
          : '**Organization:** type its slug below — the part after `sentry.io/organizations/` — or, with a token, choose from the ones it can see.',
        '**Projects:** a Tade project reports to the Sentry project with the same name. Where the names differ, say which: `checkout=checkout-api`, and `+` for more than one (`web=web-app+web-edge`).',
        '**Your own Sentry:** leave Sentry empty for sentry.io; for a self-hosted or local one, give its address.',
      ],
      fields: [
        {
          key: 'org',
          label: 'Organization',
          kind: 'text',
          placeholder: found.org ?? 'acme',
          help: 'its slug, as in the address of its pages',
          ...(found.token
            ? {
                choices: async (asked: typeof ctx) => {
                  const response = await asked.fetch(`${found.url}/api/0/organizations/`, {
                    headers: { authorization: `Bearer ${found.token?.value ?? ''}` },
                    signal: AbortSignal.timeout(15_000),
                  })
                  if (!response.ok) return []
                  const orgs = (await response.json()) as { slug?: unknown }[]
                  return orgs.map((org) => String(org.slug ?? '')).filter(Boolean)
                },
              }
            : {}),
        },
        {
          key: 'projects',
          label: 'Projects',
          kind: 'map',
          placeholder: 'checkout=checkout-api',
          help: 'only where a Sentry project is called something else',
        },
        {
          key: 'url',
          label: 'Sentry',
          kind: 'text',
          placeholder: 'https://sentry.io',
          help: 'only for a Sentry you run yourself',
        },
        {
          key: 'brief',
          kind: 'flag',
          label: 'In the brief',
          help: 'say how many new issues there are',
        },
      ],
      links: [
        {
          title: 'Create an auth token',
          url: `${found.url.includes('sentry.io') ? 'https://sentry.io' : found.url}/settings/account/api/auth-tokens/`,
        },
        { title: 'Install sentry-cli', url: 'https://docs.sentry.io/cli/installation/' },
      ],
    }
  },
  harness: { pi: { skills: ['skills/fix-sentry-issue'] } },
}
