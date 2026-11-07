import { join } from 'node:path'
import type { Workbench } from '@tade/workbench'
import { describe, expect, it } from 'vitest'
import { type FakeTerminal, type Repo, until, windowUnderTest } from './harness.ts'

// The conflict forecast, through the whole window: two agents' branches that
// would conflict, a mark on both of them, and the orchestrator told once —
// with the call that answers it, and without asking anybody.

describe('the window, and work that would collide', () => {
  let terminal: FakeTerminal
  let client: Workbench
  let repo: Repo
  const { start, sidebar, beats } = windowUnderTest((wired) => {
    terminal = wired.terminal
    client = wired.client
    repo = wired.repo
  })

  it('marks both agents and tells the orchestrator once, then says when it has gone', async () => {
    const refunds = join(repo.root, '..', 'worktrees', 'app-refunds')
    const search = join(repo.root, '..', 'worktrees', 'app-search')
    repo.commit('refunds', { 'charge.ts': 'charge once\n' }, refunds)
    repo.commit('search', { 'charge.ts': 'charge twice\n' }, search)
    const told: string[] = []
    await start({
      thinker: {
        ask: async () => 'ok',
        tell: async (text: string) => {
          told.push(text)
        },
      },
    })
    await until('the orchestrator told', () => told.some((text) => text.includes('charge.ts')))
    const said = told.find((text) => text.includes('charge.ts')) ?? ''
    expect(said).toContain('app/refunds and app/search would conflict in charge.ts')
    // Both waiting for review, so the later one takes the other's in, by its branch.
    expect(said).toContain(
      'tade_steer with task: app/search, message: "app/refunds (branch tade/refunds) changes charge.ts too',
    )
    expect(said).toContain('Resolving it is yours (queue.holds), without asking them')
    await until('both marked', () => {
      const side = sidebar()
      return side.includes('refunds ⇄') && side.includes('search ⇄')
    })
    const [line] = await client.events({ types: ['conflict_forecast'] })
    expect(line).toMatchObject({
      task: 'app/refunds',
      detail: {
        project: 'app',
        kind: 'branches',
        tasks: ['app/refunds', 'app/search'],
        files: ['charge.ts'],
      },
    })

    // Moving on without touching the files it collides over is not news.
    repo.commit('search more', { 'search.ts': 'faster\n' }, search)
    await beats(3)
    expect(told.filter((text) => text.includes('would conflict in charge.ts'))).toHaveLength(1)

    // Taking the other's work in resolves it, and that is written down.
    repo.git('-C', search, 'merge', '-q', 'tade/refunds', '-X', 'theirs', '-m', 'take refunds')
    await until(
      'the collision gone',
      async () =>
        (await client.events({ types: ['conflict_forecast'] })).some(
          (event) => event.detail.gone === true,
        ),
      15_000,
    )
    // The conversation keeps its line about it; the agents stop wearing it.
    await until('the marks gone', () => {
      const side = sidebar()
      return !side.includes('refunds ⇄') && !side.includes('search ⇄')
    })
    expect(terminal.written).toContain('would conflict in charge.ts')
  })

  it('keeps what it would have told while no orchestrator is running, once written down', async () => {
    // Written down first, so it is never told again: resolved as if told, a
    // collision seen while the orchestrator was starting was heard by nobody.
    const refunds = join(repo.root, '..', 'worktrees', 'app-refunds')
    const search = join(repo.root, '..', 'worktrees', 'app-search')
    repo.commit('refunds', { 'charge.ts': 'charge once\n' }, refunds)
    repo.commit('search', { 'charge.ts': 'charge twice\n' }, search)
    const window = await start()
    await until(
      'the collision written down',
      async () => (await client.events({ types: ['conflict_forecast'] })).length === 1,
    )
    const asked: string[] = []
    window.attachThinker({
      ask: async (text: string) => {
        asked.push(text)
        return 'ok'
      },
      tell: async () => {},
    })
    terminal.press('\x00')
    for (const char of 'anything new') terminal.press(char)
    terminal.press('\r')
    await until('the orchestrator asked', () => asked.length === 1)
    expect(asked[0]).toContain('app/refunds and app/search would conflict in charge.ts')
  })
})
