import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { deriveState } from '@wilco/core'
import type { WorkerHandle } from '@wilco/harnesses-core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { livenessFrom, runSignal } from '../src/lane-liveness.ts'
import { Workbench } from '../src/workbench.ts'
import type { PendingApproval } from '../src/workers.ts'

// Supervised runs have to reach `wilco status`, or a task waiting on an
// approval would sit there looking idle.

const handle = (over: Partial<WorkerHandle> = {}): WorkerHandle => ({
  run: 'r1',
  task: 'app/refunds',
  sessionId: 's1',
  startedAt: 1_000,
  lane: null,
  ...over,
})

const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({
  run: 'r1',
  task: 'app/refunds',
  requestId: 'q1',
  tool: 'bash',
  summary: 'bash: git push --force origin main',
  tier: 'hard',
  rule: 'force-push',
  reason: 'force push',
  at: 2_000,
  ...over,
})

describe('runSignal', () => {
  it('reports a live run with nothing waiting', () => {
    expect(runSignal(handle(), [])).toMatchObject({
      source: 'run',
      sessionId: 'r1',
      alive: true,
      pendingPermissions: [],
    })
  })

  it('carries waiting approvals so the task reads as blocked', () => {
    const signal = runSignal(handle(), [approval()])
    expect(signal.pendingPermissions).toEqual(['bash: git push --force origin main'])

    const derived = deriveState({
      now: 3_000,
      parked: false,
      git: null,
      agents: [signal],
      tests: 'unknown',
    })
    // A missing worktree is a harder failure than blocked, so check the signal
    // directly against a task that has one.
    expect(derived.state).toBe('failed')

    const withWorktree = deriveState({
      now: 3_000,
      parked: false,
      git: {
        branch: 'wilco/refunds',
        head: 'a'.repeat(40),
        headSubject: 'wip',
        headTime: 1_000,
        dirty: [],
        ahead: 0,
        behind: 0,
        baseRef: 'main',
        mergedIntoBase: false,
        upstreamGone: false,
        pr: null,
      },
      agents: [signal],
      tests: 'unknown',
    })
    expect(withWorktree).toMatchObject({
      state: 'blocked',
      reason: 'wants approval: bash: git push --force origin main',
    })
  })

  it('ignores approvals belonging to another run', () => {
    expect(runSignal(handle({ run: 'r2' }), [approval()]).pendingPermissions).toEqual([])
  })
})

describe('livenessFrom', () => {
  let repo: ReturnType<typeof mkrepo>
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    const home = tmp('wilco-liveness-')
    writeFileSync(join(home, 'config.yaml'), `projects:\n  app:\n    root: ${repo.root}\n`)
    client = await Workbench.open({ home })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  it('reports a supervised run under its own task and nothing under others', async () => {
    const task = await client.createTask({ project: 'app', slug: 'refunds', intent: 'fix refunds' })
    await client.startRun({ run: 'r1', task: task.id, cwd: task.worktree, prompt: '' })

    const probe = livenessFrom(client)
    const signals = await probe.lanes('app/refunds')
    expect(signals).toMatchObject([{ source: 'run', sessionId: 'r1', alive: true }])
    expect(await probe.lanes('app/other')).toEqual([])
  })

  it('returns nothing rather than failing when the workbench goes away', async () => {
    const probe = livenessFrom(client)
    await client.close()
    expect(await probe.lanes('app/refunds')).toEqual([])
  })
})
