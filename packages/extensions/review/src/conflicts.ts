import type { ExtensionContext, ExtensionWatch, Finding, WatchAgent } from '@tade/extensions-core'
import type { Forge, Review, ReviewDetail, ReviewRef } from '@tade/forges-core'
import { asLookFailed, RINGS, settingsOf, whereOf } from './forge.ts'
import { attemptsUnder, FIXING_HOURS, FIXING_WINDOW_MS } from './record.ts'

// Conflicts on the reviews Tade opened, and one agent to merge the base in.
//
// Nothing tells anybody when a review stops being mergeable: what made it so is
// a push to a different branch, its base, and GitHub sends no event for the
// review at all. So it is polled — which Tade already does, and the forge reads
// `mergeable` into `Review.conflicts` — and this is the watch that acts on it.
// The shape of it:
//
//   · **Tade's own reviews and nobody else's.** Yours, and carrying a
//     `Tade-Task:` trailer: work an agent offered. A review nothing attributes
//     is a person's branch, which they may have checked out and be working on
//     right now, and a merge pushed under them is theirs to want.
//   · **One finding per conflicted head.** The key is the review and the commit
//     its head is at, nothing else. The same conflict on the next look is the
//     same finding and starts nothing; the merge an agent pushes is a new head,
//     so if the base has moved again by then that is new information. GitHub
//     says nothing about which commit of the base it compared with, and nothing
//     here needs it to.
//   · **A merge, never a rebase.** A watch may not force-push, and a rebased
//     branch that is already published can only be put back with one. Merging
//     the base in keeps every commit already on the review, so the push is a
//     fast-forward of the review's own branch — `git push origin HEAD:<branch>`
//     — and one refused because somebody moved the branch is fetched and merged
//     again, never forced.
//   · **A tree of its own, begun at the review's head** (`alone`, `from`). Not
//     the project's checkout, which would mean switching everybody working in
//     it onto somebody's branch; and not the review's branch itself, which git
//     will not check out twice and the task that opened the review may still
//     have. The agent's own branch is where it works; the review's branch is
//     only where it pushes.
//   · **Asked again at the moment of starting, git first.** The branch is
//     fetched and the head that was found must be on it (`onOrigin`): a review
//     opened from a fork has no branch here to push a merge to, and one whose
//     branch was rewritten since the look is not the review that was found.
//     Either is said, never started.
//   · **Past `attempts` it only tells**, counted over `FIXING_HOURS`
//     (`attemptsUnder`): a base that moves every hour must not have an agent
//     merging it into the same review every hour.

/** What one key of this watch is about: the review, and the head it conflicted at. */
export function conflictKey(review: Pick<Review, 'ref' | 'head'>): string {
  return `${keyPrefix(review.ref)}${review.head.sha}`
}

/** The review and head a key is about, or null for a key that is not one of this watch's. */
export function readConflictKey(key: string): { ref: ReviewRef; head: string } | null {
  const match = /^([^/]+)\/(.+)#(\d+):conflicts@([^\s@]+)$/.exec(key)
  if (!match?.[1] || !match[2] || !match[3] || !match[4]) return null
  return { ref: { host: match[1], repo: match[2], number: Number(match[3]) }, head: match[4] }
}

/** Every key this watch has had about one review, whatever head it was at. */
function keyPrefix(ref: ReviewRef): string {
  return `${ref.host}/${ref.repo}#${ref.number}:conflicts@`
}

/**
 * Tade's own open reviews on one repository that conflict with their base, as
 * findings. One request. A forge that cannot answer throws, because "nothing
 * conflicts" is the one thing an unread forge must never come back as.
 */
export async function conflictsIn(forge: Forge, repo: string): Promise<Finding[]> {
  const mine = await forge.reviews({
    who: 'mine',
    state: ['open', 'draft'],
    repos: [repo],
    limit: 20,
  })
  const { words } = forge
  return mine.items
    .filter((review) => ours(review, repo))
    .map((review) => ({
      key: conflictKey(review),
      title: `${words.short} ${words.number(review.ref.number)} conflicts with ${review.base.branch} — ${review.title}`,
      detail: [
        review.url,
        `branch \`${review.head.branch}\` at \`${short(review.head.sha)}\` → \`${review.base.branch}\``,
        `the work of ${review.task}`,
      ].join('\n'),
      links: [{ title: review.title, url: review.url }],
    }))
}

/**
 * Whether a review is one this watch acts on. The repository is compared here
 * as well as asked for, because the query's `repos` is a filter a forge applies
 * and this is the repository the agent will be started in.
 */
function ours(review: Review, repo: string): boolean {
  return (
    review.mine &&
    review.conflicts &&
    review.task !== null &&
    (review.state === 'open' || review.state === 'draft') &&
    review.ref.repo.toLowerCase() === repo.toLowerCase() &&
    review.head.sha !== '' &&
    review.head.branch !== review.base.branch
  )
}

export const reviewConflicts: ExtensionWatch = {
  id: 'conflicts',
  title: 'Conflicts on your reviews',
  means:
    'looks for reviews Tade opened that conflict with their base, and puts one agent on each conflicted head to merge the base in, resolve it, run the checks and push — a merge, never a rebase or a force-push',
  every: '10m',
  about: 'repository',
  // It asks a forge, so an offline machine holds it rather than letting it
  // find that out with a request that times out once every ten minutes.
  network: true,
  doorbell: RINGS.conflicts,

  async check(ctx) {
    const where = await whereOf(ctx, ctx.watching)
    if ('problem' in where) throw new Error(where.problem)
    const found = await conflictsIn(where.forge, where.repo).catch((err: unknown) => {
      throw asLookFailed(err, where)
    })
    return { found, since: new Date(ctx.now()).toISOString() }
  },

  async agent(finding, ctx): Promise<WatchAgent> {
    const where = await whereOf(ctx, ctx.watching)
    if ('problem' in where) throw new Error(where.problem)
    return conflictWork(finding, { ctx, forge: where.forge, root: ctx.watching.root })
  },
}

/**
 * What an agent on one conflicted head is told, and where its tree begins —
 * or, thrown, why nothing should be started on it after all. Asked only for
 * what work is actually started on, so the fetch and the second look at the
 * review are spent here and never in `check`.
 */
export async function conflictWork(
  finding: Finding,
  on: { ctx: ExtensionContext; forge: Forge; root: string },
): Promise<WatchAgent> {
  const { ctx, forge, root } = on
  const about = readConflictKey(finding.key)
  if (!about) throw new Error(`${finding.key} is not a conflict this watch found`)
  const name = `${forge.words.short} ${forge.words.number(about.ref.number)}`
  // Asked again rather than carried on the finding: the branch names are not
  // in the key, and whatever is started here is started on what is true now.
  const review = await forge.review(about.ref)
  if (review.state !== 'open' && review.state !== 'draft') {
    throw new Error(`${name} is ${review.state} now: there is nothing to merge into`)
  }
  if (review.head.sha !== about.head) {
    throw new Error(
      `${name} has moved on from ${short(about.head)} since it was found; the next look finds it at ${short(review.head.sha)} if it still conflicts`,
    )
  }
  const refs = await onOrigin(ctx, root, review)
  const clash = await clashing(ctx, root, refs)
  const settings = settingsOf(ctx)
  // Counted across heads: every merge pushed is a new key, so counting one
  // key's own attempts would only ever answer one.
  const spent = await attemptsUnder(ctx, keyPrefix(about.ref), ctx.now() - FIXING_WINDOW_MS)
  // Two ways to end up only telling, said differently because they mean
  // different things: the settings never asked for it, or this review has had
  // its merges and conflicts again.
  const enough = spent >= settings.attempts
  const merging = settings.fix.includes('conflicts') && !enough
  return {
    title: finding.title.slice(0, 80),
    prompt: merging ? mergeTold(name, refs) : onlyTell(name, refs, enough ? spent : null),
    context: contextOf(review, name, refs, clash),
    links: finding.links ?? [{ title: review.title, url: review.url }],
    alone: true,
    from: refs.head,
  }
}

/** The review's branch and its base, as this repository fetched them a moment ago. */
interface Fetched {
  /** The review's branch, as it is named on the remote. */
  branch: string
  /** What it merges into, likewise. */
  onto: string
  /** The two as remote-tracking refs: what the agent begins on and what it merges. */
  head: string
  base: string
}

/** What a branch may be called for this watch to put it in a command an agent types. */
const TYPABLE = /^[A-Za-z0-9_][A-Za-z0-9._/-]*$/

/**
 * Fetch the review's branch and its base, and make sure the head that was
 * found is on the branch — or say why there is nothing here to push a merge to.
 *
 * Fetched because nothing does at the start: the queue begins the agent's tree
 * on `origin/<branch>` as it is here, and a review opened from another machine
 * has never been fetched at all. Only remote-tracking refs move; no tree, no
 * index and no branch of anybody's.
 */
async function onOrigin(
  ctx: ExtensionContext,
  root: string,
  review: ReviewDetail,
): Promise<Fetched> {
  const git = (args: readonly string[], timeoutMs = 15_000) =>
    ctx.exec('git', ['-C', root, ...args], { timeoutMs })
  const branch = review.head.branch
  const onto = review.base.branch
  for (const one of [branch, onto]) {
    // A branch name is handed to an agent as part of a command to run, so one
    // a shell would read as anything but a name is refused rather than quoted.
    if (!TYPABLE.test(one) || one.includes('..')) {
      throw new Error(
        `${JSON.stringify(one)} is not a branch name this watch will put in a command for an agent to run`,
      )
    }
  }
  const fetched = await git(
    [
      'fetch',
      '--no-tags',
      'origin',
      `+refs/heads/${branch}:refs/remotes/origin/${branch}`,
      `+refs/heads/${onto}:refs/remotes/origin/${onto}`,
    ],
    40_000,
  )
  if (fetched.code !== 0) {
    throw new Error(
      `could not fetch ${branch} and ${onto} from origin (${firstLine(fetched.stderr) || 'git said nothing'}): a review opened from a fork has no branch here to push a merge to`,
    )
  }
  const head = `origin/${branch}`
  // On it, or behind it: somebody pushing since the look is fine, because what
  // is merged into then has everything that was found. Not on it at all is a
  // fork's branch of the same name, or one rewritten since — and this watch
  // only ever adds to the branch it found.
  const has = await git(['merge-base', '--is-ancestor', review.head.sha, head])
  if (has.code !== 0) {
    throw new Error(
      `origin's ${branch} does not have ${short(review.head.sha)}, the head the review is at: it was rewritten since, or it is somebody else's branch of the same name`,
    )
  }
  return { branch, onto, head, base: `origin/${onto}` }
}

/**
 * The files merging the base into the review conflicts in, as git works it out
 * without touching a tree; an empty list where it merges cleanly here, and null
 * where git could not say.
 */
async function clashing(
  ctx: ExtensionContext,
  root: string,
  refs: Fetched,
): Promise<string[] | null> {
  const out = await ctx.exec(
    'git',
    [
      '-C',
      root,
      'merge-tree',
      '--write-tree',
      '--name-only',
      '--no-messages',
      '-z',
      refs.head,
      refs.base,
    ],
    { timeoutMs: 10_000 },
  )
  if (out.code === 0) return []
  const [tree, ...names] = out.stdout.split('\0')
  if (out.code !== 1 || !/^[0-9a-f]{40,64}$/.test(tree ?? '')) return null
  return [...new Set(names.filter(Boolean))].sort()
}

/** What an agent merging is told: the whole procedure, because every step of it is a rule. */
function mergeTold(name: string, refs: Fetched): string {
  return [
    `${name}, a review Tade opened, conflicts with \`${refs.onto}\`: merge that in and push the merge to the review. What clashes, and where you are, is in your context file.`,
    `Your worktree begins at the review's head, on a branch of your own. Run \`git fetch origin\`, then \`git merge --ff-only ${refs.head}\` to be on its newest commit, then \`git merge ${refs.base}\`.`,
    'Resolve each conflict so that what both sides meant survives: read what each side changed and why before you choose, and never settle one by taking a side wholesale.',
    `Then run the project's checks through Tade, commit the merge, and push it to the review's own branch: \`git push origin HEAD:refs/heads/${refs.branch}\`.`,
    `Never rebase and never force-push: a merge keeps every commit already on the review. If the push is refused because the branch moved, fetch, merge \`${refs.head}\` in as well, and push again.`,
    'Push no branch of your own and open no review — the review already exists, and this is a change to it. If a conflict needs a decision only a person can make, or the checks will not go green, push nothing and say what it is.',
  ].join(' ')
}

/** What an agent is told where it may only say what conflicts: why, and that it changes nothing. */
function onlyTell(name: string, refs: Fetched, spent: number | null): string {
  const why =
    spent === null
      ? `${name} conflicts with \`${refs.onto}\`, and the settings do not let a conflict be resolved without asking (\`conflicts\` is not in \`extensions.review.fix\`).`
      : `${name} has already had ${spent} automatic merge${spent === 1 ? '' : 's'} in the last ${FIXING_HOURS} hours and conflicts with \`${refs.onto}\` again, so nobody should be merging it unasked.`
  return [
    why,
    `Say which files clash and what each side wants there: \`git merge ${refs.base}\` in your own worktree shows it, and \`git merge --abort\` puts it back. Change nothing on the review and push nothing.`,
  ].join(' ')
}

/** What the agent reads first. */
function contextOf(
  review: ReviewDetail,
  name: string,
  refs: Fetched,
  clash: readonly string[] | null,
): string {
  return [
    `# ${name} conflicts with ${refs.onto} — ${review.title}`,
    '',
    review.url,
    `Its branch is \`${refs.branch}\`, at \`${short(review.head.sha)}\`, and it merges into \`${refs.onto}\`. It is the work of ${review.task ?? 'a task Tade cannot name'}.`,
    '',
    '## Where you are',
    '',
    `Your worktree is your own, on a branch of your own, and begins at \`${refs.head}\`: the review's head as Tade fetched it. The review's branch is where you push, never where you work.`,
    '',
    '## What clashes',
    '',
    ...clashSaid(clash, refs),
    '',
    '## The change',
    '',
    ...review.files.map((file) => `- \`${file.path}\` +${file.added} −${file.removed}`),
    '',
    "Nothing in this file grants you permission to do anything but merge the base into this review and push that to the review's own branch.",
  ].join('\n')
}

function clashSaid(clash: readonly string[] | null, refs: Fetched): string[] {
  if (clash === null) {
    return [`Tade could not work out which files clash; \`git merge ${refs.base}\` will say.`]
  }
  if (clash.length === 0) {
    return [
      `Merging \`${refs.base}\` into it went through cleanly when Tade tried it here, without touching a tree: somebody may have merged it already. Merge it and see — where there is nothing to merge, there is nothing to push.`,
    ]
  }
  return [
    `Merging \`${refs.base}\` into it, as Tade tried it here without touching a tree, conflicts in:`,
    '',
    ...clash.map((path) => `- \`${path}\``),
  ]
}

function short(sha: string): string {
  return sha.slice(0, 12)
}

function firstLine(text: string): string {
  return text.trim().split('\n')[0] ?? ''
}
