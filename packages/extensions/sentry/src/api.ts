import type { SentryAccess } from './auth.ts'

// Sentry's REST API, the parts Wilco reads: issues and their events, traces,
// the Explore datasets (errors, spans, logs, metrics), time series, Seer's
// root cause, and changing an issue's status.
//
// Plain requests rather than an SDK or an MCP server: it is one implementation
// for every harness and every caller, it needs nothing installed, and it can
// be tested against answers written down here instead of against sentry.io.
// Organization calls go to the organization's own region, which is where
// Sentry itself sends them.

export class SentryError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'SentryError'
    this.status = status
  }
}

export interface Page<T> {
  items: T[]
  /** Where the next page starts, when there is one. */
  next: string | null
}

export type Json = Record<string, unknown>

const TIMEOUT_MS = 30_000

export class SentryApi {
  readonly access: SentryAccess
  private readonly fetcher: typeof fetch
  private region: string | null = null
  private readonly projectIds = new Map<string, string>()

  constructor(access: SentryAccess, fetcher: typeof fetch) {
    this.access = access
    this.fetcher = fetcher
  }

  /** Where a person looks at something in Sentry, in their browser. */
  webUrl(path: string): string {
    const base = new URL(this.access.url)
    if (/(^|\.)sentry\.io$/.test(base.hostname)) {
      return `https://${this.access.org}.sentry.io${path}`
    }
    return `${this.access.url}/organizations/${this.access.org}${path}`
  }

  private async request(
    path: string,
    options: {
      method?: string
      query?: Record<string, string | number | readonly string[] | undefined>
      body?: unknown
      global?: boolean
    } = {},
  ): Promise<{ json: unknown; next: string | null }> {
    const base = options.global ? this.access.url : await this.regionUrl()
    const url = new URL(`${base}/api/0${path}`)
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined) continue
      for (const one of Array.isArray(value) ? value : [value])
        url.searchParams.append(key, String(one))
    }
    let response: Response
    try {
      response = await this.fetcher(url, {
        method: options.method ?? 'GET',
        headers: {
          authorization: `Bearer ${this.access.token}`,
          'content-type': 'application/json',
          'user-agent': 'wilco',
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (err) {
      throw new SentryError(
        0,
        `could not reach Sentry at ${base}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
    const text = await response.text()
    let json: unknown = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {
      json = null
    }
    if (!response.ok) {
      const detail = (json as { detail?: unknown } | null)?.detail
      const said = typeof detail === 'string' ? detail : text.slice(0, 200)
      throw new SentryError(response.status, explain(response.status, said, this.access))
    }
    return { json, next: nextCursor(response.headers.get('link')) }
  }

  /** The organization's own region, asked once. Self-hosted Sentry has none, and is its own. */
  private async regionUrl(): Promise<string> {
    if (this.region) return this.region
    try {
      const { json } = await this.request(`/organizations/${this.access.org}/`, { global: true })
      const region = (json as { links?: { regionUrl?: unknown } } | null)?.links?.regionUrl
      this.region =
        typeof region === 'string' && region ? region.replace(/\/+$/, '') : this.access.url
    } catch (err) {
      if (
        err instanceof SentryError &&
        (err.status === 401 || err.status === 403 || err.status === 404)
      )
        throw err
      this.region = this.access.url
    }
    return this.region
  }

  /** Project ids for slugs, which is what the organization endpoints filter by. */
  async projectIdsOf(slugs: readonly string[]): Promise<string[]> {
    const out: string[] = []
    for (const slug of slugs) {
      const known = this.projectIds.get(slug)
      if (known) {
        out.push(known)
        continue
      }
      const { json } = await this.request(`/projects/${this.access.org}/${slug}/`)
      const id = (json as { id?: unknown } | null)?.id
      if (typeof id !== 'string' && typeof id !== 'number')
        throw new SentryError(404, `there is no Sentry project called ${slug}`)
      this.projectIds.set(slug, String(id))
      out.push(String(id))
    }
    return out
  }

  async issues(options: {
    projects: readonly string[]
    query?: string
    period?: string
    sort?: string
    limit?: number
    environment?: string
  }): Promise<Page<Json>> {
    const { json, next } = await this.request(`/organizations/${this.access.org}/issues/`, {
      query: {
        project: await this.projectIdsOf(options.projects),
        query: options.query ?? 'is:unresolved',
        statsPeriod: options.period ?? '14d',
        sort: options.sort ?? 'date',
        limit: Math.min(100, options.limit ?? 25),
        environment: options.environment,
        // Not `stats` or `lifetime`: on the list those take the counts with them.
        collapse: ['filtered', 'unhandled'],
      },
    })
    return { items: Array.isArray(json) ? (json as Json[]) : [], next }
  }

  /** One issue, by its numeric id or its short id (`SHOP-1A`). */
  async issue(id: string): Promise<Json> {
    const { json } = await this.request(
      `/organizations/${this.access.org}/issues/${encodeURIComponent(id)}/`,
    )
    return (json ?? {}) as Json
  }

  /** An issue's event: the one Sentry recommends looking at, or the latest. */
  async event(
    issueId: string,
    which: 'recommended' | 'latest' | 'oldest' | string = 'recommended',
  ): Promise<Json> {
    const { json } = await this.request(
      `/organizations/${this.access.org}/issues/${encodeURIComponent(issueId)}/events/${encodeURIComponent(which)}/`,
    )
    return (json ?? {}) as Json
  }

  /** A trace, as the spans (and errors) in it. */
  async trace(traceId: string, period = '14d'): Promise<Json[]> {
    const { json } = await this.request(
      `/organizations/${this.access.org}/trace/${encodeURIComponent(traceId)}/`,
      {
        query: { statsPeriod: period, project: '-1', limit: 10_000 },
      },
    )
    return Array.isArray(json) ? (json as Json[]) : []
  }

  /** Rows from one of the Explore datasets: errors, spans, logs, tracemetrics. */
  async events(options: {
    dataset: string
    fields: readonly string[]
    query?: string
    period?: string
    sort?: string
    limit?: number
    projects?: readonly string[]
  }): Promise<Json[]> {
    const { json } = await this.request(`/organizations/${this.access.org}/events/`, {
      query: {
        dataset: options.dataset,
        field: options.fields,
        query: options.query,
        statsPeriod: options.period ?? '24h',
        sort: options.sort,
        per_page: Math.min(100, options.limit ?? 50),
        project:
          options.projects && options.projects.length > 0
            ? await this.projectIdsOf(options.projects)
            : undefined,
      },
    })
    const data = (json as { data?: unknown } | null)?.data
    return Array.isArray(data) ? (data as Json[]) : []
  }

  /** A time series: how one aggregate moved over a period. */
  async series(options: {
    dataset: string
    yAxis: string
    query?: string
    period?: string
    interval?: string
    projects?: readonly string[]
  }): Promise<{ at: number; value: number }[]> {
    const { json } = await this.request(`/organizations/${this.access.org}/events-stats/`, {
      query: {
        dataset: options.dataset,
        yAxis: options.yAxis,
        query: options.query,
        statsPeriod: options.period ?? '24h',
        interval: options.interval ?? '1h',
        project:
          options.projects && options.projects.length > 0
            ? await this.projectIdsOf(options.projects)
            : undefined,
      },
    })
    const data = (json as { data?: unknown } | null)?.data
    if (!Array.isArray(data)) return []
    return data.flatMap((point) => {
      if (!Array.isArray(point)) return []
      const [at, values] = point as [unknown, unknown]
      const value = Array.isArray(values)
        ? (values[0] as { count?: unknown } | undefined)?.count
        : undefined
      return typeof at === 'number' && typeof value === 'number' ? [{ at: at * 1000, value }] : []
    })
  }

  async updateIssue(id: string, change: Json): Promise<Json> {
    const { json } = await this.request(
      `/organizations/${this.access.org}/issues/${encodeURIComponent(id)}/`,
      {
        method: 'PUT',
        body: change,
      },
    )
    return (json ?? {}) as Json
  }

  /** What Seer has worked out about an issue, if anything has been asked. */
  async rootCause(id: string): Promise<Json | null> {
    const { json } = await this.request(
      `/organizations/${this.access.org}/issues/${encodeURIComponent(id)}/autofix/`,
    )
    const autofix = (json as { autofix?: unknown } | null)?.autofix
    return autofix && typeof autofix === 'object' ? (autofix as Json) : null
  }

  async startRootCause(id: string): Promise<void> {
    await this.request(
      `/organizations/${this.access.org}/issues/${encodeURIComponent(id)}/autofix/`,
      {
        method: 'POST',
        body: { step: 'root_cause', referrer: 'wilco' },
      },
    )
  }
}

/** A Sentry answer that went wrong, in words that say what to do. */
function explain(status: number, said: string, access: SentryAccess): string {
  switch (status) {
    case 401:
      return `Sentry did not accept the token from ${access.from} (401): it may have expired or been revoked`
    case 402:
      return `Sentry says this needs a plan or budget the organization does not have (402): ${said}`
    case 403:
      return `Sentry refused (403): the token from ${access.from} lacks a scope this needs, or the feature is off for ${access.org}. ${said}`
    case 404:
      return `Sentry has no such thing (404): ${said}`
    case 429:
      return 'Sentry is rate limiting these requests (429): try again in a minute'
    default:
      return `Sentry answered ${status}: ${said}`
  }
}

/** The cursor for the next page, from Sentry's `Link` header. */
export function nextCursor(link: string | null): string | null {
  if (!link) return null
  for (const part of link.split(',')) {
    if (/rel="next"/.test(part) && /results="true"/.test(part)) {
      return /cursor="([^"]+)"/.exec(part)?.[1] ?? null
    }
  }
  return null
}
