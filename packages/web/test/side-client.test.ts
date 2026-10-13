import { describe, expect, it } from 'vitest'
import {
  agentGroups,
  FOLDS,
  foldsFrom,
  foldsTo,
  queueAt,
  queueLine,
  queuePaused,
  queueTree,
  sideAgents,
} from '../src/assets/tree.js'

// The right-hand side as data: a project's agents in the window's order, and
// its queue hung as the window hangs it — a piece under the queued work it
// waits on — with the window's words at the end of each row and under it.
//
// What it looks like, and that a drawer opens and closes, is a browser's to
// answer (`scripts/browser-desk.ts`).

type State =
  | { kind: 'ready' }
  | { kind: 'waiting'; on: string[] }
  | { kind: 'held'; on: string | null; because: string; changed: null; by: string[] }
  | { kind: 'scheduled'; at: string }
  | { kind: 'paused'; all: boolean; parked: boolean }

function piece(task: string, state: State, after: string[] = [], order: number | null = null) {
  return {
    task: `p/${task}`,
    project: 'p',
    state,
    order,
    waitsOn: after.map((one) => ({ task: `p/${one}`, why: null })),
  }
}

/** The forest as indented names, which is the drawing without the lines. */
function drawn(forest: ReturnType<typeof queueTree>, level = 0): string[] {
  return forest.flatMap((node) => [
    `${'  '.repeat(level)}${node.row.task.slice(2)}`,
    ...drawn(node.children, level + 1),
  ])
}

describe('the queue, as a tree', () => {
  it('hangs a chain under the work it waits on, in the order it will run', () => {
    // The person's own screenshot: eight pieces, each after the one before,
    // listed alphabetically with `after …` under each — a chain nobody could
    // read the order of. Hung, it reads top to bottom.
    const rows = [
      piece('final', { kind: 'waiting', on: ['p/remediation'] }, ['remediation']),
      piece('a04', { kind: 'paused', all: false, parked: false }),
      piece('remediation', { kind: 'waiting', on: ['p/g03'] }, ['g03']),
      piece('g01', { kind: 'waiting', on: ['p/e2e'] }, ['e2e']),
      piece('e2e', { kind: 'waiting', on: ['p/a04'] }, ['a04']),
      piece('g03', { kind: 'waiting', on: ['p/g01'] }, ['g01']),
    ]
    expect(drawn(queueTree(rows))).toEqual([
      'a04',
      '  e2e',
      '    g01',
      '      g03',
      '        remediation',
      '          final',
    ])
  })

  it('puts what starts next first, and what will not start by itself last', () => {
    const rows = [
      piece('later', { kind: 'paused', all: false, parked: true }),
      piece('held', {
        kind: 'held',
        on: null,
        because: 'two change one file',
        changed: null,
        by: [],
      }),
      piece('clock', { kind: 'scheduled', at: '2026-10-12T18:00:00.000Z' }),
      piece('next', { kind: 'ready' }),
      piece('behind', { kind: 'waiting', on: ['p/running-agent'] }),
    ]
    expect(drawn(queueTree(rows))).toEqual(['next', 'behind', 'held', 'clock', 'later'])
  })

  it('orders the ready by the written preference, and then by name', () => {
    const rows = [
      piece('b', { kind: 'ready' }),
      piece('c', { kind: 'ready' }, [], 1),
      piece('a', { kind: 'ready' }),
    ]
    expect(drawn(queueTree(rows))).toEqual(['c', 'a', 'b'])
  })

  it('draws a piece that waits on two once, under the deeper of them', () => {
    // Its own line says the other: `after a and b`.
    const rows = [
      piece('a', { kind: 'ready' }),
      piece('b', { kind: 'waiting', on: ['p/a'] }, ['a']),
      piece('both', { kind: 'waiting', on: ['p/a', 'p/b'] }, ['a', 'b']),
    ]
    expect(drawn(queueTree(rows))).toEqual(['a', '  b', '    both'])
  })

  it('treats work it waits on that is not queued as a reason, not a parent', () => {
    const rows = [piece('docs', { kind: 'waiting', on: ['p/schema'] }, ['schema'])]
    expect(drawn(queueTree(rows))).toEqual(['docs'])
  })

  it('draws every piece once even where the files say a cycle', () => {
    // Task files anybody can edit: a cycle must neither hang the page nor
    // drop both pieces off it.
    const rows = [
      piece('x', { kind: 'waiting', on: ['p/y'] }, ['y']),
      piece('y', { kind: 'waiting', on: ['p/x'] }, ['x']),
    ]
    const names = drawn(queueTree(rows)).map((one) => one.trim())
    expect(names.sort()).toEqual(['x', 'y'])
  })
})

describe('what a piece says', () => {
  const clock = (at: string) => at.slice(11, 16)

  it('says a word or a time at the end of its row, and nothing for waiting work', () => {
    expect(queueAt({ kind: 'ready' }, clock)).toBe('next')
    expect(queueAt({ kind: 'held' }, clock)).toBe('held')
    expect(queueAt({ kind: 'scheduled', at: '2026-10-12T18:00:00.000Z' }, clock)).toBe('18:00')
    expect(queueAt({ kind: 'paused', all: false, parked: true }, clock)).toBe('parked')
    expect(queueAt({ kind: 'paused', all: true, parked: false }, clock)).toBe('paused')
    expect(queueAt({ kind: 'waiting', on: ['p/a'] }, clock)).toBe('')
  })

  it('says what it waits on without its own project’s name, which is the heading over it', () => {
    expect(queueLine({ kind: 'waiting', on: ['p/a', 'other/b'] }, 'p')).toBe('after a and other/b')
    expect(queueLine({ kind: 'held', because: 'both change src/a.ts' }, 'p')).toBe(
      'held: both change src/a.ts',
    )
    expect(queueLine({ kind: 'ready' }, 'p')).toBe('')
  })

  it('says a whole queue paused once, and not for one piece paused on its own', () => {
    const all = { kind: 'paused', all: true, parked: false }
    const one = { kind: 'paused', all: false, parked: false }
    expect(queuePaused([{ state: all }, { state: all }])).toBe(true)
    expect(queuePaused([{ state: all }, { state: one }])).toBe(false)
    expect(queuePaused([])).toBe(false)
  })
})

describe('the agents down the side', () => {
  const task = (name: string, over: Record<string, unknown> = {}) => ({
    name,
    state: 'working',
    createdAt: `2026-10-12T0${name.length}:00:00.000Z`,
    agents: 1,
    lanes: 1,
    effort: null as string | null,
    ...over,
  })

  it('lists what was started, in the order it was made, never by state', () => {
    // A list that reorders itself when an agent finishes moves the row
    // somebody was about to press.
    const tasks = [
      task('ccc', { state: 'failed' }),
      task('a'),
      task('bb', { state: 'review' }),
      task('queued', { state: 'queued', agents: 0 }),
      task('merged', { state: 'merged' }),
      task('put-away', { state: 'parked', agents: 0, lanes: 0 }),
    ]
    expect(sideAgents(tasks).map((one) => one.name)).toEqual(['a', 'bb', 'ccc'])
  })

  it('groups by run only once there are two, the rest last and unheaded', () => {
    const one = [task('a', { effort: 'x' }), task('b', { effort: 'x' })]
    expect(agentGroups(one)).toEqual([{ effort: null, agents: one }])
    const two = [task('a', { effort: 'x' }), task('b'), task('c', { effort: 'y' })]
    expect(
      agentGroups(two).map((group) => [group.effort, group.agents.map((t) => t.name)]),
    ).toEqual([
      ['x', ['a']],
      ['y', ['c']],
      [null, ['b']],
    ])
  })
})

describe('the folds a device keeps', () => {
  it('reads back exactly what it wrote, and every dock open from nothing', () => {
    expect(FOLDS).toEqual(['menu', 'side', 'tade'])
    expect(foldsFrom(null)).toEqual({ menu: false, side: false, tade: false })
    expect(foldsFrom(foldsTo({ menu: true, side: false, tade: true }))).toEqual({
      menu: true,
      side: false,
      tade: true,
    })
  })

  it('knows no word but the three, so nothing else rides in on the key', () => {
    expect(foldsFrom('side,someone-else’s,{"x":1}')).toEqual({
      menu: false,
      side: true,
      tade: false,
    })
    expect(Object.keys(foldsFrom(42))).toEqual([...FOLDS])
  })
})
