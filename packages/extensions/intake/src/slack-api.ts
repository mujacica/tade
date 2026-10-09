import { Unreachable } from '@tade/extensions-core'

// The four Slack methods this door needs, and nothing else.
//
// **Not a port and not a client library.** A port earns its place when two
// implementations must pass one suite, and there is one Slack; a library earns
// its place when the surface is wide, and this is four methods with a handful
// of arguments between them. What is here is the part that is actually worth
// writing down: which error Slack means, which of them is "nothing came back",
// and the one it answers when a reaction is already there.
//
// ## The rate limits, which decide the shape rather than decorating it
//
// Read off Slack's own documentation on 2026-10-09:
//
// - `conversations.history` and `conversations.replies` are **Tier 3 — 50+ a
//   minute, `limit` up to 1,000** — for Marketplace-approved apps and for
//   **internal customer-built** ones.
// - For an app **distributed outside the Marketplace** and created after
//   29 May 2025, both are **1 request a minute, with `limit` capped and
//   defaulted to 15 objects**; existing non-Marketplace installations join them
//   on 3 March 2026. Internal apps are explicitly not affected.
// - `reactions.add` is Tier 3.
// - `auth.test` needs **no scope at all** and allows "hundreds of requests per
//   minute", which is what makes asking it once a look affordable — and it is
//   the only way to learn the app's own user id, which is both the mention this
//   watch triggers on and the identity its own messages are excluded by.
// - `chat.postMessage` is `chat:write`, "generally … 1 message per second to a
//   specific channel", which one status per request per saying is nowhere near.
// - Over a limit, Slack answers **HTTP 429 with a `Retry-After` header** in
//   seconds.
//
// So the generous tier is not the tier every app gets, and nothing here may
// assume it: a look is a handful of requests with a hard ceiling, a 429 **ends
// the sweep rather than sleeping through it** — a look has a minute before the
// window gives up on it, and `Retry-After` on a throttled app is a minute — and
// what it could not read is said rather than passed over.

/** Where Slack's web API is. Not configurable: there is one Slack. */
const SLACK = 'https://slack.com/api'

/** The host a failed look names, for the one thing allowed an opinion about connectivity. */
export const SLACK_HOST = 'slack.com'

/**
 * What Tade's own status messages are marked with, in Slack's own metadata.
 *
 * One `event_type` for all of them, with the saying's marker in the payload, so
 * a read can tell Tade's messages from everybody's with no text matching: an
 * app's metadata can only be set by that app (`metadata_must_be_sent_from_app`),
 * which is a stronger answer than a sentence that happens to look like Tade's.
 */
export const TADE_STATUS = 'tade_intake_status'

/**
 * What went wrong, as Slack itself distinguishes them.
 *
 * `network` is the one that matters most: **nothing came back at all**, which
 * the watch turns into `Unreachable` so an outage is found on the first failed
 * look rather than on every look all night. Everything else is an answer —
 * Slack was reached and said no — and stays an ordinary error, because one
 * method being refused is not the machine being offline.
 */
export type SlackTrouble =
  /** Nothing came back: no response, no status, no body. */
  | 'network'
  /** HTTP 429. `retryAfter` is Slack's own number of seconds. */
  | 'ratelimited'
  /** The token is not good: `invalid_auth`, `token_revoked`, `account_inactive`. */
  | 'auth'
  /** The token is good and lacks a scope: `missing_scope`, `not_allowed_token_type`. */
  | 'scope'
  /** It is not there, or this app cannot see it: `channel_not_found`, `thread_not_found`. */
  | 'missing'
  /** The bot is not in the channel, which is the one thing every setup gets wrong first. */
  | 'not_in_channel'
  /** This exact reaction by this app is already on that message. */
  | 'already'
  /** Slack will not take the write: the channel is archived, read-only or locked. */
  | 'refused'
  /** Anything else Slack said, including a 5xx. */
  | 'slack'

/** What Slack answered, with which kind of trouble it is. */
export class SlackError extends Error {
  readonly trouble: SlackTrouble
  /** Slack's own `Retry-After`, in seconds, where it sent one. */
  readonly retryAfter: number

  constructor(trouble: SlackTrouble, said: string, retryAfter = 0) {
    super(said)
    this.name = 'SlackError'
    this.trouble = trouble
    this.retryAfter = retryAfter
  }
}

/** Which trouble one of Slack's `error` strings is. */
function troubleOf(error: string): SlackTrouble {
  switch (error) {
    case 'invalid_auth':
    case 'not_authed':
    case 'token_expired':
    case 'token_revoked':
    case 'account_inactive':
      return 'auth'
    case 'missing_scope':
    case 'not_allowed_token_type':
    case 'no_permission':
      return 'scope'
    case 'channel_not_found':
    case 'thread_not_found':
    case 'message_not_found':
      return 'missing'
    case 'not_in_channel':
      return 'not_in_channel'
    case 'already_reacted':
      return 'already'
    case 'ratelimited':
    // `chat.postMessage` spells its own one with an underscore.
    case 'rate_limited':
      return 'ratelimited'
    case 'is_archived':
    case 'cannot_reply_to_message':
    case 'restricted_action':
    case 'restricted_action_read_only_channel':
    case 'restricted_action_thread_locked':
      return 'refused'
    default:
      return 'slack'
  }
}

/** One message, as much of Slack's own shape as this door reads. */
export interface SlackMessage {
  type?: string
  subtype?: string
  ts?: string
  thread_ts?: string
  text?: string
  user?: string
  bot_id?: string
  app_id?: string
  username?: string
  /** Set where somebody has edited it: `edited.ts` is when, and is the revision. */
  edited?: { user?: string; ts?: string }
  reply_count?: number
  /** The newest reply's `ts`, which `conversations.history` gives without a second request. */
  latest_reply?: string
  /**
   * What an app attached to its own message, invisible in Slack's own UI and
   * returned only when a read asks for it.
   *
   * It is where Tade's marker for a status goes, which is the one place it
   * belongs: `intakeMark` is for the transport's own bookkeeping and putting it
   * in the visible text would be Tade writing its machinery into somebody's
   * channel.
   */
  metadata?: { event_type?: string; event_payload?: Record<string, unknown> }
  files?: {
    name?: string
    title?: string
    mimetype?: string
    size?: number
    permalink?: string
    url_private?: string
  }[]
}

/** One page of messages, and whether Slack has more below it. */
export interface SlackPage {
  messages: SlackMessage[]
  /** Slack's own cursor for the next page, which walks **older**. */
  cursor: string | null
  /** Slack's own word that there are more, which is not the same as there being a cursor. */
  more: boolean
}

/**
 * The three methods, over the `fetch` the extension was given.
 *
 * Every call is one POST with a form body, which is how Slack documents a web
 * API call and the only shape that needs no JSON encoder. Nothing retries here:
 * a look has a deadline, a schedule is the thing that comes back, and a retry
 * inside a method is a second clock nobody asked for.
 */
export class SlackApi {
  private readonly token: string
  private readonly fetch: typeof fetch
  private readonly signal: AbortSignal
  private whoami: Promise<{ userId: string; botId: string; url: string }> | null = null

  constructor(token: string, from: { fetch: typeof fetch; signal: AbortSignal }) {
    this.token = token
    this.fetch = from.fetch
    this.signal = from.signal
  }

  /** A page of a channel's top-level messages, newest first, as Slack returns them. */
  async history(req: {
    channel: string
    /** Exclusive: Slack leaves out a message whose `ts` is exactly this. */
    oldest?: string
    latest?: string
    inclusive?: boolean
    limit: number
    cursor?: string | null
  }): Promise<SlackPage> {
    return this.page('conversations.history', {
      channel: req.channel,
      ...(req.oldest ? { oldest: req.oldest } : {}),
      ...(req.latest ? { latest: req.latest } : {}),
      ...(req.inclusive ? { inclusive: 'true' } : {}),
      limit: String(req.limit),
      ...(req.cursor ? { cursor: req.cursor } : {}),
    })
  }

  /** A thread: the parent first, then its replies oldest first. */
  async replies(req: {
    channel: string
    ts: string
    limit: number
    cursor?: string | null
    /** Ask for what apps attached to their own messages, which is where Tade's marker is. */
    metadata?: boolean
  }): Promise<SlackPage> {
    return this.page('conversations.replies', {
      channel: req.channel,
      ts: req.ts,
      limit: String(req.limit),
      ...(req.cursor ? { cursor: req.cursor } : {}),
      ...(req.metadata ? { include_all_metadata: 'true' } : {}),
    })
  }

  /**
   * Who this token is, which is three facts and one request.
   *
   * `user_id` is the app's own user id — the `<@U…>` a person types to mention
   * it, and the identity its own messages are left out of a thread by. `url` is
   * the workspace's own address, which is what a permalink needs and the reason
   * nothing here asks `chat.getPermalink`, which would be a request per message.
   *
   * **Asked once per door and remembered for that door's lifetime**, which is
   * one look: a cache that outlived a look would be a token swapped under Tade
   * and an app still answering as the old one.
   */
  async me(): Promise<{ userId: string; botId: string; url: string }> {
    if (!this.whoami) {
      this.whoami = this.call('auth.test', {}).then((body) => ({
        userId: typeof body.user_id === 'string' ? body.user_id : '',
        botId: typeof body.bot_id === 'string' ? body.bot_id : '',
        url: typeof body.url === 'string' ? body.url : '',
      }))
    }
    return this.whoami
  }

  /**
   * Say one sentence in a message's own thread.
   *
   * The sentence is Tade's, generated from a fixed set and never a word an agent
   * wrote; `mark` rides in `metadata`, which Slack does not show anybody and
   * returns only to a read that asks for it, so a retry can recognise its own
   * work without Tade writing its machinery into somebody's channel.
   *
   * `reply_broadcast` is deliberately never set: a status belongs in the thread
   * of the thing it is about, and a channel-wide copy of it is Tade talking over
   * people.
   */
  async post(req: {
    channel: string
    /** The message this is a reply to, so a status never lands as a new topic. */
    thread: string
    text: string
    mark: string
  }): Promise<{ ts: string }> {
    const body = await this.call('chat.postMessage', {
      channel: req.channel,
      thread_ts: req.thread,
      text: req.text,
      metadata: JSON.stringify({ event_type: TADE_STATUS, event_payload: { mark: req.mark } }),
    })
    return { ts: typeof body.ts === 'string' ? body.ts : '' }
  }

  /**
   * Put one reaction on one message.
   *
   * It carries no text, adds nothing to the thread that is the request's own
   * material, and moves no `ts` — and it is also **the only idempotency Slack
   * offers**: `already_reacted` is its own answer to this app having already put
   * this emoji here, per app, per emoji, per message. `chat.postMessage` has
   * nothing like it, which is why a reply claims its slot here first and posts
   * its words second.
   *
   * Returned rather than thrown, so a window that died between reacting and
   * writing its line comes back, asks again, and is told the claim was made.
   */
  async react(req: { channel: string; ts: string; name: string }): Promise<{ already: boolean }> {
    try {
      await this.call('reactions.add', {
        channel: req.channel,
        timestamp: req.ts,
        name: req.name,
      })
    } catch (err) {
      if (err instanceof SlackError && err.trouble === 'already') return { already: true }
      throw err
    }
    return { already: false }
  }

  /** One method, as a page: the messages, Slack's cursor and Slack's own `has_more`. */
  private async page(method: string, form: Record<string, string>): Promise<SlackPage> {
    const body = await this.call(method, form)
    const messages = Array.isArray(body.messages) ? (body.messages as SlackMessage[]) : []
    const meta = body.response_metadata
    const cursor =
      meta &&
      typeof meta === 'object' &&
      typeof (meta as { next_cursor?: unknown }).next_cursor === 'string'
        ? (meta as { next_cursor: string }).next_cursor || null
        : null
    return { messages, cursor, more: body.has_more === true }
  }

  /**
   * One call, and the three answers it can have: a body, an answer that is a
   * refusal, or nothing at all.
   *
   * The last is the only one that becomes `Unreachable`, and it is told apart
   * by *where* it failed rather than by reading a message: a `fetch` that
   * rejects never reached Slack, and any response — 200, 404, 429, 500 — did.
   */
  private async call(
    method: string,
    form: Record<string, string>,
  ): Promise<Record<string, unknown>> {
    let answer: Response
    try {
      answer = await this.fetch(`${SLACK}/${method}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.token}`,
          'content-type': 'application/x-www-form-urlencoded; charset=utf-8',
        },
        body: new URLSearchParams(form).toString(),
        signal: this.signal,
      })
    } catch (err) {
      // A look that was given up on is not an outage: `inTime` aborts the
      // controller when the window's deadline passes, and reporting that as
      // Slack being unreachable would take a whole project's watches down
      // because one of them was slow.
      if (this.signal.aborted) throw err
      throw new Unreachable(SLACK_HOST, `${SLACK_HOST} did not answer ${method}: ${said(err)}`)
    }
    if (answer.status === 429) {
      const after = Number(answer.headers.get('retry-after') ?? '')
      throw new SlackError(
        'ratelimited',
        `Slack rate limited ${method}${Number.isFinite(after) && after > 0 ? ` and asked for ${after}s` : ''}`,
        Number.isFinite(after) && after > 0 ? after : 0,
      )
    }
    if (!answer.ok) {
      throw new SlackError('slack', `${method} answered ${answer.status}`)
    }
    let body: unknown
    try {
      body = await answer.json()
    } catch (err) {
      throw new SlackError('slack', `${method} answered something that is not JSON: ${said(err)}`)
    }
    if (!body || typeof body !== 'object') {
      throw new SlackError('slack', `${method} answered something that is not an object`)
    }
    const read = body as Record<string, unknown>
    if (read.ok !== true) {
      const error = typeof read.error === 'string' ? read.error : 'said no and did not say why'
      throw new SlackError(troubleOf(error), `${method}: ${error}`)
    }
    return read
  }
}

function said(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
