import { describe, expect, it } from 'vitest'
import {
  conflictsOn,
  conflictsToTell,
  contested,
  hunksFrom,
  type Wrote,
  whoYields,
} from '../src/conflicts.ts'
import type { TadeEvent } from '../src/events.ts'
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
