import { renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Task, Workspace } from '@wilco/core'
import { git } from '@wilco/status'
import type { LaneRecord } from '@wilco/workbench/registry'
import type { PendingApproval } from '@wilco/workbench/workers'
import { describe, expect, it } from 'vitest'
import { mkrepo } from '../../../test/fixtures/mkrepo.ts'
import { changesFrom, knownTasks, snapshotsFrom } from '../src/live.ts'

// What the window shows is a fold of three sources that each know part of the
// truth: status knows the states, the registry knows the screens, the approval
// queue knows what is waiting.

const task = (id: string, state: Task['state']): Task => ({
  id,
  project: id.split('/')[0] ?? id,
  intent_spoken: 'something',
  branch: `wilco/${id.split('/').at(-1)}`,
  worktree: `/wt/${id.split('/').at(-1)}`,
  created: '2026-09-11T09:00:00.000Z',
  state,
  reason: 'because',
  stalled: false,
  git: null,
  agents: [],
  lanes: [],
})

const workspace = (tasks: Task[]): Workspace => ({
  generatedAt: '2026-09-11T14:00:00.000Z',
  projects: [{ name: 'checkout', root: '/src/checkout', brief: null, tasks, untracked: [] }],
  elsewhere: [],
  warnings: [],
})

const lane = (over: Partial<LaneRecord>): LaneRecord =>
  ({
    id: 'checkout/refunds/agent',
    task: 'checkout/refunds',
    kind: 'agent',
    spec: { id: 'checkout/refunds/agent', cwd: '/wt/refunds', command: 'pi', args: [] },
    pid: 1,
    startedAt: 1,
    title: 'agent',
    alive: true,
    exitCode: null,
    lastOutputAt: null,
    ...over,
  }) as LaneRecord

const approval = (task: string): PendingApproval => ({
  run: 'r1',
  task,
  requestId: 'q1',
  tool: 'bash',
  summary: 'bash: npm test',
  tier: 'soft',
  rule: 'shell',
  reason: 'runs a command',
  at: 1,
})

describe('snapshotsFrom', () => {
  it('carries each task and its state', () => {
    const snapshots = snapshotsFrom(
      workspace([task('checkout/refunds', 'working'), task('checkout/stripe-v15', 'blocked')]),
      [],
      [],
    )
    expect(snapshots).toEqual([
      {
        task: 'checkout/refunds',
        state: 'working',
        title: null,
        branch: expect.any(String),
        lane: null,
        waiting: false,
        approval: null,
        lanes: [],
      },
      {
        task: 'checkout/stripe-v15',
        state: 'blocked',
        title: null,
        branch: expect.any(String),
        lane: null,
        waiting: false,
        approval: null,
        lanes: [],
      },
    ])
  })

  it('attaches the lane whose screen the pane should draw', () => {
    const [snapshot] = snapshotsFrom(
      workspace([task('checkout/refunds', 'working')]),
      [],
      [lane({})],
    )
    expect(snapshot?.lane).toBe('checkout/refunds/agent')
  })

  it('prefers the agent lane over the others', () => {
    const [snapshot] = snapshotsFrom(
      workspace([task('checkout/refunds', 'working')]),
      [],
      [
        lane({ id: 'checkout/refunds/tests', kind: 'tests' }),
        lane({ id: 'checkout/refunds/agent', kind: 'agent' }),
      ],
    )
    expect(snapshot?.lane).toBe('checkout/refunds/agent')
  })

  it('ignores a lane that has exited', () => {
    const [snapshot] = snapshotsFrom(
      workspace([task('checkout/refunds', 'working')]),
      [],
      [lane({ alive: false })],
    )
    expect(snapshot?.lane).toBeNull()
  })

  it('marks the task an approval is waiting on', () => {
    const snapshots = snapshotsFrom(
      workspace([task('checkout/refunds', 'working'), task('checkout/stripe-v15', 'working')]),
      [approval('checkout/stripe-v15')],
      [],
    )
    expect(snapshots.find((s) => s.task === 'checkout/stripe-v15')?.waiting).toBe(true)
    expect(snapshots.find((s) => s.task === 'checkout/refunds')?.waiting).toBe(false)
  })

  it('keeps a stable order, so the sidebar does not jump around', () => {
    const tasks = [task('checkout/zebra', 'working'), task('checkout/alpha', 'working')]
    expect(snapshotsFrom(workspace(tasks), [], []).map((s) => s.task)).toEqual([
      'checkout/alpha',
      'checkout/zebra',
    ])
  })

  it('has nothing to show when there is nothing', () => {
    expect(snapshotsFrom(workspace([]), [], [])).toEqual([])
  })
})

describe('knownTasks', () => {
  it('hands the resolver what it needs to work out which one you meant', () => {
    expect(
      knownTasks([{ task: 'checkout/refunds', state: 'blocked', lane: null, waiting: true }]),
    ).toEqual([{ id: 'checkout/refunds', project: 'checkout', state: 'blocked' }])
  })
})

describe('changesFrom', () => {
  it('reads everything a task changed since it branched, committed or not', async () => {
    const repo = mkrepo()
    repo.commit('first', { 'keep.ts': 'a\nb\nc\n', 'gone.ts': 'x\n', 'old name.ts': 'same\n' })
    const base = repo.head()

    // Committed on the task's branch: plain `git status` would show none of this.
    repo.commit('agent work', { 'committed.ts': 'one\ntwo\n' })
    repo.write({
      'keep.ts': 'a\nB\nc\nd\n',
      'new file.ts': 'hello\n',
      '.wilco/task.yaml': 'id: x\n',
    })
    rmSync(join(repo.root, 'gone.ts'))
    renameSync(join(repo.root, 'old name.ts'), join(repo.root, 'new name.ts'))
    repo.git('add', '-A', 'new name.ts', 'old name.ts')

    const run = async (args: string[]) => (await git(repo.root, args)).stdout
    const changes = changesFrom(
      await run(['diff', '--name-status', '-z', base]),
      await run(['diff', '--numstat', '-z', base]),
      await run(['status', '--porcelain=v2', '-z', '--untracked-files=all']),
    )
    const at = (path: string) => changes.find((change) => change.path === path)

    expect(at('committed.ts')).toEqual({ path: 'committed.ts', mark: 'A', added: 2, removed: 0 })
    expect(at('keep.ts')).toEqual({ path: 'keep.ts', mark: 'M', added: 2, removed: 1 })
    expect(at('gone.ts')?.mark).toBe('D')
    // Paths with spaces survive, because the output is NUL-separated.
    expect(at('new file.ts')?.mark).toBe('?')
    expect(at('new name.ts')?.mark).toBe('R')
    // Wilco's own record of the task is not a change anybody made.
    expect(changes.some((change) => change.path.startsWith('.wilco'))).toBe(false)
  })
})
