import type { AgentSignal, GitSnapshot, TaskState, TestSignal } from './model.ts'

// The state machine. A pure function of probe results: no I/O, no clock reads
// (`now` is passed in), no async. This is the thing that changes most often,
// so it is exhaustively table-tested in core/test/state.test.ts.

export interface ProbeBundle {
  now: number
  parked: boolean
  /** `null` when the worktree is missing or unreadable. */
  git: GitSnapshot | null
  agents: AgentSignal[]
  tests: TestSignal
  /**
   * The work is in a checkout other agents share, so its changes and commits
   * are not this task's alone: they say nothing about where this task is.
   */
  shared?: boolean
}

export interface Derived {
  state: TaskState
  /** One short human-readable clause explaining why. */
  reason: string
  /** Working, but no output for longer than `stallMs`. */
  stalled: boolean
}

export const Thresholds = {
  /** An adopted session with activity this recent counts as live. */
  activeWindowMs: 5 * 60_000,
  /** A running turn with no output for this long is flagged stalled. */
  stallMs: 30 * 60_000,
  /** This many consecutive failures forces `failed`. */
  maxFailures: 3,
} as const

export function isLive(a: AgentSignal, now: number): boolean {
  if (a.alive !== null) return a.alive
  return a.lastActivityAt !== null && now - a.lastActivityAt <= Thresholds.activeWindowMs
}

function minutes(ms: number): string {
  const m = Math.floor(ms / 60_000)
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`
}

function mostRecent(agents: AgentSignal[]): AgentSignal | undefined {
  return [...agents].sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))[0]
}

/**
 * Why a task is `blocked` when nothing is wrong: its agent finished its turn
 * and is waiting to be told something. Every other `blocked` is waiting on a
 * decision — an approval, failing tests, work left uncommitted.
 */
export const IDLE_REASON = 'agent idle, waiting for input'

const d = (state: TaskState, reason: string, stalled = false): Derived => ({
  state,
  reason,
  stalled,
})

export function deriveState(b: ProbeBundle): Derived {
  if (b.shared) return deriveShared(b)
  const { git, now } = b

  // Terminal states first: nothing below can override a merge.
  if (git?.pr?.state === 'merged') return d('merged', 'review merged')
  if (git?.mergedIntoBase) return d('merged', `branch merged into ${git.baseRef ?? 'base'}`)

  if (b.parked) return d('parked', 'parked by you')

  if (git === null) return d('failed', 'worktree missing')

  const live = b.agents.filter((a) => isLive(a, now))
  const dirty = git.dirty.length
  const ahead = git.ahead ?? 0
  const hasCleanWork = ahead > 0 && dirty === 0

  const pending = live.flatMap((a) => a.pendingPermissions)
  if (pending.length > 0) {
    const more = pending.length > 1 ? ` (+${pending.length - 1} more)` : ''
    return d('blocked', `wants approval: ${pending[0]}${more}`)
  }

  const looping = b.agents.find((a) => a.consecutiveFailures >= Thresholds.maxFailures)
  if (looping) return d('failed', `${looping.consecutiveFailures} consecutive failures`)

  const primary = mostRecent(live)
  if (primary) {
    if (primary.turn !== 'idle') {
      const silent = primary.lastActivityAt === null ? 0 : now - primary.lastActivityAt
      if (silent > Thresholds.stallMs) return d('working', `no output for ${minutes(silent)}`, true)
      return d('working', dirty > 0 ? `${dirty} files touched` : 'agent running')
    }
    // The agent's turn ended: it is waiting on a human either way.
    if (b.tests === 'fail') return d('blocked', 'turn ended with failing tests')
    if (hasCleanWork) return d('review', reviewReason(ahead, b.tests))
    if (dirty > 0) return d('blocked', `turn ended with ${dirty} uncommitted files`)
    return d('blocked', IDLE_REASON)
  }

  const dead = mostRecent(b.agents)
  if (dead) {
    if (hasCleanWork && b.tests !== 'fail') return d('review', reviewReason(ahead, b.tests))
    if (dead.exitCode !== null && dead.exitCode !== 0) {
      return d('failed', `agent exited with code ${dead.exitCode}`)
    }
    if (dirty > 0) return d('failed', `agent gone, ${dirty} uncommitted files left`)
    if (dead.source === 'lane') return d('failed', 'agent exited without committing')
    // An old adopted session with nothing to show: treat like a fresh task.
  }

  if (hasCleanWork && b.tests !== 'fail') return d('review', reviewReason(ahead, b.tests))
  if (dirty > 0) return d('working', `${dirty} uncommitted files, no agent attached`)
  return d('queued', 'no agent has started')
}

/**
 * A task in a shared checkout is where its agent is: the files and commits
 * there are everyone's, so none of them can say it is finished or stuck.
 */
function deriveShared(b: ProbeBundle): Derived {
  if (b.parked) return d('parked', 'parked by you')
  if (b.git === null) return d('failed', 'checkout missing')
  const live = b.agents.filter((a) => isLive(a, b.now))
  const pending = live.flatMap((a) => a.pendingPermissions)
  if (pending.length > 0) {
    const more = pending.length > 1 ? ` (+${pending.length - 1} more)` : ''
    return d('blocked', `wants approval: ${pending[0]}${more}`)
  }
  const looping = b.agents.find((a) => a.consecutiveFailures >= Thresholds.maxFailures)
  if (looping) return d('failed', `${looping.consecutiveFailures} consecutive failures`)
  const primary = mostRecent(live)
  if (primary) {
    if (primary.turn !== 'idle') {
      const silent = primary.lastActivityAt === null ? 0 : b.now - primary.lastActivityAt
      if (silent > Thresholds.stallMs) return d('working', `no output for ${minutes(silent)}`, true)
      return d('working', 'agent running')
    }
    if (b.tests === 'fail') return d('blocked', 'turn ended with failing tests')
    return d('blocked', IDLE_REASON)
  }
  const dead = mostRecent(b.agents)
  if (dead?.exitCode !== null && dead?.exitCode !== undefined && dead.exitCode !== 0) {
    return d('failed', `agent exited with code ${dead.exitCode}`)
  }
  if (dead) return d('review', 'agent stopped: its work is in the checkout')
  return d('queued', 'no agent has started')
}

function reviewReason(ahead: number, tests: TestSignal): string {
  const commits = `${ahead} commit${ahead === 1 ? '' : 's'} ahead`
  return tests === 'pass' ? `${commits}, tests green` : `${commits}, tests unverified`
}
