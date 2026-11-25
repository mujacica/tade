import type { ProjectConfig } from './config.ts'

// Keeping one repository in step on several machines: when a branch moves on
// origin or on another machine of the person's, this machine fast-forwards its
// own copy of it — and only ever fast-forwards, and only when nobody's
// uncommitted work is in the way.
//
// **Each machine moves only its own checkout**, from origin and from its
// mirror of the others (`elsewhere.ts`); nothing ever writes into another
// machine's checkout. A machine that cannot be dialled is handed this one's
// commits into *its* mirror — a bare repository in its Tade home — and moves
// its own checkout by these same rules.
//
// **The six rules**, each refusal naming its reason:
//   1. the target is the source that has every other source's commits: origin's
//      branch or a machine's, whichever contains the others; two that have
//      parted are no target at all;
//   2. fast-forward only: a branch here with commits the target lacks has
//      diverged, and a shared checkout is never merged or rebased — the merge
//      is proposed, worked in a worktree of its own;
//   3. nobody is mid-commit: no `index.lock`, nothing staged — wait, and look
//      again;
//   4. nothing the target changes is uncommitted here — modified, staged,
//      untracked, or a file on disk git does not track where the target adds
//      one — and a refusal names every such path;
//   5. no checks run on the tree: the run lock is held across the move (the
//      window's, `wire/project-sync.ts`);
//   6. `git merge --ff-only` to the commit, never `git pull`, written down as
//      `project_synced`, and every agent working in that checkout told.
//
// A branch no worktree has checked out moves by its ref alone, which
// disturbs nobody: rules 1 and 2 are the whole of it.
//
// Pure: facts in, a verdict and its sentences out. The git is status's
// `sync.ts`, the lock, the journal and the telling are the window's.

/** What `projects.<name>.sync` may say. */
export const PROJECT_SYNC = ['ff', 'origin', 'ask', 'off'] as const
export type ProjectSync = (typeof PROJECT_SYNC)[number]

/**
 * What a project that says nothing does: the person asked for projects kept in
 * step, so origin's branch moves this checkout by itself — but a commit only
 * another machine has waits for the person. Origin is where branch protection
 * and review live; a machine's mirror is whatever that machine committed, and
 * fast-forwarding to it unasked would hand a compromised box (or an agent
 * injected there) this machine's commit hook and test runs. `ff` is the
 * person's to choose.
 */
export const SYNC_BY_DEFAULT: ProjectSync = 'origin'

/** Each answer, as the Settings row and the tool say it. */
export const SYNC_MEANS =
  "ff: fast-forwarded by itself whenever every safety rule passes, to origin's or another machine's branch, and a merge proposed when the branches have parted; origin: the same, but a commit only another machine has is asked about, like ask; ask: the orchestrator is told it could move and moves it when you say so; off: never moved"

/** How a project keeps its branch in step: its own answer, or the default. */
export function syncFor(
  projects: Readonly<Record<string, Pick<ProjectConfig, 'sync'> | undefined>>,
  project: string,
): ProjectSync {
  return projects[project]?.sync ?? SYNC_BY_DEFAULT
}

/** What origin is called among the sources: never a machine's name (`mirrorMachine`). */
export const ORIGIN = 'origin'

/** One place a branch's next commits may come from: origin, or another machine by its name here. */
export interface SyncSource {
  from: string
  sha: string
}

/** Whether `older` is `newer` or one of its ancestors: git's answer, asked before the rules run. */
export type Contains = (older: string, newer: string) => boolean

/** What the branch is to move to. */
export type SyncTarget =
  | { kind: 'none'; why: string }
  | { kind: 'apart'; a: SyncSource; b: SyncSource }
  | { kind: 'one'; sha: string; from: readonly string[] }

/**
 * Rule 1: the source with every other source's commits, among those with
 * anything this branch has not got. Two that have parted are no target, and
 * which two is said.
 */
export function targetOf(
  head: string,
  sources: readonly SyncSource[],
  contains: Contains,
): SyncTarget {
  const news = sources.filter((one) => !contains(one.sha, head))
  if (news.length === 0) {
    return {
      kind: 'none',
      why:
        sources.length === 0
          ? 'neither origin nor another machine has this branch'
          : `it has everything ${joinedNames(sources.map((one) => one.from))} has`,
    }
  }
  for (const one of news) {
    if (news.every((other) => contains(other.sha, one.sha))) {
      const from = news.filter((other) => other.sha === one.sha).map((other) => other.from)
      return { kind: 'one', sha: one.sha, from }
    }
  }
  for (const a of news) {
    const b = news.find((other) => !contains(other.sha, a.sha) && !contains(a.sha, other.sha))
    if (b) return { kind: 'apart', a, b }
  }
  // Unreachable with a real ancestry, which is a partial order; said rather than thrown.
  return { kind: 'none', why: 'git gave no order between its sources' }
}

/** Where the branch is checked out on this machine. */
export type CheckedOut =
  | { kind: 'checkout'; dir: string }
  | { kind: 'worktree'; dir: string; task: string | null }
  | { kind: 'nowhere' }

/** What one look found, for the rules to read. */
export interface SyncFacts {
  project: string
  /** The branch kept in step: the checkout's, or the base where the checkout is on none. Null: neither. */
  branch: string | null
  at: CheckedOut
  /** The commit the branch is on here. */
  head: string | null
  target: SyncTarget
  /** Rule 2: the branch here is the target or one of its ancestors. */
  forward: boolean
  /** Commits here the target lacks, and commits the target has that are not here. */
  ahead: number
  behind: number
  /** What moving would change: each path, and whether the target adds it. */
  incoming: readonly { path: string; added: boolean }[]
  /** Every uncommitted path in the checkout: modified, staged, untracked, unmerged. */
  dirty: readonly string[]
  /** What is staged there now. */
  staged: readonly string[]
  /** Paths the target adds that are on disk here and git does not track — untracked or ignored. */
  inTheWay: readonly string[]
  /** Somebody holds the checkout's `index.lock`. */
  committing: boolean
}

/** What the rules decided. */
export type SyncVerdict =
  /** Nothing to do, and why. */
  | { kind: 'still'; why: string }
  /** Not now: look again soon. */
  | { kind: 'wait'; why: string }
  /** Never while it stands: uncommitted work is in the way, every path named. */
  | { kind: 'refused'; why: string; paths: readonly string[] }
  /** The sources have parted from each other, so there is nothing to fast-forward to. */
  | { kind: 'apart'; why: string }
  /** The branch here and the target have parted: a merge, proposed, never made here. */
  | {
      kind: 'diverged'
      why: string
      target: string
      from: readonly string[]
      ahead: number
      behind: number
    }
  /** It would move, and the project says to ask first. */
  | { kind: 'ask'; why: string; target: string; from: readonly string[]; behind: number }
  /** Move it: by its ref where nothing has it checked out, else a fast-forward in the checkout. */
  | { kind: 'move'; target: string; from: readonly string[]; behind: number; byRef: boolean }

/** How many paths one refusal names before the rest are counted. */
export const PATHS_NAMED = 20

/**
 * The rules over one look. `mode` is the project's answer — or `ff` where the
 * person asked for it now.
 */
export function syncVerdict(facts: SyncFacts, mode: ProjectSync): SyncVerdict {
  const { project, branch } = facts
  if (mode === 'off') return { kind: 'still', why: `projects.${project}.sync is off` }
  if (branch === null || facts.head === null) {
    return {
      kind: 'still',
      why: `${project}'s checkout is on no branch, and it has no base branch`,
    }
  }
  if (facts.at.kind === 'worktree') {
    const whose = facts.at.task ? `${facts.at.task}'s worktree` : facts.at.dir
    return {
      kind: 'still',
      why: `${branch} is checked out in ${whose}, which is not Tade's to move`,
    }
  }
  const target = facts.target
  if (target.kind === 'none') return { kind: 'still', why: `${branch} is in step: ${target.why}` }
  if (target.kind === 'apart') {
    return {
      kind: 'apart',
      why: `${sourceSays(target.a.from, branch)} and ${sourceSays(target.b.from, branch)} have parted — neither has the other's commits — so there is nothing to fast-forward ${branch} to; the machine whose own branch parted proposes the merge there`,
    }
  }
  const from = target.from
  const theirs = sourceSays(from[0] ?? ORIGIN, branch)
  if (!facts.forward) {
    return {
      kind: 'diverged',
      why: `${branch} here has ${commits(facts.ahead)} ${theirs} lacks, and ${theirs} has ${commits(facts.behind)} it lacks: a shared checkout is never merged or rebased by Tade, so the merge is proposed, to be worked in a worktree of its own`,
      target: target.sha,
      from,
      ahead: facts.ahead,
      behind: facts.behind,
    }
  }
  const moving = { target: target.sha, from, behind: facts.behind }
  // Under `origin`, a target origin has too moves by itself; one only machines have is asked.
  const asks = mode === 'ask' || (mode === 'origin' && !from.includes(ORIGIN))
  const asking = (): SyncVerdict => ({
    kind: 'ask',
    why: askSays(project, branch, theirs, facts.behind, mode),
    ...moving,
  })
  if (facts.at.kind === 'nowhere') {
    return asks ? asking() : { kind: 'move', ...moving, byRef: true }
  }
  const dir = facts.at.dir
  if (facts.committing) {
    return { kind: 'wait', why: `somebody is committing in ${dir} (its index.lock is held)` }
  }
  if (facts.staged.length > 0) {
    return {
      kind: 'wait',
      why: `${files(facts.staged.length)} staged in ${dir} — ${named(facts.staged)} — so somebody is mid-commit`,
    }
  }
  const dirty = new Set(facts.dirty)
  const inTheWay = new Set(facts.inTheWay)
  const paths = facts.incoming
    .map((one) => one.path)
    .filter((path) => dirty.has(path) || inTheWay.has(path))
  if (paths.length > 0) {
    return {
      kind: 'refused',
      why: `${theirs} changes ${files(paths.length)} that ${paths.length === 1 ? 'is' : 'are'} uncommitted in ${dir}: ${named(paths)}. Nobody's uncommitted work is touched, so ${branch} stays where it is until ${paths.length === 1 ? 'it is' : 'they are'} committed or put away`,
      paths,
    }
  }
  if (asks) return asking()
  return { kind: 'move', ...moving, byRef: false }
}

function askSays(
  project: string,
  branch: string,
  theirs: string,
  behind: number,
  mode: ProjectSync,
): string {
  const because =
    mode === 'origin'
      ? `origin has not got it and projects.${project}.sync is origin, which moves only to origin's commits by itself`
      : `projects.${project}.sync is ${mode}`
  return `${theirs} is ${commits(behind)} ahead of ${branch} here and fast-forwards cleanly, but ${because}, so nothing moved`
}

/** A source as a sentence names it: `origin's main`, `vps's main`. */
export function sourceSays(from: string, branch: string): string {
  return `${from}'s ${branch}`
}

/** Every source a move came from, as one name: `vps`, `origin and vps`. */
export function joinedNames(names: readonly string[]): string {
  if (names.length <= 1) return names[0] ?? ORIGIN
  return `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
}

function commits(n: number): string {
  return n === 1 ? '1 commit' : `${n} commits`
}

function files(n: number): string {
  return n === 1 ? '1 file' : `${n} files`
}

/** The paths, every one up to `PATHS_NAMED`, the rest counted. */
export function named(paths: readonly string[]): string {
  const shown = paths.slice(0, PATHS_NAMED).join(', ')
  const more = paths.length - PATHS_NAMED
  return more > 0 ? `${shown} and ${more} more` : shown
}

/** How many changed files a tell and the journal name before the rest are counted. */
export const FILES_TOLD = 50

/** A commit as a sentence names it. */
export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

/**
 * What every agent working in the checkout is told when its HEAD moved under
 * it: the same class of news as another agent's commit, said so it reads
 * again before it edits.
 */
export function syncToldSays(req: {
  branch: string
  from: readonly string[]
  was: string
  now: string
  files: readonly string[]
}): string {
  const shown = req.files.slice(0, FILES_TOLD)
  const more = req.files.length - shown.length
  const changed =
    req.files.length === 0
      ? 'No file changed.'
      : `These files changed: ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`
  return `HEAD moved from ${shortSha(req.was)} to ${shortSha(req.now)}: Tade fast-forwarded ${req.branch} in this checkout to ${sourceSays(joinedNames(req.from), req.branch)}. ${changed} Read a file again before you edit it — what you read before this may be out of date. Your own uncommitted changes were not touched.`
}

/** What the orchestrator hears of a move: the news, with who was told. */
export function syncedNews(req: {
  project: string
  branch: string
  from: readonly string[]
  was: string
  now: string
  files: number
  told: readonly string[]
  byRef: boolean
}): string {
  const told = req.byRef
    ? 'nothing had it checked out, so only the branch moved'
    : req.told.length === 0
      ? 'no agent was working in that checkout'
      : `${joinedNames(req.told)} ${req.told.length === 1 ? 'was' : 'were'} told to read again before editing`
  return `${req.project}'s ${req.branch} was fast-forwarded from ${shortSha(req.was)} to ${shortSha(req.now)}, to ${sourceSays(joinedNames(req.from), req.branch)} (${files(req.files)} changed); ${told}.`
}

/**
 * What a task proposed to merge a parted branch is called, before its target:
 * one name per branch, and **never a machine's**. The slug is the worktree's
 * branch, and git's own merge message names the branch merged into — so a
 * machine named here was a machine named in a commit on origin. One merge of a
 * branch at a time, from whichever source.
 */
export function mergeSlugStem(branch: string): string {
  const plain = `merge-${branch}`
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '')
  return plain.slice(0, 55).replace(/-$/, '')
}

/**
 * What a merge for a branch from one source was called before 0.4.3, so one
 * still open under that name counts as open (`openProposalIn`): read, never
 * made again.
 */
export function formerMergeStem(from: string, branch: string): string {
  return mergeSlugStem(`${from}-${branch}`)
}

/** The one message a parted-branch merge is committed with: the branches, by their names here. */
export function mergeMessage(from: string, branch: string): string {
  return `Merge ${sourceSays(from, branch)} into ${branch}`
}

/**
 * The work a parted branch becomes: made parked, for the orchestrator to decide.
 *
 * **Merged on one machine and pushed, and the other fast-forwards** — what a
 * person does by hand, and nothing else. Never a review, whatever
 * `projects.<name>.push` says, and never a branch of its own on the forge: a
 * review of one machine's branch against another's is noise on a forge, and it
 * was a public one. Where the project says agents `never` push, the merge is
 * made and handed to the person with the line that pushes it.
 */
export function mergeProposal(req: {
  project: string
  branch: string
  from: string
  head: string
  target: string
  ahead: number
  behind: number
  /** Whether agents here may push at all (`pushFor` is not `never`). */
  pushes: boolean
}): { slug: string; title: string; prompt: string; context: string } {
  const { branch, from, head, target } = req
  const theirs = sourceSays(from, branch)
  const ref = from === ORIGIN ? `origin/${branch}` : target
  const merge = `git merge --no-ff -m ${JSON.stringify(mergeMessage(from, branch))} ${ref}`
  const offer = req.pushes
    ? `Then push the merge to ${branch} on origin itself — \`git push origin HEAD:${branch}\` — and nothing else: that is the whole of offering it, whatever this project says about finished work. If origin's ${branch} moved meanwhile, fetch it, merge it the same way and push again; never force-push. Once origin's ${branch} has both sides, every machine fast-forwards to it by itself, this one's checkout included.`
    : `This project says agents never push, so push nothing: say in your last message the merge's commit and the line that pushes it, \`git push origin <commit>:${branch}\`, for the person to run.`
  return {
    slug: `${mergeSlugStem(branch)}-${shortSha(target)}`,
    title: `Merge ${theirs} into ${branch} here`,
    prompt: [
      `${req.project}'s ${branch} on this machine and ${theirs} have parted: ${branch} here has ${commits(req.ahead)} ${theirs} lacks, and ${theirs} has ${commits(req.behind)} this machine lacks. Tade only ever fast-forwards a branch, so it moved nothing.`,
      `In your own worktree, which starts from ${branch} as it is here (${shortSha(head)}), merge ${theirs} (${shortSha(target)}) with \`${merge}\`, resolve what conflicts, and run the checks. ${offer}`,
      `Never open a review or a pull request for this merge, and never push this worktree's own branch: two copies of one branch are brought together by a merge on ${branch}, not offered for review. Name a machine only as it is named here, never by its host name.`,
    ].join('\n\n'),
    context: [
      `## Keeping ${branch} in step`,
      '',
      `- Here: ${branch} at ${head}.`,
      `- ${theirs}: ${target}. Its commits are already in this repository's objects, so \`git merge ${ref}\` works in your worktree; \`git log --oneline ${shortSha(head)}..${shortSha(target)}\` lists them.`,
      '- Nothing was merged or rebased in the shared checkout, and nothing there is yours to change: your worktree is.',
    ].join('\n'),
  }
}

/**
 * This machine's name as another machine's mirror files its branches under
 * (`mirrorRef`): its label (`machineLabel`) made a namespace git and a mirror
 * accept — lowercase, digits and dashes, at most 24.
 */
export function mirrorMachine(label: string): string {
  const plain = label
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+/, '')
    .slice(0, 24)
    .replace(/-+$/, '')
  return plain === '' || plain === ORIGIN ? 'machine' : plain
}
