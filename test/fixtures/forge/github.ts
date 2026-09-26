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
}

export function githubReplay(options: ReplayOptions = {}): GithubReplay {
  const nodes = [read('pull-412.json'), read('pull-418.json')]
  const checkRuns = read('check-runs.json')
  const calls: string[] = []
  const bodies: unknown[] = []
  let lastHeadSha = ''
  const me = options.me ?? 'mujacica'
  const readOnly = options.scopes !== undefined && !/repo/.test(options.scopes)

  const answer = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
    new Response(typeof body === 'string' ? body : JSON.stringify(body), {
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
    if (options.limited) {
      return answer({ message: 'API rate limit exceeded' }, 403, {
        'x-ratelimit-remaining': '0',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 300),
      })
    }
    if (url.endsWith('/user')) {
      return answer(
        { login: me },
        200,
        options.scopes === undefined ? {} : { 'x-oauth-scopes': options.scopes },
      )
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
    const pull = /\/repos\/([^/]+\/[^/]+)\/pulls\/(\d+)$/.exec(url)
    if (pull) {
      const node = nodes.find((one) => one.number === Number(pull[2]))
      if (!node) return answer({ message: 'Not Found' }, 404)
      return answer({ number: node.number, head: { sha: node.headRefOid } })
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
    return { code: 0, stdout: 'gho_pretendtoken\n', stderr: '' }
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
