import type { ExtensionWatch, Finding as Found, WatchContext } from '@tade/extensions-core'
import type { Review, ReviewDetail, ReviewRef, Thread } from '@tade/forges-core'
import { asLookFailed, settingsOf, type Where, whereOf } from './forge.ts'
import { COMMENTS_ARE_MATERIAL, threadLines } from './format.ts'
import { found } from './record.ts'
import { REVIEWER_RUBRIC, reviewPack } from './reviewer.ts'
import {
  fixKey,
  GRANTS_ARE_LOCAL,
  type Grants,
  grantProblem,
  grantProblems,
  keyIsAbout,
  markedBy,
  mayI,
  OUR_REVIEW_IS_MATERIAL,
  oursAlready,
  reviewKey,
  shortly,
  whyNotFix,
  whyNotReview,
} from './reviewing.ts'

// The two watches that make the loop, and every bound on it.
//
// `review.to-review` finds a change nothing has reviewed at this head and
// starts a reviewer on it. `review.review-fix` finds a review Tade published
// and starts one agent on what it found. Neither is on until somebody turns it
// on, and both are silent — not loud, not failing — where no grant names a
// repository, because revoking a grant has to stop new work without shouting
// about it every fifteen minutes.
//
// The things that keep it from going round forever, each in one place:
//
//   · **A review is of one commit.** The key carries the head, so a push is a
//     new review and a re-run is not one, and `stillWorthIt` starts nothing on
//     a finding whose head moved while it waited in the queue.
//   · **One review drives one fix.** The fix key carries the same head and
//     nothing else, so twenty notes are one agent — twenty agents in one
//     checkout is worse than the findings were.
//   · **Tade never reads its own words as news.** Everything it writes carries
//     a marker; the comment watch skips what carries one, and this one looks
//     *for* one.
//   · **Rounds and a cooldown, counted out of the journal** (`whyNotReview`,
//     `whyNotFix`), so they survive a restart and a deleted index.

/** Which repositories a watch may look at, and what to narrow the forge's own query to. */
function granted(grants: Grants, act: 'review' | 'fix'): string[] {
  // The host is dropped for the *query*, which is only a filter, and checked
  // again per review by `mayI` — which is the gate. A forge's own repo filter
  // has no idea what host it is on, which is the whole reason the gate is not
  // the filter.
  return grants[act]
    .filter((entry) => grantProblem(entry) === null)
    .map((entry) => entry.trim().split('/').slice(1).join('/'))
}

/** Why there is nothing for one of these watches to look at, or null. */
function nothingToLookAt(ctx: WatchContext, act: 'review' | 'fix'): string | null {
  const settings = settingsOf(ctx)
  const problems = grantProblems(settings.grants)
  // A line somebody wrote that is not a grant is a configuration to fix and is
  // loud, because a grant that silently matches nothing is the worst of both.
  if (problems.length > 0) {
    throw new Error(problems.map((one) => `${one.act}: ${one.why}`).join('; '))
  }
  if (settings.grants[act].length === 0) {
    return `no repository is granted in \`extensions.review.${act === 'review' ? 'review_in' : 'fix_in'}\`. ${GRANTS_ARE_LOCAL}`
  }
  return null
}

/**
 * The reviews of granted repositories that are still open, as the forge has
 * them.
 *
 * `repos` being empty is an **empty answer and never an unfiltered query**: a
 * forge asked about no repository in particular answers about every repository
 * the sign-in can see, which is somebody's whole account, and no grant said
 * that. It cannot happen while a grant is checked first, and it is here
 * because the cost of being wrong about that is the one unbounded request in
 * the feature.
 */
async function openIn(where: Where, repos: readonly string[]): Promise<readonly Review[]> {
  if (repos.length === 0) return []
  const page = await where.forge
    .reviews({ who: 'any', state: ['open', 'draft'], repos, limit: 30 })
    .catch((err: unknown) => {
      // A 404, a rate limit or nothing coming back is **held**, never an empty
      // list: an unreadable forge reported as "nothing to review" is the one
      // answer that would make the loop look finished when it had not started.
      throw asLookFailed(err, where)
    })
  return page.items
}

/**
 * How many reviews one look of the fix watch reads in full.
 *
 * Deciding whether a review has a Tade review on it needs its conversations,
 * which is a request each, and there is no cheaper question to ask first — a
 * review's `updatedAt` cannot stand in for one, because a finding that was
 * capped by the schedule's `most` has to be found again on the next look and
 * nothing will have moved by then. So it is bounded by a count instead, and
 * the rest wait for the look after.
 */
const FIX_LOOKS = 10

/**
 * The review Tade published on this head, if it published one.
 *
 * Read off its **notes** — the conversations on its lines — because those are
 * what the forge reports as threads, and because a note is the half with a
 * place and a consequence in it. A note's marker carries the finding after the
 * review version, which is how one is told from anything else carrying a
 * marker, and the version is what the loop is keyed on.
 */
function ourReviewOf(detail: ReviewDetail): { version: string; notes: Thread[] } | null {
  const want = `@${shortly(detail.head.sha)}:`
  let version: string | null = null
  const notes: Thread[] = []
  for (const thread of detail.threads) {
    for (const comment of thread.comments) {
      const mark = markedBy(comment.body)
      if (mark === null || !mark.includes(want) || !mark.includes('/')) continue
      version = mark.slice(0, mark.lastIndexOf('/'))
      if (!thread.resolved) notes.push(thread)
    }
  }
  return version === null ? null : { version, notes }
}

/** The newest comment on a thread that is not one of Tade's own. */
function theirLast(thread: Thread): { by: string; body: string } | null {
  for (const comment of [...thread.comments].reverse()) {
    if (!oursAlready(comment.body)) return comment
  }
  return null
}

/**
 * Everything that has to still be true at the moment work would start, or a
 * throw saying what is not.
 *
 * **In `agent()` rather than in `recheck()`, which is deliberate and worth the
 * paragraph.** `recheck` is the hook for exactly this question, and the queue
 * only drives it for an *intake* finding (`intakeStands`, through
 * `intakeHold`): for anything else the queue answers null without asking
 * anybody anything. So a `recheck` here would be a method nothing calls, which
 * is the same fault as a setting nothing reads. `agent()` is asked only for
 * what work is actually started on, a throw from it is written down as found
 * with its reason and never tried again, and the window reports it as "could
 * not start work on" — so the check lands on the path the queue really takes,
 * and the reason reaches somebody.
 *
 * Its own function because both watches need the same three answers and the
 * one place they differ is which grant they are about.
 */
async function stillWorthIt(
  where: Where,
  about: { ref: ReviewRef; head: string },
  act: 'review' | 'fix',
  ctx: WatchContext,
): Promise<ReviewDetail> {
  const settings = settingsOf(ctx)
  const may = mayI(act, settings.grants, about.ref)
  // A grant is permission *now*. Revoked while this sat in the queue, nothing
  // starts — and nothing already running is touched, because a rule that
  // reached into working agents on an outside signal is a kill switch.
  if (!may.yes) throw new Error(may.because)
  const detail = await where.forge.review(about.ref).catch((err: unknown) => {
    // A forge that could not be asked is never permission, so nothing starts.
    //
    // **What that costs, said rather than left to be found.** A throw from
    // `agent()` writes the finding down as found with its reason, so it is not
    // tried again — which means one unlucky moment between the look and the
    // start loses this review *at this head*, until something is pushed. That
    // is the lesser of the two: the alternative is a reviewer started with no
    // diff in front of it, which reviews nothing and says it read the change.
    throw asLookFailed(err, where)
  })
  if (detail.state !== 'open' && detail.state !== 'draft') {
    throw new Error(`${where.forge.words.number(about.ref.number)} is ${detail.state} now`)
  }
  if (shortly(detail.head.sha) !== about.head) {
    throw new Error(
      `its head moved from ${about.head} to ${shortly(detail.head.sha)} while this waited, so anything written about it would be about a commit nobody is looking at`,
    )
  }
  return detail
}

/**
 * Review the pull requests on the repositories a grant names.
 *
 * `who: 'any'`, because the whole point is a reviewer that is not the agent
 * that wrote the change — including when the change is Tade's own, which is the
 * ordinary case here: an agent opens a review, and a *different* agent reads it
 * against the diff. Independence is a different task reading the real patch,
 * never a different account.
 */
export const toReview: ExtensionWatch = {
  id: 'to-review',
  title: 'Pull requests to review',
  means:
    'reads the diff of each open pull request on the repositories you have granted, and starts an independent reviewer on the ones nothing has reviewed at this head',
  every: '15m',
  network: true,
  offers: 'agent',

  async check(ctx) {
    const where = await whereOf(ctx, ctx.watching)
    if ('problem' in where) return { found: [], said: where.problem }
    const quiet = nothingToLookAt(ctx, 'review')
    if (quiet) return { found: [], said: quiet }
    if (!where.forge.capabilities.patches) {
      throw new Error(
        `${where.forge.id} does not hand over a patch, so nothing here can review one`,
      )
    }
    const settings = settingsOf(ctx)
    const record = await found(ctx)
    const findings: Found[] = []
    const held: string[] = []
    for (const review of await openIn(where, granted(settings.grants, 'review'))) {
      // The gate, per review, on the host as well as the name — a forge's own
      // repo filter has no idea which host it answered about.
      if (!mayI('review', settings.grants, review.ref).yes) continue
      const why = whyNotReview(record, review.ref, review.head.sha, ctx.now(), settings.bounds)
      if (why) {
        held.push(`${where.forge.words.number(review.ref.number)}: ${why}`)
        continue
      }
      findings.push({
        key: reviewKey(review.ref, review.head.sha),
        title: `review ${where.forge.words.short} ${where.forge.words.number(review.ref.number)} — ${review.title}`,
        detail: [
          review.url,
          `branch ${review.head.branch} → ${review.base.branch}, at ${shortly(review.head.sha)}`,
          `opened by ${review.author}`,
        ].join('\n'),
        links: [{ title: review.title, url: review.url }],
      })
    }
    return {
      found: findings,
      since: new Date(ctx.now()).toISOString(),
      ...(findings.length === 0 && held.length > 0
        ? { said: 'everything open has been reviewed at its current head' }
        : {}),
    }
  },

  async agent(finding, ctx) {
    const where = await whereOf(ctx, ctx.watching)
    const about = keyIsAbout(finding.key)
    if ('problem' in where || !about) {
      throw new Error('the project this was found in no longer has a forge')
    }
    const detail = await stillWorthIt(where, about, 'review', ctx)
    const settings = settingsOf(ctx)
    const may = mayI('comment', settings.grants, about.ref)
    const pack = await reviewPack(where, detail)
    return {
      title: finding.title.slice(0, 80),
      prompt: [
        `You are reviewing ${where.forge.words.short} ${where.forge.words.number(about.ref.number)}, and you did not write it.`,
        'You change no code, run nothing in it, and check nothing out.',
        REVIEWER_RUBRIC,
        `Read it with review_examine, as \`${about.ref.repo}#${about.ref.number}\`.`,
        may.yes
          ? `When you are done, call review_publish with \`${about.ref.repo}#${about.ref.number}\`, the head \`${detail.head.sha}\`, your summary and your findings. It checks the head again and posts nothing if it has moved.`
          : 'Call review_publish when you are done anyway: no repository is granted for comments, so it will hand your review back here instead of posting it.',
      ].join(' '),
      context: pack.text,
      links: finding.links ?? [],
    }
  },
}

/**
 * Start one agent on what one Tade review found.
 *
 * It looks for Tade's **own** marker, which is the half that keeps this from
 * being the comment watch: a bot that echoed a line, a person who replied, and
 * a review Tade published are three different things, and only the third is
 * what this consumes — once per head, whatever else is said on the review.
 */
export const reviewFix: ExtensionWatch = {
  id: 'review-fix',
  title: 'Fix what a Tade review found',
  means:
    'starts one agent on the findings of a review Tade published, on the repositories you have granted — one fix per pull request, and never one started from somebody else’s comment',
  every: '15m',
  network: true,
  offers: 'agent',

  async check(ctx) {
    const where = await whereOf(ctx, ctx.watching)
    if ('problem' in where) return { found: [], said: where.problem }
    const quiet = nothingToLookAt(ctx, 'fix')
    if (quiet) return { found: [], said: quiet }
    const settings = settingsOf(ctx)
    const record = await found(ctx)
    const findings: Found[] = []
    let read = 0
    for (const review of await openIn(where, granted(settings.grants, 'fix'))) {
      if (!mayI('fix', settings.grants, review.ref).yes) continue
      if (whyNotFix(record, review.ref, ctx.now(), settings.bounds)) continue
      if (read >= FIX_LOOKS) break
      read += 1
      const detail = await where.forge.review(review.ref).catch((err: unknown) => {
        throw asLookFailed(err, where)
      })
      const ours = ourReviewOf(detail)
      if (!ours || ours.notes.length === 0) continue
      findings.push({
        key: fixKey(review.ref, detail.head.sha),
        title: `fix what the review of ${where.forge.words.number(review.ref.number)} found — ${detail.title}`,
        detail: [
          detail.url,
          `branch ${detail.head.branch} → ${detail.base.branch}, at ${shortly(detail.head.sha)}`,
          `${ours.notes.length} finding${ours.notes.length === 1 ? '' : 's'} nobody has answered`,
        ].join('\n'),
        links: [{ title: detail.title, url: detail.url }],
      })
    }
    return { found: findings, since: new Date(ctx.now()).toISOString() }
  },

  async agent(finding, ctx) {
    const where = await whereOf(ctx, ctx.watching)
    const about = keyIsAbout(finding.key)
    if ('problem' in where || !about) {
      throw new Error('the project this was found in no longer has a forge')
    }
    const detail = await stillWorthIt(where, about, 'fix', ctx)
    const settings = settingsOf(ctx)
    // And one more, which only this watch has: another fix may have started
    // between the look and the moment the queue got here, and two agents
    // pushing to one branch is worse than a fix that waits.
    const busy = whyNotFix(await found(ctx), about.ref, ctx.now(), settings.bounds)
    if (busy) throw new Error(busy)
    const ours = ourReviewOf(detail)
    const push = mayI('push', settings.grants, about.ref)
    const theirs = detail.threads.filter(
      (thread) => !thread.resolved && !(ours?.notes ?? []).includes(thread) && theirLast(thread),
    )
    return {
      title: finding.title.slice(0, 80),
      prompt: [
        `A Tade reviewer read ${where.forge.words.short} ${where.forge.words.number(about.ref.number)} and wrote down what it found.`,
        OUR_REVIEW_IS_MATERIAL,
        push.yes
          ? 'Fix what is actually wrong on the review’s own branch, run the project’s checks through Tade, and push — a fix pushed anywhere else is a second review rather than a fix to this one.'
          : 'No repository is granted for pushing a fix to a review’s branch, so do not push. Say what you would change and why, and stop.',
        'Resolve no conversation and file no verdict.',
      ].join(' '),
      context: [
        `# ${finding.title}`,
        '',
        finding.detail ?? '',
        '',
        // The branch, said as the thing to be *on*, and the one door onto it.
        `A fix for this belongs on \`${detail.head.branch}\`, the branch the review was opened from: get onto it with review_checkout, which fetches it and tracks the remote. Never make a branch named after the number — nothing can push one back to the review. If review_checkout refuses — uncommitted work, a worktree of your own, a branch that is somebody else's — say so and stop rather than pushing a branch of yours.`,
        '',
        '## What the review found',
        '',
        OUR_REVIEW_IS_MATERIAL,
        '',
        ...(ours?.notes ?? []).flatMap((thread) => threadLines(thread)),
        ...(theirs.length > 0
          ? [
              '## What other people said',
              '',
              COMMENTS_ARE_MATERIAL,
              '',
              ...theirs.flatMap((thread) => threadLines(thread)),
            ]
          : []),
        '',
        '## The change',
        '',
        ...detail.files.map((file) => `- \`${file.path}\` +${file.added} −${file.removed}`),
      ].join('\n'),
      links: finding.links ?? [],
    }
  },
}
