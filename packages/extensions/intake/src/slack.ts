import {
  INTAKE_SAYINGS,
  type IntakeCandidate,
  intakeKey,
  intakePrompt,
  intakeTitle,
  newerRevision,
  slackTs,
} from '@tade/core'
import type { ExtensionWatch, WatchContext } from '@tade/extensions-core'
import { object, string } from '@tade/extensions-core'
import { SlackApi, SlackError, type SlackMessage, TADE_STATUS } from './slack-api.ts'
import {
  advanceTo,
  candidateOf,
  isRequest,
  needsThread,
  requesterOf,
  revisionOf,
  SLACK_REACTIONS,
  type SlackSelf,
  type SlackThread,
  slackRefOf,
  slackSayingOf,
  threadOf,
  tsOf,
} from './slack-message.ts'

// `@tade` in one Slack channel, as work that arrives from outside this machine.
//
// **It is polled, and nothing anywhere may call it chat.** There is no listener,
// no Socket Mode, no public URL and no three-second clock: Tade asks the channel
// what has been said every couple of minutes. Three consequences, all of them
// the kind a connector's README usually leaves out:
//
// 1. A mention is **noticed** up to one poll interval after it was written, and
//    never answered on the spot. If what somebody wants is `@tade` replying in
//    seconds, that is the Events API over a socket an extension can hold open,
//    and it is a different slice.
// 2. **A mention inside a thread is invisible**, because
//    `conversations.history` does not return thread replies. What is visible is
//    a reply somebody also sent to the channel, and that is taken in with its
//    whole thread. `slack-message.ts` says why reading every thread instead is
//    not an option at these rate limits.
// 3. A sleeping laptop reads nothing and promises nothing, which is why the
//    statuses Tade can say back do not include "we will get to it".
//
// What is here is the two halves a connector has to answer for itself: asking
// Slack, and saying something back. What selects a message, who asked, and what
// the envelope is live in `slack-message.ts`, which asks Slack nothing.
//
// ## Loops, and what actually bounds them
//
// Tade **can** write into the channel — a status in the request's own thread —
// so the loop is bounded by three things rather than by there being no way back:
//
// - **A status is never a revision.** The revision is the request's own
//   `edited.ts ?? ts` (`revisionOf`), and posting a reply moves `latest_reply`
//   and nothing else. So Tade's own words can never read, on the next look, as
//   somebody having rewritten the request and put back an approval.
// - **Tade's own messages are left out of the material**, by its own `bot_id`
//   and user id from `auth.test` and by the metadata only this app can set — not
//   by matching the text, which would be defeated the first time somebody quoted
//   a status back.
// - **A status goes in the thread of the thing it is about, and nowhere else.**
//   There is no route here to a channel a finding did not come from, and
//   `reply_broadcast` is never set.
//
// And a status goes out only where the owner granted it
// (`surfaces.intake.sources.slack.reply`), which is a second act and never
// implied by accepting work.
//
// ## What a poll costs, which is the number that decides the bounds
//
// One `auth.test` and one `conversations.history` a look, plus one
// `conversations.replies` for each selected message that has a thread. A channel
// where nobody mentioned Tade costs two requests. Everything is bounded because
// **Slack's generous tier is not the tier every app gets**: see `slack-api.ts`
// for the numbers and the date they were read. A 429 ends the sweep and is said;
// it is never slept through, because a look has a minute before the window gives
// up on it.

/** Where the bot token is read from. `ctx.secret`, so the environment wins. */
export const SLACK_TOKEN = 'slack_token'

/**
 * How many requests one look hands over.
 *
 * Deliberately small, and smaller than the GitHub door's twenty: each one may
 * cost a second request for its thread, and `most: 1` means one of them is acted
 * on anyway. A channel with more than this waiting says so rather than quietly
 * reading three.
 */
export const SLACK_MOST_MESSAGES = 3

/** How many pages of history one look walks. The ceiling on what a look spends. */
export const SLACK_MOST_PAGES = 3

/**
 * How many objects a page asks for.
 *
 * Asked for, not got: Slack caps this at 15 for an app distributed outside the
 * Marketplace and at 1,000 for an internal one, silently, so the honest thing is
 * to ask for a page that suits the generous case and read what comes back.
 */
export const SLACK_PAGE = 200

/** How much of a thread is read as material. One request, and what it missed is said. */
export const SLACK_MOST_THREAD = 50

/** A Slack channel id, as Slack writes one. Not a channel name, which is the usual mistake. */
const CHANNEL = /^[CGD][A-Z0-9]{2,}$/

const INPUT = object(
  {
    channel: string(
      'the id of the one channel to read — C0ABCDEF, from the channel’s own details in Slack, and not its name. Required: there is no "every channel", and one that could be turned on without it would be a channel nobody chose to read. It need not be a channel of Tade’s own: only messages that mention the app are read as requests',
    ),
  },
  ['channel'],
)

/** The channel this watch reads, or why what it was turned on with is not one. */
function channelOf(ctx: WatchContext): string {
  const said = String(ctx.input.channel ?? '').trim()
  if (!said) {
    throw new Error(
      'intake.slack needs the id of the channel to read: turn it on with channel, and there is no "every channel"',
    )
  }
  if (!CHANNEL.test(said)) {
    throw new Error(
      `"${said}" is not a Slack channel id: it is the C0ABCDEF in the channel’s own details, not its name`,
    )
  }
  return said
}

function apiFor(ctx: WatchContext): SlackApi {
  const token = ctx.secret(SLACK_TOKEN)?.value.trim() ?? ''
  if (!token) {
    throw new Error(
      `intake.slack needs a Slack bot token: $SLACK_BOT_TOKEN, or extensions.intake.${SLACK_TOKEN} in config.yaml`,
    )
  }
  return new SlackApi(token, { fetch: ctx.fetch, signal: ctx.signal })
}

/**
 * A failure said in words somebody can act on.
 *
 * `Unreachable` is the api's own and is already thrown where nothing came back.
 * The first two here are the setup mistakes every Slack app makes once, and the
 * third is the one nobody expects — so each carries its own fix rather than
 * Slack's one-word error string.
 */
function asLookFailed(err: unknown, channel: string): unknown {
  if (!(err instanceof SlackError)) return err
  if (err.trouble === 'not_in_channel') {
    return new Error(`${err.message}: invite the Slack app to ${channel}`)
  }
  if (err.trouble === 'scope') {
    return new Error(
      `${err.message}: the bot token needs channels:history for a public channel, groups:history for a private one, and chat:write with reactions:write for the reply path`,
    )
  }
  if (err.trouble === 'ratelimited') {
    return new Error(
      `${err.message}: an app distributed outside the Slack Marketplace gets one request a minute and 15 objects, where an internal one gets 50+ and 1,000`,
    )
  }
  return err
}

/** Given up on: the window's deadline passed, or somebody stopped it. */
function stopped(ctx: WatchContext): void {
  if (ctx.signal.aborted) throw new Error('the look was stopped before it had read everything')
}

export const slackMessages: ExtensionWatch = {
  id: 'slack',
  title: 'Messages that mention Tade in a channel you named',
  means:
    'reads one Slack channel every couple of minutes and takes in each message that mentions the app, from somebody on the list in surfaces.intake, with the thread it was asked in as material — as far as that grant allows it. It notices a mention rather than answering one: there is no slash command, no instant reply, and a mention inside a thread is only visible where it was also sent to the channel',
  // Two minutes, which is as close to "a person is waiting" as a poll gets. Two
  // requests a look is 60 an hour, which an internal app does not notice and a
  // throttled one survives as a 429 that ends one sweep.
  every: '2m',
  intake: 'slack',
  network: true,
  // One a look. The schedule's two is a ceiling on agents started, and this one
  // starts work on somebody else's words: three proposals from one poll is three
  // things a person has to read before they can do anything about any.
  most: 1,
  input: INPUT,

  async check(ctx) {
    const channel = channelOf(ctx)
    const api = apiFor(ctx)
    const seenAt = new Date(ctx.now()).toISOString()
    let me: SlackSelf
    try {
      // Who this token is, which is the mention to look for and the identity
      // Tade's own messages are left out by. One request, no scope at all, and
      // the reason there is nothing to configure about either.
      me = await api.me()
    } catch (err) {
      throw asLookFailed(err, channel)
    }
    if (!me.userId) {
      // A token that cannot say who it is cannot be matched against a mention,
      // and reading *every* message as a request instead would be the one
      // widening this must never do by accident.
      throw new Error(
        'Slack did not say which user this token is, so there is no mention to look for: nothing was read',
      )
    }
    // Where the last look left off, as a Slack `ts`, which Slack treats as
    // exclusive — so the message a look ended on is not read twice. The first
    // look starts at the moment the watch was turned on: what was in the channel
    // before then is not news, and nothing backfills a year of chat.
    const oldest = ctx.since && slackTs(ctx.since) ? ctx.since : tsOf(ctx.turnedOn, ctx.now())
    const read: SlackMessage[] = []
    let cursor: string | null = null
    let pages = 0
    let drained = false
    let limited = 0
    while (pages < SLACK_MOST_PAGES) {
      stopped(ctx)
      let page: Awaited<ReturnType<typeof api.history>>
      try {
        page = await api.history({ channel, oldest, limit: SLACK_PAGE, cursor })
      } catch (err) {
        // A 429 on the **first** request is a look that could not look, and it
        // throws. One partway through is a look that read some of the channel,
        // which is an honest answer: the sweep ends, nothing sleeps, and the
        // next look carries on from the same place.
        if (err instanceof SlackError && err.trouble === 'ratelimited' && pages > 0) {
          limited = err.retryAfter
          break
        }
        throw asLookFailed(err, channel)
      }
      pages += 1
      read.push(...page.messages)
      cursor = page.cursor
      if (!page.more || !cursor) {
        drained = true
        break
      }
    }
    // Oldest first, which is the opposite of the GitHub door and is deliberate:
    // an issue tracker is read newest-movement-first because what somebody
    // labelled a minute ago is the point, and people who asked for something in
    // a channel are answered in the order they asked. `most: 1` takes the first.
    const ordered = read
      .filter((message) => isRequest(message, me))
      .sort((a, b) => newerRevision('slack', a.ts ?? '', b.ts ?? '') ?? 0)
    const found: { key: string; title: string; intake: IntakeCandidate }[] = []
    const unnamed: string[] = []
    const unread: string[] = []
    // What this look will not hand over and the next one must find again. The
    // cursor stops below the oldest of them.
    const held: string[] = []
    let more = 0
    for (const message of ordered) {
      if (found.length >= SLACK_MOST_MESSAGES) {
        more += 1
        held.push(String(message.ts))
        continue
      }
      const requester = requesterOf(message)
      if (!requester) {
        // Slack can name nobody for it. There is no authorisation question to
        // ask about a message with no author, so it selects nothing — named
        // rather than passed over, because this is also what a shape Tade was
        // not written knowing about looks like.
        unnamed.push(String(message.ts))
        continue
      }
      stopped(ctx)
      let thread: SlackThread
      try {
        thread = await threadFor(api, channel, message, me)
      } catch (err) {
        if (
          err instanceof SlackError &&
          (err.trouble === 'ratelimited' || err.trouble === 'missing')
        ) {
          // **A half-read thread is not handed over.** The thread is the
          // request's material and a person approves what they read, so a
          // request whose thread this look could not finish waits for the next
          // one — its key is not burned, so nothing is lost.
          if (err.trouble === 'ratelimited') limited = err.retryAfter
          unread.push(String(message.ts))
          held.push(String(message.ts))
          continue
        }
        throw asLookFailed(err, channel)
      }
      const candidate = candidateOf(message, thread, {
        channel,
        me,
        project: ctx.watching.name,
        requester,
        seenAt,
      })
      found.push({ key: intakeKey(candidate), title: intakeTitle(candidate), intake: candidate })
    }
    return {
      found,
      since: advanceTo(read, held, oldest, drained),
      ...(found.length === 0
        ? {
            said: whyNothing(channel, {
              unnamed,
              unread,
              more,
              drained,
              limited,
              looked: read.length,
            }),
          }
        : {}),
    }
  },

  // Tade's own words, both of them, and neither can reach the message: it is not
  // in the type either of them takes. An agent whose prompt carried a stranger's
  // sentences would be an agent taking its instructions from one, whatever
  // heading was put above them.
  agent: (finding) => {
    const candidate = finding.intake as IntakeCandidate
    return { title: intakeTitle(candidate), prompt: intakePrompt(candidate) }
  },

  /**
   * Whether the message a task was made for is still the message it was made
   * for, asked at the moment the queue would start it. It may only ever hold.
   *
   * **It reads the request itself and not its thread.** A Slack thread is several
   * messages with their own ids, so unlike GitHub's `updated_at` this source can
   * tell an *edit of the ask* from *somebody saying something about it* — and
   * only the first is a new revision. So a "thanks, looking" five minutes after
   * an approval does not hold the work, and neither does Tade's own status
   * message, while an edit to the ask itself does.
   *
   * What that costs is said rather than hidden: the thread in the context file is
   * what it said when the task was made, and a reply that arrived afterwards is
   * not in it.
   *
   * Whether the grant still allows it is **not** asked here: that is
   * `intakeStands`' own first question, read from the config at the moment of
   * starting, and asking it twice in two places is how two answers happen.
   */
  async recheck(finding, ctx) {
    const ref = slackRefOf(finding.key)
    if (!ref) return { still: false, because: `${finding.key} is not a message this watch found` }
    const said = String(ctx.input.channel ?? '').trim()
    if (!said) {
      // Asked without the channel it was selected from, this can verify less
      // than the selector did — so it holds rather than checking the rest and
      // answering yes. It may only ever hold, and "I was not told what to check"
      // is the plainest case of that there is.
      return {
        still: false,
        because: `${ref.externalId} cannot be checked without the channel the watch reads`,
      }
    }
    if (ref.channel !== said) {
      // A key naming another channel cannot be checked from here, and an
      // unverifiable request holds: this is the one direction that must be got
      // right, because the alternative is starting work on somebody's word.
      return {
        still: false,
        because: `${ref.externalId} is not in ${said}, which is what ${ctx.watching.name} reads`,
      }
    }
    const channel = channelOf(ctx)
    const api = apiFor(ctx)
    let message: SlackMessage | undefined
    let me: SlackSelf
    try {
      me = await api.me()
      // The documented way to read one message: the window that is exactly its
      // own `ts`. `conversations.replies` is not asked at all.
      const page = await api.history({
        channel,
        oldest: ref.ts,
        latest: ref.ts,
        inclusive: true,
        limit: 1,
      })
      message = page.messages.find((one) => one.ts === ref.ts)
    } catch (err) {
      if (err instanceof SlackError && (err.trouble === 'missing' || err.trouble === 'scope')) {
        // Gone, or this app can no longer read the channel. Nothing was
        // verified, so nothing stands.
        return {
          still: false,
          because: `${ref.externalId} cannot be read any more: ${err.message}`,
        }
      }
      // Everything else throws: a rate limit, a 500 and an outage are not "no
      // longer stands", and the start door turns a throw into a hold that says
      // the source could not be asked.
      throw asLookFailed(err, channel)
    }
    if (!message) {
      return {
        still: false,
        because: `${ref.externalId} is not there to read any more: it was deleted, or this app can no longer see it`,
      }
    }
    if (!isRequest(message, me)) {
      return {
        still: false,
        because: `${ref.externalId} no longer mentions this app, or is no longer a message this watch would take in`,
      }
    }
    const now = revisionOf(message)
    const order = newerRevision('slack', now, ref.revision)
    if (order === null) {
      return {
        still: false,
        because: `${ref.externalId}'s revisions cannot be ordered: somebody has to say`,
      }
    }
    // Anything but the same revision holds, in **both** directions: later is an
    // edit, and earlier is a source answering something that cannot have
    // happened, which is not a thing to start work on either.
    if (order > 0) {
      return {
        still: false,
        because: `${ref.externalId} was edited after the work was made for ${ref.revision}: it is now ${now}`,
      }
    }
    if (order < 0) {
      return {
        still: false,
        because: `${ref.externalId} now reports revision ${now}, which is earlier than the ${ref.revision} the work was made for`,
      }
    }
    return { still: true }
  },

  /**
   * Say one status back: a reaction on the message, and the sentence in its own
   * thread.
   *
   * **The reaction is the claim and the message is the status**, in that order,
   * because `already_reacted` is Slack's own per-app, per-emoji, per-message
   * answer and is therefore the one piece of bookkeeping that survives a window
   * dying mid-reply — `chat.postMessage` has no such answer of its own. So a
   * reaction that was new means this status has never gone, and one that was
   * already there means the thread has to be read to find out whether the words
   * made it: one extra request, on the retry path only.
   *
   * **What goes out is the sentence Tade generated and nothing else** — one of
   * seven, capped per request, never a word an agent wrote, never a diff, a log
   * line, a file name or a link. The marker rides in Slack's `metadata`, which
   * Slack shows nobody and returns only to a read that asks for it, because
   * putting Tade's machinery in the visible text is the disclosure the rest of
   * this is careful about.
   *
   * **No revision is reported**, honestly: a reaction moves nothing, and a reply
   * in the thread moves `latest_reply`, which `revisionOf` deliberately does not
   * read. There is nothing here for the next look to mistake for an edit.
   */
  async reply(request, ctx) {
    const ref = slackRefOf(request.key)
    if (!ref) throw new Error(`${request.key} is not a message this watch found`)
    const channel = channelOf(ctx)
    if (ref.channel !== channel) {
      throw new Error(`${ref.externalId} is not in ${channel}, which is what this watch reads`)
    }
    const saying = slackSayingOf(request.mark)
    if (!saying) {
      throw new Error(
        `${request.mark} does not end in one of the ${INTAKE_SAYINGS.length} statuses, and a status has to be one of them: nothing was posted`,
      )
    }
    const api = apiFor(ctx)
    const name = SLACK_REACTIONS[saying]
    const claimed = await api.react({ channel, ts: ref.ts, name })
    if (claimed.already) {
      const mine = await saidAlready(api, channel, ref.ts, request.mark, await api.me())
      if (mine) return { posted: mine, already: true }
      // The reaction is there and the words are not: a window died between the
      // two halves, so this is the half that has not happened rather than a
      // status that has.
    }
    const posted = await api.post({
      channel,
      thread: ref.ts,
      text: request.say,
      mark: request.mark,
    })
    return { posted: posted.ts || `:${name}:` }
  },
}

/**
 * The thread a request was asked in, bounded to a single request.
 *
 * Asked only where there is one to read (`needsThread`), so a channel of plain
 * mentions costs no second request at all. What it could not read is carried as
 * a flag rather than dropped: the context file says *there are more*, because
 * material that silently stopped is material somebody approves without knowing
 * what else is in it.
 *
 * **Tade's own messages are left out**, by this app's own ids and by the
 * metadata only this app can set, rather than by matching text: a status Tade
 * posted is not a person asking for anything, and reading one back as material
 * is how a thread fills up with Tade talking to itself. The request is left out
 * too — it is already the thing above the thread.
 */
async function threadFor(
  api: SlackApi,
  channel: string,
  request: SlackMessage,
  me: SlackSelf,
): Promise<SlackThread> {
  if (!needsThread(request)) return { messages: [], more: false }
  const page = await api.replies({
    channel,
    ts: threadOf(request),
    limit: SLACK_MOST_THREAD,
    metadata: true,
  })
  return {
    messages: page.messages.filter((one) => one.ts !== request.ts && !isMine(one, me)),
    more: page.more,
  }
}

/**
 * Whether a message is this app's own. By id and by its own metadata, never by
 * what it says.
 *
 * The metadata half is a belt and errs the safe way round: a message somebody
 * else marked as Tade's would be left *out* of the material, which loses a
 * sentence rather than passing one off as Tade's. Where the answer decides
 * whether a status still has to go, identity alone is asked (`mineById`).
 */
function isMine(message: SlackMessage, me: SlackSelf): boolean {
  return mineById(message, me) || message.metadata?.event_type === TADE_STATUS
}

/** Whether a message was posted by this app, as Slack names it. */
function mineById(message: SlackMessage, me: SlackSelf): boolean {
  if (me.botId && message.bot_id === me.botId) return true
  return me.userId !== '' && message.user === me.userId
}

/**
 * Whether this exact status is already in the thread.
 *
 * Asked only after the reaction said the claim had already been made, which is
 * the one case where a window may have died between the two halves of a reply.
 * By the marker in Slack's own metadata and never by comparing the text, which
 * would break the day somebody rewords a sentence or quotes one back.
 *
 * **And by identity as well as by the marker.** Slack only lets an app set
 * metadata as itself (`metadata_must_be_sent_from_app`), but an `event_type` is
 * not namespaced to an app — so another app in the workspace could write the
 * same one, and a status read as already said is a status that silently never
 * goes. Asking whose the message is first costs nothing: `me` is already known.
 */
async function saidAlready(
  api: SlackApi,
  channel: string,
  ts: string,
  mark: string,
  me: SlackSelf,
): Promise<string | null> {
  const page = await api.replies({ channel, ts, limit: SLACK_MOST_THREAD, metadata: true })
  const found = page.messages.find(
    (one) =>
      mineById(one, me) &&
      one.metadata?.event_type === TADE_STATUS &&
      one.metadata?.event_payload?.mark === mark,
  )
  return found ? String(found.ts) : null
}

/** Why a look that could look found nothing to hand over. */
function whyNothing(
  channel: string,
  what: {
    unnamed: readonly string[]
    unread: readonly string[]
    more: number
    drained: boolean
    limited: number
    looked: number
  },
): string {
  const bits = [
    what.looked === 0
      ? `nothing has been said in ${channel} since the last look`
      : `nothing said in ${channel} since the last look mentions this app, as a message a poll can see`,
  ]
  if (what.unnamed.length > 0) {
    bits.push(`Slack names nobody for ${what.unnamed.join(', ')}`)
  }
  if (what.unread.length > 0) {
    bits.push(
      `${what.unread.join(', ')} has a thread this look could not read, and half a thread is not handed over`,
    )
  }
  if (what.more > 0) {
    bits.push(`${what.more} more than one look hands over are waiting`)
  }
  if (what.limited > 0) {
    bits.push(`Slack rate limited the look and asked for ${what.limited}s`)
  } else if (!what.drained) {
    bits.push('there is more in the channel than one look reads')
  }
  return bits.join('; ')
}
