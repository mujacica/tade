import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// A Slack that answers from a file, for tests that must never reach one.
//
// The message shapes in `channel.json` are Slack's own documented ones, written
// down once and replayed by a fake `fetch`. What is around them — `auth.test`,
// cursors, `has_more`, a 429 with a `Retry-After`, an edit, a deletion, metadata
// only the app that sent it can read back, a reaction that is already there — is
// played by this file, because those are the paths worth exercising and a static
// file cannot page.
//
// **Two things in the fixture are filled in rather than written down.**
// Timestamps are offsets, because a fixed epoch is a test that starts failing on
// some date for a reason nobody can read; and `ME` in a message's text is the
// app's own user id, because a mention is `<@U…>` and the id is a run-time fact.
//
// There is no evidence here that the real Slack still looks like this. What there
// is instead is `slack-api.ts`, which writes down the date its numbers were read
// and where from.

const here = dirname(fileURLToPath(import.meta.url))

/** The app this Slack has installed, as `auth.test` answers for it. */
export const SLACK_ME = { userId: 'U0TADE', botId: 'B0TADE', url: 'https://acme.slack.com/' }

/** One message as the fixture writes it: an offset where Slack has a `ts`. */
interface Written {
  about?: string
  subtype?: string
  at: number
  text?: string
  user?: string
  bot_id?: string
  app_id?: string
  username?: string
  edited?: { user?: string; at: number }
  reply_count?: number
  latest_reply_at?: number
  /** This message is its own thread's parent, which Slack says by `thread_ts === ts`. */
  thread_ts_self?: boolean
  /** This message is a reply in the thread rooted at that offset. */
  thread_ts_at?: number
  files?: Record<string, unknown>[]
}

interface Channel {
  messages: Written[]
  threads: Record<string, Written[]>
}

/** A Slack `ts` for an offset in seconds from the base. Six digits, as Slack writes them. */
export function tsAt(base: number, at: number): string {
  return `${base + at}.000100`
}

/**
 * The fixture's messages and threads, as Slack would return them.
 *
 * `messages` is what `conversations.history` can see — which deliberately leaves
 * out a thread reply that was not also sent to the channel, because that is the
 * fact the whole mention design turns on.
 */
export function channelAt(
  base: number,
  me: string = SLACK_ME.userId,
): { messages: Record<string, unknown>[]; threads: Record<string, Record<string, unknown>[]> } {
  const read = JSON.parse(readFileSync(join(here, 'channel.json'), 'utf8')) as Channel
  const one = (written: Written): Record<string, unknown> => {
    const { about, at, edited, latest_reply_at, thread_ts_self, thread_ts_at, text, ...rest } =
      written
    void about
    return {
      type: 'message',
      ...rest,
      ...(text === undefined ? {} : { text: text.replaceAll('<@ME>', `<@${me}>`) }),
      ts: tsAt(base, at),
      ...(edited ? { edited: { user: edited.user, ts: tsAt(base, edited.at) } } : {}),
      ...(latest_reply_at ? { latest_reply: tsAt(base, latest_reply_at) } : {}),
      ...(thread_ts_self ? { thread_ts: tsAt(base, at) } : {}),
      ...(thread_ts_at ? { thread_ts: tsAt(base, thread_ts_at) } : {}),
    }
  }
  const messages = read.messages.map(one)
  // Each thread whole, root first, which is what `conversations.replies`
  // answers. A message that is in both — a reply also sent to the channel — is
  // written down in both, because that is the one shape where the two methods
  // disagree about what exists.
  const threads = Object.fromEntries(
    Object.entries(read.threads).map(([at, whole]) => [tsAt(base, Number(at)), whole.map(one)]),
  )
  return {
    // Only what a poll can see: a reply that is in the thread alone is not here.
    messages: messages.filter(
      (message) =>
        !message.thread_ts ||
        message.thread_ts === message.ts ||
        message.subtype === 'thread_broadcast',
    ),
    threads,
  }
}

export interface SlackOptions {
  /** The moment the watch was turned on, in whole seconds, which every offset is from. */
  base: number
  /** The channel this Slack has. Anything else answers `channel_not_found`. */
  channel?: string
  /** The messages a poll can see. Order does not matter: this sorts them the way Slack does. */
  messages?: Record<string, unknown>[]
  /** Threads by the parent's `ts`, parent first. */
  threads?: Record<string, Record<string, unknown>[]>
  /** How many objects a page holds whatever was asked for, the way a throttled app is capped. */
  pageSize?: number
  /** Answer 429 to this call onwards, 1-based, so a sweep can be cut short partway. */
  limitFrom?: number
  /** Slack's own `Retry-After`, in seconds. */
  retryAfter?: number
  /** Every call answers this Slack `error`. */
  error?: string
  /** One method answers this Slack `error`, and everything else works. */
  refuse?: { method: string; error: string }
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
  /** An HTTP status that is not 200 and not 429. */
  status?: number
  /** What `auth.test` says this app is. The default is `SLACK_ME`. */
  me?: Partial<typeof SLACK_ME>
}

export interface SlackScript {
  fetch: typeof fetch
  /** Every call, as the method and the form it was sent, for asserting what Tade asked for. */
  calls: { method: string; form: Record<string, string> }[]
  /** Only the methods, for the short assertions. */
  methods: () => string[]
  /** The reactions this Slack holds, as `<ts>:<name>`. */
  reactions: Set<string>
  /** Somebody editing a message: `ts` stays and `edited.ts` moves, which is what Slack does. */
  edit(ts: string, text: string, at: number): void
  /** Somebody deleting one, which is a message that is simply not there any more. */
  remove(ts: string): void
  /** Somebody replying in a thread, which moves `reply_count` and `latest_reply`. */
  replyTo(ts: string, reply: { user: string; text: string; at: number }): void
}

/** A Slack whose answers are this file's, and whose state a test can change under Tade. */
export function slackScript(options: SlackOptions): SlackScript {
  const channel = options.channel ?? 'C0ACME'
  const me = { ...SLACK_ME, ...options.me }
  const from = options.messages ? null : channelAt(options.base, me.userId)
  const messages = options.messages ?? (from as NonNullable<typeof from>).messages
  const threads: Record<string, Record<string, unknown>[]> =
    options.threads ?? (from ? from.threads : {})

  /** How many objects a page holds: what was asked for, capped the way Slack caps it. */
  const pageOf = (asked: string): number =>
    Math.max(1, Math.min(Number(asked) || 100, options.pageSize ?? 1000))

  /** The cursor this Slack hands out: how far down the list the next page starts. */
  const atOf = (cursor: string | undefined): number =>
    cursor?.startsWith('at:') ? Number(cursor.slice(3)) : 0

  function paged(
    all: Record<string, unknown>[],
    form: Record<string, string>,
    metadata: boolean,
  ): Record<string, unknown> {
    const at = atOf(form.cursor)
    const size = pageOf(form.limit ?? '')
    const page = all.slice(at, at + size).map((one) => {
      // Metadata comes back only to a read that asked for it, which is the whole
      // reason Tade's marker is safe to put there.
      if (metadata || one.metadata === undefined) return one
      const { metadata: _hidden, ...rest } = one
      return rest
    })
    const more = at + size < all.length
    return {
      ok: true,
      messages: page,
      has_more: more,
      ...(more ? { response_metadata: { next_cursor: `at:${at + size}` } } : {}),
    }
  }

  /** `conversations.history`: top-level messages, newest first, bounded by oldest/latest. */
  function history(form: Record<string, string>): Record<string, unknown> {
    const inclusive = form.inclusive === 'true' || form.inclusive === '1'
    // Compared as numbers, which is right for a fixture whose offsets are whole
    // seconds apart and is exactly what the code under test may not do: the
    // ordering that matters is `newerRevision`'s, and that has its own tests.
    const within = messages
      .filter((one) => {
        const ts = Number(one.ts)
        if (form.oldest && (inclusive ? ts < Number(form.oldest) : ts <= Number(form.oldest))) {
          return false
        }
        if (form.latest && (inclusive ? ts > Number(form.latest) : ts >= Number(form.latest))) {
          return false
        }
        return true
      })
      .sort((a, b) => Number(b.ts) - Number(a.ts))
    return paged(within, form, form.include_all_metadata === 'true')
  }

  /** `conversations.replies`: the parent first, then its replies oldest first. */
  function thread(form: Record<string, string>): Record<string, unknown> {
    const asked = form.ts ?? ''
    const whole = threads[asked]
    if (whole) return paged(whole, form, form.include_all_metadata === 'true')
    const alone = messages.find((one) => one.ts === asked)
    if (!alone) return { ok: false, error: 'thread_not_found' }
    return paged([alone], form, form.include_all_metadata === 'true')
  }

  /** `reactions.add`, and Slack's own answer when this app already put that one there. */
  function react(form: Record<string, string>): Record<string, unknown> {
    const key = `${form.timestamp}:${form.name}`
    if (script.reactions.has(key)) return { ok: false, error: 'already_reacted' }
    if (!messages.some((one) => one.ts === form.timestamp)) {
      return { ok: false, error: 'message_not_found' }
    }
    script.reactions.add(key)
    return { ok: true }
  }

  /** `chat.postMessage`: a real message in the thread, carrying the metadata it was sent with. */
  function post(form: Record<string, string>): Record<string, unknown> {
    if (!form.thread_ts) return { ok: false, error: 'no_text' }
    const written: Record<string, unknown> = {
      type: 'message',
      ts: `${Number(form.thread_ts) + 1}.000100`,
      thread_ts: form.thread_ts,
      user: me.userId,
      bot_id: me.botId,
      text: form.text,
      ...(form.metadata ? { metadata: JSON.parse(form.metadata) } : {}),
    }
    const whole = threads[form.thread_ts]
    if (whole) whole.push(written)
    else {
      const parent = messages.find((one) => one.ts === form.thread_ts)
      threads[form.thread_ts] = [...(parent ? [parent] : []), written]
      if (parent) {
        parent.reply_count = (threads[form.thread_ts] as unknown[]).length - 1
        parent.latest_reply = written.ts
        parent.thread_ts = form.thread_ts
      }
    }
    return { ok: true, ts: written.ts, channel: form.channel }
  }

  const script: SlackScript = {
    calls: [],
    methods: () => script.calls.map((one) => one.method),
    reactions: new Set<string>(),
    edit(ts, text, at) {
      const found = messages.find((one) => one.ts === ts)
      if (found) {
        found.text = text.replaceAll('<@ME>', `<@${me.userId}>`)
        found.edited = { user: 'U0KIM', ts: tsAt(options.base, at) }
      }
    },
    remove(ts) {
      const at = messages.findIndex((one) => one.ts === ts)
      if (at >= 0) messages.splice(at, 1)
    },
    replyTo(ts, reply) {
      const parent = messages.find((one) => one.ts === ts)
      if (!parent) return
      const written = {
        type: 'message',
        ts: tsAt(options.base, reply.at),
        thread_ts: ts,
        user: reply.user,
        text: reply.text,
      }
      threads[ts] = [...(threads[ts] ?? [parent]), written]
      parent.reply_count = (threads[ts] as unknown[]).length - 1
      parent.latest_reply = written.ts
      parent.thread_ts = ts
    },
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = String(input)
      const method = url.slice(url.lastIndexOf('/') + 1)
      const form = Object.fromEntries(new URLSearchParams(String(init?.body ?? '')))
      script.calls.push({ method, form })
      if (options.offline) throw new TypeError('fetch failed')
      if (init?.signal?.aborted) throw new Error('aborted')
      if (options.hang) {
        return new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), {
            once: true,
          })
        })
      }
      if (options.limitFrom !== undefined && script.calls.length >= options.limitFrom) {
        return answer(
          429,
          { ok: false, error: 'ratelimited' },
          { 'retry-after': String(options.retryAfter ?? 30) },
        )
      }
      if (options.status !== undefined) return answer(options.status, { ok: false })
      if (options.error) return answer(200, { ok: false, error: options.error })
      if (options.refuse?.method === method) {
        return answer(200, { ok: false, error: options.refuse.error })
      }
      if (method === 'auth.test') {
        return answer(200, { ok: true, user_id: me.userId, bot_id: me.botId, url: me.url })
      }
      if (form.channel !== channel) return answer(200, { ok: false, error: 'channel_not_found' })
      if (method === 'conversations.history') return answer(200, history(form))
      if (method === 'conversations.replies') return answer(200, thread(form))
      if (method === 'reactions.add') return answer(200, react(form))
      if (method === 'chat.postMessage') return answer(200, post(form))
      return answer(200, { ok: false, error: 'unknown_method' })
    }) as typeof fetch,
  }
  return script
}

function answer(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}
