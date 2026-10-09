import { createHash } from 'node:crypto'
import {
  type IntakeCandidate,
  intakeKey,
  intakePrompt,
  intakeTitle,
  newerRevision,
} from '@tade/core'
import type { ExtensionWatch, WatchContext } from '@tade/extensions-core'
import { object, string, Unreachable } from '@tade/extensions-core'
import { ForgeError, type Labelling, type TicketRef } from '@tade/forges-core'
import { type ForgePlace, forgeAt } from '@tade/status'

// GitHub issues, as work that arrives from outside this machine.
//
// **It is an ordinary watch and there is no second anything.** A look on a
// clock, findings with keys, and then the grant, the rule, the queue and the
// approval every other source goes through. What is here is only the three
// things a connector has to answer for itself: what selects an issue, who the
// source says asked, and whether one still stands.
//
// ## What selects an issue, and every clause is a decision
//
// 1. **The project's own repository**, read from its checkout's `origin`
//    (`forgeAt`). There is no `repository` input and there must never be one:
//    a watch that could be told which repository to read is a watch somebody
//    can point at a repository the owner never mapped. The mapping is the
//    checkout plus `surfaces.intake.sources.github.projects`, both local, and
//    neither is anything a request can reach.
// 2. **The label, which must be said.** Required input, no default, and a
//    watch cannot be turned on without one — which is also why nothing turns
//    this on by itself: there is nothing for a wizard to supply. "Any issue"
//    is not an option this offers.
// 3. **The issue is open**, and GitHub says it moved at or after the moment
//    the watch was turned on: what was already there is not news.
// 4. **It is an issue and not a pull request**, which is the forge's filter
//    (`forges/github/tickets.ts`) and GitHub's own documented warning.
// 5. **Somebody can be named for having applied that label**, read from the
//    issue's events, where GitHub documents `actor` as "The person who
//    generated the event". A label nobody can be named for selects nothing.
//
// **The person who applied the label is the requester**, and that is the whole
// of why this is safe to have at all: applying the label is the act that asks
// Tade for the work, and the author of an issue is whoever could open a browser.
// So `from` in the owner's grant is the list of logins whose *labelling*
// counts, `intakeDecision` reads that list, and the author is carried as
// identification into the context file and is never anywhere a rule looks.
// Reading the author as the labeller is the one mistake here that would
// authorise the wrong person, and the two are different people in the ordinary
// case.
//
// **Nothing about the sender's own permissions is read.** A collaborator with
// write access is not thereby allowed to start agents on somebody else's
// laptop with somebody else's subscription. The owner's list authorises, and
// GitHub's answer about who somebody is only identifies them.
//
// ## Loops, and what actually bounds them
//
// Two things, and only the second is a guarantee:
//
// - **An app's labelling is refused by actor** — `requester.bot` is GitHub's
//   own word about the actor, and `intakeDecision` refuses it as `is_bot`.
//   Never by looking for Tade's words in the text, which is defeated the first
//   time somebody quotes Tade back at it.
// - **There is no way back.** This watch implements no `reply`, so Tade cannot
//   write a word into GitHub, so nothing it reads can be something it wrote.
//   That is enforced by absence rather than by a flag, which is the stronger
//   of the two and the reason the first one does not have to be perfect.
//
// What is left is honest and is why `propose` is the default forever: an agent
// runs as you and could label an issue itself, and then a person is looking at
// a proposal rather than at a loop. `most: 1` is the other half.
//
// ## What a poll costs
//
// One conditional request. GitHub's own words: "Making a conditional request
// does not count against your primary rate limit if a `304` response is
// returned" — so a repository where nothing moved costs nothing, and the
// issue's events are read only for what a changed list actually turned up.
// That is the difference between ~6 requests an hour and a few hundred.

/** The label this suggests, and nothing defaults to it: it has to be said. */
export const SUGGESTED_LABEL = 'tade'

/**
 * How many of one changed list's issues are read in full.
 *
 * A detail read per issue is the cost of knowing who applied a label, so a
 * repository where somebody has labelled two hundred issues must not turn one
 * look into two hundred requests.
 *
 * It is the head of a page the port answers **newest movement first**, which is
 * the half that matters: what somebody labelled a minute ago is what this is
 * for, and a bounded read of an oldest-first page is the one shape in which
 * that is the thing it never sees. A backlog deeper than this is named in the
 * look rather than quietly skipped.
 */
export const MOST_READ = 20

/** What the watch is turned on with. The label is required, which is the whole of the opt-in. */
const INPUT = object(
  {
    label: string(
      `the label an issue must carry to be taken in — "${SUGGESTED_LABEL}" is the suggestion. Required: there is no "any issue", and a watch that could be turned on without one would be a repository nobody chose to read`,
    ),
  },
  ['label'],
)

/** `github:acme/api#501:2026-09-19T08:00:00Z`, pulled apart again. */
export function refOf(key: string): { externalId: string; revision: string } | null {
  // By index and never `split(':')`: a GitHub revision is an ISO timestamp and
  // has two colons of its own, so splitting gives back the hour as a revision.
  const first = key.indexOf(':')
  const second = key.indexOf(':', first + 1)
  if (first < 0 || second < 0) return null
  const externalId = key.slice(first + 1, second)
  const revision = key.slice(second + 1)
  return externalId && revision ? { externalId, revision } : null
}

/** `acme/api#501` as a repository and a number. Null where it is not one. */
function ticketRef(externalId: string, host: string): TicketRef | null {
  const found = /^([^/\s]+\/[^#\s]+)#(\d+)$/.exec(externalId)
  return found?.[1] && found[2] ? { repo: found[1], number: Number(found[2]), host } : null
}

/**
 * The forge this project's work goes to, ready to be asked about issues.
 *
 * The *same* resolver the reviews use (`forgeAt`, in `@tade/status`) and
 * nothing of the review extension's: whose sign-in reaches a repository is the
 * remote's own declaration, read once, in one place. Nothing here reads which
 * account `gh` is currently signed in as and nothing changes it — a second
 * account's repository says so in its remote, which is what an SSH host alias
 * already is.
 */
async function forgeFor(ctx: WatchContext): Promise<ForgePlace> {
  const place = await forgeAt(ctx.watching.root, {
    exec: ctx.exec,
    fetch: ctx.fetch,
    // The environment as it is, which is where the forge finds a token. No
    // credential of intake's own, so there is no second place to paste one and
    // nothing here to leak: `gh auth token` and $GITHUB_TOKEN, exactly as the
    // reviews already read them.
    env: ctx.env,
    now: ctx.now,
  })
  if ('problem' in place) {
    throw new Error(
      `${ctx.watching.name} has no GitHub repository to read issues from: ${place.problem}`,
    )
  }
  if (!place.forge.capabilities.tickets) {
    throw new Error(
      `${place.repo} is served by ${place.forge.id}, which cannot be asked about issues`,
    )
  }
  return place
}

/**
 * A failed look as the scheduler's reach can read it: nothing having come back
 * is `Unreachable` and names the host, and everything GitHub actually answered
 * — a 401, a 404, a rate limit, a 500 — stays what it was. One endpoint being
 * down is never the machine being offline.
 *
 * The same three lines the review extension's `asLookFailed` is, written again
 * rather than imported: `Unreachable` is the extension port's and `ForgeError`
 * is the forge's, and the one place both are in scope is a watch.
 */
function asLookFailed(err: unknown, place: ForgePlace): unknown {
  return err instanceof ForgeError && err.trouble === 'network'
    ? new Unreachable(place.host, err.message)
    : err
}

/** The validator carried across looks in the one thing Tade keeps for a watch. */
const VALIDATOR = 'etag:'

export const githubIssues: ExtensionWatch = {
  id: 'github',
  title: 'Issues somebody labelled for Tade',
  means:
    'takes in each open issue in this project’s own repository that carries the label you name, where somebody on the list in surfaces.intake applied that label — as far as that grant allows it',
  // Ten minutes. GitHub allows 5,000 requests an hour on a personal token and
  // an unchanged list costs none of them, so this is about how soon somebody
  // wants an answer rather than about a budget.
  every: '10m',
  intake: 'github',
  network: true,
  // One a look. The schedule's two is a ceiling on agents started, and this
  // one starts work on somebody else's words: four proposals from one poll is
  // four things a person has to read before they can do anything about any.
  most: 1,
  input: INPUT,

  async check(ctx) {
    const label = String(ctx.input.label ?? '').trim()
    if (!label) {
      throw new Error(
        'intake.github needs the label an issue must carry: turn it on with label, and there is no "any issue"',
      )
    }
    const place = await forgeFor(ctx)
    const seenAt = new Date(ctx.now()).toISOString()
    const was = ctx.since?.startsWith(VALIDATOR) ? ctx.since.slice(VALIDATOR.length) : null
    let page: Awaited<ReturnType<typeof place.forge.tickets>>
    try {
      page = await place.forge.tickets({
        repo: place.repo,
        labels: [label],
        state: 'open',
        // What was already labelled when the watch was turned on is not news,
        // and the moment it was turned on is the one fixed point there is —
        // which also keeps the question identical between looks, which is what
        // makes the conditional request match.
        since: ctx.turnedOn,
        limit: 100,
        ...(was ? { validator: was } : {}),
      })
    } catch (err) {
      throw asLookFailed(err, place)
    }
    const since = page.validator ? `${VALIDATOR}${page.validator}` : (ctx.since ?? undefined)
    if (page.unchanged) {
      // Nothing was read because nothing moved — not because nothing is there.
      // Reading those two as one would make every look after the first say the
      // repository was empty.
      return { found: [], ...(since ? { since } : {}), said: standing(place) }
    }
    const found: { key: string; title: string; intake: IntakeCandidate }[] = []
    const unnamed: string[] = []
    for (const listed of page.items.slice(0, MOST_READ)) {
      let whole: Awaited<ReturnType<typeof place.forge.ticket>>
      try {
        whole = await place.forge.ticket(listed.ref)
      } catch (err) {
        // One issue that could not be read is not a look that could not look:
        // something that is gone between the list and the detail is the
        // ordinary race, and the rest of the list is still an honest answer.
        if (err instanceof ForgeError && err.trouble === 'missing') continue
        throw asLookFailed(err, place)
      }
      // Read again from the detail rather than trusted from the list: the list
      // is a snapshot of a moment that has already passed, and these are the
      // three things the selector is actually about.
      if (whole.state !== 'open') continue
      if (!whole.labels.includes(label)) continue
      const applied = newest(whole.labelled, label)
      if (!applied) {
        // The label is on it and GitHub cannot name anybody for having put it
        // there. That selects nothing: a label alone is not authority, and the
        // author is not a stand-in for whoever labelled it.
        unnamed.push(`#${whole.ref.number}`)
        continue
      }
      const candidate = candidateOf(whole, applied, { project: ctx.watching.name, seenAt })
      found.push({
        key: intakeKey(candidate),
        title: intakeTitle(candidate),
        intake: candidate,
      })
    }
    const more = Math.max(0, page.items.length - MOST_READ)
    return {
      found,
      ...(since ? { since } : {}),
      // A sentence only about a look that found nothing: what was found says
      // what it is itself. `page.more` is carried separately from the count
      // because a list that was itself cut short makes the count a floor, and
      // a floor said as a total is the sort of number somebody plans against.
      ...(found.length === 0
        ? { said: whyNothing(place, label, { unnamed, more, cutShort: page.more }) }
        : {}),
    }
  },

  // Tade's own words, both of them, and neither can reach the body: it is not
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
   * Four of the five answers are read off the issue itself. The fifth —
   * reassigned — arrives as the revision moving, because assigning, labelling,
   * unlabelling, editing and commenting all move GitHub's `updated_at`; there
   * is no record of who it was assigned to when the work was made, and
   * inventing one would be a second thing to keep in sync. So an edit, a
   * relabelling by somebody else, an assignment and a comment all come back as
   * "this is not the revision the work was made for", which holds.
   *
   * Whether the grant still allows it is **not** asked here: that is
   * `intakeStands`' own first question, read from the config at the moment of
   * starting, and asking it twice in two places is how two answers happen.
   */
  async recheck(finding, ctx) {
    const label = String(ctx.input.label ?? '').trim()
    const ref = refOf(finding.key)
    if (!ref) return { still: false, because: `${finding.key} is not an issue this watch found` }
    const place = await forgeFor(ctx)
    const at = ticketRef(ref.externalId, place.host)
    if (!at) return { still: false, because: `${ref.externalId} is not an owner/repo#number` }
    if (at.repo !== place.repo) {
      // A key naming another repository cannot be checked from here, and an
      // unverifiable request holds: this is the one direction that must be got
      // right, because the alternative is starting work on somebody's word.
      return {
        still: false,
        because: `${ref.externalId} is not in ${place.repo}, which is what ${ctx.watching.name} reads`,
      }
    }
    let whole: Awaited<ReturnType<typeof place.forge.ticket>>
    try {
      whole = await place.forge.ticket(at)
    } catch (err) {
      if (err instanceof ForgeError && err.trouble === 'missing') {
        // Gone, or this account can no longer see it — GitHub answers the same
        // 404 for both, and both hold. Nothing was verified, so nothing stands.
        return {
          still: false,
          because: `${ref.externalId} is not there to read any more, or this sign-in can no longer see it`,
        }
      }
      // Everything else throws: a rate limit, a 500 and an outage are not "no
      // longer stands", and the start door turns a throw into a hold that says
      // the source could not be asked.
      throw asLookFailed(err, place)
    }
    if (whole.state !== 'open') {
      return { still: false, because: `${ref.externalId} was closed` }
    }
    if (label && !whole.labels.includes(label)) {
      return { still: false, because: `the ${label} label has been taken off ${ref.externalId}` }
    }
    if (label && !newest(whole.labelled, label)) {
      return {
        still: false,
        because: `nobody can be named for the ${label} label on ${ref.externalId} any more`,
      }
    }
    const order = newerRevision('github', whole.updatedAt, ref.revision)
    if (order === null) {
      return {
        still: false,
        because: `${ref.externalId}'s revisions cannot be ordered: somebody has to say`,
      }
    }
    if (order > 0) {
      return {
        still: false,
        because: `${ref.externalId} has moved since the work was made for ${ref.revision}: it is now ${whole.updatedAt}`,
      }
    }
    return { still: true }
  },

  // No `reply`, and that is the guarantee rather than an omission: with no way
  // to write a word into GitHub, nothing Tade reads there can be something
  // Tade wrote. A person who turns `surfaces.intake.sources.github.reply` on
  // is told, in as many words, that this source has no way back.
}

/** The newest application of one label, or null where nobody can be named for it. */
function newest(labelled: readonly Labelling[], label: string): Labelling | null {
  return (
    [...labelled]
      .filter((one) => one.label === label)
      .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))[0] ?? null
  )
}

/**
 * One issue as the envelope a watch hands over: no grant, no template, no
 * project of its own choosing, and nothing downloaded.
 *
 * **No attachments, ever.** A GitHub issue has no attachment list: what looks
 * like one is a link somebody wrote in the body, and it is already in the body
 * where it reads as theirs. Lifting those out would put a stranger's filename
 * and a stranger's URL into a line Tade writes in its own voice, which is the
 * one place external text must never reach.
 */
function candidateOf(
  whole: {
    ref: TicketRef
    title: string
    body: string
    url: string
    author: { login: string; bot: boolean }
    updatedAt: string
  },
  applied: Labelling,
  where: { project: string; seenAt: string },
): IntakeCandidate {
  const externalId = `${whole.ref.repo}#${whole.ref.number}`
  return {
    source: 'github',
    externalId,
    // GitHub's own `updated_at`, which is what "this version of it" means
    // here. Compared by `newerRevision('github', …)` and never as a string.
    revision: whole.updatedAt,
    url: whole.url,
    // The person who applied the label, because applying it is the act that
    // asked. `bot` is GitHub's word about that actor and the loop filter reads
    // it; the author goes in `label`, which is shown and never parsed, so that
    // the context file says whose words these are as well as whose ask it is.
    requester: {
      id: applied.by.login,
      label:
        applied.by.login === whole.author.login
          ? ''
          : `labelled it; @${whole.author.login} filed it`,
      bot: applied.by.bot,
    },
    from: where.project,
    // THE REQUEST, VERBATIM: GitHub's two text fields and not a word of
    // Tade's. It goes in the context file under the material heading and
    // nowhere else.
    verbatim: `${whole.title}\n\n${whole.body}`.trimEnd(),
    // Where the exact bytes are, as a person can open them, and a hash of what
    // was read — which is how "the text has moved since you approved it" is a
    // comparison rather than a guess.
    material: { ref: whole.url || externalId, hash: bodyHash(whole) },
    attachments: [],
    sourceAt: whole.updatedAt,
    seenAt: where.seenAt,
    // One id per delivery of one revision, so every line about it — the
    // received, the accepted, the retry — carries the same one.
    correlation: `${externalId}@${whole.updatedAt}`,
  }
}

/**
 * sha256 of what was read, so a later look can see the words have moved.
 *
 * Of the same text that goes in `verbatim`, and written the same way as the
 * local door's (`spool.ts`): what a hash of a request means must not depend on
 * which source handed it over, because `intakeAgain` compares the two.
 */
function bodyHash(whole: { title: string; body: string }): string {
  const text = `${whole.title}\n\n${whole.body}`.trimEnd()
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`
}

/** What is true while nothing moves, worded as a standing fact rather than as a count. */
function standing(place: ForgePlace): string {
  return `nothing has moved in ${place.repo} since the last look`
}

/** Why a look that could look found nothing to hand over. */
function whyNothing(
  place: ForgePlace,
  label: string,
  what: { unnamed: readonly string[]; more: number; cutShort: boolean },
): string {
  const bits = [`no open issue in ${place.repo} carries ${label} and was labelled by a person`]
  if (what.unnamed.length > 0) {
    bits.push(
      `${what.unnamed.join(', ')} ${what.unnamed.length === 1 ? 'carries' : 'carry'} it and GitHub cannot name who applied it`,
    )
  }
  if (what.more > 0 || what.cutShort) {
    bits.push(`${what.cutShort ? 'at least ' : ''}${what.more} more carried it than one look reads`)
  }
  return bits.join('; ')
}
