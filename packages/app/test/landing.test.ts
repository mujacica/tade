import { visibleWidth } from '@earendil-works/pi-tui'
import type { Conflict, Task, TaskState, Workspace } from '@tade/core'
import { describe, expect, it } from 'vitest'
import type { ActionsView } from '../src/frame.ts'
import { deskOf } from '../src/landing.ts'
import { landingClick, landingKey, landingPanel } from '../src/panels/landing/state.ts'
import { figuresOf, waited } from '../src/panels/landing/view.ts'
import { draw } from '../src/view.ts'
import { actions, base, frame, green } from './screens/scenarios/fixtures.ts'
import { desk } from './screens/scenarios/landing.ts'

// The landing desk in the window: the fold over what the window holds, the
// panel's keys, and its drawing in the room there is.

const NOW = Date.parse('2026-10-16T12:00:00Z')

function task(
  id: string,
  state: TaskState,
  over: { pr?: 'open' | 'draft' | 'merged'; headTime?: number } = {},
): Task {
  return {
    id,
    project: id.split('/')[0],
    intent_spoken: '',
    branch: `tade/${id}`,
    worktree: '/nowhere',
    created: new Date(NOW - 3_600_000).toISOString(),
    state,
    reason: '',
    stalled: false,
    git: {
      branch: `tade/${id}`,
      head: 'abc',
      headSubject: null,
      headTime: over.headTime ?? NOW - 600_000,
      dirty: [],
      xy: {},
      ahead: 1,
      behind: 0,
      baseRef: 'main',
      mergedIntoBase: false,
      upstreamGone: false,
      pr: over.pr ? { state: over.pr, url: 'https://example.com/pull/1' } : null,
    },
    agents: [],
    lanes: [],
  } as Task
}

function world(tasks: readonly Task[], conflicts?: Conflict[]): Workspace {
  return {
    generatedAt: new Date(NOW).toISOString(),
    projects: [
      {
        name: 'app',
        root: '/nowhere',
        brief: null,
        untracked: [],
        tasks: [...tasks],
        ...(conflicts ? { conflicts } : {}),
      },
    ],
    elsewhere: [],
    toolServers: { looked: true, alive: 0 },
    warnings: [],
  } as Workspace
}

describe('the desk the window folds', () => {
  const looked = new Map<string, ActionsView>([
    ['app/green', green()],
    ['app/red', actions()],
  ])
  const fold = (tasks: readonly Task[], over: Partial<Parameters<typeof deskOf>[0]> = {}) =>
    deskOf({
      world: world(tasks),
      finished: new Set(),
      waiting: new Set(),
      work: (id) => looked.get(id) ?? null,
      findings: [],
      usd: () => null,
      ...over,
    })

  it('holds finished work and open reviews, and nothing still working without one', () => {
    const rows = fold(
      [
        task('app/green', 'review'),
        task('app/busy', 'working'),
        task('app/out', 'working', { pr: 'open' }),
        task('app/landed', 'merged', { pr: 'merged' }),
        task('app/said-done', 'blocked'),
      ],
      { finished: new Set(['app/said-done']) },
    )
    expect(rows.map((row) => row.task).sort()).toEqual(['app/green', 'app/out', 'app/said-done'])
  })

  it('reads green only where a look said so, and says when nothing has looked', () => {
    const [ready, unlooked] = fold([task('app/green', 'review'), task('app/new', 'review')])
    expect(ready).toMatchObject({ task: 'app/green', tier: 'ready', checks: 'pass', why: null })
    expect(unlooked).toMatchObject({
      task: 'app/new',
      tier: 'yours',
      checks: null,
      size: null,
      why: 'nothing has looked at its checks yet',
    })
  })

  it('counts a red check, a collision and a finding as the agent’s, whoever else waits', () => {
    const rows = deskOf({
      world: world(
        [task('app/red', 'review'), task('app/green', 'review')],
        [{ kind: 'branches', tasks: ['app/green', 'app/red'], files: ['a.ts'] }],
      ),
      finished: new Set(),
      waiting: new Set(),
      work: (id) => looked.get(id) ?? null,
      findings: [{ tasks: ['app/green'], stillThere: true, account: null, verdict: null }],
      usd: (id) => (id === 'app/red' ? 1.5 : null),
    })
    expect(rows.every((row) => row.tier === 'theirs')).toBe(true)
    expect(rows.find((row) => row.task === 'app/green')).toMatchObject({
      conflicts: 1,
      findings: { open: 1, answered: 0, confirmed: 0, dismissed: 0 },
      usd: null,
    })
    expect(rows.find((row) => row.task === 'app/red')?.usd).toBe(1.5)
  })

  it('never reads a judge nobody could ask as one that found nothing', () => {
    const [row] = fold([task('app/green', 'review')], { findings: null })
    expect(row?.findings).toBeNull()
    expect(figuresOf(row!, NOW).map((one) => one.text)).toContain('findings —')
  })
})

describe('the desk panel', () => {
  const inputs = { desk, deskFiles: { [desk[0]!.task]: ['src/a.ts', 'src/b.ts'] } }

  it('walks the desk, and stops at its ends', () => {
    let panel = landingPanel()
    panel = landingKey(panel, 'up', '', inputs).panel as typeof panel
    expect(panel.index).toBe(0)
    for (let i = 0; i < 20; i++) panel = landingKey(panel, 'down', '', inputs).panel as typeof panel
    expect(panel.index).toBe(desk.length - 1)
  })

  it('reads the change it is on as a patch, at its first file', () => {
    const read = landingKey(landingPanel(), 'enter', '\r', inputs)
    expect(read.panel).toMatchObject({
      kind: 'diff',
      task: desk[0]!.task,
      files: ['src/a.ts', 'src/b.ts'],
    })
    expect(read.submit).toBe(false)
  })

  it('says why it cannot read a change nothing has looked at, or one with nothing in it', () => {
    const second = { ...landingPanel(), index: 1 }
    expect(landingKey(second, 'enter', '\r', inputs).panel).toMatchObject({
      kind: 'landing',
      said: expect.stringMatching(/not been looked at yet/),
    })
    const empty = { desk, deskFiles: { [desk[1]!.task]: [] } }
    expect(landingKey(second, 'enter', '\r', empty).panel).toMatchObject({
      said: expect.stringMatching(/nothing to read/),
    })
  })

  it('goes to the agent on `a`, and a row pressed twice is read', () => {
    expect(landingKey(landingPanel(), undefined, 'a', inputs)).toMatchObject({
      submit: true,
      choice: `agent:${desk[0]!.task}`,
    })
    const chosen = landingClick(landingPanel(), 'row:2', inputs)
    expect(chosen.panel).toMatchObject({ kind: 'landing', index: 2 })
    expect(landingClick(landingPanel(), 'row:0', inputs).panel).toMatchObject({ kind: 'diff' })
    expect(landingClick(landingPanel(), 'close', inputs).panel).toBeNull()
  })

  it('keeps the window exactly its size with the desk over it, at every size', () => {
    for (const width of [40, 60, 80, 120, 200]) {
      for (const height of [10, 24, 50]) {
        const drawn = draw(
          { ...base(), panel: landingPanel() },
          frame({ width, height, landing: desk, now: NOW }),
        )
        expect(drawn.rows.length, `${width}x${height}`).toBe(height)
        for (const row of drawn.rows) expect(visibleWidth(row), `${width}x${height}`).toBe(width)
      }
    }
  })

  it('says a wait in the one unit that says it', () => {
    expect(waited(0)).toBe('1m')
    expect(waited(45 * 60_000)).toBe('45m')
    expect(waited(5 * 3_600_000)).toBe('5h')
    expect(waited(72 * 3_600_000)).toBe('3d')
  })
})
