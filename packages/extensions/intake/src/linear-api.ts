import { Unreachable } from '@tade/extensions-core'

// The one GraphQL query this door sends, and what Linear's answers mean.
//
// **Not a port, not a client library, and not Linear's own SDK.** A port earns
// its place when two implementations must pass one suite, and there is one
// Linear; the SDK is a generated surface over the whole schema, which is a
// dependency and a code generator for one query. What is here is the part worth
// writing down: the arithmetic the bounds are written against, and which of
// Linear's answers are "slow down", "you may not" and "nothing came back".
//
// ## The numbers, read off Linear's own documentation on 2026-10-09
//
// - **Requests:** 2,500 an hour per user on a personal API key; 5,000 for an
//   OAuth app; 600 an hour per IP unauthenticated. This door is the key case.
// - **Complexity:** 3,000,000 points an hour on a key, 2,000,000 for OAuth —
//   and this is the one that decides the shape, because of how it is counted:
//   *"Each property is 0.1 point, each object is 1 point and any connection
//   multiplies its children's points based on the given pagination argument,
//   **or the default 50**."* So a nested connection with no `first` on it costs
//   fifty times what it needed to, and a query with two of them costs two and a
//   half thousand times. **Every connection in `ISSUES` carries an explicit
//   `first`**, which is also Linear's own advice ("specifying explicit
//   pagination limits rather than relying on the default 50").
// - What one look costs, at `linear.ts`'s bounds (25 issues a page, 25 history
//   entries each): about 130 points an issue, so ~3,250 a page, ~9,750 for a
//   look that walks its three pages, ~58,500 an hour at a look every ten
//   minutes — **2% of the complexity budget and 18 of the 2,500 requests.**
// - **Over a limit, Linear answers HTTP 400** with `RATELIMITED` among the
//   errors — *not* 429 — so a connector written against "429 means slow down"
//   sails past it and reads a rate limit as a query that failed. The reset is
//   in `X-RateLimit-Requests-Reset` / `X-RateLimit-Complexity-Reset`, **in UTC
//   epoch milliseconds**, and there is no `Retry-After`.
//
// ## Why the error taxonomy is five words and not twelve
//
// **Linear does not publish one.** Its SDK is the only authority on what comes
// back, and it classifies from the first error's `extensions.type` and
// otherwise from the HTTP status (403, 429, other 4xx, 500, other 5xx) — so
// that is what is read here, in both the spellings Linear's own material uses:
// the lowercase-with-spaces `type` the SDK matches on, and the uppercase code
// the rate-limiting page quotes. Everything else stays **"Linear said no",
// carried through with Linear's own words**, because inventing a case for an
// error nobody has documented is how a connector comes to swallow one.

/** Where Linear's API is. Not configurable: there is one Linear. */
const LINEAR = 'https://api.linear.app/graphql'

/** The host a failed look names, for the one thing allowed an opinion about connectivity. */
export const LINEAR_HOST = 'api.linear.app'

/**
 * What went wrong, as far as anything here behaves differently about it.
 *
 * `network` is the one that matters most: **nothing came back at all**, which
 * the watch turns into `Unreachable` so an outage is found on the first failed
 * look rather than on every look all night. Everything else is an answer —
 * Linear was reached and said no — and one query being refused is not the
 * machine being offline.
 */
export type LinearTrouble =
  /** Nothing came back: no response, no status, no body. */
  | 'network'
  /** A budget is spent. `resetsAt` is Linear's own epoch-millisecond answer. */
  | 'ratelimited'
  /** The key is not good: revoked, expired, or not a key at all. */
  | 'auth'
  /** The key is good and may not see this: another workspace's team, a paid feature. */
  | 'forbidden'
  /** Anything else Linear said, including a 5xx and anything it has not documented. */
  | 'linear'

/** What Linear answered, with which kind of trouble it is. */
export class LinearError extends Error {
  readonly trouble: LinearTrouble
  /**
   * When Linear says a budget is clear again, in epoch milliseconds, or 0.
   *
   * **The later of the two it reports**, because a rate-limit error does not say
   * *which* budget was spent — so the only moment both are certainly clear is
   * the later one. Nothing sleeps until it: a look has the window's deadline, so
   * a sweep ends and says so.
   */
  readonly resetsAt: number

  constructor(trouble: LinearTrouble, said: string, resetsAt = 0) {
    super(said)
    this.name = 'LinearError'
    this.trouble = trouble
    this.resetsAt = resetsAt
  }
}

/**
 * Which trouble a Linear error code is, in either of the two spellings its own
 * material uses.
 *
 * The SDK matches `extensions.type` against lowercase-with-spaces strings
 * (`"ratelimited"`, `"authentication error"`); the rate-limiting page quotes
 * the uppercase `RATELIMITED`. Matching one would miss the other, so both are
 * flattened to the same shape first.
 */
function troubleOf(code: string, status: number): LinearTrouble {
  switch (
    code
      .toLowerCase()
      .replace(/[^a-z]+/g, ' ')
      .trim()
  ) {
    case 'ratelimited':
    case 'rate limited':
      return 'ratelimited'
    case 'authentication error':
    case 'bootstrap error':
      return 'auth'
    case 'forbidden':
    case 'feature not accessible':
      return 'forbidden'
    case '':
      // No code at all, so the status is all there is — which is exactly what
      // Linear's own SDK falls back to.
      return status === 403
        ? 'forbidden'
        : status === 429
          ? 'ratelimited'
          : status >= 400 && status < 500
            ? 'auth'
            : 'linear'
    default:
      return 'linear'
  }
}

/** A Linear user, as much of one as this door reads. */
export interface LinearUser {
  id?: string
  /** Shown beside the id and never parsed: Linear's own display (nick) name. */
  displayName?: string
  /** Linear's own word that this user is an app. The loop filter reads it. */
  app?: boolean
}

/** An integration or automation, where Linear names one instead of a user. */
export interface LinearBot {
  id?: string | null
  name?: string | null
  type?: string
}

/** One change to an issue, of which this door reads only who added which labels. */
export interface LinearChange {
  createdAt?: string
  /**
   * Who did it. Linear's own schema: *"The actor that performed the actions.
   * This field may be empty in the case of integrations or automations."* —
   * which is why `botActor` is read beside it rather than instead of it.
   */
  actor?: LinearUser | null
  botActor?: LinearBot | null
  /** Linear's own `addedLabels: [IssueLabel!]`, which is a list and not a connection. */
  addedLabels?: { name?: string }[] | null
}

/** One issue, as much of Linear's own shape as this door reads. */
export interface LinearIssue {
  /** `ENG-412`: the team's key, a dash, the issue's number. */
  identifier?: string
  title?: string
  description?: string | null
  url?: string
  /** Linear's own *"last time at which the entity was meaningfully updated"*. */
  updatedAt?: string
  trashed?: boolean | null
  /** One of triage, backlog, unstarted, started, completed, canceled, duplicate. */
  state?: { type?: string } | null
  team?: { key?: string } | null
  /** Asked for with a filter, so it is the selected label or nothing. */
  labels?: { nodes?: { name?: string }[] } | null
  creator?: LinearUser | null
  botActor?: LinearBot | null
  history?: { nodes?: LinearChange[] } | null
}

/** One page of issues, and whether Linear has more below it. */
export interface LinearPage {
  issues: LinearIssue[]
  /** Linear's own `endCursor`, for the next page. */
  cursor: string | null
  /** Linear's own `hasNextPage`, which is the word that decides whether a sweep drained. */
  more: boolean
}

/** What the query selects on, built here and sent as a variable. */
export interface LinearSelector {
  /** The team's key, as it prefixes an identifier: `ENG`. */
  team: string
  /** The label an issue must carry. Required everywhere: there is no "any issue". */
  label: string
  /** An ISO instant. Only issues Linear says moved at or after it. */
  since?: string
  /** One issue by its number, for the re-check. */
  number?: number
}

/**
 * The one document this door sends, and **it is a constant.**
 *
 * Nothing is interpolated into it: the team, the label, the moment and the
 * bounds all arrive as GraphQL variables, so a label with a brace in it is a
 * string Linear compares and never a fragment of a query. That is the whole of
 * the injection answer here, and it is a shape rather than an escaping rule.
 *
 * Every connection carries an explicit `first`, for the arithmetic at the top
 * of this file. `labels` is asked for **with a filter**, so it costs one node
 * and answers the only question about labels this door has.
 */
const ISSUES = `query TadeIntake($filter: IssueFilter!, $first: Int!, $after: String, $label: String!, $history: Int!) {
  issues(filter: $filter, first: $first, after: $after, orderBy: updatedAt) {
    pageInfo { hasNextPage endCursor }
    nodes {
      identifier
      title
      description
      url
      updatedAt
      trashed
      state { type }
      team { key }
      labels(first: 1, filter: { name: { eq: $label } }) { nodes { name } }
      creator { id displayName app }
      botActor { id name type }
      history(first: $history) {
        nodes {
          createdAt
          actor { id displayName app }
          botActor { id name type }
          addedLabels { name }
        }
      }
    }
  }
}`

/**
 * Linear, over the `fetch` the extension was given.
 *
 * **One method and one query**, which is as small as a tracker's client gets:
 * the look and the re-check ask the same question with a different filter, so
 * there is one shape of answer to parse and one place a change to it shows up.
 *
 * **Nothing here asks who the key is.** There is no mention to look for, no
 * reply path and nothing to exclude by identity, so a `viewer` call would buy a
 * nicer error message and cost a request a look — and reading the key's own
 * workspace, team or user would be exactly the hard-coded account assumption
 * this must not have. What authorises is the owner's `from` list; what selects
 * is the team and the label somebody typed.
 *
 * Nothing retries: a look has a deadline, a schedule is the thing that comes
 * back, and a retry inside a method is a second clock nobody asked for.
 */
export class LinearApi {
  private readonly key: string
  private readonly fetch: typeof fetch
  private readonly signal: AbortSignal

  constructor(key: string, from: { fetch: typeof fetch; signal: AbortSignal }) {
    this.key = key
    this.fetch = from.fetch
    this.signal = from.signal
  }

  /** A page of a team's labelled issues, ordered by when Linear says each last moved. */
  async issues(req: {
    select: LinearSelector
    first: number
    history: number
    cursor?: string | null
  }): Promise<LinearPage> {
    const body = await this.call({
      filter: filterOf(req.select),
      first: req.first,
      after: req.cursor ?? null,
      label: req.select.label,
      history: req.history,
    })
    const page = body.issues
    const read =
      page && typeof page === 'object' ? (page as { nodes?: unknown; pageInfo?: unknown }) : null
    // Only the objects, which is what makes the cast below honest. Linear's
    // schema says `nodes: [Issue!]!`, so a null in there is a contract
    // violation and should not happen — but the cost of it happening is a
    // `TypeError` from somewhere deep in the selector, which reads as a broken
    // connector rather than as a strange answer. Everything else about this
    // door treats the shape as untrusted (every field on `LinearIssue` is
    // optional) and this is the one place that was only true by assertion.
    const issues = Array.isArray(read?.nodes)
      ? read.nodes.filter((one): one is LinearIssue => Boolean(one) && typeof one === 'object')
      : []
    const info =
      read?.pageInfo && typeof read.pageInfo === 'object'
        ? (read.pageInfo as { hasNextPage?: unknown; endCursor?: unknown })
        : null
    return {
      issues,
      cursor: typeof info?.endCursor === 'string' && info.endCursor ? info.endCursor : null,
      more: info?.hasNextPage === true,
    }
  }

  /**
   * One issue, by the team and the number its identifier is made of.
   *
   * **By a filter and never by `issue(id:)`**, whose argument Linear documents
   * only as "the identifier" — so whether it takes `ENG-412` or the UUID is a
   * guess, and a re-check that guessed would be a re-check that threw on a
   * source that was perfectly reachable. A filter on the team's key and the
   * number is documented, and it is also the shape that makes "this key names
   * another team" unaskable rather than refused.
   *
   * **Null is two answers and both hold**: it is not there any more, or this key
   * can no longer see it. Linear answers the same empty connection for both.
   */
  async issue(req: { select: LinearSelector; history: number }): Promise<LinearIssue | null> {
    const page = await this.issues({ select: req.select, first: 1, history: req.history })
    return page.issues[0] ?? null
  }

  /**
   * One POST, and the three answers it can have: data, an answer that is a
   * refusal, or nothing at all.
   *
   * The last is the only one that becomes `Unreachable`, and it is told apart by
   * *where* it failed rather than by reading a message: a `fetch` that rejects
   * never reached Linear, and any response — 200, 400, 429, 500 — did.
   *
   * **A 200 with errors in it is still a refusal.** GraphQL answers that way
   * routinely and Linear's rate limit answers 400, so neither the status nor the
   * presence of `data` decides this on its own: errors are read first.
   */
  private async call(variables: Record<string, unknown>): Promise<Record<string, unknown>> {
    let answer: Response
    try {
      answer = await this.fetch(LINEAR, {
        method: 'POST',
        headers: {
          // A personal API key goes in `Authorization` **without** `Bearer`,
          // which is Linear's own documented spelling and the opposite of its
          // OAuth tokens. With `Bearer` on a key every call is an auth error.
          authorization: this.key,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ query: ISSUES, variables }),
        signal: this.signal,
      })
    } catch (err) {
      // A look that was given up on is not an outage: `inTime` aborts the
      // controller when the window's deadline passes, and reporting that as
      // Linear being unreachable would take a whole project's watches down
      // because one of them was slow.
      if (this.signal.aborted) throw err
      throw new Unreachable(LINEAR_HOST, `${LINEAR_HOST} did not answer: ${said(err)}`)
    }
    const resetsAt = resetOf(answer.headers)
    let body: unknown
    try {
      body = await answer.json()
    } catch (err) {
      throw new LinearError(
        troubleOf('', answer.status),
        `Linear answered ${answer.status} with something that is not JSON: ${said(err)}`,
        resetsAt,
      )
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      // An array is the case worth naming: it parses, it is `typeof 'object'`,
      // and it has neither `data` nor `errors` — so without this it would read
      // as a GraphQL answer that said nothing, which is a different sentence
      // about a different problem.
      throw new LinearError(
        troubleOf('', answer.status),
        `Linear answered ${answer.status} with something that is not an object`,
        resetsAt,
      )
    }
    const read = body as { data?: unknown; errors?: unknown }
    const problem = firstError(read.errors)
    if (problem) {
      throw new LinearError(
        troubleOf(problem.code, answer.status),
        `Linear said no: ${problem.said}`,
        resetsAt,
      )
    }
    if (!answer.ok) {
      throw new LinearError(
        troubleOf('', answer.status),
        `Linear answered ${answer.status} and said nothing about why`,
        resetsAt,
      )
    }
    if (!read.data || typeof read.data !== 'object') {
      // No data and no errors: a shape nothing here was written knowing about.
      // An error rather than an empty page, because an empty page would read
      // everywhere above as "no issue carries this label".
      throw new LinearError('linear', 'Linear answered with neither data nor errors', resetsAt)
    }
    return read.data as Record<string, unknown>
  }
}

/**
 * What the query selects on, as Linear's own `IssueFilter`.
 *
 * Four clauses, and each is a decision rather than a default:
 *
 * - **the team**, by the key that prefixes its identifiers, so the issues this
 *   can ever read are the ones in the team somebody typed;
 * - **the label**, by name, which is the act that asks for the work;
 * - **what is still open**, as *not* one of the three state types that mean it
 *   is over — Linear documents the type as one of "triage", "backlog",
 *   "unstarted", "started", "completed", "canceled", "duplicate", so naming the
 *   three that are over is narrower than listing the four that are not: a state
 *   type Linear adds later reads as open and is then settled by `recheck`,
 *   rather than silently selecting nothing;
 * - **since when**, where a cursor said. Left out on the re-check, which is
 *   about one issue and must not fail to find it because it has not moved.
 *
 * `includeArchived` is left alone, so Linear's own default (false) stands: an
 * archived issue reads as absent, which holds the work.
 */
function filterOf(select: LinearSelector): Record<string, unknown> {
  return {
    team: { key: { eq: select.team } },
    labels: { name: { eq: select.label } },
    state: { type: { nin: ['completed', 'canceled', 'duplicate'] } },
    ...(select.since ? { updatedAt: { gte: select.since } } : {}),
    ...(select.number === undefined ? {} : { number: { eq: select.number } }),
  }
}

/**
 * The first error Linear reported, as a code and a sentence somebody can read.
 *
 * The code may be in either of two places — `extensions.code`, which the
 * rate-limiting page quotes, or `extensions.type`, which Linear's own SDK
 * matches on — and the readable message in either `extensions.userPresentableMessage`
 * (the SDK's first choice) or `message`.
 */
function firstError(errors: unknown): { code: string; said: string } | null {
  if (!Array.isArray(errors) || errors.length === 0) return null
  const one = errors[0]
  const read = one && typeof one === 'object' ? (one as Record<string, unknown>) : {}
  const extensions =
    read.extensions && typeof read.extensions === 'object'
      ? (read.extensions as Record<string, unknown>)
      : {}
  const code = [extensions.code, extensions.type].find((each) => typeof each === 'string' && each)
  const said = [extensions.userPresentableMessage, read.message, code].find(
    (each) => typeof each === 'string' && each,
  )
  return {
    code: typeof code === 'string' ? code : '',
    said: typeof said === 'string' ? said : 'it did not say why',
  }
}

/**
 * When Linear says a budget is clear again, in epoch milliseconds, or 0.
 *
 * **The later of the two**, because the error does not say which budget was
 * spent and the later reset is the only moment both certainly are. A value that
 * is not a number — or a header that is not there — is 0, which reads
 * everywhere as "it did not say" rather than as the epoch.
 */
function resetOf(headers: Headers): number {
  const at = ['x-ratelimit-requests-reset', 'x-ratelimit-complexity-reset']
    .map((name) => Number(headers.get(name) ?? ''))
    .filter((each) => Number.isFinite(each) && each > 0)
  return at.length === 0 ? 0 : Math.max(...at)
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
