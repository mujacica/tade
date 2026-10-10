import type { CheckRun } from '@tade/checks-core'
import type { RequiredProgram } from '@tade/core'
import type { TicketDetail, TicketPage, TicketQuery, TicketRef } from './tickets.ts'

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

/**
 * One file's patch in a change, as the forge wrote it.
 *
 * The patch and not a rendering of it: a reviewer that is told what changed in
 * somebody's own words is reviewing the words. `patch` is null where the forge
 * hands none over — a binary file, one too large for it, a rename with no
 * content change — which is a **first-class answer** and not an empty diff:
 * "nothing changed in this file" and "I was not given the change" are opposite
 * facts, and a reviewer told the first about the second reviews a file it never
 * saw.
 */
export interface FilePatch {
  path: string
  /** Where it was before a rename; null where it was not renamed. */
  from: string | null
  added: number
  removed: number
  what: 'added' | 'removed' | 'changed' | 'renamed'
  /** The unified patch, as the forge wrote it; null where it hands none over. */
  patch: string | null
}

/**
 * The patch of a review, **pinned**: the commit it is of, said with it.
 *
 * `head` is what the review's head was at the moment the patch was read, and
 * it is the whole reason this is not just a list of files. A review read at
 * one commit and commented on at another is a comment on a line that has
 * moved, so every caller that acts on a patch carries this sha and checks it
 * again before it writes anything.
 */
export interface Patch {
  /** The commit the patch is of. */
  head: string
  /** What it is against, where the forge says; null where it does not. */
  base: string | null
  files: readonly FilePatch[]
  /** More files changed than were handed over: `limit` was reached. */
  more: boolean
}

/**
 * Something to say about one place in a change, with no verdict attached.
 *
 * `line` is a line **on the new side** of the patch, as the patch numbers it,
 * and null is a note about the file as a whole. A note is never an approval,
 * a rejection or a request for changes: there is no field for one, which is
 * the same enforcement-by-absence the rest of this port uses — a forge cannot
 * be asked for what cannot be said.
 */
export interface Note {
  path: string
  line: number | null
  body: string
}

/**
 * What came of one note, as the forge that posted it says.
 *
 * Per note rather than per batch, because posting a set of line comments is a
 * request each on every forge there is: a line that has moved under the patch
 * is refused on its own while the rest go up, and a caller that was handed one
 * answer for the batch would either report a failure that did not happen or
 * hide one that did.
 */
export interface NoteReceipt {
  path: string
  line: number | null
  /** Whether it was created. */
  posted: boolean
  /** Why not, in the forge's own words. */
  said?: string
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
  /**
   * Can answer about the things people *file* here, not only the branches they
   * offer for merge — `tickets` and `ticket` (`tickets.ts`). False is an
   * ordinary answer: a forge that mails patches to a list has reviews and no
   * tickets, and both methods then throw `unsupported` rather than inventing
   * an empty list, because "there are no tickets" and "I cannot be asked about
   * tickets" are opposite facts.
   */
  tickets: boolean
  /**
   * Can hand over the **patch** of a review, pinned to the commit it read —
   * `patch` below. False is an ordinary answer and the method then throws
   * `unsupported`, because "there is no diff" and "I cannot be asked for one"
   * are opposite facts about somebody's change.
   */
  patches: boolean
  /**
   * Can anchor something said at a file and a line in a review's diff —
   * `note` below — **without a verdict attached**. A forge whose only way of
   * posting line comments is to submit an approval or a rejection with them
   * declares `false`: Tade never files a verdict, so a capability that cannot
   * be used without one is a capability it does not have.
   */
  notes: boolean
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
  /**
   * The ref on the remote a review's head can be fetched by, where the forge
   * publishes one — `refs/pull/412/head`. Pure: a name, not a request.
   *
   * It is not how a review is ordinarily checked out, and must never be read as
   * one: the branch to be on is `head.branch`, the branch the review was
   * opened from, and the only thing this answers is *where its commits are to
   * be had from* when that branch is not on this remote at all — a review from
   * a fork, whose branch lives in somebody else's repository. `null` is a
   * first-class answer: a forge that publishes no such ref can only be checked
   * out from its head branch, and saying so is what stops a caller inventing a
   * local branch named after the number instead.
   */
  headRef(ref: ReviewRef): string | null
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
  /**
   * The patch of a review, pinned to the commit it was read at. Needs
   * `capabilities.patches`.
   *
   * A review with nothing in it is an **empty file list, never `missing`**: a
   * branch whose commits are all on the base already is an ordinary thing for
   * somebody to have opened, and a caller reading it as a failure to look
   * would say a real review is broken.
   */
  patch(ref: ReviewRef, limit?: { files?: number }): Promise<Patch>
  /**
   * Say a set of things about places in a change, anchored to one commit.
   * Needs `capabilities.notes` and `capabilities.write`.
   *
   * `on` is the commit the notes were written against, handed in rather than
   * looked up, so a head that moved between reading the patch and writing the
   * notes is a refusal from the forge rather than a comment on a line that is
   * no longer there. `body` is what to say about the change as a whole, posted
   * once; with no notes at all it is still posted, because a review that found
   * nothing is a thing to say.
   *
   * Nothing here is a verdict, and there is no argument one could go in.
   */
  note(
    ref: ReviewRef,
    what: { on: string; notes: readonly Note[]; body?: string },
  ): Promise<readonly NoteReceipt[]>
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
  /**
   * The tickets in one repository, newest movement last. Needs
   * `capabilities.tickets`.
   *
   * A repository with nothing matching is an **empty page, never `missing`**:
   * a label nobody has used yet is the ordinary case for anything polling one.
   * Handing `validator` back from a previous page is how an unchanged answer
   * is had cheaply, and then `unchanged` is true and `items` is empty because
   * there was nothing to read.
   */
  tickets(query: TicketQuery): Promise<TicketPage>
  /**
   * One ticket, with **who applied each of its labels**. Needs
   * `capabilities.tickets`.
   *
   * Its own call rather than a field on the list, because the provenance of a
   * label is a second question on every forge that can answer it at all, and a
   * caller that only wants to know what moved must not pay for it.
   */
  ticket(ref: TicketRef): Promise<TicketDetail>
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
