import { type CheckRun, settled } from '@tade/checks-core'
import type { ExtensionContext, ProjectRef } from '@tade/extensions-core'
import { ForgeError, hostOf } from '@tade/forges-core'
import { type Where, whereOf } from './forge.ts'
import {
  commitUnknownTo,
  couldNotReach,
  credentialRefused,
  gitWouldNotSay,
  nothingPushedYet,
} from './format.ts'

// What CI says about a commit that is sitting in a checkout here — and every
// honest reason it says nothing.
//
// **A commit that is not on the remote is not a failure: it is CI that has not
// run yet.** A forge can only answer about work it has been given, so asking
// one about a commit that exists on this machine and nowhere else is a question
// with no true answer — and the answer it does give is a 404, which every
// reader above took for a look that went wrong. That is how `✗ Failing CI on
// the branch you are on could not look: github.com refused: No commit found for
// SHA: ce7b55f` came to be said about a repository where nothing at all was
// wrong, once per look, with a new sha in it every time somebody committed so
// that even saying it once could not hold.
//
// So git is asked first, and this is the **one** place that asks: every
// commit-addressed question about a forge goes through `ciOn`, and the only
// answer that carries a forge with it is `red` — the one case there is anything
// further to do about. A caller cannot reach past it to ask a forge about a
// commit whose sha only this machine has ever seen, because it is never handed
// the forge to ask with.
//
// The cases are told apart the way `problemWith` tells a process probe's apart
// (`packages/status/src/processes.ts`): not one answer but each of the real
// ones, because "could not look" and "nothing is wrong" are opposite facts and
// collapsing them is what makes a watch cry wolf all day.

/** Where the project's own checkout stands: the branch, its commit, and that commit's subject. */
export interface Standing {
  branch: string
  commit: string
  subject: string
}

/**
 * The branch a project is on, and the commit it is on. Null where there is no
 * branch to watch — a detached worktree, or a directory git knows nothing
 * about. Never throws: a project Tade cannot read git in is not a look that
 * went wrong.
 */
export async function standingOn(ctx: ExtensionContext, root: string): Promise<Standing | null> {
  const branch = (await git(ctx, root, ['rev-parse', '--abbrev-ref', 'HEAD'])).out
  // `HEAD` is what git answers for a detached worktree, which is what an
  // agent's own workspace looks like before its first commit: nobody's
  // branch, and nothing anybody could have pushed.
  if (!branch || branch === 'HEAD') return null
  const said = await git(ctx, root, ['log', '-1', '--format=%H%n%s'])
  const [commit, ...rest] = said.out.split('\n')
  if (!commit) return null
  return { branch, commit, subject: rest.join(' ').trim() }
}

/** Whether a commit here is on `origin`, as the refs this checkout holds have it. */
export interface Pushed {
  /** A ref of `origin` here has this commit. */
  on: boolean
  /** `origin/<branch>` exists at all, which is a different sentence from being behind it. */
  branchThere: boolean
  /** Why git would not say. Null when it said. */
  problem: string | null
}

/**
 * Whether a commit is on the remote, asked of this checkout's own refs.
 *
 * `rev-list -1 <commit> --not --remotes=origin` prints the commit when no ref
 * of `origin` reaches it and nothing when one does — one walk, no network, and
 * no fetch: a watch that looked at somebody's remote every ten minutes would be
 * spending their quota to answer a question git already knows.
 *
 * What that costs is a push made from another machine and not fetched here,
 * which reads as "not pushed" until something fetches. That is why the sentence
 * a person is given names the checkout's refs as where it looked rather than
 * claiming the push never happened.
 */
export async function onRemote(
  ctx: ExtensionContext,
  root: string,
  here: Standing,
): Promise<Pushed> {
  const asked = await git(ctx, root, ['rev-list', '-1', here.commit, '--not', '--remotes=origin'])
  if (!asked.ok) return { on: false, branchThere: false, problem: asked.said }
  if (asked.out === '') return { on: true, branchThere: true, problem: null }
  const branch = await git(ctx, root, [
    'rev-parse',
    '--verify',
    '--quiet',
    `refs/remotes/origin/${here.branch}`,
  ])
  return { on: false, branchThere: branch.ok && branch.out !== '', problem: null }
}

/** What CI said about a commit, once it has finished saying it. Pure: the rule, with nothing asked. */
export type Ran =
  /** Something failed and everything has settled. The only answer worth acting on. */
  | { kind: 'red'; runs: readonly CheckRun[] }
  | { kind: 'passed' }
  | { kind: 'running' }
  | { kind: 'nothing ran' }

/**
 * What CI can say about one commit of a checkout here, and every honest reason
 * it cannot.
 *
 * `red` is the only answer anybody acts on, and the only one carrying the forge
 * it was got from. Of the rest, four are quiet facts about a branch nothing is
 * wrong with — `passed`, `running`, `nothing ran`, `not pushed` — and the ones
 * with a `said` that `cannotLook` names are a look that went wrong, which is
 * said once and not every ten minutes for as long as it stays wrong. Two of
 * those are told apart by whether anything came back — `unreachable` and
 * `would not answer` — because only the first could be this machine having no
 * network, and a forge answering a 500 must never read as one.
 */
export type CommitCi =
  | { kind: 'red'; runs: readonly CheckRun[]; where: Where }
  | { kind: 'passed' }
  | { kind: 'running' }
  | { kind: 'nothing ran' }
  /** It is here and nowhere else yet. Nothing has run on it because nothing could. */
  | { kind: 'not pushed'; said: string }
  /** No remote, or no forge that serves the one there is: a decision, not a fault. */
  | { kind: 'no forge'; said: string }
  /** The forge would not say who we are. */
  | { kind: 'no credential'; said: string }
  /**
   * Nothing came back at all. The one answer that may be about this machine
   * rather than about that host, so it is the one that names the host: the
   * scheduler's reach asks about it before anything concludes anything.
   */
  | { kind: 'unreachable'; host: string; said: string }
  /** It answered, and the answer was trouble: a 5xx, a rate limit, something it did not explain. */
  | { kind: 'would not answer'; said: string }
  /** A ref of origin here has it and the forge has never heard of it. */
  | { kind: 'unknown commit'; said: string }
  /** Nobody here could answer: git refused, or this forge cannot answer about a commit. */
  | { kind: 'cannot tell'; said: string }

/** The answers that are a look that went wrong rather than a fact about the branch. */
const CANNOT_LOOK = [
  'no credential',
  'unreachable',
  'would not answer',
  'unknown commit',
  'cannot tell',
] as const satisfies readonly CommitCi['kind'][]

/** One of those, which always has a sentence: it is the only thing it has to give. */
export type CannotLook = Extract<CommitCi, { kind: (typeof CANNOT_LOOK)[number] }>

/**
 * Whether an answer is a look that went wrong. These are the ones worth a
 * person's attention and the only ones that become a watch's `problem`; the
 * rest are facts about a branch that nothing is wrong with.
 */
export function cannotLook(ci: CommitCi): ci is CannotLook {
  return (CANNOT_LOOK as readonly string[]).includes(ci.kind)
}

/** What this answer would tell a person, or null where there is nothing worth saying. */
export function saidOf(ci: CommitCi): string | null {
  return 'said' in ci ? ci.said : null
}

/**
 * What ran, once it has finished running.
 *
 * Nothing having run, something still running and everything passing are three
 * different facts and none of them is a failure — acting while a run is still
 * going is how an agent gets started on a check that a retry was about to turn
 * green.
 */
export function whatRan(runs: readonly CheckRun[]): Ran {
  if (runs.length === 0) return { kind: 'nothing ran' }
  if (runs.some((run) => !settled(run.state))) return { kind: 'running' }
  const failed = runs.filter((run) => run.state === 'failed' || run.state === 'timed out')
  return failed.length > 0 ? { kind: 'red', runs: failed } : { kind: 'passed' }
}

/**
 * What CI says about the commit a checkout is on: git first, the forge only
 * about a commit git says it has.
 *
 * The one reader. Anything that would ask a forge about a commit read out of a
 * checkout asks this instead, and gets the forge back only in the one answer
 * that has something to do with it.
 */
export async function ciOn(
  ctx: ExtensionContext,
  project: ProjectRef,
  here: Standing,
): Promise<CommitCi> {
  const where = await whereOf(ctx, project)
  // A project with no remote is one Tade only reads git from, and somebody
  // decided that on purpose: a standing watch says nothing about it rather
  // than complaining about it every ten minutes.
  if ('problem' in where) return { kind: 'no forge', said: where.problem }
  if (!where.forge.capabilities.commitChecks) {
    return {
      kind: 'cannot tell',
      said: `${where.forge.id} cannot say what ran on a commit with no review`,
    }
  }
  const pushed = await onRemote(ctx, project.root, here)
  if (pushed.problem) {
    return { kind: 'cannot tell', said: gitWouldNotSay(here.commit, pushed.problem) }
  }
  if (!pushed.on) {
    return { kind: 'not pushed', said: nothingPushedYet(here.branch, pushed.branchThere) }
  }
  try {
    const ran = whatRan(await where.forge.checksOn(where.repo, here.commit))
    return ran.kind === 'red' ? { ...ran, where } : ran
  } catch (err) {
    return trouble(err, where, here)
  }
}

/** What a forge refusing to answer about a commit means, told apart by what it declared. */
function trouble(err: unknown, where: Where, here: Standing): CommitCi {
  const host = hostOf(where.remote) ?? where.forge.id
  const said = err instanceof Error ? err.message : String(err)
  if (err instanceof ForgeError) {
    if (err.trouble === 'auth') {
      return { kind: 'no credential', said: credentialRefused(where.repo, said) }
    }
    // Pushed, and the forge has never heard of it. Not "not pushed" — git says
    // it is there — so the thing to look at is whether this is the repository
    // that branch goes to at all: a fork, a mirror, a second remote.
    if (err.trouble === 'missing') {
      return { kind: 'unknown commit', said: commitUnknownTo(host, where.repo, here.commit) }
    }
    // Nothing came back at all, which is the only trouble here that could be
    // about this machine rather than about that host. It is still only a
    // *could*: what decides is the scheduler's reach, which asks about this
    // host before it concludes anything, so a forge having a bad afternoon
    // never reads as an outage.
    if (err.trouble === 'network') {
      return { kind: 'unreachable', host, said: couldNotReach(host, said) }
    }
  }
  return { kind: 'would not answer', said: couldNotReach(host, said) }
}

/** Git, with its answer trimmed and its failure kept. Never throws: a failure is a sentence. */
async function git(
  ctx: ExtensionContext,
  root: string,
  args: readonly string[],
): Promise<{ ok: boolean; out: string; said: string }> {
  const ran = await ctx.exec('git', ['-C', root, ...args], { timeoutMs: 10_000 })
  return {
    ok: ran.code === 0,
    out: ran.stdout.trim(),
    said: ran.stderr.trim().split('\n')[0] ?? `git exited ${ran.code}`,
  }
}
