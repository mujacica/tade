import type { CheckRun, CheckState } from '@tade/checks-core'
import type { Review, ReviewDetail, ReviewState, Thread, Verdict } from '@tade/forges-core'

// GitHub's words, turned into the port's.
//
// This file and `queries.ts` are the only two that know GitHub's spelling —
// `MERGED`, `CHANGES_REQUESTED`, `statusCheckRollup`, and the fact that what
// GitHub calls a review is what the port calls a verdict. Everything above
// them reads `merged`, `changes requested` and `Verdict`.
//
// A parser of somebody else's format never throws on a shape it does not
// know: what it cannot read is `null`, `none` or absent, never a guess.

type Raw = Record<string, unknown>

const obj = (value: unknown): Raw | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Raw) : null

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])

const text = (value: unknown): string => (typeof value === 'string' ? value : '')

/** A pull request, as the port describes a review. Null when the shape is not one. */
export function asReview(node: unknown, me: string | null, host: string): Review | null {
  const raw = obj(node)
  if (!raw || typeof raw.number !== 'number') return null
  const repo = text(obj(raw.repository)?.nameWithOwner)
  if (!repo) return null
  const author = text(obj(raw.author)?.login)
  const lastCommit = obj(obj(list(obj(raw.commits)?.nodes)[0])?.commit)
  const rollup = text(obj(lastCommit?.statusCheckRollup)?.state)
  const decision = text(raw.reviewDecision)
  // Only a person can be "waiting on you": a team's request is the team's.
  const requested =
    me !== null &&
    list(obj(raw.reviewRequests)?.nodes).some(
      (one) => text(obj(obj(one)?.requestedReviewer)?.login) === me,
    )
  return {
    ref: { repo, number: raw.number, host },
    title: text(raw.title),
    url: text(raw.url),
    state: stateOf(text(raw.state), raw.isDraft === true),
    author,
    mine: me !== null && author === me,
    waitingOnYou: requested,
    head: { branch: text(raw.headRefName), sha: text(raw.headRefOid) },
    base: { branch: text(raw.baseRefName), sha: null },
    updatedAt: text(raw.updatedAt),
    openedAt: text(raw.createdAt) || null,
    checks: checksOf(rollup),
    decision: decisionOf(decision),
    conflicts: text(raw.mergeable) === 'CONFLICTING',
    blocked: decision === 'CHANGES_REQUESTED' ? 'changes were requested' : null,
    task: taskIn(text(raw.body)),
  }
}

/** The same, with what only the one-review query carries. */
export function asDetail(node: unknown, me: string | null, host: string): ReviewDetail | null {
  const review = asReview(node, me, host)
  const raw = obj(node)
  if (!review || !raw) return null
  return {
    ...review,
    checksRan: [],
    verdicts: list(obj(raw.reviews)?.nodes).flatMap((one) => {
      const verdict = asVerdict(one)
      return verdict ? [verdict] : []
    }),
    threads: list(obj(raw.reviewThreads)?.nodes).flatMap((one) => {
      const thread = asThread(one)
      return thread ? [thread] : []
    }),
    files: list(obj(raw.files)?.nodes).flatMap((one) => {
      const file = obj(one)
      const path = text(file?.path)
      return path
        ? [
            {
              path,
              added: typeof file?.additions === 'number' ? file.additions : 0,
              removed: typeof file?.deletions === 'number' ? file.deletions : 0,
            },
          ]
        : []
    }),
  }
}

function asVerdict(node: unknown): Verdict | null {
  const raw = obj(node)
  if (!raw) return null
  const by = text(obj(raw.author)?.login)
  const state = text(raw.state)
  const kind: Verdict['kind'] | null =
    state === 'APPROVED'
      ? 'approved'
      : state === 'CHANGES_REQUESTED'
        ? 'changes requested'
        : state === 'COMMENTED'
          ? 'commented'
          : null
  if (!by || !kind) return null
  return { by, bot: looksLikeBot(by), kind, at: text(raw.submittedAt) || null }
}

function asThread(node: unknown): Thread | null {
  const raw = obj(node)
  if (!raw || typeof raw.id !== 'string') return null
  return {
    id: raw.id,
    path: text(raw.path) || null,
    line: typeof raw.line === 'number' ? raw.line : null,
    resolved: raw.isResolved === true,
    outdated: raw.isOutdated === true,
    comments: list(obj(raw.comments)?.nodes).flatMap((one) => {
      const comment = obj(one)
      const by = text(obj(comment?.author)?.login)
      if (!comment || typeof comment.id !== 'string') return []
      return [
        {
          id: comment.id,
          by,
          bot: looksLikeBot(by),
          at: text(comment.createdAt),
          // As written: it is what an agent is asked to answer, and
          // summarising it would be summarising the instruction.
          body: text(comment.body),
        },
      ]
    }),
  }
}

/** What GitHub's Checks API said, in the shape a local run has. */
export function asCheckRun(
  node: unknown,
  at: { repo: string; commit: string; url: string | null },
): CheckRun | null {
  const raw = obj(node)
  if (!raw) return null
  const name = text(raw.name)
  if (!name) return null
  const status = text(raw.status)
  const conclusion = text(raw.conclusion)
  const state: CheckState =
    status === 'queued' || status === 'waiting' || status === 'pending'
      ? 'queued'
      : status !== 'completed'
        ? 'running'
        : conclusion === 'success'
          ? 'passed'
          : conclusion === 'skipped' || conclusion === 'neutral'
            ? 'skipped'
            : conclusion === 'cancelled'
              ? 'cancelled'
              : conclusion === 'timed_out'
                ? 'timed out'
                : 'failed'
  return {
    id: `${at.commit.slice(0, 7)}:${name}:github:${text(raw.id) || String(raw.id ?? '')}`,
    check: name,
    commit: at.commit,
    state,
    where: {
      kind: 'forge',
      forge: 'github',
      job: name,
      url: text(raw.html_url) || at.url,
    },
    // Which checks a repository requires is a branch-protection question, and
    // asking it per poll costs a request per repository. Until it is asked,
    // "required" is unknown rather than claimed.
    required: false,
    startedAt: text(raw.started_at) || null,
    finishedAt: text(raw.completed_at) || null,
    code: null,
    summary: text(obj(raw.output)?.title) || null,
    by: null,
  }
}

export function stateOf(state: string, draft: boolean): ReviewState {
  if (state === 'MERGED') return 'merged'
  if (state === 'CLOSED') return 'closed'
  return draft ? 'draft' : 'open'
}

function checksOf(rollup: string): Review['checks'] {
  if (rollup === 'SUCCESS') return 'passed'
  if (rollup === 'FAILURE' || rollup === 'ERROR') return 'failed'
  if (rollup === 'PENDING' || rollup === 'EXPECTED') return 'running'
  return 'none'
}

function decisionOf(decision: string): Review['decision'] {
  if (decision === 'APPROVED') return 'approved'
  if (decision === 'CHANGES_REQUESTED') return 'changes requested'
  if (decision === 'REVIEW_REQUIRED') return 'review required'
  return 'none'
}

/** The task a review says it belongs to, from the trailer in its body. */
export function taskIn(body: string): string | null {
  return /^Tade-Task:[ \t]*(\S+)[ \t]*$/m.exec(body)?.[1] ?? null
}

/** Whether a name is a robot's. GitHub marks apps `[bot]`; the rest is a guess and says so. */
export function looksLikeBot(login: string): boolean {
  return /\[bot\]$/.test(login) || /(^|-)(bot|ci)$/.test(login)
}
