import { type IntakeCandidate, type IntakeRequester, intakeHash, newerRevision } from '@tade/core'
import type { LinearBot, LinearChange, LinearIssue, LinearUser } from './linear-api.ts'

// What a Linear issue is, read as an envelope — and nothing that asks Linear
// anything.
//
// Its own file because it is the half that is pure: issues in, an envelope out,
// no network, no clock read, no key. That is what makes the selector and the
// provenance rule testable without a Linear at all, and it is the half where
// every decision that could authorise the wrong person lives.
//
// ## What selects an issue, and every clause is a decision
//
// 1. **The team somebody typed.** A required input, read back off the issue
//    rather than trusted from the filter, so a key that is read as something
//    else by Linear's comparator cannot widen what this takes in. There is no
//    "every team": a watch that could be turned on without one would be a
//    workspace nobody chose to read.
// 2. **The label, which must be said.** Required input, no default. "Any issue
//    in the team" is not an option this offers, and a watch that has to be told
//    something cannot be turned on by a wizard or by pressing enter.
// 3. **It is not over and not in the bin.** The filter asks Linear for issues
//    whose state type is not `completed`, `canceled` or `duplicate`; `trashed`
//    is read here because Linear's `IssueFilter` has no clause for it.
// 4. **Somebody can be named for having applied that label**, read from the
//    issue's own history, where Linear documents `actor` as *"The actor that
//    performed the actions"*. A label nobody can be named for selects nothing.
//
// ## Assignment is not a selector, and that is a decision rather than an omission
//
// Linear's `IssueFilter` will happily select on `assignee`, and it was looked
// at. Three reasons it is not here, and the third is the one that settles it:
//
// - **Assigning says who should do it, not who asked.** A triager assigns
//   things all morning; the act that asks Tade for the work is the one somebody
//   does *on purpose, to ask*, and the whole safety argument of this door is
//   that `from` is the list of people whose such act counts.
// - **It would need its own provenance question** — who assigned it, out of the
//   same bounded history — so it is a second selector with a second set of
//   ways to attribute the wrong person, for no case the label does not cover.
// - **Assigning Tade in Linear *is* the realtime path.** An agent there is "a
//   workspace user that can be @mentioned, assigned issues as a delegate", and
//   that path is deferred for reasons about a laptop being awake. Selecting on
//   assignment would be the half-built version of exactly that: the gesture
//   people would read as "Tade is answering" answered, if at all, ten minutes
//   later. A deferral that quietly supports the gesture is worse than no
//   support, so there is no `assignee` input and no route to one.
//
// **The person who applied the label is the requester**, and that is the whole
// of why this is safe to have at all: applying the label is the act that asks
// Tade for the work, and the *creator* of an issue is whoever could open a
// browser. So `from` in the owner's grant is the list of ids whose *labelling*
// counts, `intakeDecision` reads that list, and the creator is carried as
// identification into the context file and is never anywhere a rule looks.
//
// **By user id and never by display name.** Linear documents a display name as
// *"Must be unique within the workspace"* — which makes it worse than Slack's,
// not better: a name its owner gives up can be **taken** by somebody else, and
// a grant written against one would follow it to whoever took it. An id cannot
// be taken over. The look names the ids it saw, because an allowlist of opaque
// ids nobody can find is an allowlist nobody fills in.
//
// **Nothing about the requester's permissions in Linear is read.** Being an
// admin is not permission and being able to label is not permission. The
// owner's grant authorises; Linear's answer about who somebody is only
// identifies them.
//
// ## Loops, and what actually bounds them
//
// Two things, and only the second is a guarantee:
//
// - **An app's labelling is refused by actor** — Linear's own `User.app` and
//   its `botActor`, read as `requester.bot`, which `intakeDecision` refuses as
//   `is_bot`. Never by looking for Tade's words in the text, which is defeated
//   the first time somebody quotes Tade back at it.
// - **There is no way back.** The watch implements no `reply`, so Tade cannot
//   write a word into a Linear workspace, so nothing it reads there can be
//   something it wrote. That is enforced by absence rather than by a flag,
//   which is the stronger of the two and the reason the first one does not have
//   to be perfect.

/** The label this suggests, and nothing defaults to it: it has to be said. */
export const SUGGESTED_LABEL = 'tade'

/** The state types that mean an issue is over, as Linear's own schema names them. */
const OVER = new Set(['completed', 'canceled', 'duplicate'])

/** `linear:ENG-412:2026-10-09T08:00:00.000Z`, pulled apart again. */
export function linearRefOf(
  key: string,
): { externalId: string; team: string; number: number; revision: string } | null {
  // By the first colon only, never `split(':')`: a Linear revision is an ISO
  // timestamp with two colons of its own, so splitting on every colon gives
  // back the hour as a revision.
  if (!key.startsWith('linear:')) return null
  const rest = key.slice('linear:'.length)
  const at = rest.indexOf(':')
  if (at <= 0) return null
  const externalId = rest.slice(0, at)
  const revision = rest.slice(at + 1)
  const ref = identifierOf(externalId)
  return ref && revision ? { ...ref, externalId, revision } : null
}

/**
 * `ENG-412` as a team key and a number, or null where it is not one.
 *
 * Split on the **last** dash, because Linear documents the key only as "the
 * team's unique key, used as a prefix in issue identifiers" and says nothing
 * about what may be in one — while the number is digits and cannot hold a dash.
 * Splitting on the first would read `MY-TEAM-7` as team `MY`.
 */
export function identifierOf(identifier: string): { team: string; number: number } | null {
  const at = identifier.lastIndexOf('-')
  if (at <= 0) return null
  const team = identifier.slice(0, at)
  const digits = identifier.slice(at + 1)
  if (!/^\d+$/.test(digits)) return null
  const number = Number(digits)
  return Number.isSafeInteger(number) ? { team, number } : null
}

/**
 * Whether one issue is one this watch would take in, said as a sentence or
 * null when it would.
 *
 * A sentence rather than a boolean because every one of these is read again at
 * the moment of starting, and `recheck` may only ever hold — so the thing it
 * owes a person is *which* of these stopped it, in the same words both times.
 *
 * The team and the label are checked **here** rather than trusted from the
 * filter that asked for them: the filter is a question Linear answered a moment
 * ago, and these are the two clauses the whole selector is about.
 */
export function notSelected(
  issue: LinearIssue,
  select: { team: string; label: string },
): string | null {
  const identifier = issue.identifier ?? ''
  if (!identifier || !identifierOf(identifier)) {
    return 'Linear did not give it an identifier of the ENG-412 shape'
  }
  if ((issue.team?.key ?? '') !== select.team) {
    return `${identifier} is in ${issue.team?.key || 'no team Linear named'}, not ${select.team}`
  }
  if (issue.trashed === true) return `${identifier} is in the bin`
  const state = issue.state?.type ?? ''
  if (OVER.has(state)) return `${identifier} is ${state}`
  if (!labelled(issue, select.label)) {
    return `the ${select.label} label is not on ${identifier}`
  }
  if (!revisionOf(issue)) {
    return `Linear did not say when ${identifier} last moved, so there is no revision to take`
  }
  return null
}

/** Whether the label the watch selects on is on the issue, as Linear answered. */
function labelled(issue: LinearIssue, label: string): boolean {
  return (issue.labels?.nodes ?? []).some((one) => one?.name === label)
}

/**
 * Who applied that label, most recently, or null where Linear can name nobody.
 *
 * **Sorted here and never trusted from Linear's order.** Linear's schema offers
 * `orderBy: createdAt | updatedAt` on a history connection and documents no
 * *direction* for either, so which end a bounded read comes from is not
 * something to build on: what came back is ordered by `createdAt` in code, and
 * the newest application wins.
 *
 * **What a bounded read of history costs is a label it cannot attribute**, not
 * a wrong answer: an application older than the slice this read is simply not
 * there, `applied` is null, and the issue selects nothing and is named in the
 * look. That is the safe direction — the alternative, reading an unattributable
 * label as somebody's, authorises whoever is first on the owner's list.
 */
export function appliedBy(issue: LinearIssue, label: string): LinearChange | null {
  const changes = (issue.history?.nodes ?? []).filter((change) =>
    (change?.addedLabels ?? []).some((one) => one?.name === label),
  )
  let newest: LinearChange | null = null
  for (const change of changes) {
    const at = Date.parse(change.createdAt ?? '')
    if (!Number.isFinite(at)) continue
    const was = Date.parse(newest?.createdAt ?? '')
    if (!newest || !Number.isFinite(was) || at > was) newest = change
  }
  return newest
}

/**
 * Who Linear says did something, or null where it says nobody.
 *
 * **Three cases, not two.** A `User` is a person or an app user and carries
 * Linear's own `app` flag; a `botActor` is an integration or an automation,
 * which Linear's schema says is exactly when `actor` is empty — and naming it
 * is better than leaving it unnamed, because a refusal written down is what
 * makes somebody automating their way onto this machine *visible*, while an
 * unnamed one writes nothing at all. Neither is null: null is only when Linear
 * named nobody, which is the one case with no authorisation question to ask.
 *
 * A bot's id is its own, its name, or its kind, in that order — whichever
 * Linear gave. It reaches `requester.id` and is compared against nothing: the
 * bot check runs **before** the allowlist in `intakeDecision`, so a bot that
 * named itself after somebody on the list is refused as a bot either way.
 */
export function requesterOf(
  who: { actor?: LinearUser | null; botActor?: LinearBot | null } | null,
): IntakeRequester | null {
  const actor = who?.actor
  if (actor?.id) {
    return {
      id: actor.id,
      // Shown and never parsed, so a person reading the inbox has something
      // other than a UUID — and so the look can say which id a name belongs to.
      label: shown(actor.displayName),
      bot: actor.app === true,
    }
  }
  const bot = who?.botActor
  const id = bot ? bot.id || bot.name || bot.type || '' : ''
  if (!id) return null
  return { id, label: shown(bot?.name), bot: true }
}

/**
 * A name somebody else chose, made safe to put on one line.
 *
 * **`requester.label` is the one piece of external text that reaches a line
 * Tade writes in its own voice** — `intakeContext`'s "Asked by @id (name)",
 * above the fence and above the heading saying what is material. Everything
 * else from a source goes *inside* the fence, where it reads as theirs.
 *
 * Linear is the first source to put a free-form name there: a GitHub login has
 * no whitespace in it and the Slack door leaves this empty, so a newline in it
 * has not been possible before. A newline is a heading, and a heading there is
 * a stranger's sentence in Tade's voice — so whitespace is collapsed and the
 * result is cut. Not an escaping rule and not a sanitiser for anything else:
 * one field, one line, and the rest of the request is already fenced.
 */
function shown(name: string | null | undefined): string {
  return (name ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
}

/**
 * Which version of the request this is: when Linear says the issue last moved.
 *
 * Linear's own `updatedAt`, which its schema documents as *"the last time at
 * which the entity was meaningfully updated"* and nothing more — so **whether a
 * comment moves it is not documented and nothing here guesses**. It is read in
 * the direction this is allowed to be wrong in: a revision that moved holds the
 * work and a person looks, and the hash written down beside it says whether the
 * words themselves actually moved.
 *
 * Empty where Linear gave something that is not an instant, which selects
 * nothing — the one thing a revision may never be is "probably fine".
 */
export function revisionOf(issue: LinearIssue): string {
  const at = issue.updatedAt ?? ''
  return newerRevision('linear', at, at) === null ? '' : at
}

/**
 * The request, verbatim: Linear's two text fields and not a word of Tade's.
 *
 * It goes in the context file under the material heading and nowhere else, and
 * it is the exact text the hash is of.
 */
export function verbatimOf(issue: LinearIssue): string {
  return `${issue.title ?? ''}\n\n${issue.description ?? ''}`.trimEnd()
}

/**
 * One issue as the envelope a watch hands over: no grant, no template, no
 * project of its own choosing, and nothing downloaded.
 *
 * **No attachments, ever**, for the reason the GitHub door has none and one of
 * its own. A file somebody dropped into a Linear issue is a link in the
 * description, and it is already in the body where it reads as theirs; what
 * Linear *calls* an attachment is something else again — a pull request, a
 * Slack thread, a support ticket an integration linked — and lifting those out
 * would put a third party's title and URL into a line Tade writes in its own
 * voice, which is the one place external text must never reach.
 */
export function candidateOf(
  issue: LinearIssue,
  applied: LinearChange,
  requester: IntakeRequester,
  where: { project: string; seenAt: string },
): IntakeCandidate {
  const externalId = issue.identifier ?? ''
  const revision = revisionOf(issue)
  const verbatim = verbatimOf(issue)
  const creator = issue.creator?.id ?? ''
  return {
    source: 'linear',
    externalId,
    revision,
    url: issue.url ?? '',
    // The person who applied the label, because applying it is the act that
    // asked. The creator goes in `label`, which is shown and never parsed, so
    // that the context file says whose words these are as well as whose ask it
    // is — and so the two are never confusable by a reader either.
    //
    // **Through `shown` and never interpolated raw**, which is the same rule as
    // `requesterOf`'s and the same reason: this whole string is a sentence Tade
    // wrote, and the only part of it somebody else chose is a name.
    requester: {
      ...requester,
      label:
        creator && creator !== requester.id
          ? `labelled it${applied.createdAt ? ` at ${applied.createdAt}` : ''}; ${shown(issue.creator?.displayName) || shown(creator)} filed it`
          : requester.label,
    },
    // What this door called where it came from. The owner's own list is what
    // decides whether that may become work, which is `intakeMapped`'s.
    from: where.project,
    verbatim,
    // Where the exact bytes are, as a person can open them, and a hash of what
    // was read — which is how "the text has moved since you approved it" is a
    // comparison rather than a guess.
    material: { ref: issue.url || externalId, hash: intakeHash(verbatim) },
    attachments: [],
    sourceAt: revision,
    seenAt: where.seenAt,
    // One id per delivery of one revision, so every line about it — the
    // received, the accepted, the retry — carries the same one.
    correlation: `${externalId}@${revision}`,
  }
}
