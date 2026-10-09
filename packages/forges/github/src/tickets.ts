import {
  type Actor,
  ForgeError,
  type Labelling,
  type Ticket,
  type TicketDetail,
  type TicketPage,
  type TicketQuery,
  type TicketRef,
} from '@tade/forges-core'

// GitHub issues, as the port's tickets.
//
// Four things here are GitHub's own semantics rather than anybody's
// preference, and every one of them is a way of getting this wrong:
//
// 1. **The issues endpoint returns pull requests too.** GitHub's own words:
//    "GitHub's REST API considers every pull request an issue, but not every
//    issue is a pull request. For this reason, 'Issues' endpoints may return
//    both issues and pull requests in the response. You can identify pull
//    requests by the `pull_request` key." So every answer is filtered by that
//    key, and `ticket()` refuses a number that turns out to be a review.
// 2. **Paging is the `link` header**, with `rel="next"`, `rel="last"` and the
//    rest — "you should use the link headers to determine what pages of
//    results you can request" — never a page number guessed from a count.
// 3. **`since` is a modified-time cursor**: "Only show results that were last
//    updated after the given time", "a timestamp in ISO 8601 format". It is
//    not a page cursor and the two are not interchangeable.
// 4. **A conditional request is what makes a poll nearly free**: "Making a
//    conditional request does not count against your primary rate limit if a
//    `304` response is returned and the request was made while correctly
//    authorized." So the list carries its `etag` out and back, and a `304` is
//    `unchanged` rather than an empty repository.
//
// The fifth is not an endpoint's semantics but a fact about the data, and it is
// the one that matters most to anything deciding on a label: **an issue's label
// list says what is on it and says nothing about who put it there.** Who did
// is in the events, where `actor` is documented as "The person who generated
// the event" — which is why `ticket()` costs a second request and `tickets()`
// does not.

/**
 * How many pages of an issue's events are read, from the newest end.
 *
 * The newest `labeled` event for a label is what the provenance is, so reading
 * the newest events answers it; reading the oldest would answer a question
 * about a label that has since been taken off and put back by somebody else.
 * Bounded because an issue with four thousand events is somebody's long
 * argument and not a reason to spend a rate limit, and a label whose
 * application is older than what was read gets **no provenance at all** rather
 * than a guess — which is what the port says an empty `labelled` means.
 */
export const EVENT_PAGES = 3

/** What this file needs of the forge: one request, already carrying the credential. */
export type Asking = (
  url: string,
  init?: { method?: string; body?: unknown; accept?: string; headers?: Record<string, string> },
) => Promise<{ status: number; body: unknown; text: string; headers: Headers }>

/**
 * Whether GitHub says an actor is an app rather than a person.
 *
 * Two of GitHub's own signals, because its REST reference declares `type` as a
 * string and enumerates no values for it: the `type` it sends for an app, and
 * the `[bot]` suffix it gives an app's login. Read together rather than either
 * alone, and the error this can make is calling an app's act a person's — so
 * the one that is only a naming convention is still read, because a caller
 * refusing an app's request is the direction to be wrong in.
 */
function actorOf(raw: unknown): Actor {
  const one = (raw ?? {}) as { login?: unknown; type?: unknown }
  const login = typeof one.login === 'string' ? one.login : ''
  const type = typeof one.type === 'string' ? one.type : ''
  return { login, bot: type === 'Bot' || /\[bot\]$/.test(login) }
}

/** An issue as GitHub sends it, or null where it is a pull request wearing one's clothes. */
function asTicket(raw: unknown, repo: string, host: string): Ticket | null {
  const one = (raw ?? {}) as Record<string, unknown>
  const number = typeof one.number === 'number' ? one.number : 0
  if (!number) return null
  // The whole of telling the two apart, and it is GitHub's documented way:
  // every pull request is an issue here, and only a pull request has this key.
  if (one.pull_request !== undefined && one.pull_request !== null) return null
  const labels = Array.isArray(one.labels)
    ? one.labels.flatMap((label) => {
        if (typeof label === 'string') return [label]
        const named = (label ?? {}) as { name?: unknown }
        return typeof named.name === 'string' ? [named.name] : []
      })
    : []
  const assignees = Array.isArray(one.assignees)
    ? one.assignees.flatMap((who) => {
        const named = (who ?? {}) as { login?: unknown }
        return typeof named.login === 'string' ? [named.login] : []
      })
    : []
  return {
    ref: { repo, number, host },
    title: typeof one.title === 'string' ? one.title : '',
    // As written, and `null` is what GitHub sends for an issue with no body at
    // all — an empty request, which is a request and not a failure to read one.
    body: typeof one.body === 'string' ? one.body : '',
    url: typeof one.html_url === 'string' ? one.html_url : '',
    state: one.state === 'closed' ? 'closed' : 'open',
    author: actorOf(one.user),
    labels,
    assignees,
    createdAt: typeof one.created_at === 'string' ? one.created_at : '',
    updatedAt: typeof one.updated_at === 'string' ? one.updated_at : '',
  }
}

/** One `rel` out of a `link` header, as a page number. Null where there is none. */
function pageOf(headers: Headers, rel: string): number | null {
  const link = headers.get('link') ?? ''
  for (const part of link.split(',')) {
    const found = /^\s*<([^>]+)>\s*;\s*rel="([^"]+)"/.exec(part)
    if (!found || found[2] !== rel) continue
    const page = /[?&]page=(\d+)/.exec(found[1] ?? '')
    if (page?.[1]) return Number(page[1])
  }
  return null
}

/** The tickets methods, given something that can ask GitHub as the right account. */
export function githubTickets(
  request: Asking,
  rest: (path: string) => string,
  host: string,
): {
  tickets(query: TicketQuery): Promise<TicketPage>
  ticket(ref: TicketRef): Promise<TicketDetail>
} {
  return {
    async tickets(query: TicketQuery): Promise<TicketPage> {
      const per = Math.min(Math.max(1, query.limit ?? 30), 100)
      const page = Number(query.cursor ?? '1')
      const search = new URLSearchParams({
        state: query.state === 'any' ? 'all' : (query.state ?? 'open'),
        // Newest movement first, which is the port's own order and GitHub's
        // own default. A caller reading only the head of the page is reading it
        // to find what just happened, and oldest-first is the one order in
        // which that is the thing it never sees.
        sort: 'updated',
        direction: 'desc',
        per_page: String(per),
        page: String(Number.isFinite(page) && page > 0 ? page : 1),
      })
      // Comma separated, and GitHub reads them as "has all of these".
      if (query.labels && query.labels.length > 0) search.set('labels', query.labels.join(','))
      if (query.since) search.set('since', query.since)
      const url = rest(`/repos/${query.repo}/issues?${search.toString()}`)
      const answer = await request(url, {
        ...(query.validator ? { headers: { 'if-none-match': query.validator } } : {}),
      })
      const validator = answer.headers.get('etag')
      if (answer.status === 304) {
        // Nothing read because nothing moved, which is not the same answer as
        // an empty repository — and the request cost nothing against the rate
        // limit, which is the whole reason to have asked this way.
        return { items: [], cursor: query.cursor ?? null, more: false, unchanged: true, validator }
      }
      const raw = Array.isArray(answer.body) ? answer.body : []
      const items = raw.flatMap((one) => {
        const ticket = asTicket(one, query.repo, host)
        return ticket ? [ticket] : []
      })
      const next = pageOf(answer.headers, 'next')
      return {
        items,
        cursor: next === null ? null : String(next),
        more: next !== null,
        unchanged: false,
        validator,
      }
    },

    async ticket(ref: TicketRef): Promise<TicketDetail> {
      const answer = await request(rest(`/repos/${ref.repo}/issues/${ref.number}`))
      const ticket = asTicket(answer.body, ref.repo, ref.host || host)
      if (!ticket) {
        // Either GitHub sent something unreadable or the number is a pull
        // request, and both are "there is no such ticket" rather than a crash:
        // the one thing this must not do is hand a review back as a ticket.
        throw new ForgeError('missing', `there is no issue ${ref.repo}#${ref.number}`)
      }
      return { ...ticket, labelled: await labelled(request, rest, ref, ticket.labels) }
    },
  }
}

/**
 * Who applied each of the labels that is on a ticket now, newest first.
 *
 * Read from the **newest end** of the events, because the newest `labeled`
 * event for a label is the provenance of the label that is on it now: one
 * taken off and put back by somebody else has two events and only the second
 * is true. GitHub documents `actor` as "The person who generated the event",
 * which is the only reason any of this can be answered at all.
 *
 * **A window that does not reach the labelling answers nobody, and that is
 * deliberate.** The first page is read because its `link` header is the only
 * way to learn how many there are — and its events are then *thrown away*
 * unless the whole list fits in the window, because a labelling on page one
 * that was undone and redone on page two would otherwise come back as the
 * provenance. Naming somebody who was overruled is worse than naming nobody:
 * a caller can refuse on nobody and cannot tell a stale answer from a true one.
 */
async function labelled(
  request: Asking,
  rest: (path: string) => string,
  ref: TicketRef,
  on: readonly string[],
): Promise<readonly Labelling[]> {
  if (on.length === 0) return []
  const path = (page: number) =>
    rest(`/repos/${ref.repo}/issues/${ref.number}/events?per_page=100&page=${page}`)
  const first = await request(path(1))
  const last = pageOf(first.headers, 'last')
  // Where the window starts. With one page there is nothing to page and the
  // list is whole, which is every ordinary issue and costs one request.
  const from = last === null || last <= 1 ? 1 : Math.max(1, last - EVENT_PAGES + 1)
  const raw: unknown[] = from === 1 && Array.isArray(first.body) ? [...first.body] : []
  for (let page = Math.max(2, from); last !== null && page <= last; page += 1) {
    const more = await request(path(page))
    if (Array.isArray(more.body)) raw.push(...more.body)
  }
  const newest = new Map<string, Labelling>()
  for (const one of raw) {
    const event = (one ?? {}) as { event?: unknown; label?: unknown; created_at?: unknown }
    if (event.event !== 'labeled') continue
    const label = ((event.label ?? {}) as { name?: unknown }).name
    if (typeof label !== 'string' || !on.includes(label)) continue
    const at = typeof event.created_at === 'string' ? event.created_at : ''
    const was = newest.get(label)
    // Compared as times rather than by the order they arrived: the pages read
    // are not contiguous when the newest end was jumped to, so "later in the
    // list" is not "later in time" here.
    if (was && Date.parse(was.at) >= Date.parse(at)) continue
    newest.set(label, { label, by: actorOf((one as { actor?: unknown }).actor), at })
  }
  return [...newest.values()].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
}
