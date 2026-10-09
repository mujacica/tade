import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A Linear that answers from a file, for tests that must never reach one.
//
// The issue shapes in `team.json` are Linear's own documented ones, written
// down once and replayed by a fake `fetch`. What is around them — the filter
// Linear would apply, `pageInfo`, cursors, a 400 with `RATELIMITED` among the
// errors and a reset header in epoch milliseconds, a label taken off, an issue
// closed or deleted — is played by this file, because those are the paths worth
// exercising and a static file cannot page.
//
// **Three things in the fixture are filled in rather than written down.**
// Timestamps are offsets, because a fixed date is a test that starts failing on
// some day for a reason nobody can read; the team defaults to the one the
// tests read, so an issue only says which team it is in when the point is that
// it is in another; and the GraphQL filter is *applied here* rather than
// ignored, because a fixture kinder than the server hides every bug where the
// code trusts a filter it did not get.
//
// **It answers the query by reading the variables, never by parsing the
// document.** The one document the connector sends is a constant, so what a
// test is about is always what it asked *for* — and a fixture that parsed
// GraphQL would be a second implementation of Linear to get wrong.
//
// There is no evidence here that the real Linear still looks like this. What
// there is instead is `linear-api.ts`, which writes down the date its numbers
// were read and where from.

const here = dirname(fileURLToPath(import.meta.url))

/** The team these issues are in unless one says otherwise. */
export const LINEAR_TEAM = 'ENG'

/** One history entry as the fixture writes it: an offset where Linear has a `createdAt`. */
interface WrittenChange {
  about?: string
  at: number
  actor?: { id: string; displayName?: string; app?: boolean }
  botActor?: { id?: string; name?: string; type?: string }
  addedLabels?: string[]
  removedLabels?: string[]
}

/** One issue as the fixture writes it. */
interface Written {
  about?: string
  identifier: string
  at: number
  team?: string
  title: string
  description?: string
  state: string
  trashed?: boolean
  creator?: { id: string; displayName?: string; app?: boolean }
  labels: string[]
  history: WrittenChange[]
}

/** An ISO instant for an offset in seconds from the base. */
export function atOf(base: number, at: number): string {
  return new Date((base + at) * 1000).toISOString()
}

/** The fixture's issues, as Linear would return them. */
export function teamAt(base: number): Record<string, unknown>[] {
  const read = JSON.parse(readFileSync(join(here, 'team.json'), 'utf8')) as { issues: Written[] }
  return read.issues.map((issue) => issueOf(issue, base))
}

function issueOf(written: Written, base: number): Record<string, unknown> {
  const team = written.team ?? LINEAR_TEAM
  return {
    identifier: written.identifier,
    title: written.title,
    description: written.description ?? null,
    url: `https://linear.app/acme/issue/${written.identifier}`,
    updatedAt: atOf(base, written.at),
    trashed: written.trashed ?? null,
    state: { type: written.state },
    team: { key: team },
    // Every label it has. The fake applies the connection's own filter, the
    // way Linear would, so the code under test never sees a label it did not
    // ask for.
    labels: { nodes: written.labels.map((name) => ({ name })) },
    creator: written.creator ?? null,
    botActor: null,
    history: {
      nodes: written.history.map((change) => ({
        createdAt: atOf(base, change.at),
        actor: change.actor ?? null,
        botActor: change.botActor ?? null,
        addedLabels: (change.addedLabels ?? []).map((name) => ({ name })),
      })),
    },
  }
}

export interface LinearOptions {
  /** The moment the watch was turned on, in whole seconds, which every offset is from. */
  base: number
  /** The issues this Linear has. The default is the fixture's. */
  issues?: Record<string, unknown>[]
  /** How many nodes a page holds whatever `first` asked for. The default honours `first`. */
  pageSize?: number
  /** Answer a rate limit from this call onwards, 1-based, so a sweep can be cut short partway. */
  limitFrom?: number
  /** Linear's own reset, in epoch milliseconds, for the headers. */
  resetsAt?: number
  /** Every call answers this error code in `extensions.code`, with HTTP 200. */
  error?: string
  /** Every call answers this error code in `extensions.type` instead, Linear's other spelling. */
  errorType?: string
  /** Nothing comes back at all: a `fetch` that rejects, which is the only outage. */
  offline?: boolean
  /**
   * Never answer: the call waits until its signal aborts.
   *
   * For a look the window gives up on. No sleep anywhere — the only timer is
   * `inTime`'s own — so the test is about the deadline rather than about how
   * fast the machine happened to be.
   */
  hang?: boolean
  /** An HTTP status that is not 200, with no errors array: a proxy, or a bad gateway. */
  status?: number
  /** Answer something that is not a GraphQL response at all. */
  nonsense?: 'text' | 'array' | 'empty'
}

export interface LinearScript {
  fetch: typeof fetch
  /** Every call, as the variables it was sent, for asserting what Tade asked for. */
  calls: { variables: Record<string, unknown>; query: string }[]
  /** The issues this Linear holds, as objects a test can change under Tade. */
  issues: Record<string, unknown>[]
  /** Somebody editing one: `updatedAt` moves, which is what Linear does. */
  touch(identifier: string, at: number): void
  /** Somebody taking the label off. */
  unlabel(identifier: string, label: string): void
  /** Somebody closing one, as a state type Linear counts as over. */
  close(identifier: string, state?: string): void
  /** Somebody deleting one, which is an issue that is simply not there any more. */
  remove(identifier: string): void
}

/** A Linear whose answers are this file's, and whose state a test can change under Tade. */
export function linearScript(options: LinearOptions): LinearScript {
  const issues = options.issues ?? teamAt(options.base)

  const find = (identifier: string): Record<string, unknown> | undefined =>
    script.issues.find((one) => one.identifier === identifier)

  /**
   * The filter Linear would apply, applied here.
   *
   * Only the clauses the connector actually sends — the team's key, a label by
   * name, the state types that are over, `updatedAt` at or after a moment, and
   * one issue by number. Anything else in a filter is ignored and the test that
   * needed it would see its issue come back, which is the loud way round.
   */
  const matches = (issue: Record<string, unknown>, filter: Record<string, unknown>): boolean => {
    const team = pick(filter, ['team', 'key', 'eq'])
    if (typeof team === 'string' && (issue.team as { key?: string } | null)?.key !== team) {
      return false
    }
    const label = pick(filter, ['labels', 'name', 'eq'])
    if (typeof label === 'string' && !labelsOf(issue).includes(label)) return false
    const over = pick(filter, ['state', 'type', 'nin'])
    if (Array.isArray(over) && over.includes((issue.state as { type?: string } | null)?.type)) {
      return false
    }
    const since = pick(filter, ['updatedAt', 'gte'])
    if (typeof since === 'string' && Date.parse(String(issue.updatedAt)) < Date.parse(since)) {
      return false
    }
    const number = pick(filter, ['number', 'eq'])
    if (typeof number === 'number') {
      const identifier = String(issue.identifier)
      if (Number(identifier.slice(identifier.lastIndexOf('-') + 1)) !== number) return false
    }
    return true
  }

  function answerIssues(variables: Record<string, unknown>): Record<string, unknown> {
    const filter = (variables.filter ?? {}) as Record<string, unknown>
    const label = String(variables.label ?? '')
    const history = Number(variables.history ?? 0)
    // Linear orders by `updatedAt` when asked. Which *direction* its own
    // documentation does not say, so this fixture answers NEWEST FIRST — the
    // opposite of the order the connector hands requests over in — because a
    // fixture that happened to agree with the code would never catch a
    // connector that trusted the server's order.
    const within = script.issues
      .filter((one) => matches(one, filter))
      .sort((a, b) => Date.parse(String(b.updatedAt)) - Date.parse(String(a.updatedAt)))
    const at = atOfCursor(variables.after)
    const size = Math.max(1, options.pageSize ?? Number(variables.first) ?? 25)
    const page = within.slice(at, at + size).map((one) => bounded(one, label, history))
    const more = at + size < within.length
    return {
      issues: {
        pageInfo: { hasNextPage: more, endCursor: more ? `at:${at + size}` : null },
        nodes: page,
      },
    }
  }

  const script: LinearScript = {
    calls: [],
    issues,
    touch(identifier, at) {
      const found = find(identifier)
      if (found) found.updatedAt = atOf(options.base, at)
    },
    unlabel(identifier, label) {
      const found = find(identifier)
      if (!found) return
      found.labels = {
        nodes: labelsOf(found)
          .filter((name) => name !== label)
          .map((name) => ({ name })),
      }
    },
    close(identifier, state = 'completed') {
      const found = find(identifier)
      if (found) found.state = { type: state }
    },
    remove(identifier) {
      const at = script.issues.findIndex((one) => one.identifier === identifier)
      if (at >= 0) script.issues.splice(at, 1)
    },
    fetch: (async (_input: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as {
        query?: string
        variables?: Record<string, unknown>
      }
      script.calls.push({ query: body.query ?? '', variables: body.variables ?? {} })
      if (options.offline) throw new TypeError('fetch failed')
      if (init?.signal?.aborted) throw new Error('aborted')
      if (options.hang) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
      }
      const headers: Record<string, string> = options.resetsAt
        ? {
            // Two resets, a second apart, so a test can see which one the
            // error carries: the later, because Linear does not say which
            // budget was spent.
            'x-ratelimit-complexity-reset': String(options.resetsAt - 1000),
            'x-ratelimit-requests-reset': String(options.resetsAt),
          }
        : {}
      if (options.limitFrom !== undefined && script.calls.length >= options.limitFrom) {
        // Linear's own answer: **HTTP 400**, not 429, with the code among the
        // errors. A connector that watched for 429 would sail straight past it.
        return answer(
          400,
          { errors: [{ message: 'Rate limit exceeded', extensions: { code: 'RATELIMITED' } }] },
          headers,
        )
      }
      if (options.nonsense) {
        const said =
          options.nonsense === 'text'
            ? 'gateway timeout'
            : options.nonsense === 'array'
              ? '[]'
              : '{}'
        return new Response(said, { status: 200, headers: { 'content-type': 'text/plain' } })
      }
      if (options.status !== undefined) return answer(options.status, {}, headers)
      if (options.error || options.errorType) {
        return answer(
          200,
          {
            errors: [
              {
                message: 'Linear said no',
                extensions: options.error
                  ? { code: options.error, userPresentableMessage: 'you may not read that team' }
                  : { type: options.errorType },
              },
            ],
          },
          headers,
        )
      }
      return answer(200, { data: answerIssues(body.variables ?? {}) }, headers)
    }) as typeof fetch,
  }
  return script
}

/** An issue with its connections cut to what the query asked for, the way Linear would. */
function bounded(
  issue: Record<string, unknown>,
  label: string,
  history: number,
): Record<string, unknown> {
  const changes = (issue.history as { nodes?: unknown[] } | null)?.nodes ?? []
  return {
    ...issue,
    // `labels(first: 1, filter: { name: { eq: $label } })`: the selected label
    // or nothing, never the issue's whole list.
    labels: { nodes: labelsOf(issue).includes(label) ? [{ name: label }] : [] },
    // `history(first: $history)`: a bounded slice, in the order the fixture
    // holds them, which is deliberately neither oldest nor newest first.
    history: { nodes: changes.slice(0, history) },
  }
}

function labelsOf(issue: Record<string, unknown>): string[] {
  const nodes = (issue.labels as { nodes?: { name?: string }[] } | null)?.nodes ?? []
  return nodes.map((one) => String(one.name))
}

/** How far down the list the next page starts, out of the cursor this fake hands out. */
function atOfCursor(after: unknown): number {
  return typeof after === 'string' && after.startsWith('at:') ? Number(after.slice(3)) : 0
}

/** One value out of a nested filter object, or undefined. */
function pick(from: Record<string, unknown>, path: readonly string[]): unknown {
  let at: unknown = from
  for (const step of path) {
    if (!at || typeof at !== 'object') return undefined
    at = (at as Record<string, unknown>)[step]
  }
  return at
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
