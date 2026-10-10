import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A GitHub that answers from files, for tests that must never reach one.
//
// The pull request shapes in `github/*.json` are GitHub's documented ones,
// written down here once and replayed by a fake `fetch`. What is around them
// — paging, rate limiting, what a read-only token is allowed to do — is
// played by this file, because those are the paths worth exercising and a
// static file cannot page.
//
// The only evidence that the real GitHub still looks like this is the live
// test, which is skipped by default and costs an account.

const here = dirname(fileURLToPath(import.meta.url))

const read = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(here, 'github', name), 'utf8')) as Record<string, unknown>

const readList = (name: string): unknown[] =>
  JSON.parse(readFileSync(join(here, 'github', name), 'utf8')) as unknown[]

/**
 * An `etag` for a body: stable for the same bytes and different for different
 * ones, which is the whole of what a caller may rely on. Not GitHub's own
 * algorithm, which nobody documents and nothing may depend on.
 */
function etagOf(text: string): string {
  let hash = 0
  for (let at = 0; at < text.length; at += 1) hash = (hash * 31 + text.charCodeAt(at)) | 0
  return `W/"${text.length.toString(16)}-${(hash >>> 0).toString(16)}"`
}

/** A `link` header the way GitHub writes one, for the pages that exist. */
function linkHeader(url: string, page: number, pages: number): string {
  const at = (n: number) => `<${url.replace(/([?&])page=\d+/, `$1page=${n}`)}>`
  const parts: string[] = []
  if (page < pages) parts.push(`${at(page + 1)}; rel="next"`, `${at(pages)}; rel="last"`)
  if (page > 1) parts.push(`${at(page - 1)}; rel="prev"`, `${at(1)}; rel="first"`)
  return parts.join(', ')
}

export interface GithubReplay {
  fetch: typeof fetch
  exec: (
    command: string,
    args: readonly string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>
  /** Every request made, as `METHOD url`, for asserting what Tade asked for. */
  calls: string[]
  /** What was sent, by call, for asserting what Tade would write. */
  bodies: unknown[]
  /**
   * The pull requests this GitHub has, as it has them. Mutable on purpose:
   * somebody force-pushing a branch or squashing a review is the server's
   * own state changing under a Tade that is already looking at it, and a
   * fixture that could not change could not show that.
   */
  pulls: Record<string, unknown>[]
  /** A branch rewritten under a review: a new head, and checks that never ran on it. */
  forcePush(number: number, sha: string): void
}

export interface ReplayOptions {
  /** No credential anywhere: `gh` says no and the environment has none. */
  signedOut?: boolean
  /** Every answer is a rate limit. */
  limited?: boolean
  /**
   * There is a credential and GitHub will not take it: `401`, which is a token
   * that expired or never had the scope, and is a different thing to do about it
   * from being rate limited or unreachable.
   */
  refused?: boolean
  /** The scopes the token answers with; writes are then refused as GitHub refuses them. */
  scopes?: string
  /** Who the token belongs to. */
  me?: string
  /**
   * What ran on a commit that is nobody's pull request head — a push straight
   * to `main`, which is the whole case the branch watch exists for. By sha,
   * in GitHub's own check-runs shape; a sha nothing names has had nothing run
   * on it, which is what CI not having got there yet looks like.
   */
  runs?: Record<string, { check_runs: Record<string, unknown>[] }>
  /** The log of one job, by `<sha>:<check>`. */
  logs?: Record<string, string>
  /**
   * Every question about a commit's checks is answered the way GitHub answers
   * one about a sha it has never been sent: `404 No commit found for SHA`.
   *
   * Written down because it is the answer a whole watch was built on top of
   * without anybody having seen it. It is what a commit that is only on
   * somebody's laptop looks like from here — and, told apart from that by
   * asking git first, what a branch pushed to a different repository than the
   * one Tade is reading looks like too.
   */
  missingCommit?: boolean
  /**
   * Nothing comes back at all: `fetch` rejects, which is what an offline
   * machine, a dead DNS or a dropped connection actually looks like.
   *
   * Its own option because it is a different fact from every other one here —
   * each of those is GitHub answering, and this is nobody answering. Told
   * apart, because only one of them could be about this machine.
   */
  unreachable?: boolean
  /** GitHub answers, badly: a 500. It was reached, so it is nothing to do with the network. */
  serverError?: boolean
  /**
   * The accounts `gh` holds a sign-in for here. Undefined is a `gh` that
   * answers for whoever it is asked about, which is what every other test
   * wants; a list is a machine where one alias maps to an account `gh` knows
   * and another maps to nothing.
   */
  signedInAs?: readonly string[]
  /**
   * The one account this GitHub shows its repositories to. Every other token
   * gets `404 Not Found` — which is how GitHub answers somebody who may not
   * see a repository, and is the whole reason "no access" has to be asked
   * about rather than read out of a message.
   */
  seenBy?: string
  /**
   * The issues this GitHub has, in its own shape — a pull request among them,
   * because GitHub's issues endpoints answer with both and telling them apart
   * is the caller's job. Undefined is `issues.json`.
   */
  issues?: Record<string, unknown>[]
  /** The events of each issue, by number, oldest first. Undefined is `issue-events.json`. */
  issueEvents?: Record<string, Record<string, unknown>[]>
  /**
   * Issue numbers the list still answers with and the detail answers `404`
   * for: an issue deleted, transferred or hidden between the two calls.
   *
   * Its own option because it is a real race and not a contrivance — a list is
   * a snapshot of a moment that has already passed — and because it is the
   * only way to tell it apart from a repository where every detail 404s, which
   * is what losing access looks like and must not read as "nothing is there".
   */
  goneDetails?: readonly number[]
  /**
   * The files of a pull request, in GitHub's own `pulls/<n>/files` shape, by
   * number. Undefined is `pull-<n>-files.json` where there is one, and an
   * empty list otherwise — a review whose commits are all on the base already,
   * which is an ordinary thing for somebody to have opened.
   */
  files?: Record<number, Record<string, unknown>[]>
  /**
   * Paths whose line comments GitHub refuses, as it refuses one whose line is
   * not part of the diff: `422`. By `<path>:<line>`.
   */
  refusesNotes?: Record<string, string>
  /**
   * Conditional requests are answered: a repeat ask carrying the `etag` this
   * handed over gets `304` and no body.
   *
   * On by default, because that is what GitHub does and because a poll that
   * relies on it is the whole reason the rate limit survives. Off is a forge
   * that never gets a `304`, which is every other host and must keep working.
   */
  etags?: boolean
}

export function githubReplay(options: ReplayOptions = {}): GithubReplay {
  const nodes = [read('pull-412.json'), read('pull-418.json')]
  const filesOf = (number: number): Record<string, unknown>[] => {
    const told = options.files?.[number]
    if (told) return told
    try {
      return readList(`pull-${number}-files.json`) as Record<string, unknown>[]
    } catch {
      return []
    }
  }
  const checkRuns = read('check-runs.json')
  const issues = options.issues ?? (readList('issues.json') as Record<string, unknown>[])
  const issueEvents =
    options.issueEvents ??
    (read('issue-events.json') as unknown as Record<string, Record<string, unknown>[]>)
  const calls: string[] = []
  const bodies: unknown[] = []
  let lastHeadSha = ''
  const me = options.me ?? 'mujacica'
  const readOnly = options.scopes !== undefined && !/repo/.test(options.scopes)

  const answer = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    // 304 is a null-body status and `Response` refuses one with a body, which
    // is the spec being right: a conditional answer is the headers and nothing
    // else, and that is exactly what a caller must be able to handle.
    new Response(status === 304 ? null : typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: {
        'content-type': 'application/json',
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4987',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 600),
        ...headers,
      },
    })

  const replayFetch = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const method = (init?.method ?? 'GET').toUpperCase()
    calls.push(`${method} ${url}`)
    // GitHub's jobs and logs are addressed by run id, not by commit, so the
    // replay keeps the commit the walk started at rather than inventing an
    // id-to-commit table nothing here would ever read back.
    const asked = /\/actions\/runs\?head_sha=([^&]+)/.exec(url)
    if (asked?.[1]) lastHeadSha = asked[1]
    if (init?.body) bodies.push(JSON.parse(String(init.body)))
    if (options.unreachable) {
      throw Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('getaddrinfo ENOTFOUND api.github.com'), {
          code: 'ENOTFOUND',
        }),
      })
    }
    if (options.serverError) {
      return answer({ message: 'Server Error' }, 500)
    }
    if (options.limited) {
      return answer({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300),
      })
    }
    if (options.refused) {
      return answer({ message: 'Bad credentials' }, 401)
    }
    // Which account is asking, read back out of the token `gh` handed over.
    // A real GitHub knows this because the token is the account; the replay
    // has to be told, and the token is where it is written.
    const auth = String((init?.headers as Record<string, string> | undefined)?.authorization ?? '')
    const asking = /^Bearer gho_(.+)token$/.exec(auth)?.[1] ?? me
    if (url.endsWith('/user')) {
      return answer(
        { login: asking },
        200,
        options.scopes === undefined ? {} : { 'x-oauth-scopes': options.scopes },
      )
    }
    // GitHub hides what you may not see rather than refusing it, so the wrong
    // account gets the same 404 as a repository that does not exist.
    if (options.seenBy !== undefined && asking !== options.seenBy) {
      return answer({ message: 'Not Found' }, 404)
    }
    if (readOnly && method !== 'GET' && !url.endsWith('/graphql')) {
      return answer({ message: 'Resource not accessible by personal access token' }, 403)
    }
    if (url.endsWith('/graphql')) {
      const sent = JSON.parse(String(init?.body ?? '{}')) as {
        query: string
        variables: Record<string, unknown>
      }
      if (readOnly && /^\s*mutation/.test(sent.query)) {
        return answer({ errors: [{ type: 'FORBIDDEN', message: 'read-only' }] })
      }
      return answer(graphql(sent, nodes, me))
    }
    // The repository itself, which is what "can this account see it at all?"
    // asks. Anything hidden from the asking account was already answered 404
    // above, so reaching here means it is shown.
    const repo = /\/repos\/([^/]+\/[^/]+)$/.exec(url)
    if (repo) return answer({ full_name: repo[1] })
    const runs = /\/repos\/([^/]+\/[^/]+)\/commits\/([^/]+)\/check-runs/.exec(url)
    if (runs) {
      const sha = runs[2] ?? ''
      if (options.missingCommit) {
        return answer({ message: `No commit found for SHA: ${sha}` }, 404)
      }
      const named = options.runs?.[sha]
      if (named) return answer(named)
      // A commit no pull request here is on, and nobody scripted, has had
      // nothing run on it. Answering the one fixture for every sha would make
      // "CI has not reached this push yet" untestable, and that is the state
      // a branch is in for a minute after every push.
      const head = nodes.some((one) => String(one.headRefOid) === sha)
      return answer(head ? checkRuns : { total_count: 0, check_runs: [] })
    }
    const jobs = /\/repos\/([^/]+\/[^/]+)\/actions\/runs\?head_sha=([^&]+)/.exec(url)
    if (jobs) return answer({ workflow_runs: [{ id: 77, head_sha: jobs[2] }] })
    if (/\/actions\/runs\/\d+\/jobs/.test(url)) {
      const sha = String(lastHeadSha)
      const names = options.runs?.[sha]?.check_runs ?? (checkRuns.check_runs as { name: string }[])
      return answer({
        jobs: names.map((one, n) => ({ id: 900 + n, name: String(one.name ?? '') })),
      })
    }
    const log = /\/actions\/jobs\/(\d+)\/logs/.exec(url)
    if (log) {
      const sha = String(lastHeadSha)
      const names = options.runs?.[sha]?.check_runs ?? (checkRuns.check_runs as { name: string }[])
      const name = String(names[Number(log[1]) - 900]?.name ?? '')
      return answer(options.logs?.[`${sha}:${name}`] ?? `nothing was kept for ${name}`, 200, {
        'content-type': 'text/plain',
      })
    }
    // Issues, and the events of one. Before the pull-request routes because
    // `/issues/504` is a pull request here too: GitHub answers about it from
    // both, and a fixture that could not would hide the one filtering mistake
    // this endpoint is famous for.
    const events = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)\/events\?(.*)$/.exec(url)
    if (events) {
      const all = issueEvents[String(events[2])] ?? []
      const query = new URLSearchParams(events[3] ?? '')
      const per = Math.min(Math.max(1, Number(query.get('per_page') ?? 30)), 100)
      const page = Math.max(1, Number(query.get('page') ?? 1))
      const pages = Math.max(1, Math.ceil(all.length / per))
      const body = all.slice((page - 1) * per, page * per)
      const link = linkHeader(url, page, pages)
      return answer(body, 200, link ? { link } : {})
    }
    const one = /\/repos\/([^/]+\/[^/]+)\/issues\/(\d+)$/.exec(url)
    if (one) {
      const number = Number(one[2])
      if (options.goneDetails?.includes(number)) {
        return answer({ message: 'Not Found' }, 404)
      }
      const found = issues.find((issue) => issue.number === number)
      return found ? answer(found) : answer({ message: 'Not Found' }, 404)
    }
    const listed = /\/repos\/([^/]+\/[^/]+)\/issues\?(.*)$/.exec(url)
    if (listed) {
      const query = new URLSearchParams(listed[2] ?? '')
      const state = query.get('state') ?? 'open'
      const labels = (query.get('labels') ?? '').split(',').filter(Boolean)
      const since = query.get('since')
      let found = issues.filter((issue) => {
        if (state !== 'all' && issue.state !== state) return false
        const on = ((issue.labels ?? []) as { name?: string }[]).map((label) => label.name ?? '')
        if (labels.some((label) => !on.includes(label))) return false
        if (since && Date.parse(String(issue.updated_at)) < Date.parse(since)) return false
        return true
      })
      // `sort=updated&direction=asc` is what Tade asks for, and the fixture
      // honours it rather than answering in file order: a caller that walks
      // pages is relying on the order being the one it asked for.
      if (query.get('sort') === 'updated') {
        found = [...found].sort((a, b) => {
          const order = Date.parse(String(a.updated_at)) - Date.parse(String(b.updated_at))
          return query.get('direction') === 'desc' ? -order : order
        })
      }
      const per = Math.min(Math.max(1, Number(query.get('per_page') ?? 30)), 100)
      const page = Math.max(1, Number(query.get('page') ?? 1))
      const pages = Math.max(1, Math.ceil(found.length / per))
      const body = JSON.stringify(found.slice((page - 1) * per, page * per))
      const etag = etagOf(body)
      const link = linkHeader(url, page, pages)
      const asked = String(
        (init?.headers as Record<string, string> | undefined)?.['if-none-match'] ?? '',
      )
      if (options.etags !== false && asked && asked === etag) {
        // GitHub's own words: a conditional request that comes back `304`
        // "does not count against your primary rate limit". No body, and the
        // validator again so the next poll can ask the same cheap question.
        return answer('', 304, { etag, ...(link ? { link } : {}) })
      }
      return answer(body, 200, {
        ...(options.etags === false ? {} : { etag }),
        ...(link ? { link } : {}),
      })
    }
    // The files of one pull request, paged the way GitHub pages them. Before
    // the pull-request detail route, which would otherwise not match it but
    // reads as though it might.
    const files = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/files\?(.*)$/.exec(url)
    if (files) {
      const node = nodes.find((one) => one.number === Number(files[2]))
      if (!node) return answer({ message: 'Not Found' }, 404)
      const all = filesOf(Number(files[2]))
      const query = new URLSearchParams(files[3] ?? '')
      const per = Math.min(Math.max(1, Number(query.get('per_page') ?? 30)), 100)
      const page = Math.max(1, Number(query.get('page') ?? 1))
      return answer(all.slice((page - 1) * per, page * per))
    }
    // A line comment, which GitHub refuses with a `422` when the line it names
    // is not part of the diff — the whole reason a note is answered for on its
    // own rather than for the batch.
    //
    // **It is checked against the patch this replay serves**, the way the real
    // one checks it against the real diff, rather than accepted because a test
    // did not say otherwise: a fixture that took any line number would be the
    // one place an anchoring bug could not show up, and anchoring is the whole
    // of what keeps a comment off code nobody read. `refusesNotes` is for the
    // other half — a line that *is* in the diff and is refused anyway.
    const noted = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)\/comments$/.exec(url)
    if (noted && method === 'POST') {
      const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const key = `${String(sent.path ?? '')}:${sent.line === undefined ? 'file' : String(sent.line)}`
      const refused = options.refusesNotes?.[key]
      if (refused) return answer({ message: refused }, 422)
      const file = filesOf(Number(noted[2])).find((one) => one.filename === sent.path)
      if (!file) {
        return answer({ message: 'path is not part of the pull request' }, 422)
      }
      if (sent.line !== undefined && !onNewSide(String(file.patch ?? ''), Number(sent.line))) {
        return answer({ message: 'line must be part of the diff' }, 422)
      }
      return answer({ id: 7000 + bodies.length, path: sent.path, line: sent.line })
    }
    const pull = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url)
    if (pull) {
      const node = nodes.find((one) => one.number === Number(pull[2]))
      if (!node) return answer({ message: 'Not Found' }, 404)
      return answer({
        number: node.number,
        head: { sha: node.headRefOid },
        base: { sha: node.baseRefOid ?? 'base0000000000000000000000000000000000000' },
      })
    }
    if (/\/pulls$/.test(url) && method === 'POST') {
      const sent = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>
      const made = {
        ...(nodes[0] as Record<string, unknown>),
        number: 999,
        title: sent.title,
        body: sent.body,
        headRefName: sent.head,
        baseRefName: sent.base,
        isDraft: sent.draft === true,
        url: 'https://github.com/acme/api/pull/999',
      }
      nodes.push(made)
      return answer({ number: 999 })
    }
    if (/\/(comments|labels|requested_reviewers|merge)$/.test(url)) return answer({ ok: true })
    return answer({ message: 'Not Found' }, 404)
  }) as typeof fetch

  const exec = async (command: string, args: readonly string[]) => {
    calls.push(`${command} ${args.join(' ')}`)
    if (options.signedOut) {
      return { code: 1, stdout: '', stderr: 'gh: not logged in to github.com' }
    }
    const at = args.indexOf('--user')
    const user = at < 0 ? undefined : args[at + 1]
    if (options.signedInAs && user !== undefined && !options.signedInAs.includes(user)) {
      return { code: 1, stdout: '', stderr: `no accounts matched "${user}"` }
    }
    return { code: 0, stdout: `gho_${user ?? me}token\n`, stderr: '' }
  }

  const forcePush = (number: number, sha: string): void => {
    const node = nodes.find((one) => one.number === number)
    if (!node) throw new Error(`the fixture has no pull request ${number}`)
    node.headRefOid = sha
    // Nothing has run on the new commit yet, which is the whole point of
    // asking again rather than trusting what was read before the push.
    node.commits = { nodes: [{ commit: { oid: sha, statusCheckRollup: { state: 'PENDING' } } }] }
    node.updatedAt = '2026-09-19T09:00:00Z'
  }

  return { fetch: replayFetch, exec, calls, bodies, pulls: nodes, forcePush }
}

/** The bit of GitHub's GraphQL Tade actually asks for, played back. */
function graphql(
  sent: { query: string; variables: Record<string, unknown> },
  nodes: Record<string, unknown>[],
  me: string,
): unknown {
  const vars = sent.variables
  if (/^\s*mutation/.test(sent.query)) return { data: { clientMutationId: 'ok' } }
  if (sent.query.includes('search(')) {
    const q = String(vars.q ?? '')
    let found = nodes.filter((node) => matches(node, q, me))
    if (vars.after) {
      const from = found.findIndex((node) => String(node.url) === String(vars.after))
      found = from < 0 ? found : found.slice(from + 1)
    }
    const n = Number(vars.n ?? 30)
    const page = found.slice(0, n)
    return {
      data: {
        search: {
          issueCount: found.length,
          pageInfo: {
            hasNextPage: found.length > n,
            endCursor: page.at(-1)?.url ?? null,
          },
          nodes: page,
        },
      },
    }
  }
  if (sent.query.includes('pullRequests(headRefName')) {
    const node = nodes.find((one) => one.headRefName === vars.branch)
    return { data: { repository: { pullRequests: { nodes: node ? [node] : [] } } } }
  }
  const node = nodes.find((one) => one.number === Number(vars.number))
  if (!node)
    return { errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest' }] }
  if (sent.query.includes('{ id }')) {
    return { data: { repository: { pullRequest: { id: `PR_${node.number}` } } } }
  }
  return { data: { repository: { pullRequest: node } } }
}

function matches(node: Record<string, unknown>, q: string, me: string): boolean {
  if (q.includes('author:@me') && (node.author as { login?: string })?.login !== me) return false
  if (q.includes('review-requested:@me')) {
    const asked = (node.reviewRequests as { nodes?: { requestedReviewer?: { login?: string } }[] })
      ?.nodes
    if (!asked?.some((one) => one.requestedReviewer?.login === me)) return false
  }
  const repos = [...q.matchAll(/repo:(\S+)/g)].map((one) => one[1] ?? '')
  if (repos.length > 0) {
    const name = (node.repository as { nameWithOwner?: string })?.nameWithOwner ?? ''
    const ok = repos.some((glob) =>
      new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`).test(name),
    )
    if (!ok) return false
  }
  return true
}

/**
 * Whether a line is on the new side of a unified patch.
 *
 * Written here rather than imported, deliberately: this is the fixture playing
 * GitHub's own rule, and a fixture that validated with the same code as the
 * thing under test would agree with it about a line they were both wrong
 * about.
 */
function onNewSide(patch: string, line: number): boolean {
  if (patch === '') return false
  let at = 0
  for (const row of patch.replace(/\n$/, '').split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(row)
    if (hunk?.[1]) {
      at = Number(hunk[1])
      continue
    }
    if (at === 0 || row.startsWith('-') || row.startsWith('\\')) continue
    if (at === line) return true
    at += 1
  }
  return false
}
