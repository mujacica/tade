import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type CheckLog, readRuns, writeRun } from '@tade/checks-core'
import { recordsDir, type Task, type Workspace } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { checkTreeIn } from '../../src/away-checks.ts'
import { CheckRecords, RECORDS_MS, treesOf } from '../../src/wire/web-checks.ts'

// The run records the away view's checks are drawn from, read the way the
// window reads them: a held value the beat takes at once, a look behind it no
// more often than `RECORDS_MS`, and a record read again only when it changed —
// against real `checks.jsonl` files written by the same `writeRun` a check run
// writes them with.

const NOW = Date.parse('2026-10-13T09:00:00.000Z')

function run(over: Partial<CheckLog> = {}): CheckLog {
  return {
    id: `abc:${over.check ?? 'tests'}:here:${over.startedAt ?? '1'}`,
    check: 'tests',
    commit: 'abc',
    state: 'passed',
    where: { kind: 'here', runner: 'local', host: 'here.local' },
    required: true,
    startedAt: '2026-10-13T08:00:00.000Z',
    finishedAt: '2026-10-13T08:01:30.000Z',
    code: 0,
    summary: null,
    by: 'app/fix',
    tail: 'the tail of what it printed, which stays at the machine',
    ...over,
  }
}

function worldOf(tasks: { id: string; workspace: 'checkout' | 'worktree' }[]): Workspace {
  return {
    generatedAt: new Date(NOW).toISOString(),
    projects: [
      {
        name: 'app',
        root: '/nowhere',
        brief: null,
        untracked: [],
        tasks: tasks.map((one) => ({ ...one, project: 'app' }) as unknown as Task),
      },
    ],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  } as unknown as Workspace
}

/** A reader whose reads are counted and whose clock is a number. */
function counted(clock: { now: number }) {
  const reads: string[] = []
  const records = new CheckRecords({
    now: () => clock.now,
    read: (dir) => {
      reads.push(dir)
      return readRuns(dir)
    },
  })
  return { records, reads }
}

describe('the trees a project’s runs are in', () => {
  it('are its checkout and each task with a worktree of its own, never a task sharing the checkout', () => {
    const trees = treesOf(
      '/home',
      worldOf([
        { id: 'app/mine', workspace: 'worktree' },
        { id: 'app/shared', workspace: 'checkout' },
      ]),
    )
    expect(trees).toEqual([
      { dir: recordsDir('/home', 'app'), project: 'app', task: null },
      { dir: recordsDir('/home', 'app', 'app/mine'), project: 'app', task: 'app/mine' },
    ])
  })
})

describe('a run, as the away view is handed it', () => {
  it('is its check, answer, requirement, time and length, and nothing else of the record', () => {
    const tree = checkTreeIn('app', null, [
      run(),
      run({ state: 'failed', finishedAt: null }),
      run({ startedAt: null, finishedAt: null }),
    ])
    expect(tree).toEqual({
      project: 'app',
      task: null,
      runs: [
        {
          check: 'tests',
          state: 'passed',
          required: true,
          at: Date.parse('2026-10-13T08:01:30.000Z'),
          ms: 90_000,
          by: 'app/fix',
        },
        // No finish: placed at its start, with no length to claim.
        {
          check: 'tests',
          state: 'failed',
          required: true,
          at: Date.parse('2026-10-13T08:00:00.000Z'),
          ms: null,
          by: 'app/fix',
        },
        { check: 'tests', state: 'passed', required: true, at: null, ms: null, by: 'app/fix' },
      ],
    })
    expect(JSON.stringify(tree)).not.toContain('tail')
    expect(JSON.stringify(tree)).not.toContain('abc')
  })
})

describe('the run records, held', () => {
  it('are null before the first look, and then every tree with what its record says', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-records-'))
    await writeRun(recordsDir(home, 'app'), run())
    const world = worldOf([{ id: 'app/mine', workspace: 'worktree' }])
    const { records } = counted({ now: NOW })
    expect(records.heldNow(home, world)).toBeNull()
    await records.look(home, world)
    const held = records.heldNow(home, world)
    expect(held?.map((one) => [one.task, one.runs.length])).toEqual([
      [null, 1],
      // Never run in its worktree: a tree with nothing in it, not a missing one.
      ['app/mine', 0],
    ])
  })

  it('look once however often the beat asks, and again only when `RECORDS_MS` has gone', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-records-'))
    await writeRun(recordsDir(home, 'app'), run())
    const world = worldOf([])
    const clock = { now: NOW }
    const { records, reads } = counted(clock)
    await records.look(home, world)
    // Two beats a second for the whole interval.
    for (let at = 0; at < RECORDS_MS; at += 500) {
      clock.now = NOW + at
      records.heldNow(home, world)
    }
    expect(reads).toHaveLength(1)
  })

  it('read a record again only when it changed', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-records-'))
    const dir = recordsDir(home, 'app')
    await writeRun(dir, run())
    const world = worldOf([])
    const { records, reads } = counted({ now: NOW })
    await records.look(home, world)
    await records.look(home, world)
    await records.look(home, world)
    expect(reads).toHaveLength(1)
    await writeRun(dir, run({ state: 'failed', startedAt: '2026-10-13T08:30:00.000Z' }))
    await records.look(home, world)
    expect(reads).toHaveLength(2)
    expect(records.heldNow(home, world)?.[0]?.runs.map((one) => one.state)).toEqual([
      'passed',
      'failed',
    ])
  })

  it('say what was read in time when a read never answers, and look again later', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-records-'))
    await writeRun(recordsDir(home, 'app'), run())
    const records = new CheckRecords({
      now: () => NOW,
      lookMs: 20,
      read: () => new Promise<never>(() => {}),
    })
    await records.look(home, worldOf([]))
    // The checkout did not answer, so it is not there: *not read*, which the
    // projection says as nothing looked rather than as nothing ran.
    expect(records.heldNow(home, worldOf([]))).toEqual([])
  })

  it('make a record that cannot be read a tree with no runs, never a throw', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tade-records-'))
    await writeRun(recordsDir(home, 'app'), run())
    const records = new CheckRecords({
      now: () => NOW,
      read: async () => {
        throw new Error('EACCES')
      },
    })
    await records.look(home, worldOf([]))
    expect(records.heldNow(home, worldOf([]))).toEqual([{ project: 'app', task: null, runs: [] }])
  })
})
