import { describe, expect, it } from 'vitest'
import {
  conflictsOn,
  conflictsToTell,
  contested,
  hunksFrom,
  liveBranchOf,
  type Wrote,
  whoYields,
} from '../src/conflicts.ts'
import { fetchDue, liveThere, mirrorRef, sameRepository } from '../src/elsewhere.ts'
import type { TadeEvent } from '../src/events.ts'
import { conflictsFor } from '../src/landing.ts'
import type { Conflict } from '../src/model.ts'

const T = 1_800_000_000_000

const claims = (by: Record<string, [string, number][]>): Map<string, Wrote[]> =>
  new Map(
    Object.entries(by).map(([task, wrote]) => [task, wrote.map(([path, at]) => ({ path, at }))]),
  )

let seq = 0
const told = (detail: Record<string, unknown>): TadeEvent => ({
  seq: ++seq,
  ts: new Date(T).toISOString(),
  type: 'conflict_forecast',
  urgency: 'notable',
  task: null,
  lane: null,
  run: null,
  detail: { project: 'app', ...detail },
})

const pair: Conflict = { kind: 'branches', tasks: ['app/a', 'app/b'], files: ['x.ts'] }

describe('hunks in a shared checkout', () => {
  it('are two agents that wrote one changed file', () => {
    const wrote = claims({
      'app/a': [
        ['x.ts', T],
        ['y.ts', T],
      ],
      'app/b': [['x.ts', T]],
      'app/c': [['x.ts', T]],
    })
    expect(contested(wrote, ['x.ts', 'y.ts'])).toEqual(['x.ts'])
    expect(hunksFrom(wrote, ['x.ts', 'y.ts'], new Map())).toEqual([
      { kind: 'hunks', tasks: ['app/a', 'app/b'], files: ['x.ts'] },
      { kind: 'hunks', tasks: ['app/a', 'app/c'], files: ['x.ts'] },
      { kind: 'hunks', tasks: ['app/b', 'app/c'], files: ['x.ts'] },
    ])
  })

  it('are not a file nobody has changed now, or one claimed once', () => {
    const wrote = claims({ 'app/a': [['x.ts', T]], 'app/b': [['x.ts', T]] })
    expect(hunksFrom(wrote, [], new Map())).toEqual([])
    expect(hunksFrom(claims({ 'app/a': [['x.ts', T]] }), ['x.ts'], new Map())).toEqual([])
  })

  it('are only writes newer than the last commit of that file, the same second counting as in it', () => {
    const wrote = claims({ 'app/a': [['x.ts', T + 500]], 'app/b': [['x.ts', T + 9_000]] })
    expect(hunksFrom(wrote, ['x.ts'], new Map([['x.ts', T]]))).toEqual([])
    expect(hunksFrom(wrote, ['x.ts'], new Map([['x.ts', T - 2_000]]))).toEqual([
      { kind: 'hunks', tasks: ['app/a', 'app/b'], files: ['x.ts'] },
    ])
  })
})

describe('one side of a conflict', () => {
  it('names the other side, or the base', () => {
    const base: Conflict = { kind: 'base', tasks: ['app/a'], base: 'main', files: ['y.ts'] }
    expect(conflictsOn('app/a', [pair, base])).toEqual([
      { kind: 'branches', with: 'app/b', files: ['x.ts'] },
      { kind: 'base', with: 'main', files: ['y.ts'] },
    ])
    expect(conflictsOn('app/b', [pair, base])).toEqual([
      { kind: 'branches', with: 'app/a', files: ['x.ts'] },
    ])
    expect(conflictsOn('app/c', undefined)).toEqual([])
  })
})

describe('who gives way', () => {
  const tasks = (a: string, b: string, created = ['2026-10-01', '2026-10-02']) =>
    new Map([
      ['app/a', { state: a as 'working', created: created[0] ?? '' }],
      ['app/b', { state: b as 'working', created: created[1] ?? '' }],
    ])

  it('is the one still working, beside one waiting for review', () => {
    expect(whoYields(pair, tasks('review', 'working'))).toEqual({ yields: 'app/b', keeps: 'app/a' })
    expect(whoYields(pair, tasks('working', 'review'))).toEqual({ yields: 'app/a', keeps: 'app/b' })
  })

  it('is the one started later, between two alike', () => {
    expect(whoYields(pair, tasks('working', 'working'))).toEqual({
      yields: 'app/b',
      keeps: 'app/a',
    })
    expect(whoYields(pair, tasks('working', 'working', ['2026-10-03', '2026-10-02']))).toEqual({
      yields: 'app/a',
      keeps: 'app/b',
    })
  })

  it('is the branch itself, against its base', () => {
    const base: Conflict = { kind: 'base', tasks: ['app/a'], base: 'main', files: ['y.ts'] }
    expect(whoYields(base, tasks('working', 'working'))).toEqual({ yields: 'app/a', keeps: null })
  })
})

describe('what is told', () => {
  it('is a conflict the first time it is seen, and not again', () => {
    expect(conflictsToTell('app', [pair], [])).toEqual({ tell: [pair], gone: [] })
    const events = [told({ kind: 'branches', tasks: ['app/a', 'app/b'], files: ['x.ts'] })]
    expect(conflictsToTell('app', [pair], events)).toEqual({ tell: [], gone: [] })
    // Another project's line is not this one's.
    expect(conflictsToTell('web', [pair], events).tell).toEqual([pair])
  })

  it('is told again when it reaches a file it was not told over', () => {
    const events = [told({ kind: 'branches', tasks: ['app/a', 'app/b'], files: ['x.ts'] })]
    const wider = { ...pair, files: ['x.ts', 'y.ts'] }
    expect(conflictsToTell('app', [wider], events).tell).toEqual([wider])
    expect(conflictsToTell('app', [{ ...pair, files: [] }], events).tell).toEqual([])
  })

  it('is gone when it is no longer there, and news again after that', () => {
    const events = [told({ kind: 'branches', tasks: ['app/a', 'app/b'], files: ['x.ts'] })]
    expect(conflictsToTell('app', [], events)).toEqual({ tell: [], gone: [pair] })
    events.push(told({ kind: 'branches', tasks: ['app/a', 'app/b'], files: ['x.ts'], gone: true }))
    expect(conflictsToTell('app', [], events)).toEqual({ tell: [], gone: [] })
    expect(conflictsToTell('app', [pair], events).tell).toEqual([pair])
  })

  it('is nothing at all where the look could not be made', () => {
    const events = [told({ kind: 'branches', tasks: ['app/a', 'app/b'], files: ['x.ts'] })]
    expect(conflictsToTell('app', undefined, events)).toEqual({ tell: [], gone: [] })
  })
})

describe('another machine’s branch on the other side', () => {
  const there: Conflict = {
    kind: 'elsewhere',
    tasks: ['app/a'],
    elsewhere: { machine: 'vps', task: 'app/a', branch: 'tade/a' },
    files: ['x.ts'],
  }

  it('is named as that machine’s task, never as one of this machine’s', () => {
    expect(conflictsOn('app/a', [there])).toEqual([
      { kind: 'elsewhere', with: 'app/a on vps', files: ['x.ts'] },
    ])
    // A task of the same name there is not this one: the landing desk counts it as another side.
    expect(conflictsFor([there], 'app/a')).toEqual([{ with: 'app/a on vps', files: 1 }])
  })

  it('has the side here give way, since the other is that machine’s to steer', () => {
    expect(whoYields(there, new Map())).toEqual({ yields: 'app/a', keeps: null })
  })

  it('is told once, and again for another machine’s task of the same name', () => {
    const events = [told({ ...there })]
    expect(conflictsToTell('app', [there], events)).toEqual({ tell: [], gone: [] })
    const lab = { ...there, elsewhere: { machine: 'lab', task: 'app/a', branch: 'tade/a' } }
    expect(conflictsToTell('app', [lab], events)).toEqual({ tell: [lab], gone: [there] })
  })
})

describe('what another machine’s branches are, here', () => {
  const head = 'c'.repeat(40)
  const branch = { task: 'app/fix', branch: 'tade/fix', base: 'main', head, live: true }

  it('is one repository only where both machines name one, and the same one', () => {
    expect(sameRepository('github.com/acme/app', 'github.com/acme/app')).toBe(true)
    expect(sameRepository('github.com/acme/app', 'github.com/acme/api')).toBe(false)
    expect(sameRepository(null, null)).toBe(false)
  })

  it('fetches only where a head there is not what the mirror holds', () => {
    const held = new Map([[mirrorRef('vps', 'tade/fix'), head]])
    expect(fetchDue('vps', [branch], held)).toBe(false)
    expect(fetchDue('vps', [branch], new Map())).toBe(true)
    expect(fetchDue('lab', [branch], held)).toBe(true)
    expect(fetchDue('vps', [{ ...branch, head: null }], new Map())).toBe(false)
  })

  it('hands the forecast only live branches on the commit the mirror holds', () => {
    const held = new Map([
      [mirrorRef('vps', 'tade/fix'), head],
      [mirrorRef('vps', 'tade/old'), 'd'.repeat(40)],
    ])
    expect(
      liveThere(
        'vps',
        [
          branch,
          { ...branch, task: 'app/idle', branch: 'tade/idle', live: false },
          { ...branch, task: 'app/old', branch: 'tade/old' },
          { ...branch, task: 'app/new', branch: 'tade/new' },
        ],
        held,
      ),
    ).toEqual([{ machine: 'vps', task: 'app/fix', branch: 'tade/fix', head }])
  })

  it('is live work by the same rule on every machine', () => {
    const git = { head, mergedIntoBase: false, ahead: 1 } as never
    expect(liveBranchOf({ workspace: 'worktree', state: 'working', git })).toBe(true)
    expect(liveBranchOf({ workspace: 'checkout', state: 'working', git })).toBe(false)
    expect(liveBranchOf({ workspace: 'worktree', state: 'merged', git })).toBe(false)
  })
})
