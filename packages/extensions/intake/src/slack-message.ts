import {
  advanceCursor,
  INTAKE_SAYINGS,
  type IntakeCandidate,
  type IntakeRequester,
  type IntakeSaying,
  intakeHash,
  slackTs,
} from '@tade/core'
import type { SlackMessage } from './slack-api.ts'

// What a Slack message is, read as an envelope — and nothing that asks Slack
// anything.
//
// Its own file because it is the half that is pure: messages in, an envelope
// out, no network, no clock read, no token. That is what makes the selector and
// the revision rule testable without a Slack at all, and it is the half where
// every decision that could authorise the wrong person lives.
//
// ## What selects a message, and every clause is a decision
//
// 1. **It mentions the app.** The trigger is `@tade` — `<@U07TADE>` in the text
//    Slack actually returns — and the app's own user id comes from `auth.test`,
//    so there is nothing to configure and nothing a message can claim about who
//    it is addressing. A channel the app is in that is *not* a dedicated one
//    therefore costs nothing: what is not addressed to Tade is not read as a
//    request.
// 2. **Top-level, or a reply that was also sent to the channel.** This is the
//    one place polling is visibly worse than a socket, and it is written here
//    rather than apologised for: **`conversations.history` does not return
//    thread replies**, so a plain `@tade` inside a thread is invisible to a
//    poll — no amount of care here can see it, and reading every thread in the
//    channel to find one is a request per thread per look. What *is* visible is
//    a reply somebody ticked "also send to channel" on (`thread_broadcast`), and
//    that is taken in with the whole thread as its material. A mention in an
//    ordinary thread reply needs the Events API, which needs a socket.
// 3. **Somebody wrote it.** A join, a leave, a topic change and an app's
//    channel-wide post are not asks. An **allowlist of subtypes**, so a subtype
//    this was not written knowing about is read as a channel event: the safe
//    reading of an unknown one is "not a request".
// 4. **Slack can name who posted it.** A message Slack names nobody for selects
//    nothing — there is no authorisation question to ask about it.
//
// **The person who posted is the requester, by their Slack user id and never by
// their display name.** A display name is its owner's to change and a workspace
// may hold two people with the same one, while `from` is the thing that decides
// whether somebody's words become work on your laptop with your keys. So the
// allowlist is `U…` ids, and nothing here asks Slack who they are: one scope
// fewer and one request fewer.
//
// **Nothing about their permissions in Slack is read.** Being in the channel is
// not permission and being an admin is not permission. The owner's grant
// authorises; Slack's answer about who somebody is only identifies them.
//
// **An app's post is refused by actor, twice.** A channel-wide bot post has a
// subtype the allowlist does not have; an app posting as a user sets `bot_id`
// with no subtype, gets through, and is refused as `is_bot` with a record,
// because `requester.bot` carries Slack's own word about it. Never by looking
// for Tade's words in the text, which is defeated the first time somebody quotes
// Tade back at it.

/** Subtypes that are still somebody writing a message. An allowlist, deliberately. */
const WRITTEN = new Set(['file_share', 'me_message', 'thread_broadcast'])

/**
 * Which reaction says which status.
 *
 * **One emoji per saying, so each has its own idempotency slot**: Slack's
 * `already_reacted` is per message, per emoji, per app, so two sayings sharing
 * one emoji would make the second silently "already said". All seven are stock
 * Slack aliases, which exist in every workspace — a custom one would fail with
 * `invalid_name` in somebody else's.
 */
export const SLACK_REACTIONS: Readonly<Record<IntakeSaying, string>> = {
  noticed: 'eyes',
  proposed: 'hourglass',
  accepted: 'inbox_tray',
  started: 'hammer_and_wrench',
  held: 'warning',
  review: 'mag',
  finished: 'white_check_mark',
}

/** This app, as `auth.test` answers: the mention to look for, and its own messages. */
export interface SlackSelf {
  /** The app's own user id, which is the `<@U…>` a person types to ask it for something. */
  userId: string
  /** Its `bot_id`, for leaving its own messages out of a thread. */
  botId: string
  /** The workspace's own address, which is what a permalink is built from. */
  url: string
}

/** `slack:C0ACME/1727442000.123456:1727445000.000100`, pulled apart again. */
export function slackRefOf(
  key: string,
): { channel: string; ts: string; revision: string; externalId: string } | null {
  // By the first and last colon, never `split(':')`: the external id has a
  // channel and a `ts` in it and the revision is a `ts` of its own, so a split
  // on every colon gives back the channel as the whole of it.
  if (!key.startsWith('slack:')) return null
  const rest = key.slice('slack:'.length)
  const last = rest.lastIndexOf(':')
  if (last <= 0) return null
  const externalId = rest.slice(0, last)
  const revision = rest.slice(last + 1)
  const slash = externalId.indexOf('/')
  if (slash <= 0) return null
  const channel = externalId.slice(0, slash)
  const ts = externalId.slice(slash + 1)
  if (!slackTs(ts) || !slackTs(revision)) return null
  return { channel, ts, revision, externalId }
}

/**
 * Which status a marker is about.
 *
 * Read off Tade's own marker rather than off the sentence, because the reaction
 * half of a reply cannot carry a sentence and matching the prose would break the
 * day somebody rewords one. A marker that does not end in a saying is a Tade bug
 * and throws where it is used: a wrong emoji is worse than a status that visibly
 * failed.
 */
export function slackSayingOf(mark: string): IntakeSaying | null {
  const tail = mark.slice(mark.lastIndexOf(':') + 1)
  return (INTAKE_SAYINGS as readonly string[]).includes(tail) ? (tail as IntakeSaying) : null
}

/** What is left of a message once every `<@U…>` in it is taken out. */
export function withoutMentions(text: string): string {
  return text.replace(/<@[^>]*>/g, ' ').trim()
}

/** Whether the text addresses this app, in the form Slack actually returns one. */
export function mentions(text: string, me: Pick<SlackSelf, 'userId'>): boolean {
  // `<@U07TADE>` ordinarily, `<@U07TADE|tade>` in Slack's older spelling, so the
  // opening is matched and the closing is not. A bare `@tade` is not a mention:
  // Slack only writes the bracketed form for one that resolved to this app, so
  // somebody typing the characters at a Tade that is not in the channel does not
  // make a request — which is the right way round.
  return me.userId !== '' && text.includes(`<@${me.userId}`)
}

/** Whether one history item is somebody asking this app for something. */
export function isRequest(message: SlackMessage, me: Pick<SlackSelf, 'userId'>): boolean {
  if (message.type !== undefined && message.type !== 'message') return false
  if (!message.ts || !slackTs(message.ts)) return false
  if (message.subtype !== undefined && !WRITTEN.has(message.subtype)) return false
  // A thread reply is only ever visible to a poll where somebody also sent it to
  // the channel; one that is in the thread alone is not here to be read at all.
  if (message.thread_ts && message.thread_ts !== message.ts) {
    if (message.subtype !== 'thread_broadcast') return false
  }
  const text = message.text ?? ''
  if (!mentions(text, me)) return false
  // A mention with nothing else in it asks for nothing, and a request whose
  // whole content is Tade's own handle is one no agent could act on. The
  // mentions come out first, so `@tade @kim` is as empty as `@tade` is.
  return withoutMentions(text) !== '' || (message.files?.length ?? 0) > 0
}

/** The thread one message belongs to: its own, or the one it was a reply in. */
export function threadOf(message: SlackMessage): string {
  return message.thread_ts || String(message.ts)
}

/** Whether a thread has to be read to know what a request's material is. */
export function needsThread(message: SlackMessage): boolean {
  return threadOf(message) !== String(message.ts) || (message.reply_count ?? 0) > 0
}

/**
 * Who Slack says posted it, or null where it says nobody.
 *
 * `bot` is Slack's own word about the actor. Never a guess from the text.
 */
export function requesterOf(message: SlackMessage): IntakeRequester | null {
  const id = message.user || message.bot_id || ''
  if (!id) return null
  return { id, label: '', bot: Boolean(message.bot_id || message.app_id) }
}

/**
 * Which version of the request this is: the moment it was edited, or the moment
 * it was posted.
 *
 * **The thread is not in it, deliberately.** A Slack thread is several messages
 * with their own ids, so this is the one source that can say "the ask itself has
 * changed" without also saying it every time somebody comments — which is the
 * thing GitHub's `updated_at` cannot do, and is why a proposal there is re-parked
 * by a "thanks" and one here is not. It is also what makes Tade's own status
 * message harmless: posting in the thread moves `latest_reply`, and `latest_reply`
 * is not this.
 */
export function revisionOf(message: SlackMessage): string {
  const edited = message.edited?.ts
  return edited && slackTs(edited) ? edited : String(message.ts)
}

/**
 * Where the next look starts.
 *
 * The newest `ts` everything below which has been dealt with — which is **not**
 * simply the newest thing read. A request this look deferred — its thread could
 * not be read, or it was past the ceiling — has to be found again, and a cursor
 * past it would be a request that vanished with nothing written down. So the
 * cursor stops below the oldest deferred one, and a sweep that did not reach the
 * bottom of its own window does not move at all.
 */
export function advanceTo(
  read: readonly SlackMessage[],
  held: readonly string[],
  oldest: string,
  drained: boolean,
): string {
  // The rule is `advanceCursor`'s, in `@tade/core` beside `newerRevision`,
  // because the source that came after this one carries a time cursor too and
  // one of two copies of this quietly losing a request is the failure nobody
  // would ever see. What is left here is what a Slack mark *is*.
  return advanceCursor(
    'slack',
    read.map((one) => String(one.ts)),
    held,
    oldest,
    drained,
  )
}

/** An ISO time for a Slack `ts`, for the two "when" facts the envelope carries. */
export function atOf(ts: string): string {
  const parsed = slackTs(ts)
  if (!parsed) return ''
  return new Date(parsed.seconds * 1000 + Math.round(parsed.micros / 1000)).toISOString()
}

/** An ISO time as a Slack `ts`, for the first look's starting point. */
export function tsOf(when: string, now: number): string {
  const at = Date.parse(when)
  // A `turnedOn` nothing can parse would otherwise read as the beginning of
  // time and backfill the whole channel, so it reads as *now* instead: the safe
  // direction for a watch whose whole opening rule is "what was already there is
  // not news".
  const ms = Number.isFinite(at) ? at : now
  return `${Math.floor(ms / 1000)}.${String(ms % 1000).padStart(3, '0')}000`
}

/** Where the exact bytes are, built from the workspace's own address. */
export function permalinkOf(me: Pick<SlackSelf, 'url'>, channel: string, ts: string): string {
  const root = me.url.replace(/\/+$/, '')
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(root)) return ''
  return `${root}/archives/${channel}/p${ts.replace('.', '')}`
}

/** What was read of one thread, and whether that was the whole of it. */
export interface SlackThread {
  /** The messages, oldest first, without the request itself and without Tade's own. */
  messages: SlackMessage[]
  /**
   * That Slack says there is more below what was read.
   *
   * A flag rather than a total, because a total here would be arithmetic over
   * what was left out — the request itself, Tade's own statuses — and a number
   * that is quietly wrong is worse than saying there is more. Unknown is a
   * first-class answer.
   */
  more: boolean
}

/**
 * The request, verbatim, and the thread it was asked in under it.
 *
 * **The only words of Tade's inside it are the line counting the thread and the
 * `@id:` before each message**, and both have to be there: a thread is several
 * people's messages, and material that did not say whose would be worse than
 * material with a label on it. Everything else is exactly what Slack returned,
 * fenced by `intakeContext` under the one wording of what material means.
 */
export function verbatimOf(request: SlackMessage, thread: SlackThread): string {
  const text = (request.text ?? '').trim()
  if (thread.messages.length === 0) return text
  const many = thread.messages.length
  const head = thread.more
    ? `--- the thread it was asked in: the first ${many} ${many === 1 ? 'message' : 'messages'}, oldest first, and Slack says there are more ---`
    : `--- the thread it was asked in: ${many} ${many === 1 ? 'message' : 'messages'}, oldest first ---`
  const lines = thread.messages.map(
    (one) => `@${one.user || one.bot_id || 'somebody'}: ${(one.text ?? '').trim()}`,
  )
  return [text, head, ...lines].filter((line) => line !== '').join('\n')
}

/**
 * The request's own files, as references and never as bytes.
 *
 * `permalink` rather than `url_private`, which needs the token to open and is
 * therefore a link nobody but this app could follow. **The request's own files
 * only**: a file dropped later in the thread is part of the discussion, and a
 * list that grew with the conversation would be a list whose length depended on
 * when Tade looked.
 */
export function attachmentsOf(request: SlackMessage): IntakeCandidate['attachments'] {
  return (request.files ?? [])
    .map((file) => ({
      name: file.name || file.title || 'a file Slack did not name',
      url: file.permalink || file.url_private || '',
      mediaType: file.mimetype ?? '',
      bytes: Number.isSafeInteger(file.size) && (file.size ?? 0) > 0 ? (file.size as number) : 0,
    }))
    .filter((file) => file.url !== '')
}

/** One message as the envelope a watch hands over: no grant, no template, no project of its own. */
export function candidateOf(
  request: SlackMessage,
  thread: SlackThread,
  where: {
    channel: string
    me: SlackSelf
    project: string
    requester: IntakeRequester
    seenAt: string
  },
): IntakeCandidate {
  const ts = String(request.ts)
  // The channel and the `ts` together, with a slash: neither has a colon in it,
  // so `intakeKey`'s `<source>:<id>:<revision>` stays something a reader can
  // pull apart again (`slackRefOf`).
  const externalId = `${where.channel}/${ts}`
  const revision = revisionOf(request)
  const url = permalinkOf(where.me, where.channel, ts)
  const verbatim = verbatimOf(request, thread)
  return {
    source: 'slack',
    externalId,
    revision,
    url,
    requester: where.requester,
    // What this door called where it came from. The owner's own list is what
    // decides whether that may become work, which is `intakeMapped`'s.
    from: where.project,
    // THE REQUEST, VERBATIM: Slack's own text and not a word of Tade's beyond
    // the two the thread needs. It goes in the context file under the material
    // heading and nowhere else.
    verbatim,
    material: { ref: url || externalId, hash: intakeHash(verbatim) },
    attachments: attachmentsOf(request),
    sourceAt: atOf(revision),
    seenAt: where.seenAt,
    // One id per delivery of one revision, so every line about it — the
    // received, the accepted, the retry — carries the same one.
    correlation: `${externalId}@${revision}`,
  }
}
