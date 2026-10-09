import {
  advanceCursor,
  type IntakeCandidate,
  intakeKey,
  intakePrompt,
  intakeTitle,
  newerRevision,
} from '@tade/core'
import type { ExtensionWatch, WatchContext } from '@tade/extensions-core'
import { object, string } from '@tade/extensions-core'
import { LinearApi, LinearError, type LinearIssue } from './linear-api.ts'
import {
  appliedBy,
  candidateOf,
  linearRefOf,
  notSelected,
  requesterOf,
  revisionOf,
  SUGGESTED_LABEL,
} from './linear-issue.ts'

// One Linear team's labelled issues, as work that arrives from outside this
// machine.
//
// **It is polled, and nothing anywhere may call it an agent.** Linear has a
// genuinely nicer intake than this — an app user you @-mention or assign, which
// answers in a thread — and it is **not what this is**, is not a slower version
// of it, and is not half-built here. It needs a publicly accessible HTTPS,
// non-localhost URL that answers a webhook inside 5 seconds and sends a first
// activity inside 10, with retries after 1 minute, 1 hour and 6 hours and the
// webhook disabled after that. Three of those are promises about a machine
// being awake, and a laptop cannot make them. So there is no listener, no
// webhook, no public hostname and no signature verification in this file, and
// `INTAKE_NOT_SUPPORTED` says so where somebody is deciding. **Jira is not here
// at all** for the same reason plus one of its own, and is likewise not a
// switch somebody has to find.
//
// What is here is the two things a connector has to answer for itself: asking
// Linear, and saying what came back. What selects an issue, who asked, and what
// the envelope is live in `linear-issue.ts`, which asks Linear nothing.
//
// ## The third source, and what was *not* built for it
//
// A port, a registry and a conformance suite for "intake sources" were weighed
// here and **not** built, because `ExtensionWatch` is already all three: the
// interface, the one registry a watch is named in, and `extensionConformance`,
// which this watch passes with everything else. What a GitHub poll through a
// forge, a Slack socketless channel read and a Linear GraphQL query actually
// share is the *envelope* and the *rules*, and those were already in
// `@tade/core` before any of them existed.
//
// What the third source did earn is two small extractions, both of a rule
// stated three times rather than of a shape repeated three times:
// `intakeHash`, because `intakeAgain` compares a hash one source wrote against
// one another computed and three spellings of it is three chances to differ;
// and `advanceCursor`, because "a cursor may never move past something the look
// deferred" is the rule whose two copies silently losing a request is the bug
// nobody would ever see. Neither is a port. A fourth source that needed a
// fourth GraphQL client would be the moment to look again.
//
// ## Loops, and what bounds them
//
// **There is no way back.** This watch implements no `reply`, so Tade cannot
// write a word into a Linear workspace and nothing it reads there can be
// something it wrote. That is the GitHub door's guarantee rather than Slack's
// three, and it is the stronger one: `surfaces.intake.sources.linear.reply`
// turns nothing on, the host refuses a status for a watch with no transport,
// and the setup steps say so rather than leaving somebody to find out.
//
// It also settles a question Linear's own documentation does not answer.
// `updatedAt` is *"the last time at which the entity was meaningfully
// updated"*, and whether a comment counts is nowhere — so a connector that
// posted statuses would have to know, or report the revision each one moved the
// issue to (`REPLIES_MOVE_REVISIONS`). With no way to post, the question never
// arises: every revision this reads moved because somebody moved it.
//
// What is left is honest and is why `propose` is the default forever: an agent
// runs as you and could label an issue itself, and then a person is looking at
// a proposal rather than at a loop. `most: 1` is the other half.
//
// ## What a poll costs
//
// One request a page, up to three pages, every ten minutes — 18 requests an
// hour out of 2,500, and about 2% of the complexity budget. The arithmetic and
// the numbers it is written against are in `linear-api.ts`. A rate limit ends
// the sweep and is said; it is never slept through, because a look has the
// window's deadline and Linear reports a reset rather than a delay.

/** Where the key is read from. `ctx.secret`, so the environment wins. */
export const LINEAR_KEY = 'linear_key'

/**
 * How many issues one page asks for.
 *
 * Explicit, and that is not a style choice: Linear counts a connection with no
 * `first` on it as 50, and this query nests one inside another, so leaving the
 * default on would cost fifty times what it needs.
 */
export const LINEAR_PAGE = 25

/** How many pages one look walks. The ceiling on what a look spends. */
export const LINEAR_MOST_PAGES = 3

/**
 * How many of an issue's history entries are read to find who applied the
 * label.
 *
 * The one bound with a visible cost: a label applied longer ago than this many
 * changes cannot be attributed, and an issue nobody can be named for selects
 * nothing and is named in the look. That is the safe direction, and it is
 * mostly theoretical — the filter already asks only for issues that moved since
 * the last look.
 */
export const LINEAR_MOST_HISTORY = 25

/**
 * How many requests one look hands over.
 *
 * Deliberately small, and the same as the Slack door's: `most: 1` means one of
 * them is acted on anyway, and a team with more than this waiting says so
 * rather than quietly reading three.
 */
export const LINEAR_MOST_ISSUES = 3

/** A Linear team key, as it prefixes an identifier. Not a team *name*, which is the usual mistake. */
const TEAM = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/

const INPUT = object(
  {
    team: string(
      'the key of the one team to read — the ENG in ENG-412, from the team’s own settings in Linear, and not its name. Required: there is no "every team", and one that could be turned on without it would be a workspace nobody chose to read',
    ),
    label: string(
      `the label an issue must carry to be taken in — "${SUGGESTED_LABEL}" is the suggestion. Required: there is no "any issue", and a watch that could be turned on without one would be a team nobody chose to read`,
    ),
  },
  ['team', 'label'],
)

/** What the watch reads, or why what it was turned on with is not a team and a label. */
function selectorOf(ctx: WatchContext): { team: string; label: string } {
  const team = String(ctx.input.team ?? '').trim()
  const label = String(ctx.input.label ?? '').trim()
  if (!team) {
    throw new Error(
      'intake.linear needs the key of the team to read: turn it on with team, and there is no "every team"',
    )
  }
  if (!TEAM.test(team)) {
    throw new Error(
      `"${team}" is not a Linear team key: it is the ENG in ENG-412, from the team’s settings, not its name`,
    )
  }
  if (!label) {
    throw new Error(
      'intake.linear needs the label an issue must carry: turn it on with label, and there is no "any issue"',
    )
  }
  return { team, label }
}

function apiFor(ctx: WatchContext): LinearApi {
  const key = ctx.secret(LINEAR_KEY)?.value.trim() ?? ''
  if (!key) {
    throw new Error(
      `intake.linear needs a Linear personal API key: $LINEAR_API_KEY, or extensions.intake.${LINEAR_KEY} in config.yaml`,
    )
  }
  return new LinearApi(key, { fetch: ctx.fetch, signal: ctx.signal })
}

/**
 * A failure said in words somebody can act on.
 *
 * `Unreachable` is the api's own and is already thrown where nothing came back.
 * These three are the setup mistakes a Linear key makes once each, and each
 * carries its own fix rather than Linear's one-line message.
 */
function asLookFailed(err: unknown, team: string): unknown {
  if (!(err instanceof LinearError)) return err
  if (err.trouble === 'auth') {
    return new Error(
      `${err.message}: check the key is a personal API key and is sent as it is — Linear takes a key in Authorization with no "Bearer", which is the opposite of its OAuth tokens`,
    )
  }
  if (err.trouble === 'forbidden') {
    return new Error(`${err.message}: this key may not read ${team}, or it is another workspace's`)
  }
  if (err.trouble === 'ratelimited') {
    return new Error(
      `${err.message}: a personal API key gets 2,500 requests and 3,000,000 complexity points an hour${resetIn(err.resetsAt)}`,
    )
  }
  return err
}

/** How long until a budget Linear reported is clear, where it reported one. */
function resetIn(resetsAt: number): string {
  return resetsAt > 0
    ? `, and it says a budget is clear again at ${new Date(resetsAt).toISOString()}`
    : ''
}

/** Given up on: the window's deadline passed, or somebody stopped it. */
function stopped(ctx: WatchContext): void {
  if (ctx.signal.aborted) throw new Error('the look was stopped before it had read everything')
}

export const linearIssues: ExtensionWatch = {
  id: 'linear',
  title: 'Linear issues somebody labelled for Tade',
  means:
    'reads one Linear team every ten minutes and takes in each open issue carrying the label you name, where somebody on the list in surfaces.intake applied that label — as far as that grant allows it. It notices a labelled issue rather than answering one: there is no @-mention, no assignment and no agent session, and nothing is ever posted back',
  // Ten minutes, the same as the GitHub door, and for the same reason: this is
  // about how soon somebody wants an answer rather than about a budget. Two
  // requests a look is nothing against 2,500 an hour.
  every: '10m',
  intake: 'linear',
  network: true,
  // One a look. The schedule's two is a ceiling on agents started, and this one
  // starts work on somebody else's words: three proposals from one poll is
  // three things a person has to read before they can do anything about any.
  most: 1,
  input: INPUT,

  async check(ctx) {
    const select = selectorOf(ctx)
    const api = apiFor(ctx)
    const seenAt = new Date(ctx.now()).toISOString()
    // Where the last look left off, as an ISO instant, which the filter uses
    // **inclusively** (`gte`): the issue a look ended on is read again rather
    // than skipped, which costs nothing because Tade knows which keys it has
    // seen, and is the only way two issues that moved in the same millisecond
    // are both read. The first look starts at the moment the watch was turned
    // on: what was already labelled then is not news.
    //
    // Checked against the comparator before it is sent, because Linear's
    // `DateTime` is wider than an instant — it accepts ISO 8601 *durations*
    // relative to now — so a cursor that got corrupted into `-P2W` would
    // silently mean "the last fortnight" rather than failing.
    const since = ctx.since && revisionIsAnInstant(ctx.since) ? ctx.since : ctx.turnedOn
    const read: LinearIssue[] = []
    let cursor: string | null = null
    let pages = 0
    let drained = false
    // Whether a rate limit ended the sweep, and the reset Linear reported with
    // it — two facts, because Linear need not report one. Carrying the reset
    // alone made a rate limit with no header read as an ordinary short sweep,
    // which is the one thing the sentence has to tell a person apart.
    let limited: { resetsAt: number } | null = null
    while (pages < LINEAR_MOST_PAGES) {
      stopped(ctx)
      let page: Awaited<ReturnType<typeof api.issues>>
      try {
        page = await api.issues({
          select: { ...select, since },
          first: LINEAR_PAGE,
          history: LINEAR_MOST_HISTORY,
          cursor,
        })
      } catch (err) {
        // A rate limit on the **first** request is a look that could not look,
        // and it throws. One partway through is a look that read some of the
        // team, which is an honest answer: the sweep ends, nothing sleeps, and
        // the next look carries on from the same place.
        if (err instanceof LinearError && err.trouble === 'ratelimited' && pages > 0) {
          limited = { resetsAt: err.resetsAt }
          break
        }
        throw asLookFailed(err, select.team)
      }
      pages += 1
      read.push(...page.issues)
      cursor = page.cursor
      if (!page.more || !cursor) {
        drained = true
        break
      }
    }
    // Oldest movement first, which is the opposite of the GitHub door and is
    // the cursor's doing rather than a preference: this source carries a time
    // cursor, so a bounded look that took the newest three would leave the
    // older ones behind with the cursor already past them. Ordered here and
    // never trusted from Linear, whose `orderBy` documents no direction.
    const ordered = [...read].sort(
      (a, b) => newerRevision('linear', revisionOf(a), revisionOf(b)) ?? 0,
    )
    const found: { key: string; title: string; intake: IntakeCandidate }[] = []
    const unnamed: string[] = []
    const over: string[] = []
    // What this look will not hand over and the next one must find again. The
    // cursor stops below the oldest of them.
    const held: string[] = []
    let more = 0
    for (const issue of ordered) {
      const revision = revisionOf(issue)
      if (found.length >= LINEAR_MOST_ISSUES) {
        more += 1
        if (revision) held.push(revision)
        continue
      }
      const why = notSelected(issue, select)
      if (why) {
        // Linear answered the filter and this issue does not match it when it
        // is read back. Not written down as a refusal — there is nobody to
        // refuse — but named, because this is also what Linear's filter not
        // meaning what this thinks it means looks like, and that is a bug
        // worth seeing loudly rather than a race worth hiding. Settled, like
        // an unattributable label, for the same reason.
        over.push(why)
        continue
      }
      const identifier = String(issue.identifier)
      const applied = appliedBy(issue, select.label)
      const requester = applied ? requesterOf(applied) : null
      if (!applied || !requester) {
        // The label is on it and Linear can name nobody for having put it
        // there — or put it there longer ago than the history this read. That
        // selects nothing: a label alone is not authority, and the creator is
        // not a stand-in for whoever labelled it.
        //
        // **Settled rather than deferred**, so the cursor may pass it. The
        // other reading is tempting and is worse: a request this look could
        // not attribute, the next one cannot attribute either, so holding the
        // cursor below it would stall the cursor for good and re-read the
        // whole window every ten minutes for ever. It is not lost in silence
        // either — it is named in the look's own sentence, which is written
        // into the journal with the look.
        unnamed.push(identifier)
        continue
      }
      const candidate = candidateOf(issue, applied, requester, {
        project: ctx.watching.name,
        seenAt,
      })
      found.push({ key: intakeKey(candidate), title: intakeTitle(candidate), intake: candidate })
    }
    return {
      found,
      since: advanceCursor(
        'linear',
        read.map((issue) => revisionOf(issue)),
        held,
        since,
        drained,
      ),
      ...(found.length === 0
        ? {
            said: whyNothing(select, {
              unnamed,
              over,
              more,
              drained,
              limited,
              looked: read.length,
            }),
          }
        : {}),
    }
  },

  // Tade's own words, both of them, and neither can reach the issue: it is not
  // in the type either of them takes. An agent whose prompt carried a
  // stranger's sentences would be an agent taking its instructions from one,
  // whatever heading was put above them.
  agent: (finding) => {
    const candidate = finding.intake as IntakeCandidate
    return { title: intakeTitle(candidate), prompt: intakePrompt(candidate) }
  },

  /**
   * Whether the issue a task was made for is still the issue it was made for,
   * asked at the moment the queue would start it. It may only ever hold.
   *
   * Every clause of the selector is asked again — the team, the bin, the state,
   * the label, and somebody nameable for having applied it — in the same words
   * the look used, because `notSelected` is the one place they are written. The
   * sixth, reassignment, arrives as the revision moving, since anything
   * Linear counts as meaningfully updating an issue moves `updatedAt`.
   *
   * Whether the grant still allows it is **not** asked here: that is
   * `intakeStands`' own first question, read from the config at the moment of
   * starting, and asking it twice in two places is how two answers happen.
   */
  async recheck(finding, ctx) {
    const ref = linearRefOf(finding.key)
    if (!ref) return { still: false, because: `${finding.key} is not an issue this watch found` }
    const team = String(ctx.input.team ?? '').trim()
    const label = String(ctx.input.label ?? '').trim()
    if (!team || !label) {
      // Asked without what it was selected on, this can verify less than the
      // selector did — so it holds rather than checking the rest and answering
      // yes. It may only ever hold, and "I was not told what to check" is the
      // plainest case of that there is.
      return {
        still: false,
        because: `${ref.externalId} cannot be checked without the ${team ? 'label the watch selects on' : 'team the watch reads'}`,
      }
    }
    if (ref.team !== team) {
      // A key naming another team cannot be checked from here, and an
      // unverifiable request holds: this is the one direction that must be got
      // right, because the alternative is starting work on somebody's word.
      return {
        still: false,
        because: `${ref.externalId} is not in ${team}, which is what ${ctx.watching.name} reads`,
      }
    }
    const select = selectorOf(ctx)
    const api = apiFor(ctx)
    let issue: LinearIssue | null
    try {
      issue = await api.issue({
        select: { ...select, number: ref.number },
        history: LINEAR_MOST_HISTORY,
      })
    } catch (err) {
      if (err instanceof LinearError && err.trouble === 'forbidden') {
        // This key can no longer see the team. Nothing was verified, so
        // nothing stands.
        return {
          still: false,
          because: `${ref.externalId} cannot be read any more: ${err.message}`,
        }
      }
      // Everything else throws: a rate limit, a 500 and an outage are not "no
      // longer stands", and the start door turns a throw into a hold that says
      // the source could not be asked.
      throw asLookFailed(err, team)
    }
    if (!issue) {
      // The filter asks for an open, labelled issue in this team, so an empty
      // answer is every one of: deleted, archived, closed, relabelled, moved to
      // another team, or a key that has lost access. Linear cannot tell them
      // apart and neither will this.
      return {
        still: false,
        because: `${ref.externalId} is no longer an open issue in ${team} carrying ${label}, or this key can no longer see it`,
      }
    }
    const why = notSelected(issue, select)
    if (why) return { still: false, because: why }
    const applied = appliedBy(issue, label)
    if (!applied || !requesterOf(applied)) {
      return {
        still: false,
        because: `nobody can be named for the ${label} label on ${ref.externalId} any more`,
      }
    }
    const now = revisionOf(issue)
    const order = newerRevision('linear', now, ref.revision)
    if (order === null) {
      return {
        still: false,
        because: `${ref.externalId}'s revisions cannot be ordered: somebody has to say`,
      }
    }
    // Anything but the same revision holds, in **both** directions: later is a
    // change, and earlier is a source answering something that cannot have
    // happened, which is not a thing to start work on either.
    if (order > 0) {
      return {
        still: false,
        because: `${ref.externalId} has moved since the work was made for ${ref.revision}: it is now ${now}`,
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

  // No `reply`, and that is the guarantee rather than an omission: with no way
  // to write a word into Linear, nothing Tade reads there can be something Tade
  // wrote — and the one thing Linear's own documentation does not say, whether
  // a comment moves `updatedAt`, never has to be answered. A person who turns
  // `surfaces.intake.sources.linear.reply` on is told, in as many words, that
  // this source has no way back.
}

/** Whether a cursor is an instant this source's comparator accepts. */
function revisionIsAnInstant(since: string): boolean {
  return newerRevision('linear', since, since) !== null
}

/** Why a look that could look found nothing to hand over. */
function whyNothing(
  select: { team: string; label: string },
  what: {
    unnamed: readonly string[]
    over: readonly string[]
    more: number
    drained: boolean
    limited: { resetsAt: number } | null
    looked: number
  },
): string {
  const bits = [
    what.looked === 0
      ? `nothing in ${select.team} carrying ${select.label} has moved since the last look`
      : `nothing that moved in ${select.team} carries ${select.label} and was labelled by somebody Linear can name`,
  ]
  if (what.unnamed.length > 0) {
    bits.push(
      // Named rather than passed over, because an unattributable label and a
      // team nobody has labelled in read identically as "found nothing", and
      // the first is somebody waiting for an answer.
      `${what.unnamed.join(', ')} ${what.unnamed.length === 1 ? 'carries' : 'carry'} it and Linear cannot name who applied it, in the last ${LINEAR_MOST_HISTORY} changes to each`,
    )
  }
  if (what.over.length > 0) bits.push(what.over.join('; '))
  if (what.more > 0) {
    bits.push(`${what.more} more than one look hands over are waiting`)
  }
  if (what.limited) {
    bits.push(`Linear rate limited the look${resetIn(what.limited.resetsAt)}`)
  } else if (!what.drained) {
    bits.push('there is more in the team than one look reads')
  }
  return bits.join('; ')
}
