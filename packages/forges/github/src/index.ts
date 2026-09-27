import type { CheckRun } from '@tade/checks-core'
import {
  type Forge,
  type ForgeCapabilities,
  ForgeError,
  type ForgeOptions,
  hostOf,
  type OpenRequest,
  type Page,
  type Review,
  type ReviewDetail,
  type ReviewQuery,
  type ReviewRef,
} from '@tade/forges-core'
import { asCheckRun, asDetail, asReview } from './map.ts'
import { DRAFT, NODE_ID, OF_BRANCH, ONE, READY, REPLY, SEARCH } from './queries.ts'

// GitHub, through one credential and one HTTP client.
//
// `gh` is how the credential is found, because that is zero setup for anybody
// who already uses it and it holds one account per host — `gh auth token
// --user <account>` is the whole multi-account design. The token is read,
// used and dropped: Tade never writes one anywhere. A machine with no `gh`
// sets `$GITHUB_TOKEN` (or whatever `token_env` names) instead.
//
// Everything after the credential is a plain request, so a poll of the lists
// is two GraphQL searches rather than two process spawns per review.

const DEFAULT_TOKEN_VARS = ['GITHUB_TOKEN', 'GH_TOKEN']

export function makeGithubForge(options: ForgeOptions): Forge {
  const now = options.now ?? Date.now
  const doFetch = options.fetch ?? globalThis.fetch.bind(globalThis)
  const env = options.env ?? {}
  const hosts = ['github.com', ...(options.hosts ?? [])].map((host) => host.toLowerCase())
  const host = hosts[0] ?? 'github.com'
  const capabilities: ForgeCapabilities = {
    assigned: true,
    checks: true,
    commitChecks: true,
    checkLogs: true,
    threads: true,
    drafts: true,
    rules: true,
    // A merge queue needs its own calls and its own failure modes; until they
    // are written, saying we have one would be worse than saying we do not.
    mergeQueue: false,
    stacks: false,
    write: true,
    since: true,
    // One search for what is ours, one for what waits on us.
    costPerPoll: 2,
  }

  let token: string | null = null
  let me: string | null = null
  let limits: { remaining: number; of: number; resetsAt: number } | null = null

  const rest = (path: string) =>
    host === 'github.com' ? `https://api.github.com${path}` : `https://${host}/api/v3${path}`
  const graphqlUrl =
    host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`

  /** The credential, found once: the environment first, then `gh`'s keyring. */
  async function credential(): Promise<string> {
    if (token) return token
    const named = options.tokenEnv ? [options.tokenEnv] : DEFAULT_TOKEN_VARS
    for (const key of named) {
      const value = env[key]
      if (value?.trim()) {
        token = value.trim()
        return token
      }
    }
    const account = options.accounts?.[host]
    const args = ['auth', 'token', '--hostname', host, ...(account ? ['--user', account] : [])]
    const got = await options.exec('gh', args, {
      timeoutMs: 5_000,
      ...(options.cwd ? { cwd: options.cwd } : {}),
    })
    const found = got.stdout.trim()
    if (got.code !== 0 || !found) {
      throw new ForgeError(
        'auth',
        `not signed in to ${host}: run \`gh auth login\`, or set $${named[0]}`,
        { said: got.stderr.trim() || undefined },
      )
    }
    token = found
    return token
  }

  async function request(
    url: string,
    init: { method?: string; body?: unknown; accept?: string } = {},
  ): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
    const auth = await credential()
    let answer: Response
    try {
      answer = await doFetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${auth}`,
          accept: init.accept ?? 'application/vnd.github+json',
          'user-agent': 'tade',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (err) {
      throw new ForgeError('network', `could not reach ${host}`, {
        said: err instanceof Error ? err.message : String(err),
      })
    }
    const remaining = Number(answer.headers.get('x-ratelimit-remaining') ?? Number.NaN)
    const of = Number(answer.headers.get('x-ratelimit-limit') ?? Number.NaN)
    const reset = Number(answer.headers.get('x-ratelimit-reset') ?? Number.NaN)
    if (Number.isFinite(remaining) && Number.isFinite(of)) {
      limits = {
        remaining,
        of,
        resetsAt: Number.isFinite(reset) ? reset * 1000 : now() + 60_000,
      }
    }
    const text = await answer.text()
    const body = text ? safeJson(text) : null
    if (answer.status === 403 || answer.status === 429) {
      if (remaining === 0 || /rate limit/i.test(text)) {
        throw new ForgeError('rate', `${host} is rate limiting us`, {
          retryAt: Number.isFinite(reset) ? reset * 1000 : now() + 60_000,
          said: said(body) || text.slice(0, 200),
        })
      }
      throw new ForgeError('auth', `${host} refused: ${said(body) || 'not allowed'}`)
    }
    if (answer.status === 401) {
      throw new ForgeError('auth', `${host} did not accept the credential: run \`gh auth login\``)
    }
    if (answer.status === 404) throw new ForgeError('missing', `${host} has no such thing`)
    if (answer.status === 422) {
      throw new ForgeError(
        'refused',
        `${host} refused: ${said(body) || 'it would not accept that'}`,
      )
    }
    if (answer.status >= 400) {
      // It answered, so this is never connectivity however badly it answered:
      // `network` is kept for nothing coming back, which is the only thing
      // that may put the machine offline.
      throw new ForgeError('server', `${host} answered ${answer.status}`, {
        said: said(body) || text.slice(0, 200),
      })
    }
    return { status: answer.status, body, text, headers: answer.headers }
  }

  async function graphql(query: string, variables: Record<string, unknown>): Promise<unknown> {
    const answer = await request(graphqlUrl, { method: 'POST', body: { query, variables } })
    const body = answer.body as { data?: unknown; errors?: { type?: string; message?: string }[] }
    const first = body?.errors?.[0]
    if (first) {
      const kind = first.type ?? ''
      if (kind === 'NOT_FOUND') throw new ForgeError('missing', first.message ?? 'no such thing')
      if (kind === 'FORBIDDEN' || kind === 'INSUFFICIENT_SCOPES') {
        throw new ForgeError('auth', first.message ?? 'not allowed')
      }
      if (kind === 'RATE_LIMITED') {
        throw new ForgeError('rate', first.message ?? 'rate limited', { retryAt: now() + 60_000 })
      }
      throw new ForgeError('refused', first.message ?? 'GitHub refused the query')
    }
    return body?.data ?? null
  }

  async function login(): Promise<string | null> {
    if (me) return me
    const answer = await request(rest('/user'))
    const found = (answer.body as { login?: unknown } | null)?.login
    me = typeof found === 'string' ? found : null
    return me
  }

  const parts = (ref: ReviewRef) => {
    const [owner, name] = ref.repo.split('/')
    if (!owner || !name) throw new ForgeError('missing', `${ref.repo} is not an owner/name`)
    return { owner, name }
  }

  /** The commit a review's head is on now — asked again rather than remembered. */
  async function headOf(ref: ReviewRef): Promise<string> {
    const detail = (await request(rest(`/repos/${ref.repo}/pulls/${ref.number}`))).body as {
      head?: { sha?: string }
    } | null
    const sha = detail?.head?.sha
    if (!sha) throw new ForgeError('missing', `there is no ${ref.repo}#${ref.number}`)
    return sha
  }

  async function nodeId(ref: ReviewRef): Promise<string> {
    const data = (await graphql(NODE_ID, { ...parts(ref), number: ref.number })) as {
      repository?: { pullRequest?: { id?: string } }
    }
    const id = data?.repository?.pullRequest?.id
    if (!id) throw new ForgeError('missing', `there is no ${ref.repo}#${ref.number}`)
    return id
  }

  return {
    id: 'github',
    capabilities,
    words: { one: 'pull request', many: 'pull requests', short: 'PR', number: (n) => `#${n}` },
    // The calls are HTTP; `gh` is how the credential is found, which is what
    // makes a review work with nothing set up. A token in the environment is
    // the way round it, so it is not required.
    programs: [
      {
        command: 'gh',
        title: 'GitHub CLI',
        why: 'finding your GitHub credential, unless a token is in the environment',
        versionArgs: ['--version'],
        optional: true,
        // Homebrew, and otherwise where GitHub says: the apt package is in
        // their own repository on most releases, and a `sudo apt-get install
        // gh` that fails is worse than a sentence that says where to look.
        install: { brew: 'gh', instead: 'cli.github.com has the package for your system' },
      },
    ],

    serves(remote) {
      const where = hostOf(remote)
      return where !== null && hosts.includes(where)
    },

    async whoami() {
      try {
        const who = await login()
        if (!who) return { problem: `${host} did not say who we are` }
        // A token's scopes are on the answer; an installation token has none,
        // and claiming read-only for it would refuse writes it can make.
        const answer = await request(rest('/user'))
        const scopes = answer.headers.get('x-oauth-scopes')
        const can =
          scopes === null || scopes === '' || /(^|,\s*)(repo|public_repo)(,|$)/.test(scopes)
            ? ('write' as const)
            : ('read' as const)
        return { login: who, can }
      } catch (err) {
        return { problem: err instanceof Error ? err.message : String(err) }
      }
    },

    async reviews(query: ReviewQuery): Promise<Page<Review>> {
      const who = await login()
      const parts: string[] = ['is:pr']
      if (!query.state || query.state.includes('open') || query.state.includes('draft')) {
        parts.push('is:open')
      }
      if (query.state?.length === 1 && query.state[0] === 'merged') parts.push('is:merged')
      if (query.state?.length === 1 && query.state[0] === 'closed') parts.push('is:closed')
      if (query.who === 'mine') parts.push('author:@me')
      if (query.who === 'waiting on you') parts.push('review-requested:@me')
      // Filters are applied in the query, not after it: somebody with two
      // hundred repositories pays for the ones they named.
      for (const repo of query.repos ?? []) parts.push(`repo:${repo}`)
      if (query.since) parts.push(`updated:>=${query.since.slice(0, 10)}`)
      const limit = Math.min(Math.max(1, query.limit ?? 30), 100)
      const data = (await graphql(SEARCH, {
        q: parts.join(' '),
        n: limit,
        after: query.cursor ?? null,
      })) as {
        search?: {
          issueCount?: number
          pageInfo?: { hasNextPage?: boolean; endCursor?: string | null }
          nodes?: unknown[]
        }
      }
      const nodes = data?.search?.nodes ?? []
      const items = nodes.flatMap((node) => {
        const review = asReview(node, who, host)
        return review ? [review] : []
      })
      return {
        items,
        cursor: data?.search?.pageInfo?.endCursor ?? null,
        more: data?.search?.pageInfo?.hasNextPage === true,
      }
    },

    async review(ref) {
      const who = await login()
      const data = (await graphql(ONE, { ...parts(ref), number: ref.number })) as {
        repository?: { pullRequest?: unknown }
      }
      const detail = asDetail(data?.repository?.pullRequest, who, ref.host || host)
      if (!detail) throw new ForgeError('missing', `there is no ${ref.repo}#${ref.number}`)
      const ran = await this.checks(ref).catch(() => [] as readonly CheckRun[])
      return { ...detail, checksRan: ran } satisfies ReviewDetail
    },

    async reviewOf(repo, branch) {
      const who = await login()
      const [owner, name] = repo.split('/')
      if (!owner || !name) return null
      const data = (await graphql(OF_BRANCH, { owner, name, branch })) as {
        repository?: { pullRequests?: { nodes?: unknown[] } }
      }
      const node = data?.repository?.pullRequests?.nodes?.[0]
      return node ? asReview(node, who, host) : null
    },

    // Both of these were always a question about a commit underneath: a
    // review's number buys nothing but the sha, so the commit-addressed pair
    // is the real call and the review-addressed pair resolves the head first.
    async checks(ref) {
      return this.checksOn(ref.repo, await headOf(ref))
    },

    async checksOn(repo, commit) {
      const answer = await request(rest(`/repos/${repo}/commits/${commit}/check-runs?per_page=100`))
      const runs = (answer.body as { check_runs?: unknown[] } | null)?.check_runs ?? []
      return runs.flatMap((one) => {
        const run = asCheckRun(one, { repo, commit, url: null })
        return run ? [run] : []
      })
    },

    async checkLog(ref, check, lines) {
      return this.checkLogOn(ref.repo, await headOf(ref), check, lines)
    },

    async checkLogOn(repo, commit, check, lines) {
      const runs = await this.checksOn(repo, commit)
      if (!runs.some((one) => one.check === check)) {
        throw new ForgeError(
          'missing',
          `${check} did not run on ${repo}@${commit.slice(0, 7)} (${runs.map((one) => one.check).join(', ') || 'nothing did'})`,
        )
      }
      const list = (
        await request(rest(`/repos/${repo}/actions/runs?head_sha=${commit}&per_page=20`))
      ).body as { workflow_runs?: { id?: number }[] } | null
      for (const run of list?.workflow_runs ?? []) {
        if (typeof run.id !== 'number') continue
        const jobs = (
          await request(rest(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`))
        ).body as { jobs?: { id?: number; name?: string }[] } | null
        const job = jobs?.jobs?.find((one) => one.name === check)
        if (!job?.id) continue
        const log = await request(rest(`/repos/${repo}/actions/jobs/${job.id}/logs`), {
          accept: 'text/plain',
        })
        return log.text.split('\n').slice(-lines).join('\n')
      }
      throw new ForgeError('missing', `${check} has no log on ${repo}@${commit.slice(0, 7)}`)
    },

    async open(request_: OpenRequest) {
      const answer = await request(rest(`/repos/${request_.repo}/pulls`), {
        method: 'POST',
        body: {
          title: request_.title,
          head: request_.head,
          base: request_.base,
          body: request_.body,
          draft: request_.draft,
        },
      })
      const made = answer.body as { number?: number } | null
      if (typeof made?.number !== 'number') {
        throw new ForgeError('refused', `${host} did not say what it opened`)
      }
      const ref: ReviewRef = { repo: request_.repo, number: made.number, host }
      if (request_.reviewers?.length) {
        await request(rest(`/repos/${request_.repo}/pulls/${made.number}/requested_reviewers`), {
          method: 'POST',
          body: { reviewers: request_.reviewers },
        })
      }
      if (request_.labels?.length) {
        await request(rest(`/repos/${request_.repo}/issues/${made.number}/labels`), {
          method: 'POST',
          body: { labels: request_.labels },
        })
      }
      const who = await login()
      const data = (await graphql(ONE, { ...parts(ref), number: ref.number })) as {
        repository?: { pullRequest?: unknown }
      }
      const detail = asDetail(data?.repository?.pullRequest, who, host)
      if (!detail) throw new ForgeError('missing', `could not read back ${ref.repo}#${ref.number}`)
      return detail
    },

    async say(ref, what) {
      if (!what.body.trim()) throw new ForgeError('refused', 'there is nothing to say')
      if (what.thread) {
        await graphql(REPLY, { thread: what.thread, body: what.body })
        return
      }
      await request(rest(`/repos/${ref.repo}/issues/${ref.number}/comments`), {
        method: 'POST',
        body: { body: what.body },
      })
    },

    async mark(ref, what) {
      if (what.ready) await graphql(READY, { id: await nodeId(ref) })
      if (what.draft) await graphql(DRAFT, { id: await nodeId(ref) })
      if (what.reviewers?.length) {
        await request(rest(`/repos/${ref.repo}/pulls/${ref.number}/requested_reviewers`), {
          method: 'POST',
          body: { reviewers: what.reviewers },
        })
      }
      if (what.labels?.length) {
        await request(rest(`/repos/${ref.repo}/issues/${ref.number}/labels`), {
          method: 'POST',
          body: { labels: what.labels },
        })
      }
    },

    async merge(ref, how) {
      if (how === 'queue') {
        throw new ForgeError('unsupported', 'Tade cannot put anything in a merge queue yet')
      }
      await request(rest(`/repos/${ref.repo}/pulls/${ref.number}/merge`), {
        method: 'PUT',
        body: { merge_method: how },
      })
    },

    limits() {
      return limits
    },
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function said(body: unknown): string {
  const raw = body as { message?: unknown; errors?: { message?: unknown }[] } | null
  const first = raw?.errors?.[0]?.message
  return typeof raw?.message === 'string' ? raw.message : typeof first === 'string' ? first : ''
}
