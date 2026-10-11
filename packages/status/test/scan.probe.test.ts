import { type Config, ConfigSchema } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { newProbeGate } from '../src/gate.ts'
import { gitLoad, resetGitLoad } from '../src/git.ts'
import { collectStatus, type StatusOptions } from '../src/status.ts'

// What one beat of `tade status` costs the machine.
//
// `Live` collects this every two seconds for as long as the window is open,
// and it used to ask everything again from scratch: three or four git
// processes per worktree, awaited one worktree at a time. Thirteen worktrees
// measured fifty spawns a beat, serially — which misses the beat, and is
// itself a good part of why the machine was too busy to answer it.
//
// Counted in spawns, and in how many ran at once. Never in wall clock: a
// `fork` on a loaded runner takes as long as the runner says, so a time budget
// here would be a test about the machine the suite happened to land on.
// Spawns are the thing the gate and the pool are *for*, and the count is the
// same number everywhere.

const NOW = Date.parse('2026-10-11T12:00:00Z')

/** Enough worktrees for a pool to have rounds and for a saving to be a saving. */
const WORKTREES = 6

/**
 * What a project costs however much it holds: its worktree list, and resolving
 * its base branch. Everything else was per worktree, which is the point.
 */
const PER_PROJECT = 4

/** How many git processes status is ever allowed to have running at once (`GIT_POOL`). */
const AT_ONCE = 4

function fixture(): { config: Config; opts: () => StatusOptions } {
  const r = mkrepo()
  for (let i = 0; i < WORKTREES; i++) {
    const wt = r.addTask(`t${i}`, { project: 'app' })
    if (i % 2 === 0) r.commit(`work ${i}`, { [`f${i}.ts`]: 'x\n' }, wt)
  }
  const config = ConfigSchema.parse({
    workspace: { adopt: false },
    projects: { app: { root: r.root } },
  })
  return {
    config,
    opts: () => ({
      config,
      now: NOW,
      home: tmp('tade-home-'),
      tadeHome: r.home,
      pr: false,
      processes: async () => ({ processes: [], servers: { looked: true, alive: 0 }, warnings: [] }),
    }),
  }
}

async function cost<T>(work: () => Promise<T>): Promise<{ value: T; spawns: number }> {
  const before = gitLoad().started
  const value = await work()
  return { value, spawns: gitLoad().started - before }
}

describe('what a status beat costs', () => {
  it('asks nothing per worktree on a beat where nothing happened', async () => {
    const { opts } = fixture()
    const gate = newProbeGate()
    const beat = () => collectStatus({ ...opts(), gate })

    const cold = await cost(beat)
    const warm = await cost(beat)
    expect(cold.value.projects[0]?.tasks).toHaveLength(WORKTREES)
    expect(cold.value.warnings).toEqual([])

    // The floor as well as the ceiling: a cold beat really is several spawns a
    // worktree, so the warm one is not a saving made by finding nothing.
    expect(cold.spawns).toBeGreaterThanOrEqual(WORKTREES * 3)
    expect(warm.spawns).toBeLessThanOrEqual(PER_PROJECT)

    // And the saving changes nothing about the answer, which is the only thing
    // that would make it not worth having.
    expect(JSON.stringify(warm.value)).toBe(JSON.stringify(cold.value))
  })

  it('still asks everything when nobody is holding a gate', async () => {
    const { opts } = fixture()
    const first = await cost(() => collectStatus(opts()))
    const second = await cost(() => collectStatus(opts()))
    // A one-shot `tade status` has nothing to reuse and no second look to be
    // wrong at, so it is given no gate and pays per worktree both times. A
    // floor rather than the same number twice: the squash-merge check has a
    // memo of its own and is a spawn cheaper the second time.
    expect(first.spawns).toBeGreaterThanOrEqual(WORKTREES * 3)
    expect(second.spawns).toBeGreaterThanOrEqual(WORKTREES * 3)
  })

  it('never has more than four git processes running at once, and never only one', async () => {
    const { opts } = fixture()
    resetGitLoad()
    await collectStatus(opts())
    const { peak } = gitLoad()
    expect(peak).toBeLessThanOrEqual(AT_ONCE)
    expect(peak).toBeGreaterThan(1)
  })
})
