import type { ExtensionContext, ToolAnswer, ToolContext } from '@tade/extensions-core'
import type { Forge, ReviewDetail } from '@tade/forges-core'
import { located, type Where } from './forge.ts'

// Putting a checkout on a review's own branch.
//
// **A review is a branch, and checking one out means that branch.** Done by
// hand the short way, it is `git fetch origin pull/151/head:pr-151` followed by
// `git checkout pr-151` — which leaves the checkout on a local branch called
// `pr-151` that tracks nothing, exists on nobody else's machine, and cannot be
// pushed back to the review. Everything afterwards looks like work on the
// review and is work on a copy of it. That happened: a checkout of #151 landed
// on `pr-151` while the review's own branch, `feat/teapot-service`, already
// existed and had moved on since. So this is a door rather than a sentence in a
// prompt, and the one place a review becomes a local branch.
//
// The rule is one line: **the branch is `head.branch`, the branch the review
// was opened from, and nothing here ever makes a name up.** What it takes to
// get there is three facts, each asked rather than assumed:
//
//   · **Whether that branch is on this remote** (`ls-remote`). It is, for every
//     review opened from the repository itself, and then the branch here tracks
//     `origin/<branch>` — which is what makes `git push` go to the review. A
//     review opened from a fork is the other case: `origin` has never heard of
//     the branch, and its commits can only come from the ref the forge
//     publishes for a head (`Forge.headRef`). A forge that publishes none is a
//     third answer and is said, never guessed around.
//   · **Whether this checkout already has that branch.** Then it is switched to
//     and fast-forwarded — never reset: a commit here the review does not have
//     is somebody's work, and it is reported rather than thrown away.
//   · **Whether there is uncommitted work here at all.** There is no case in
//     which this moves somebody else's, so it refuses first and says so.
//
// Not `gh pr checkout`, which gets the branch right and is the thing to copy.
// Three reasons it is copied rather than called: it is one forge's command and
// branching on which forge this is would be the thing R3 forbids, `gh` is
// optional here (a token in the environment is the whole of what Tade needs),
// and it is a wrapper around the same three facts the port can already answer.
// What is taken from it is the rule, which it has always had right: the local
// branch is the review's head branch.

/** What a checkout of a review is, worked out before anything runs. */
export interface CheckoutPlan {
  /** The branch to be on: the review's own. */
  branch: string
  /** The refspec that brings its commits here, and the ref they land at. */
  fetch: { refspec: string; at: string }
  /** What the branch tracks once it is here; null where there is nothing it can track. */
  tracks: string | null
  /** Why it tracks nothing. Said to whoever is about to try pushing, never implied. */
  why: string | null
}

/**
 * The plan, from the three facts and nothing else: pure, so what Tade would run
 * against somebody's repository is a thing a test can read without a repository.
 */
export function checkoutPlan(
  review: { number: number; branch: string },
  remote: { hasBranch: boolean; headRef: string | null },
): CheckoutPlan | { problem: string } {
  const branch = review.branch
  if (!branch) return { problem: 'the review does not say which branch it was opened from' }
  if (remote.hasBranch) {
    return {
      branch,
      fetch: {
        refspec: `refs/heads/${branch}:refs/remotes/origin/${branch}`,
        at: `origin/${branch}`,
      },
      tracks: `origin/${branch}`,
      why: null,
    }
  }
  if (remote.headRef) {
    return {
      branch,
      // Into `FETCH_HEAD` rather than a ref of Tade's own invention under
      // `refs/`: the commits are wanted, a second name for them is not.
      fetch: { refspec: remote.headRef, at: 'FETCH_HEAD' },
      tracks: null,
      why: `origin has no ${branch}, so the review was opened from a fork and its commits came from ${remote.headRef}. The branch here tracks nothing: pushing a fix to the review means whoever owns that fork, not you.`,
    }
  }
  return {
    problem: `origin has no ${branch} and this forge publishes no ref for a review's head, so there is nothing here to check out. Its commits are in the repository it was opened from.`,
  }
}

/** A checkout that is now on a review's branch, and what it took. */
export interface CheckedOut {
  branch: string
  tracks: string | null
  commit: string
  /** The branch was made here, switched to, or already the one we were on. */
  how: 'made' | 'switched' | 'already on it'
  /** Commits this branch has that the review does not. Kept, never thrown away. */
  ahead: number
  /** Commits the review has that this branch did not take: nought unless it had diverged. */
  behind: number
  /** The sentence somebody reads. */
  said: string
}

/**
 * Put `root` on the review's own branch. Throws with the reason where it cannot,
 * which is how a tool fails.
 */
export async function ontoReview(opts: {
  ctx: ExtensionContext
  root: string
  review: ReviewDetail
  forge: Forge
}): Promise<CheckedOut> {
  const { ctx, root, review, forge } = opts
  const git = (args: readonly string[], timeoutMs = 15_000) =>
    ctx.exec('git', ['-C', root, ...args], { timeoutMs })
  const dirty = await git(['status', '--porcelain=v2'])
  if (dirty.code !== 0) throw new Error(`${root} is not a git checkout: ${firstLine(dirty.stderr)}`)
  if (dirty.stdout.trim() !== '') {
    throw new Error(
      `there is uncommitted work in ${root}, and nothing here is going to move it: commit it or put it aside yourself, then ask again`,
    )
  }
  const branch = review.head.branch
  const heads = await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 30_000)
  // Three answers, never two: the branch is there, the branch is not there, and
  // origin could not be asked — which is not a fork and must never be read as
  // one, or an outage turns into a branch tracking nothing.
  if (heads.code !== 0) {
    throw new Error(`could not ask origin what branches it has: ${firstLine(heads.stderr)}`)
  }
  const plan = checkoutPlan(
    { number: review.ref.number, branch },
    { hasBranch: heads.stdout.trim() !== '', headRef: forge.headRef(review.ref) },
  )
  if ('problem' in plan) throw new Error(plan.problem)
  const fetched = await git(['fetch', 'origin', plan.fetch.refspec], 120_000)
  if (fetched.code !== 0) {
    throw new Error(
      `could not fetch ${plan.fetch.refspec} from origin: ${firstLine(fetched.stderr)}`,
    )
  }
  const had = await git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`])
  const was = (await git(['rev-parse', '--abbrev-ref', 'HEAD'])).stdout.trim()
  let how: CheckedOut['how'] = 'made'
  if (had.code === 0) {
    how = was === branch ? 'already on it' : 'switched'
    if (how === 'switched') {
      // `switch`, never `checkout`: it cannot be handed a path, so it cannot be
      // the command that quietly throws a file away. Its own refusals are the
      // honest ones — a branch another worktree has checked out is one of them.
      const moved = await git(['switch', branch])
      if (moved.code !== 0) {
        throw new Error(`could not get onto ${branch}: ${firstLine(moved.stderr)}`)
      }
    }
    // Fast-forwarded where it can be, and left exactly where it is where it
    // cannot: never `reset`, never a merge commit. What the two counts say is
    // then the whole answer, and they are counted either way rather than read
    // out of whether this succeeded — a branch with an unpushed commit on it
    // fast-forwards fine and is still not what the review has.
    await git(['merge', '--ff-only', plan.fetch.at])
    if (plan.tracks) {
      const set = await git(['branch', `--set-upstream-to=${plan.tracks}`, branch])
      if (set.code !== 0) {
        throw new Error(`${branch} is here but tracks nothing: ${firstLine(set.stderr)}`)
      }
    }
  } else {
    const made = plan.tracks
      ? await git(['switch', '--create', branch, '--track', plan.tracks])
      : await git(['switch', '--create', branch, '--no-track', plan.fetch.at])
    if (made.code !== 0) throw new Error(`could not check out ${branch}: ${firstLine(made.stderr)}`)
  }
  const counted = await git(['rev-list', '--left-right', '--count', `${plan.fetch.at}...HEAD`])
  const [left, right] = counted.stdout.trim().split(/\s+/)
  const behind = Number(left) || 0
  const ahead = Number(right) || 0
  const commit = (await git(['rev-parse', 'HEAD'])).stdout.trim()
  const words = forge.words
  const where = `${words.short} ${words.number(review.ref.number)}'s own branch`
  const lines = [
    `${root} ${how === 'made' ? 'is now' : how === 'switched' ? 'has switched to' : 'was already on'} \`${branch}\` at \`${commit.slice(0, 12)}\` — ${where}, ${plan.tracks ? `tracking \`${plan.tracks}\`` : 'tracking nothing'}.`,
  ]
  if (plan.why) lines.push(plan.why)
  if (ahead > 0 && behind > 0) {
    lines.push(
      `It had diverged: ${count(ahead, 'commit')} here the review does not have, ${behind} on the review that ${behind === 1 ? 'is' : 'are'} not here. Nothing was merged and nothing was moved — read them before you push.`,
    )
  } else if (ahead > 0) {
    lines.push(
      `It has ${count(ahead, 'commit')} on it that the review does not: read them before you push, because they are about to become part of it.`,
    )
  } else if (commit !== review.head.sha) {
    // Not an error: the review was read from a poll, and a head that has moved
    // since is the ordinary case. Said, because it decides what was fetched.
    lines.push(
      `Its head has moved since this was read — \`${commit.slice(0, 12)}\` is what origin has now.`,
    )
  }
  return { branch, tracks: plan.tracks, commit, how, ahead, behind, said: lines.join(' ') }
}

/**
 * Where a checkout of a review happens: the project's own checkout.
 *
 * A task working in a worktree of its own is refused, with the reason. Its
 * branch is how Tade finds the task at all — `status` looks for a `tade/*`
 * branch among a project's worktrees — so putting somebody else's branch in one
 * would not put an agent on the review, it would lose the task. Saying that is
 * better than a switch that works and takes the task with it.
 */
export function rootFor(ctx: ToolContext, where: Where): string {
  const caller = ctx.caller
  if (caller.kind !== 'agent') return where.project.root
  if (caller.cwd === where.project.root) return caller.cwd
  throw new Error(
    `${caller.cwd} is ${caller.task}'s own worktree, and its branch is how Tade finds the task: a review's branch cannot go in it. Work on the review in ${where.project.name}'s own checkout, or say that the fix belongs on the review's branch and stop — a branch of your own pushed here opens a second review rather than fixing this one.`,
  )
}

/** The tool: the one door onto a review's branch. */
export async function checkoutReview(
  input: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolAnswer> {
  const { where, ref } = await located(input, ctx)
  const review = await where.forge.review(ref)
  const root = rootFor(ctx, where)
  const got = await ontoReview({ ctx, root, review, forge: where.forge })
  // Who else it just moved. Agents in a project's own checkout share one branch,
  // so a switch moves the ground under all of them. Said rather than refused:
  // somebody asking for a review's branch in a shared checkout is asking for
  // exactly that, and what they cannot see for themselves is who is in there.
  const mine = ctx.caller.kind === 'agent' ? ctx.caller.task : null
  const others = (ctx.tade?.agents() ?? []).filter(
    (agent) => agent.project === where.project.name && agent.task !== mine,
  )
  const shared =
    others.length === 0
      ? []
      : [
          '',
          `${count(others.length, 'agent')} ${others.length === 1 ? 'is' : 'are'} working in this checkout and ${others.length === 1 ? 'is' : 'are'} now on this branch too: ${others.map((agent) => agent.task).join(', ')}.`,
        ]
  return {
    text: [got.said, ...shared, '', `${review.title} — ${review.url}`].join('\n'),
    said: `On ${where.forge.words.number(ref.number)}'s own branch, ${got.branch}`,
    data: got,
    links: [{ title: review.title, url: review.url }],
  }
}

/** The first line of what git said, which is the half that names the reason. */
function firstLine(stderr: string): string {
  return stderr.trim().split('\n')[0]?.trim() || 'git said nothing'
}

const count = (n: number, thing: string): string => `${n} ${thing}${n === 1 ? '' : 's'}`
