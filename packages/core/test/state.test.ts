import { describe, expect, it } from 'vitest'
import type { AgentSignal, GitSnapshot, TaskState, TestSignal } from '../src/model.ts'
import { deriveState, type ProbeBundle } from '../src/state.ts'

const NOW = Date.parse('2026-09-11T12:00:00Z')
const MIN = 60_000

function git(over: Partial<GitSnapshot> = {}): GitSnapshot {
  return {
    branch: 'tade/x',
    head: 'a'.repeat(40),
    headSubject: 'wip',
    headTime: NOW - 10 * MIN,
    dirty: [],
    ahead: 0,
    behind: 0,
    baseRef: 'main',
    mergedIntoBase: false,
    upstreamGone: false,
    pr: null,
    ...over,
  }
}

const files = (n: number) => Array.from({ length: n }, (_, i) => `f${i}.ts`)

function lane(over: Partial<AgentSignal> = {}): AgentSignal {
  return {
    source: 'lane',
    provider: 'claude-code',
    sessionId: 's1',
    alive: true,
    lastActivityAt: NOW - 1 * MIN,
    turn: 'running',
    pendingPermissions: [],
    consecutiveFailures: 0,
    exitCode: null,
    ...over,
  }
}

function adopted(over: Partial<AgentSignal> = {}): AgentSignal {
  return lane({ source: 'adopted', alive: null, ...over })
}

interface Case {
  name: string
  git?: GitSnapshot | null
  agents?: AgentSignal[]
  parked?: boolean
  tests?: TestSignal
  want: TaskState
  reason?: RegExp
  stalled?: boolean
}

const cases: Case[] = [
  // --- no agent ever attached
  { name: 'fresh worktree, nothing happened', want: 'queued' },
  { name: 'fresh worktree, behind base', git: git({ behind: 5 }), want: 'queued' },
  {
    name: 'hand edits, no agent',
    git: git({ dirty: files(2) }),
    want: 'working',
    reason: /2 uncommitted/,
  },
  { name: 'commits ahead, clean, no agent', git: git({ ahead: 3 }), want: 'review' },
  {
    name: 'commits ahead, dirty, no agent',
    git: git({ ahead: 3, dirty: files(1) }),
    want: 'working',
  },
  {
    name: 'commits ahead, clean, tests failing, no agent',
    git: git({ ahead: 3 }),
    tests: 'fail',
    want: 'queued',
  },
  { name: 'ahead unknown (no base)', git: git({ ahead: null }), want: 'queued' },

  // --- terminal and override states
  { name: 'PR merged', git: git({ pr: { state: 'MERGED', url: 'u' } }), want: 'merged' },
  { name: 'fast-forward merged into base', git: git({ mergedIntoBase: true }), want: 'merged' },
  {
    name: 'merged beats a live blocked agent',
    git: git({ mergedIntoBase: true }),
    agents: [lane({ pendingPermissions: ['bash: rm'] })],
    want: 'merged',
  },
  { name: 'merged beats parked', git: git({ mergedIntoBase: true }), parked: true, want: 'merged' },
  { name: 'parked, idle', parked: true, want: 'parked' },
  {
    name: 'parked beats a live working agent',
    parked: true,
    agents: [lane()],
    want: 'parked',
  },
  {
    name: 'parked beats a pending permission',
    parked: true,
    agents: [lane({ pendingPermissions: ['bash: ls'] })],
    want: 'parked',
  },
  { name: 'worktree missing', git: null, want: 'failed', reason: /worktree missing/ },
  {
    name: 'worktree deleted under a live run',
    git: null,
    agents: [lane()],
    want: 'failed',
  },
  {
    name: 'PR closed unmerged, clean ahead',
    git: git({ ahead: 2, pr: { state: 'CLOSED', url: 'u' } }),
    want: 'review',
  },
  {
    name: 'PR open, clean ahead, no agent',
    git: git({ ahead: 2, pr: { state: 'OPEN', url: 'u' } }),
    want: 'review',
  },
  {
    name: 'upstream gone is not merged',
    git: git({ upstreamGone: true, ahead: 1 }),
    want: 'review',
  },

  // --- blocked
  {
    name: 'live lane with a permission request',
    agents: [lane({ pendingPermissions: ['bash: npm i stripe@15'] })],
    want: 'blocked',
    reason: /npm i stripe@15/,
  },
  {
    name: 'two pending requests are both counted',
    agents: [lane({ pendingPermissions: ['a', 'b'] })],
    want: 'blocked',
    reason: /\+1 more/,
  },
  {
    name: 'pending request on a dead lane is ignored',
    agents: [lane({ alive: false, pendingPermissions: ['bash: x'], exitCode: 0 })],
    git: git({ ahead: 1 }),
    want: 'review',
  },
  {
    name: 'permission beats looping failures',
    agents: [lane({ pendingPermissions: ['x'], consecutiveFailures: 5 })],
    want: 'blocked',
  },
  {
    name: 'idle agent, nothing changed',
    agents: [lane({ turn: 'idle' })],
    want: 'blocked',
    reason: /waiting for input/,
  },
  {
    name: 'dirty worktree with green tests, agent idle',
    agents: [lane({ turn: 'idle' })],
    git: git({ ahead: 2, dirty: files(1) }),
    tests: 'pass',
    want: 'blocked',
    reason: /1 uncommitted/,
  },
  {
    name: 'idle agent, commits ahead, tests red',
    agents: [lane({ turn: 'idle' })],
    git: git({ ahead: 2 }),
    tests: 'fail',
    want: 'blocked',
    reason: /failing tests/,
  },
  {
    name: 'recently active adopted session, idle',
    agents: [adopted({ turn: 'idle', lastActivityAt: NOW - 2 * MIN })],
    want: 'blocked',
  },

  // --- review
  {
    name: 'idle agent, clean commits ahead, tests green',
    agents: [lane({ turn: 'idle' })],
    git: git({ ahead: 3 }),
    tests: 'pass',
    want: 'review',
    reason: /tests green/,
  },
  {
    name: 'idle agent, clean commits ahead, tests unknown',
    agents: [lane({ turn: 'idle' })],
    git: git({ ahead: 1 }),
    want: 'review',
    reason: /1 commit ahead, tests unverified/,
  },
  {
    name: 'lane exited 0 after committing',
    agents: [lane({ alive: false, exitCode: 0, turn: 'idle' })],
    git: git({ ahead: 2 }),
    want: 'review',
  },
  {
    name: 'lane crashed but left clean commits',
    agents: [lane({ alive: false, exitCode: 1 })],
    git: git({ ahead: 2 }),
    want: 'review',
  },
  {
    name: 'stale adopted session, clean commits',
    agents: [adopted({ lastActivityAt: NOW - 3 * 60 * MIN })],
    git: git({ ahead: 4 }),
    want: 'review',
  },

  // --- working
  { name: 'live lane, running', agents: [lane()], want: 'working', reason: /agent running/ },
  {
    name: 'live lane, running, touching files',
    agents: [lane()],
    git: git({ dirty: files(3) }),
    want: 'working',
    reason: /3 files touched/,
  },
  {
    name: 'live lane, unknown turn state counts as running',
    agents: [lane({ turn: 'unknown' })],
    want: 'working',
  },
  {
    name: 'adopted session active 1 minute ago',
    agents: [adopted({ lastActivityAt: NOW - 1 * MIN })],
    want: 'working',
  },
  {
    name: 'agent alive but silent 30+ minutes is stalled',
    agents: [lane({ lastActivityAt: NOW - 45 * MIN })],
    want: 'working',
    stalled: true,
    reason: /45m/,
  },
  {
    name: 'agent silent for hours',
    agents: [lane({ lastActivityAt: NOW - 125 * MIN })],
    want: 'working',
    stalled: true,
    reason: /2h05m/,
  },
  {
    name: 'agent silent exactly at threshold is not stalled',
    agents: [lane({ lastActivityAt: NOW - 30 * MIN })],
    want: 'working',
    stalled: false,
  },
  {
    name: 'newest live agent wins over an idle older one',
    agents: [
      lane({ sessionId: 'old', turn: 'idle', lastActivityAt: NOW - 20 * MIN }),
      lane({ sessionId: 'new', turn: 'running', lastActivityAt: NOW - 1 * MIN }),
    ],
    want: 'working',
  },
  {
    name: 'running agent with failures under threshold',
    agents: [lane({ consecutiveFailures: 2 })],
    want: 'working',
  },

  // --- failed
  {
    name: 'three consecutive failures',
    agents: [lane({ consecutiveFailures: 3 })],
    want: 'failed',
    reason: /3 consecutive/,
  },
  {
    name: 'failures on a dead lane still count',
    agents: [lane({ alive: false, consecutiveFailures: 4, exitCode: 1 })],
    want: 'failed',
  },
  {
    name: 'worktree whose agent process died, dirty',
    agents: [lane({ alive: false, exitCode: null })],
    git: git({ dirty: files(2) }),
    want: 'failed',
    reason: /agent gone, 2 uncommitted/,
  },
  {
    name: 'lane exited non-zero with nothing committed',
    agents: [lane({ alive: false, exitCode: 137 })],
    want: 'failed',
    reason: /code 137/,
  },
  {
    name: 'lane exited 0 without committing',
    agents: [lane({ alive: false, exitCode: 0 })],
    want: 'failed',
    reason: /without committing/,
  },
  {
    name: 'stale adopted session left dirty files',
    agents: [adopted({ lastActivityAt: NOW - 60 * MIN })],
    git: git({ dirty: files(1) }),
    want: 'failed',
  },
  {
    name: 'stale adopted session with nothing to show is queued',
    agents: [adopted({ lastActivityAt: NOW - 60 * MIN })],
    want: 'queued',
  },
  {
    name: 'adopted session with no timestamp is not live',
    agents: [adopted({ lastActivityAt: null })],
    want: 'queued',
  },
]

describe('a task sharing the checkout', () => {
  const shared = (over: Partial<ProbeBundle>): ProbeBundle => ({
    now: NOW,
    parked: false,
    git: git({ dirty: files(4), ahead: 2 }),
    agents: [],
    tests: 'unknown',
    shared: true,
    ...over,
  })

  it('is where its agent is, never what the shared files say', () => {
    expect(deriveState(shared({})).state).toBe('queued')
    expect(deriveState(shared({ agents: [lane({ turn: 'running' })] }))).toMatchObject({
      state: 'working',
      reason: 'agent running',
    })
    expect(deriveState(shared({ agents: [lane({ turn: 'idle' })] })).state).toBe('blocked')
    expect(deriveState(shared({ agents: [lane({ alive: false, exitCode: null })] }))).toMatchObject(
      { state: 'review', reason: 'agent stopped: its work is in the checkout' },
    )
    expect(deriveState(shared({ agents: [lane({ alive: false, exitCode: 2 })] })).state).toBe(
      'failed',
    )
    expect(deriveState(shared({ parked: true })).state).toBe('parked')
  })
})

describe('deriveState', () => {
  it('has a broad table', () => {
    expect(cases.length).toBeGreaterThanOrEqual(40)
  })

  it.each(cases)('$name → $want', (c) => {
    const bundle: ProbeBundle = {
      now: NOW,
      parked: c.parked ?? false,
      git: c.git === undefined ? git() : c.git,
      agents: c.agents ?? [],
      tests: c.tests ?? 'unknown',
    }
    const got = deriveState(bundle)
    expect(got.state).toBe(c.want)
    if (c.reason) expect(got.reason).toMatch(c.reason)
    if (c.stalled !== undefined) expect(got.stalled).toBe(c.stalled)
  })

  it('is pure: same input, same output, input untouched', () => {
    const bundle: ProbeBundle = {
      now: NOW,
      parked: false,
      git: git({ ahead: 1 }),
      agents: [lane({ turn: 'idle' }), lane({ sessionId: 's2', lastActivityAt: NOW - 9 * MIN })],
      tests: 'unknown',
    }
    const frozen = structuredClone(bundle)
    expect(deriveState(bundle)).toEqual(deriveState(bundle))
    expect(bundle).toEqual(frozen)
  })
})
