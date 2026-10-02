import type { ExecResult, ExtensionContext, ToolAnswer, ToolContext } from '@tade/extensions-core'
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
//   · **Whether the branch on this remote is the review's** (`originsOwn`). It
//     is, for every review opened from the repository itself, and then the
//     branch here tracks `origin/<branch>` — which is what makes `git push` go
//     to the review. A review opened from a fork is the other case: its commits
//     can only come from the ref the forge publishes for a head
//     (`Forge.headRef`), and a forge that publishes none is a third answer and
//     is said rather than guessed around. The one that must not be taken on the
//     name alone is a fork's branch *called the same as one here* —
//     `someone:main` — which is why the sha is compared and, where it differs,
//     the review's head is looked for in `origin`'s branch before anything is
//     checked out.
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
  remote: { hasBranch: boolean; headRef: string | null; instead?: string | null },
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
  // Two ways for `origin` not to have the review's branch, and they are not the
  // same sentence: it has nothing of that name, or it has something of that name
  // which is not it. Saying the first where the second is true would contradict
  // the very reason this is on the fork path.
  const absent = remote.instead ?? `\`origin\` has no \`${branch}\` at all.`
  if (remote.headRef) {
    return {
      branch,
      // Into `FETCH_HEAD` rather than a ref of Tade's own invention under
      // `refs/`: the commits are wanted, a second name for them is not.
      fetch: { refspec: remote.headRef, at: 'FETCH_HEAD' },
      tracks: null,
      why: `${absent} The review was opened from a fork, so its commits came from \`${remote.headRef}\` and the branch here tracks nothing: pushing a fix to it means whoever owns that fork, not you.`,
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
  const headRef = forge.headRef(review.ref)
  const origins = await originsOwn(git, review, headRef)
  const plan = checkoutPlan({ number: review.ref.number, branch }, { ...origins, headRef })
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
    // A branch of that name here which tracks the remote, where `origin`'s
    // branch of that name is *not* this review's, is this repository's own
    // branch — `main`, against a review opened from a fork's `main`. Switching
    // to it would leave somebody on the project's own code believing they were
    // on the review, which is the whole failure this exists to stop, so it
    // refuses and nothing is moved. One Tade made for a fork's review tracks
    // nothing, which is what tells them apart.
    const upstream = plan.tracks
      ? ''
      : (
          await git(['for-each-ref', '--format=%(upstream:short)', `refs/heads/${branch}`])
        ).stdout.trim()
    if (upstream) {
      throw new Error(
        `\`${branch}\` here tracks \`${upstream}\` and is this repository's own branch, not ${forge.words.short} ${forge.words.number(review.ref.number)}'s: the review was opened from a fork whose branch has the same name. Nothing was moved. Rename or remove yours first if you want the review's under that name.`,
      )
    }
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

type Git = (args: readonly string[], timeoutMs?: number) => Promise<ExecResult>

/**
 * Whether the branch `origin` has under the review's own name is the review's
 * branch — and not somebody else's that happens to be called the same.
 *
 * Three answers, and the third is the one that was nearly missed. The sha
 * `origin` reports **is** the review's head: certainly its branch. There is no
 * branch of that name: a fork, and the published head ref is the way to its
 * commits. The sha is **different**, which is either a review that has moved on
 * since it was polled — the ordinary case, a minute after anybody pushes — or a
 * review opened from a fork whose branch is called the same as one here, which
 * is `someone:main` and is as common as forks get. Those two must not be guessed
 * between: `origin/main` is not that review's branch, and checking it out would
 * put somebody on this repository's own code believing they were on the review.
 * So with a published head ref to go on, both are fetched and the question
 * asked is whether the review's head is in `origin`'s branch at all. With none
 * there is nothing better to go on than the branch itself, and the sentence
 * about a head that has moved is said either way.
 *
 * `ls-remote` failing is neither answer and is never read as a fork: an outage
 * would otherwise come out as a branch tracking nothing.
 */
async function originsOwn(
  git: Git,
  review: ReviewDetail,
  headRef: string | null,
): Promise<{ hasBranch: boolean; instead: string | null }> {
  const branch = review.head.branch
  const heads = await git(['ls-remote', '--heads', 'origin', `refs/heads/${branch}`], 30_000)
  if (heads.code !== 0) {
    throw new Error(`could not ask origin what branches it has: ${firstLine(heads.stderr)}`)
  }
  const sha = heads.stdout.trim().split(/\s+/)[0] ?? ''
  if (!sha) return { hasBranch: false, instead: null }
  if (sha === review.head.sha || !headRef) return { hasBranch: true, instead: null }
  const theirs = await git(
    ['fetch', 'origin', `refs/heads/${branch}:refs/remotes/origin/${branch}`],
    120_000,
  )
  const head = await git(['fetch', 'origin', headRef], 120_000)
  if (theirs.code !== 0 || head.code !== 0) return { hasBranch: true, instead: null }
  const inIt = await git(['merge-base', '--is-ancestor', 'FETCH_HEAD', `origin/${branch}`])
  if (inIt.code === 0) return { hasBranch: true, instead: null }
  return {
    hasBranch: false,
    instead: `\`origin/${branch}\` is a different branch — it does not have this review's head in it, so the review was opened from a fork whose branch has the same name. Nothing pushed to \`origin/${branch}\` would reach the review.`,
  }
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
