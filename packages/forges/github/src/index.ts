import type { CheckRun } from '@tade/checks-core'
import {
  type Access,
  type AppInstallation,
  credentialCache,
  type Forge,
  type ForgeCapabilities,
  ForgeError,
  type ForgeOptions,
  hostOf,
  type NoteReceipt,
  type OpenRequest,
  type Page,
  type Patch,
  type RemotePlace,
  type Review,
  type ReviewDetail,
  type ReviewQuery,
  type ReviewRef,
} from '@tade/forges-core'
import { appFormAt, appToken, madeFrom } from './app.ts'
import { asCheckRun, asDetail, asReview } from './map.ts'
import { DRAFT, NODE_ID, OF_BRANCH, ONE, READY, REPLY, SEARCH } from './queries.ts'
import { githubTickets } from './tickets.ts'

// GitHub, through one credential and one HTTP client.
//
// `gh` is how the credential is found, because that is zero setup for anybody
// who already uses it and it holds **more than one** account per host — `gh
// auth token --hostname <host> --user <account>` is the whole multi-account
// design, and which account to ask for is read off the remote (`placeOf`)
// rather than off this machine. The token is held in memory and nowhere else —
// what `gh` answered for minutes, per sign-in (`options.credentials`) — and
// Tade never writes one anywhere. A machine with no `gh` sets `$GITHUB_TOKEN`
// (or whatever `token_env` names) instead.
//
// Everything after the credential is a plain request, so a poll of the lists
// is two GraphQL searches rather than two process spawns per review.
//
// **And a GitHub App, where the person made one** (`app.ts`,
// `ForgeOptions.app`): a read about a repository the App is installed on is
// asked with that installation's own token — an hour long, its own budget, and
// only what the App was allowed — and everything else as before. Which reads
// is said at each call (`about`), never worked out from a URL: whether this
// sign-in can see a repository (`access`) is a question about the person and
// is asked as the person.

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
    tickets: true,
    patches: true,
    // GitHub's own word for a batch of line comments is "a review", and
    // submitting one carries an event — `APPROVE`, `REQUEST_CHANGES`,
    // `COMMENT`. Tade files no verdict, so the notes go up as plain review
    // comments, one request each, which is the half of that API that has no
    // verdict in it at all.
    notes: true,
    // An SSH host alias — `git@github.com-ammujacic:…` — is how somebody with
    // two GitHub accounts keeps them apart, and `gh` holds a sign-in for each.
    accounts: true,
    // Made from a manifest, installed where the person picks, and asked as
    // for reading those repositories (`app.ts`).
    apps: true,
    // One search for what is ours, one for what waits on us.
    costPerPoll: 2,
  }

  let token: string | null = null
  let me: string | null = null
  /** Which sign-in a credential is for: the host, and the account where the remote names one. */
  const signIn = options.accounts?.[host] ? `${options.accounts[host]}@${host}` : host
  let limits: { remaining: number; of: number; resetsAt: number } | null = null

  const rest = (path: string) =>
    host === 'github.com' ? `https://api.github.com${path}` : `https://${host}/api/v3${path}`
  const graphqlUrl =
    host === 'github.com' ? 'https://api.github.com/graphql' : `https://${host}/api/graphql`

  /**
   * The credential, found once. Three clauses, and each of them is a decision:
   *
   *   · An explicit `token_env` is somebody saying "the CLI is not what I use
   *     here", so the environment wins outright and nothing below applies.
   *   · Otherwise **a remote that names an account is answered by that
   *     account's sign-in, or by nothing**. `$GITHUB_TOKEN` is whichever
   *     account this machine happens to hold, and the whole of this bug is a
   *     repository being asked about as the machine's default when it had said
   *     whose it was — falling back to it would be the same "not found" with a
   *     credential attached, which is worse because it looks answered.
   *   · Otherwise the environment first, then `gh`'s keyring: zero setup for
   *     anybody who already uses `gh`, and a token for anybody who does not.
   *
   * What `gh` answered is kept in `options.credentials` where there is one —
   * a forge lives for one look, and asking `gh` again at every look was a
   * process a minute per project for an answer that had not changed.
   */
  async function credential(): Promise<string> {
    if (token) return token
    const account = options.accounts?.[host]
    const named = options.tokenEnv ? [options.tokenEnv] : DEFAULT_TOKEN_VARS
    if (options.tokenEnv || !account) {
      for (const key of named) {
        const value = env[key]
        if (value?.trim()) {
          token = value.trim()
          return token
        }
      }
    }
    const ask = async (): Promise<string> => {
      const args = ['auth', 'token', '--hostname', host, ...(account ? ['--user', account] : [])]
      const got = await options.exec('gh', args, {
        timeoutMs: 5_000,
        ...(options.cwd ? { cwd: options.cwd } : {}),
      })
      const found = got.stdout.trim()
      if (got.code !== 0 || !found) {
        throw new ForgeError('auth', notSignedIn(host, account, named[0]), {
          said: got.stderr.trim() || undefined,
        })
      }
      return found
    }
    if (options.credentials) return options.credentials.get(signIn, ask)
    token = await ask()
    return token
  }

  /** The app this forge may read as, where it was made on this host. */
  const app = options.app && options.app.host.toLowerCase() === host ? options.app : null
  /**
   * Where what the App found is kept: the registry's cache where there is one,
   * and otherwise one of this forge's own, which lives for its one look. The
   * same cache and the same rules as a sign-in's (`credentials.ts`).
   */
  const kept = options.credentials ?? credentialCache({ now })

  /**
   * The installation's token for reading `repo`, or null where the App is not
   * installed on it — an answer, kept like one, so a repository nobody gave
   * the App costs one request per ten minutes rather than one per look. What
   * is wrong with the App itself — a key that is not one, an App deleted — is
   * a throw that names it, never a quiet fall back: somebody connected it and
   * needs to hear that it stopped working.
   */
  async function installed(repo: string): Promise<{ token: string; signIn: string } | null> {
    if (app === null) return null
    const of = `app ${app.id}@${host}`
    const installation = await kept.get(`${of} on ${repo.toLowerCase()}`, async () => {
      const answer = await asTheApp(rest(`/repos/${repo}/installation`))
      if (answer.status === 404) return ''
      const id = (answer.body as { id?: unknown } | null)?.id
      if (typeof id !== 'number' && typeof id !== 'string') {
        throw new ForgeError(
          'server',
          `${host} did not say where GitHub App ${app.id} is installed`,
        )
      }
      return String(id)
    })
    if (installation === '') return null
    const signIn = `${of} installation ${installation}`
    return { token: await kept.get(signIn, () => installationToken(installation)), signIn }
  }

  /** A fresh token for one installation, signed for by the App. An hour long. */
  async function installationToken(installation: string): Promise<string> {
    const answer = await asTheApp(rest(`/app/installations/${installation}/access_tokens`), 'POST')
    const token = (answer.body as { token?: unknown } | null)?.token
    if (answer.status >= 300 || typeof token !== 'string' || token === '') {
      throw new ForgeError(
        answer.status === 404 ? 'missing' : 'auth',
        `${host} would not give GitHub App ${app?.id ?? ''} a token for installation ${installation}`,
        { said: said(answer.body) || undefined },
      )
    }
    return token
  }

  /**
   * One request signed as the App itself: which installation is where, and an
   * installation's token. Its own answer rather than `request`'s, because the
   * App's word is the only credential these take and a 404 here is an answer.
   */
  async function asTheApp(url: string, method = 'GET'): Promise<{ status: number; body: unknown }> {
    if (app === null) throw new ForgeError('auth', `no GitHub App is connected for ${host}`)
    let answer: Response
    try {
      answer = await doFetch(url, {
        method,
        headers: {
          authorization: `Bearer ${appToken(app, now())}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'tade',
        },
      })
    } catch (err) {
      if (err instanceof ForgeError) throw err
      throw new ForgeError('network', `could not reach ${host}`, {
        said: err instanceof Error ? err.message : String(err),
      })
    }
    const text = await answer.text()
    const body = text ? safeJson(text) : null
    if (answer.status === 401) {
      throw new ForgeError(
        'auth',
        `${host} did not accept GitHub App ${app.id}: it may have been deleted, or its key replaced — connect GitHub again`,
        { said: said(body) || undefined },
      )
    }
    if (answer.status >= 500) {
      throw new ForgeError('server', `${host} answered ${answer.status}`, {
        said: said(body) || text.slice(0, 200),
      })
    }
    return { status: answer.status, body }
  }

  async function request(
    url: string,
    init: {
      method?: string
      body?: unknown
      accept?: string
      /** Conditional-request headers: `if-none-match`, and nothing secret. */
      headers?: Record<string, string>
      /**
       * The repository this is a read about, where an App installed on it may
       * answer it. Unsaid, it is asked as the person.
       */
      about?: string
    } = {},
  ): Promise<{ status: number; body: unknown; text: string; headers: Headers }> {
    const asApp = init.about === undefined ? null : await installed(init.about)
    const auth = asApp?.token ?? (await credential())
    let answer: Response
    try {
      answer = await doFetch(url, {
        method: init.method ?? 'GET',
        headers: {
          authorization: `Bearer ${auth}`,
          accept: init.accept ?? 'application/vnd.github+json',
          'user-agent': 'tade',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...init.headers,
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
    // **What the App may not read is asked again as the person**, once: a
    // permission it was not given, or an installation taken away since its
    // token was handed out. The App answers what it may and the person the
    // rest, which is exactly what they could read before it existed.
    if (
      asApp !== null &&
      (answer.status === 401 || (answer.status === 403 && !/rate limit/i.test(text)))
    ) {
      // A 401 is the token gone; a 403 is only this endpoint, and the token
      // is still good for the next read.
      if (answer.status === 401) kept.refused(asApp.signIn, asApp.token)
      return request(url, { ...init, about: undefined })
    }
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
      // Expired or revoked: whichever forge asks next looks for it again rather
      // than being handed the same one for the rest of ten minutes.
      token = null
      options.credentials?.refused(signIn, auth)
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

  async function graphql(
    query: string,
    variables: Record<string, unknown>,
    about?: string,
  ): Promise<unknown> {
    const answer = await request(graphqlUrl, {
      method: 'POST',
      body: { query, variables },
      ...(about === undefined ? {} : { about }),
    })
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

  /** One `/user`: who the credential belongs to, and what it is allowed to do. */
  async function asWhom(): Promise<{ login: string; can: 'read' | 'write' }> {
    const answer = await request(rest('/user'))
    const found = (answer.body as { login?: unknown } | null)?.login
    if (typeof found !== 'string') throw new ForgeError('auth', `${host} did not say who we are`)
    me = found
    // A token's scopes are on the answer; an installation token has none, and
    // claiming read-only for it would refuse writes it can make.
    const scopes = answer.headers.get('x-oauth-scopes')
    const can =
      scopes === null || scopes === '' || /(^|,\s*)(repo|public_repo)(,|$)/.test(scopes)
        ? ('write' as const)
        : ('read' as const)
    return { login: found, can }
  }

  /**
   * What the remote declares, read out of how it is written and nothing else.
   *
   * A host Tade already serves is the ordinary case and names no account. An
   * SSH host alias — `github.com-ammujacic`, which is what `~/.ssh/config`
   * makes to hold a second key — is a known host, a separator, and the account
   * whoever set it up named. That suffix is a declaration, so it is read;
   * anything else is a host this forge cannot place, and saying so is better
   * than resolving it against this machine's files or against somebody's API.
   */
  function placeOf(remote: string): RemotePlace | null {
    const where = hostOf(remote)
    if (where === null) return null
    if (hosts.includes(where)) return { host: where, account: null }
    for (const known of hosts) {
      for (const separator of ['-', '_']) {
        const prefix = `${known}${separator}`
        if (!where.startsWith(prefix)) continue
        const account = where.slice(prefix.length)
        if (account) return { host: known, account }
      }
    }
    return null
  }

  const parts = (ref: ReviewRef) => {
    const [owner, name] = ref.repo.split('/')
    if (!owner || !name) throw new ForgeError('missing', `${ref.repo} is not an owner/name`)
    return { owner, name }
  }

  /** The commit a review's head is on now — asked again rather than remembered. */
  async function headOf(ref: ReviewRef): Promise<string> {
    return (await endsOf(ref)).head
  }

  /** Both ends of a review as they are now, in the one request that answers both. */
  async function endsOf(ref: ReviewRef): Promise<{ head: string; base: string | null }> {
    const detail = (
      await request(rest(`/repos/${ref.repo}/pulls/${ref.number}`), { about: ref.repo })
    ).body as {
      head?: { sha?: string }
      base?: { sha?: string }
    } | null
    const sha = detail?.head?.sha
    if (!sha) throw new ForgeError('missing', `there is no ${ref.repo}#${ref.number}`)
    return { head: sha, base: detail?.base?.sha ?? null }
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
      return placeOf(remote) !== null
    },

    placeOf,

    async whoami() {
      try {
        return await asWhom()
      } catch (err) {
        return { problem: err instanceof Error ? err.message : String(err) }
      }
    },

    async access(repo): Promise<Access> {
      const named = options.accounts?.[host] ?? null
      try {
        const who = await asWhom()
        try {
          await request(rest(`/repos/${repo}`))
          return { kind: 'signed in', account: who.login, can: who.can }
        } catch (err) {
          // GitHub hides what you may not see rather than refusing it, so a
          // repository that is there answers 404 to the wrong account. That is
          // the whole reason this question exists: it is asked about the
          // repository itself, where "not found" can only mean one thing.
          if (err instanceof ForgeError && (err.trouble === 'missing' || err.trouble === 'auth')) {
            return { kind: 'no access', account: who.login, said: noAccess(host, repo, who.login) }
          }
          throw err
        }
      } catch (err) {
        if (err instanceof ForgeError && err.trouble === 'auth') {
          return { kind: 'not signed in', account: named, said: err.message }
        }
        return { kind: 'cannot tell', said: err instanceof Error ? err.message : String(err) }
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
      const data = (await graphql(ONE, { ...parts(ref), number: ref.number }, ref.repo)) as {
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
      const data = (await graphql(OF_BRANCH, { owner, name, branch }, repo)) as {
        repository?: { pullRequests?: { nodes?: unknown[] } }
      }
      const node = data?.repository?.pullRequests?.nodes?.[0]
      return node ? asReview(node, who, host) : null
    },

    // GitHub publishes every pull request's head under the base repository,
    // which is the only way to a review opened from a fork: its branch is in
    // somebody else's repository and `origin` has never heard of it. Not a
    // name to check out *as* — the branch is still the one the review was
    // opened from.
    headRef(ref) {
      return `refs/pull/${ref.number}/head`
    },

    // Both of these were always a question about a commit underneath: a
    // review's number buys nothing but the sha, so the commit-addressed pair
    // is the real call and the review-addressed pair resolves the head first.
    async checks(ref) {
      return this.checksOn(ref.repo, await headOf(ref))
    },

    async checksOn(repo, commit) {
      const answer = await request(
        rest(`/repos/${repo}/commits/${commit}/check-runs?per_page=100`),
        { about: repo },
      )
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
        await request(rest(`/repos/${repo}/actions/runs?head_sha=${commit}&per_page=20`), {
          about: repo,
        })
      ).body as { workflow_runs?: { id?: number }[] } | null
      for (const run of list?.workflow_runs ?? []) {
        if (typeof run.id !== 'number') continue
        const jobs = (
          await request(rest(`/repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`), {
            about: repo,
          })
        ).body as { jobs?: { id?: number; name?: string }[] } | null
        const job = jobs?.jobs?.find((one) => one.name === check)
        if (!job?.id) continue
        const log = await request(rest(`/repos/${repo}/actions/jobs/${job.id}/logs`), {
          accept: 'text/plain',
          about: repo,
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

    async patch(ref, limit): Promise<Patch> {
      const ends = await endsOf(ref)
      const want = limit?.files !== undefined && limit.files > 0 ? limit.files : 300
      const files: Patch['files'][number][] = []
      let more = false
      // One past what was asked for, so `more` is set by having *seen* a file
      // beyond the limit rather than by the count happening to reach it: a
      // change with exactly as many files as the caller asked for is a change
      // that was read in full, and saying otherwise would make a reviewer
      // report half a change it actually had.
      const per = Math.min(100, want + 1)
      for (let page = 1; page <= 10; page += 1) {
        const answer = await request(
          rest(`/repos/${ref.repo}/pulls/${ref.number}/files?per_page=${per}&page=${page}`),
          { about: ref.repo },
        )
        const got = Array.isArray(answer.body) ? (answer.body as Record<string, unknown>[]) : []
        for (const one of got) {
          if (files.length >= want) {
            more = true
            break
          }
          files.push(asFilePatch(one))
        }
        if (more || got.length < per) break
      }
      return { head: ends.head, base: ends.base, files, more }
    },

    async note(ref, what): Promise<readonly NoteReceipt[]> {
      if (!what.on.trim()) throw new ForgeError('refused', 'say which commit the notes are of')
      const receipts: NoteReceipt[] = []
      for (const one of what.notes) {
        try {
          await request(rest(`/repos/${ref.repo}/pulls/${ref.number}/comments`), {
            method: 'POST',
            body: {
              body: one.body,
              commit_id: what.on,
              path: one.path,
              // A line is on the new side of the patch, which is the only side
              // a note Tade writes is ever about; no line at all is GitHub's
              // own `subject_type: file`, which is how a note about a whole
              // file is anchored without inventing a line number for it.
              ...(one.line === null ? { subject_type: 'file' } : { line: one.line, side: 'RIGHT' }),
            },
          })
          receipts.push({ path: one.path, line: one.line, posted: true })
        } catch (err) {
          // One line that has moved under the patch is refused on its own; the
          // rest still go up, and the caller is told which did not.
          receipts.push({
            path: one.path,
            line: one.line,
            posted: false,
            said: err instanceof ForgeError ? (err.said ?? err.message) : String(err),
          })
        }
      }
      // Last, so a window that died halfway leaves the notes up and the thing
      // that says a review happened absent — which reads as unfinished rather
      // than as done, and is the direction a reconciling caller can recover.
      if (what.body?.trim()) {
        await request(rest(`/repos/${ref.repo}/issues/${ref.number}/comments`), {
          method: 'POST',
          body: { body: what.body },
        })
      }
      return receipts
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

    // The issues half, in its own file: a ticket is not a review, and the two
    // things it has to get right — telling a pull request apart from an issue,
    // and who applied a label as against who wrote the words — are nothing to
    // do with anything above.
    ...githubTickets(request, rest, host),

    appForm(want) {
      return appFormAt(host, want)
    },

    async appMade(code) {
      // GitHub's own words: this "does not require authentication", and the
      // code is the whole of what identifies the app — one use, within an
      // hour. So nothing of the person's goes with it.
      let answer: Response
      try {
        answer = await doFetch(rest(`/app-manifests/${encodeURIComponent(code)}/conversions`), {
          method: 'POST',
          headers: { accept: 'application/vnd.github+json', 'user-agent': 'tade' },
        })
      } catch (err) {
        throw new ForgeError('network', `could not reach ${host}`, {
          said: err instanceof Error ? err.message : String(err),
        })
      }
      const text = await answer.text()
      const body = text ? safeJson(text) : null
      if (answer.status === 404) {
        throw new ForgeError(
          'missing',
          `${host} does not know that code: it is used once, within an hour — make the app again`,
        )
      }
      if (answer.status === 422) {
        throw new ForgeError('refused', `${host} refused: ${said(body) || 'not that code'}`)
      }
      if (answer.status >= 400) {
        throw new ForgeError(
          answer.status >= 500 ? 'server' : 'refused',
          `${host} answered ${answer.status}`,
          {
            said: said(body) || text.slice(0, 200),
          },
        )
      }
      return madeFrom(body, host)
    },

    appInstallUrl(slug, state) {
      return `https://${host}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`
    },

    async appInstallations(): Promise<readonly AppInstallation[]> {
      if (app === null) throw new ForgeError('auth', `no GitHub App is connected for ${host}`)
      const answer = await asTheApp(rest('/app/installations?per_page=100'))
      if (answer.status >= 400) {
        throw new ForgeError(
          'auth',
          `${host} would not say where GitHub App ${app.id} is installed`,
          {
            said: said(answer.body) || undefined,
          },
        )
      }
      const list = Array.isArray(answer.body) ? (answer.body as Record<string, unknown>[]) : []
      const out: AppInstallation[] = []
      for (const one of list) {
        const id = String(one.id ?? '')
        if (id === '') continue
        const account = (one.account ?? {}) as { login?: unknown }
        const login = typeof account.login === 'string' ? account.login : ''
        if (one.repository_selection === 'all') {
          out.push({ id, account: login, repositories: 'all' })
          continue
        }
        // How many it was given is one more request, as the installation:
        // `total_count` of a page of one.
        const token = await kept.get(`app ${app.id}@${host} installation ${id}`, () =>
          installationToken(id),
        )
        // A count that could not be read is a throw, never nought: "installed
        // on no repositories" is the one answer that would send somebody to
        // GitHub to fix what is not broken.
        let counted: Response
        try {
          counted = await doFetch(rest('/installation/repositories?per_page=1'), {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'tade',
            },
          })
        } catch (err) {
          throw new ForgeError('network', `could not reach ${host}`, {
            said: err instanceof Error ? err.message : String(err),
          })
        }
        const total = (safeJson(await counted.text()) as { total_count?: unknown } | null)
          ?.total_count
        if (!counted.ok || typeof total !== 'number') {
          throw new ForgeError(
            counted.status >= 500 ? 'server' : 'auth',
            `${host} would not say how many repositories GitHub App ${app.id} may read for ${login}`,
          )
        }
        out.push({ id, account: login, repositories: total })
      }
      return out
    },

    limits() {
      return limits
    },
  }
}

/**
 * Nothing to sign in with. Where the remote named an account, that is what the
 * sentence is about: telling somebody to run `gh auth login` when they are
 * already signed in — as somebody else — is the unhelpful half of this bug.
 */
function notSignedIn(host: string, account: string | undefined, variable = 'GITHUB_TOKEN'): string {
  return account
    ? `not signed in to ${host} as ${account}, which is the account this remote names: run \`gh auth login --hostname ${host}\` and sign in as ${account}`
    : `not signed in to ${host}: run \`gh auth login\`, or set $${variable}`
}

/** Signed in, and this account cannot see it. One stable sentence: no sha, no count. */
function noAccess(host: string, repo: string, account: string): string {
  return `no access to ${repo} from this account: ${host} does not show it to ${account}`
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

/** One file of GitHub's `pulls/<n>/files`, in the port's words. */
function asFilePatch(one: Record<string, unknown>): Patch['files'][number] {
  const status = String(one.status ?? '')
  const patch = typeof one.patch === 'string' && one.patch !== '' ? one.patch : null
  return {
    path: String(one.filename ?? ''),
    from: typeof one.previous_filename === 'string' ? one.previous_filename : null,
    added: Number(one.additions ?? 0),
    removed: Number(one.deletions ?? 0),
    what:
      status === 'added'
        ? 'added'
        : status === 'removed'
          ? 'removed'
          : status === 'renamed'
            ? 'renamed'
            : 'changed',
    // Null where GitHub handed none over: a binary file, or one it decided was
    // too large. Never an empty string, which would read as an empty diff.
    patch,
  }
}
