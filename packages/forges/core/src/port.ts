import type { CheckRun } from '@tade/checks-core'
import type { RequiredProgram } from '@tade/core'

// The Forge port: the service a branch is offered to other people on, and
// everything anybody says about it there.
//
// Vocabulary rule (R2): "pull request" is GitHub's word and Bitbucket's,
// GitLab says merge request, Gerrit says change, sourcehut mails patches. So
// the object here is a `Review` — Tade's own word for work that is ready for
// somebody to look at — the service is a `Forge`, and a person's verdict on a
// review is a `Verdict`. GitHub calls the verdict a review, which is the one
// mapping `forges/github` has to carry, in one file.
//
// What a person reads is never this vocabulary: each implementation declares
// the words it uses (`words`), so the window says `PR #412` on GitHub and
// `MR !88` on GitLab from a declaration rather than from anybody checking
// which forge it is.

/** Where a review stands. Neutral and lowercase: the forge's own spelling stays in the forge. */
export type ReviewState = 'draft' | 'open' | 'merged' | 'closed'

export const REVIEW_STATES: readonly ReviewState[] = ['draft', 'open', 'merged', 'closed']

/** Where a review lives, and how to ask about it again. Stable across polls. */
export interface ReviewRef {
  /** The repository as the forge names it: `owner/name`. */
  repo: string
  /** Its number there. */
  number: number
  /** The host it is on, so two forges never collide: `github.com`. */
  host: string
}

/**
 * What a remote says about itself: where it goes, and whose sign-in it is
 * reachable with.
 *
 * **The account a project belongs to is a fact about the project, not about
 * the machine.** A checkout whose remote is
 * `git@github.com-ammujacic:ammujacic/z.git` has declared, in as many words,
 * which of your sign-ins reaches it — an SSH host alias is how anybody with
 * two accounts on one forge keeps them apart. Asked as whoever the machine
 * signed in last, that repository answers "not found", and a project that is
 * perfectly fine reads as a broken one.
 *
 * So it is read out of the URL and out of nothing else. Trying each sign-in in
 * turn until one works is slow, spends somebody's rate limit and reads as an
 * attack: the URL is the declaration, and a forge either places it or says it
 * cannot.
 */
export interface RemotePlace {
  /** The forge's own host, with any local alias resolved away: `github.com`. */
  host: string
  /**
   * The sign-in the remote names, when it names one. Null is the ordinary
   * answer and means whoever this machine is signed in as.
   */
  account: string | null
}

/**
 * Whether this machine can ask about a repository at all, and as whom.
 *
 * Two things look identical from a 404 — a repository this sign-in cannot see,
 * and something that genuinely is not there — and telling them apart is the
 * difference between "no access from this account" and a watch saying a real
 * repository is broken. It is one question, asked of the forge, so every
 * caller gets the same answer rather than each guessing from a message.
 */
export type Access =
  /** Signed in, and it can see the repository. */
  | { kind: 'signed in'; account: string; can: 'read' | 'write' }
  /** Signed in as somebody, and that somebody cannot see this repository. */
  | { kind: 'no access'; account: string; said: string }
  /** Nothing to sign in with — as the account the remote names, where it names one. */
  | { kind: 'not signed in'; account: string | null; said: string }
  /** It could not be asked: nothing came back, a rate limit, a 500. */
  | { kind: 'cannot tell'; said: string }

/** Somebody's verdict on a review. `requested` is a review asked for and not yet given. */
export interface Verdict {
  by: string
  bot: boolean
  kind: 'approved' | 'changes requested' | 'commented' | 'requested'
  at: string | null
}

/** A conversation on a review: at a line, on a file, or on the review as a whole. */
export interface Thread {
  id: string
  path: string | null
  line: number | null
  resolved: boolean
  /** The diff it was written against has moved on. */
  outdated: boolean
  comments: readonly {
    id: string
    by: string
    bot: boolean
    at: string
    /** As written. Never summarised: it is what an agent is asked to answer. */
    body: string
  }[]
}

/** A review, as any forge can describe one. */
export interface Review {
  ref: ReviewRef
  title: string
  url: string
  state: ReviewState
  /** Whose it is, as the forge names them. */
  author: string
  /** Whether that is the account Tade is signed in with. */
  mine: boolean
  /** A verdict or a review is being waited on from us. */
  waitingOnYou: boolean
  head: { branch: string; sha: string }
  base: { branch: string; sha: string | null }
  updatedAt: string
  /**
   * When it was opened. Null where the forge did not say, which is a first
   * class answer: how long something has been waiting is drawn as `—` rather
   * than as nought, which would read as "opened just now".
   */
  openedAt: string | null
  /** Everything the checks add up to, without fetching them all. */
  checks: 'none' | 'running' | 'passed' | 'failed'
  /** What the verdicts add up to, as the forge decides it. */
  decision: 'none' | 'approved' | 'changes requested' | 'review required'
  /** Merging it now would conflict. */
  conflicts: boolean
  /** Why it cannot merge yet, in the forge's own terms, when it says: `behind`, `blocked`. */
  blocked: string | null
  /** The Tade task named in its body, when one is. */
  task: string | null
  /** For a stack: the review its base branch belongs to, when the forge can say. */
  below?: ReviewRef | null
}

export interface ReviewDetail extends Review {
  /** What ran on its head, in the same shape a run here has. */
  checksRan: readonly CheckRun[]
  verdicts: readonly Verdict[]
  threads: readonly Thread[]
  /** Files changed, for deciding what an agent needs to read. Never the whole patch. */
  files: readonly { path: string; added: number; removed: number }[]
}

/** What to list. Everything is optional; a forge that cannot narrow one says so in `capabilities`. */
export interface ReviewQuery {
  /** Ours, waiting on us, or both. */
  who?: 'mine' | 'waiting on you' | 'any'
  state?: readonly ReviewState[]
  /** `owner/repo` globs. The caller has already applied the person's filters. */
  repos?: readonly string[]
  /** Only what moved since: an ISO time. */
  since?: string
  /** At most this many. A forge never pages on its own. */
  limit?: number
  cursor?: string | null
}

export interface Page<T> {
  items: readonly T[]
  /** Hand back to keep reading; null when there is no more. */
  cursor: string | null
  /** More matched than were read. */
  more: boolean
}

/** What a forge can do here, declared. Never inferred from its id. */
export interface ForgeCapabilities {
  /** Can say what is waiting on you as a reviewer, not just what you wrote. */
  assigned: boolean
  checks: boolean
  /**
   * Can say what ran on a commit with no review to ask through. That is the
   * whole of watching CI on a branch nobody opened anything for — a push
   * straight to the base branch — and a forge that can only answer about a
   * review says so here rather than being asked and failing.
   */
  commitChecks: boolean
  /** Can hand back a failing check's log. */
  checkLogs: boolean
  /** Conversations with line positions, and replying inside one. */
  threads: boolean
  drafts: boolean
  /** Can say whether merging is blocked, and by what. */
  rules: boolean
  mergeQueue: boolean
  /** One review's base can be another's head, and it will say so. */
  stacks: boolean
  /** Anything that changes the forge: opening, saying, marking, merging. */
  write: boolean
  /** Cheap "what moved since" — otherwise a watch must list and compare. */
  since: boolean
  /**
   * Reads which of your sign-ins a remote belongs to out of how it is written,
   * and asks as that one. False is an answer: `placeOf` then never names an
   * account, and every project on this forge is asked as the default sign-in.
   */
  accounts: boolean
  /** How many of its own units one poll of the lists costs, for the budget. */
  costPerPoll: number
}

export type ForgeTrouble =
  /** No credential, or it cannot see this. */
  | 'auth'
  /** Rate limited; `retryAt` says when. */
  | 'rate'
  /** No such review, repo or check. */
  | 'missing'
  /** The capability is false, and a call was made anyway. */
  | 'unsupported'
  /** The forge said no: protected branch, review already merged. */
  | 'refused'
  /**
   * It answered, and the answer was trouble of its own: a 5xx, a gateway, an
   * outage. Something was reached, which is what keeps it apart from `network`
   * — one endpoint being down is never the machine being offline, and only the
   * second of those may pause anything.
   */
  | 'server'
  /** Could not be reached: nothing came back at all. */
  | 'network'

export class ForgeError extends Error {
  readonly trouble: ForgeTrouble
  readonly retryAt?: number
  /** What the forge itself said, unchanged, for the human. */
  readonly said?: string

  constructor(
    trouble: ForgeTrouble,
    message: string,
    extra: { retryAt?: number; said?: string } = {},
  ) {
    super(message)
    this.name = 'ForgeError'
    this.trouble = trouble
    if (extra.retryAt !== undefined) this.retryAt = extra.retryAt
    if (extra.said !== undefined) this.said = extra.said
  }
}

/** What a review is opened with. */
export interface OpenRequest {
  repo: string
  head: string
  base: string
  title: string
  body: string
  draft: boolean
  reviewers?: readonly string[]
  labels?: readonly string[]
}

export interface Forge {
  /** Registered under this: `github`, `gitlab`, `scripted`. */
  readonly id: string
  readonly capabilities: ForgeCapabilities
  /**
   * The programs this forge needs on the machine, and how to ask each its
   * version — `gh`, where that is how it talks. A forge that speaks HTTP and
   * nothing else declares nothing.
   */
  readonly programs?: readonly RequiredProgram[]
  /** What it calls a review, for anything a person reads. */
  readonly words: {
    one: string
    many: string
    short: string
    number(n: number): string
  }
  /**
   * Whether it serves this remote — `placeOf` answered as a boolean, so two
   * readers of one URL can never disagree. A pure function: no network, no
   * guessing.
   */
  serves(remote: string): boolean
  /**
   * Where a remote goes and whose sign-in it names. Null where this forge does
   * not serve it. Pure, like `serves`: the hosts it knows plus the hosts the
   * config gave it, and the account read out of how the remote is written —
   * never a file on this machine and never a request.
   */
  placeOf(remote: string): RemotePlace | null
  /** Who we are here, and what we may do. Never throws: what is wrong is a sentence. */
  whoami(): Promise<{ login: string; can: 'read' | 'write' } | { problem: string }>
  /**
   * Whether a repository can be seen from here, and as whom. Never throws:
   * every way of not being able to see one is an answer, because the caller is
   * a watch that has to say something honest rather than fail.
   */
  access(repo: string): Promise<Access>
  reviews(query: ReviewQuery): Promise<Page<Review>>
  review(ref: ReviewRef): Promise<ReviewDetail>
  /** The review a branch has, if any: the one narrow question `packages/status` asks. */
  reviewOf(repo: string, branch: string): Promise<Review | null>
  checks(ref: ReviewRef): Promise<readonly CheckRun[]>
  /**
   * What ran on one commit, whoever it belongs to and whether or not anything
   * was ever opened for it. Needs `capabilities.commitChecks`.
   *
   * A commit nothing has run on is an **empty list, never `missing`**: CI not
   * having reached a push yet is the ordinary case on any branch, and a watch
   * that read it as a failure to look would say it could not look every ten
   * minutes about a repository where nothing is wrong.
   */
  checksOn(repo: string, commit: string): Promise<readonly CheckRun[]>
  /** The tail of a failing check's log, at most `lines`. Needs `capabilities.checkLogs`. */
  checkLog(ref: ReviewRef, check: string, lines: number): Promise<string>
  /**
   * The same log, for a check that ran on a commit rather than on a review.
   * Needs `capabilities.checkLogs` and `capabilities.commitChecks`; a check
   * that did not run on that commit is `missing`, because a caller asking for
   * one has already been told which ran.
   */
  checkLogOn(repo: string, commit: string, check: string, lines: number): Promise<string>
  /** Needs `capabilities.write`. */
  open(request: OpenRequest): Promise<Review>
  /** Say something: on the review, or as a reply inside one thread. */
  say(ref: ReviewRef, what: { body: string; thread?: string }): Promise<void>
  /** Change what the forge shows about it. Nothing here merges anything. */
  mark(
    ref: ReviewRef,
    what: {
      ready?: boolean
      draft?: boolean
      labels?: readonly string[]
      reviewers?: readonly string[]
    },
  ): Promise<void>
  /** Only ever when a person asked for exactly this. `queue` needs `capabilities.mergeQueue`. */
  merge(ref: ReviewRef, how: 'merge' | 'squash' | 'rebase' | 'queue'): Promise<void>
  /** What is left of the budget, as the last answer reported it; null when it does not say. */
  limits(): { remaining: number; of: number; resetsAt: number } | null
}

export interface ExecResult {
  code: number
  stdout: string
  stderr: string
}

/** What a forge is made with. Credentials are read where they live and never written down. */
export interface ForgeOptions {
  /** Run a program — `gh`, mostly. Never throws: a failure is its code and what it said. */
  exec(
    command: string,
    args: readonly string[],
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<ExecResult>
  fetch?: typeof fetch
  env?: Readonly<Record<string, string | undefined>>
  /**
   * Which signed-in account to ask as, per host: `github.com=mujacica`. What a
   * remote declares (`placeOf`) is put in here by whoever made the forge for
   * it, so the forge has one place to look and the project's own word wins
   * over the machine's default.
   */
  accounts?: Readonly<Record<string, string>>
  /** Hosts this forge serves besides the ones it knows: an enterprise install. */
  hosts?: readonly string[]
  /** The variable a token is in, when the CLI is not what you use. */
  tokenEnv?: string
  /** Where to run the CLI: a checkout of the repository, when there is one. */
  cwd?: string
  now?: () => number
}

/** A remote's host, however it is written: `git@github.com:o/r.git`, `https://github.com/o/r`. */
export function hostOf(remote: string): string | null {
  const text = remote.trim()
  if (text === '') return null
  const scp = /^(?:[^@/]+@)?([^/:]+):(?!\/\/)/.exec(text)
  if (scp?.[1]) return scp[1].toLowerCase()
  try {
    return new URL(text).hostname.toLowerCase() || null
  } catch {
    return null
  }
}

/** A remote's repository as its forge names it: `owner/name`. Null when it cannot be read. */
export function repoOf(remote: string): string | null {
  const text = remote
    .trim()
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const scp = text.includes('://') ? null : /^(?:[^@/]+@)?[^/:]+:(.+)$/.exec(text)
  const path = scp?.[1] ?? safePath(text)
  if (!path) return null
  const parts = path.replace(/^\/+/, '').split('/').filter(Boolean)
  return parts.length >= 2 ? parts.slice(-2).join('/') : null
}

function safePath(text: string): string | null {
  try {
    return new URL(text).pathname
  } catch {
    return null
  }
}
