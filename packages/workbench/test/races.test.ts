import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { finishedFrom, wonFrom } from '@tade/core'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { entrantsOf, pickRace, startRace } from '../src/races.ts'
import { readTaskFile } from '../src/tasks.ts'
import { Workbench } from '../src/workbench.ts'

// A race against real git and a real journal: started through the plan path,
// every entrant a worktree of its own in a project whose agents share one
// checkout, and decided once — the others marked finished, nothing removed.

describe('a race', () => {
  let repo: ReturnType<typeof mkrepo>
  let home: string
  let client: Workbench

  beforeEach(async () => {
    repo = mkrepo()
    home = tmp('tade-races-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: checkout\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    client = await Workbench.open({ home, version: '9.9.9', sessionsRoot: tmp('tade-sessions-') })
  })

  afterEach(async () => {
    await client.close().catch(() => {})
  })

  const race = (over: Partial<Parameters<typeof startRace>[1]> = {}) =>
    startRace(client, {
      project: 'app',
      name: 'dark',
      said: 'add a dark mode',
      prompt: 'Add a dark mode, run the checks and commit.',
      entrants: [{ harness: 'claude-code' }, { harness: 'codex' }, {}],
      ...over,
    })

  const pick = (task: string, by: 'you' | 'orchestrator' = 'you') =>
    pickRace(
      {
        home,
        log: client.log,
        stopAgent: (one) => client.stopAgent(one),
        markDone: (one, how) => client.markDone(one, how),
      },
      { project: 'app', race: 'dark', task, by, why: 'it kept to what was asked' },
    )

  it('makes queued work in worktrees of their own, each on its own harness', async () => {
    const made = await race()
    expect(made.made.map((one) => [one.id, one.workspace])).toEqual([
      ['app/dark-1', 'worktree'],
      ['app/dark-2', 'worktree'],
      ['app/dark-3', 'worktree'],
    ])
    expect(new Set(made.made.map((one) => one.worktree)).size).toBe(3)
    const files = await Promise.all(made.made.map((one) => readTaskFile(home, one.id)))
    expect(files.map((one) => one?.race)).toEqual(['dark', 'dark', 'dark'])
    expect(files.map((one) => one?.harness)).toEqual(['claude-code', 'codex', undefined])
    // Queued, not started, and not parked: the queue starts them by its own rule.
    expect(files.every((one) => one?.start?.prompt.startsWith('Add a dark mode'))).toBe(true)
    expect(files.every((one) => one?.parked === false)).toBe(true)
    expect(await entrantsOf(home, 'app', 'dark')).toEqual([
      'app/dark-1',
      'app/dark-2',
      'app/dark-3',
    ])
    const created = await client.events({ types: ['task_created'] })
    expect(created.every((one) => one.detail.race === 'dark')).toBe(true)
  })

  it('makes nothing when an entrant names a harness Tade does not run', async () => {
    await expect(
      race({ entrants: [{ harness: 'claude-code' }, { harness: 'ghost' }] }),
    ).rejects.toThrow(/dark-2 names the harness ghost, and Tade runs/)
    expect(await entrantsOf(home, 'app', 'dark')).toEqual([])
  })

  it('is decided once: the winner kept, the others marked finished, every branch still there', async () => {
    const made = await race()
    const decided = await pick('app/dark-2')
    expect(decided).toEqual({ task: 'app/dark-2', closed: ['app/dark-1', 'app/dark-3'] })
    const won = wonFrom(await client.events({ types: ['race_won'] })).get('app/dark')
    expect(won).toMatchObject({ task: 'app/dark-2', by: 'you', why: 'it kept to what was asked' })
    const finished = finishedFrom(await client.events({ types: ['task_done'] }))
    expect([...finished.keys()].sort()).toEqual(['app/dark-1', 'app/dark-3'])
    expect(finished.get('app/dark-1')?.summary).toBe('dark went to dark-2; this branch is kept')
    for (const one of made.made) expect(repo.git('rev-parse', '--verify', one.branch)).toBeTruthy()
    await expect(pick('app/dark-1')).rejects.toThrow(/dark was decided already: app\/dark-2/)
  })

  it('refuses an entrant that is not in it, a race that is not there, and no reason', async () => {
    await race()
    await expect(pick('app/elsewhere')).rejects.toThrow(/not an entrant in dark: app\/dark-1/)
    await expect(
      pickRace(
        { home, log: client.log, stopAgent: async () => {}, markDone: async () => {} },
        { project: 'app', race: 'none', task: 'app/x', by: 'you', why: 'x' },
      ),
    ).rejects.toThrow(/there is no race called none in app/)
    await expect(
      pickRace(
        { home, log: client.log, stopAgent: async () => {}, markDone: async () => {} },
        { project: 'app', race: 'dark', task: 'app/dark-1', by: 'you', why: '  ' },
      ),
    ).rejects.toThrow(/say why this one/)
  })
})
