import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { stopsOf } from '../src/assets/charts.js'
import {
  commandsFor,
  GROUP_MOST,
  litOf,
  matchOf,
  movedTo,
  RECENT_MOST,
  rememberedWith,
  scoreOf,
} from '../src/assets/commands.js'
import { ICONS } from '../src/assets/icons.js'
import { partsOf } from '../src/assets/live.js'
import { glanceOf, projectShape } from '../src/assets/overview.js'
import { actsOn, jumpsOf } from '../src/assets/palette.js'
import { quickWord } from '../src/assets/quick.js'
import { barsFor } from '../src/assets/shell.js'
import { applySnapshot, emptyStore } from '../src/assets/store.js'
import { reasonFor, reasonWord } from '../src/assets/talk.js'
import { MOST, shownOf, statesOf, transitionsOf } from '../src/assets/toasts.js'
import { assetsDir } from '../src/assets.ts'
import { projector } from '../src/reading.ts'
import { blocked, EVERY, input, NOW, plan, reach, task } from './fixtures.ts'

// The overview, the command bar and the presses on a card — the parts of them
// that are rules rather than drawing, held here with no browser.
//
// **What this cannot see is how any of it looks**, which is the browser
// harness's (`scripts/browser.ts`) and in the end the owner's. What it can see
// is that the figures at the top are the projection's own counts and not a
// second fold that drifts, that the command bar offers a message only where
// the session says a message could be sent, and that every icon the page asks
// for is one the shell actually drew.

const DIR = assetsDir()

/** A page's store, filled from the real projection. */
function held(over = {}) {
  const store = emptyStore()
  const made = projector(input({ reach: reach(EVERY), ...over }), NOW)
  expect(applySnapshot(store, made.snapshot())).toBeNull()
  return store
}

describe('the overview’s figures', () => {
  it('are the projection’s own counts, across every project', () => {
    const store = held()
    const glance = glanceOf(store)
    const tasks = [...store.rows.tasks.values()] as { wantsYou: boolean; agents: number }[]
    expect(glance.wants.n).toBe(tasks.filter((one) => one.wantsYou).length)
    expect(glance.working.n).toBe(tasks.filter((one) => one.agents > 0).length)
    expect(glance.wants.blocked + glance.wants.failed + glance.wants.review).toBe(glance.wants.n)
    expect(glance.queue.n).toBe(store.rows.queue.size)
  })

  it('takes the fullest plan window, because that is the one that stops the work', () => {
    const store = held({
      plans: [
        plan(),
        plan({
          harness: 'codex',
          windows: [
            { label: '5h', used: 81, resetsAt: NOW },
            { label: 'week', used: 33, resetsAt: NOW },
          ],
        }),
      ],
    })
    expect(glanceOf(store).plan).toEqual({ used: 81, label: '5h', harness: 'codex' })
  })

  it('says no plan rather than a plan of nought when nobody reported one', () => {
    expect(glanceOf(held({ plans: [] })).plan).toBeNull()
  })

  it('is nought everywhere before anything was read, and the page says so in words', () => {
    // The tiles draw `—` while `store.had` is false; the fold itself is plain
    // counting over nothing, which is what this holds.
    const glance = glanceOf(emptyStore())
    expect(glance.wants.n).toBe(0)
    expect(glance.plan).toBeNull()
  })

  it('draws a project as the shape of all its work, the part that did not fit included', () => {
    expect(projectShape({ tasks: 10, wantsYou: 2, working: 3, queued: 1 })).toEqual([2, 3, 1, 4])
    // Counts that disagree never draw a negative part.
    expect(projectShape({ tasks: 1, wantsYou: 2, working: 3, queued: 1 })).toEqual([2, 3, 1, 0])
  })
})

describe('a chart', () => {
  it('ends each part where its share of the whole ends', () => {
    expect(stopsOf([3, 1, 1])).toEqual([60, 80, 100])
    expect(stopsOf([1, 0, 0])).toEqual([100, 100, 100])
  })

  it('has no arc at all for nothing, which is not an arc of nought', () => {
    expect(stopsOf([0, 0, 0])).toEqual([])
    expect(stopsOf([])).toEqual([])
  })
})

describe('the command bar', () => {
  const screens = [
    { label: 'Overview', icon: 'overview', path: '/' },
    { label: 'Settings', icon: 'settings', path: '/settings' },
    { label: 'Spend', icon: 'spend', path: '/spend' },
  ]
  const mine = { mine: true, busy: false }

  it('offers what was typed to Tade first, where this device may send it', () => {
    const rows = commandsFor('is anything stuck', { talk: mine, screens })
    expect(rows[0]).toMatchObject({ kind: 'ask', label: 'is anything stuck' })
  })

  it('offers no message where talking is off, not granted, busy, or nothing was typed', () => {
    for (const talk of [null, { mine: false, busy: false }, { mine: true, busy: true }]) {
      expect(commandsFor('hello', { talk, screens }).some((one) => one.kind === 'ask')).toBe(false)
    }
    expect(commandsFor('   ', { talk: mine, screens }).some((one) => one.kind === 'ask')).toBe(
      false,
    )
  })

  it('finds a prefix before a word inside, and a word inside before anywhere', () => {
    expect(scoreOf('sentry', 'se')).toBe(0)
    expect(scoreOf('queue-settings', 'se')).toBe(1)
    expect(scoreOf('reset', 'se')).toBe(2)
    expect(scoreOf('queue', 'se')).toBeNull()
    const rows = commandsFor('se', {
      talk: null,
      screens,
      projects: ['reset', 'sentry'],
    })
    expect(rows.filter((one) => one.group === 'Projects').map((one) => one.label)).toEqual([
      'sentry',
      'reset',
    ])
  })

  it('shows at most a few of each kind, so ninety tasks are still a list', () => {
    const tasks = Array.from({ length: 40 }, (_, at) => ({ id: `p/t${at}`, path: `/t/p/t${at}` }))
    const rows = commandsFor('', { tasks, screens })
    expect(rows.filter((one) => one.group === 'Work')).toHaveLength(GROUP_MOST)
  })

  it('finds the letters in order when nothing better matches, and lights them', () => {
    expect(scoreOf('queue-rules', 'qrs')).toBe(3)
    expect(matchOf('queue-rules', 'qrs')?.at).toEqual([0, 6, 10])
    expect(litOf('queue', [0, 1])).toEqual([
      { text: 'qu', on: true },
      { text: 'eue', on: false },
    ])
  })

  it('finds work by its title as well as its name, and lights only the name it matched', () => {
    const rows = commandsFor('pure data', {
      tasks: [{ id: 'sentry/away-projection', title: 'the pure data boundary', path: '/t/x' }],
    })
    expect(rows[0]).toMatchObject({ kind: 'go', label: 'sentry/away-projection', match: [] })
  })

  it('offers the acts on what wants somebody with nothing typed, and on what matches after', () => {
    const tasks = [
      {
        id: 'p/blocked',
        path: '/t/p/blocked',
        wants: true,
        acts: [{ verb: 'answer', word: 'Allow Bash', typed: { allow: true }, icon: 'check' }],
      },
      {
        id: 'p/working',
        path: '/t/p/working',
        acts: [{ verb: 'steer', word: 'Tell', icon: 'talk' }],
      },
    ]
    const empty = commandsFor('', { tasks })
    expect(empty.filter((one) => one.group === 'Do').map((one) => one.label)).toEqual([
      'Allow Bash',
    ])
    const typed = commandsFor('working', { tasks })
    expect(typed.find((one) => one.group === 'Do')).toMatchObject({
      kind: 'tell',
      task: 'p/working',
    })
  })

  it('remembers a few places, the newest first and each once', () => {
    let held: { path: string; label: string }[] = []
    for (const path of ['/a', '/b', '/a', '/c', '/d', '/e', '/f']) {
      held = rememberedWith(held, { path, label: path })
    }
    expect(held.map((one) => one.path)).toEqual(['/f', '/e', '/d', '/c', '/a'])
    expect(held).toHaveLength(RECENT_MOST)
    const rows = commandsFor('', { recent: held, screens: [{ label: 'F', icon: 'x', path: '/f' }] })
    expect(rows.filter((one) => one.path === '/f')).toHaveLength(1)
  })

  it('offers only the acts the session and the row both allow', () => {
    const row = {
      approval: { tool: 'Bash' },
      parked: false,
      can: [
        { verb: 'answer', how: 'now' },
        { verb: 'done', how: 'now' },
      ],
      cannot: [{ verb: 'park', why: 'no' }],
    }
    expect(actsOn(row, { answer: true, steer: false }).map((one) => one.word)).toEqual([
      'Allow Bash',
      'Deny',
    ])
    expect(actsOn(row, { answer: true, steer: true }).map((one) => one.word)).toEqual([
      'Allow Bash',
      'Deny',
      'Mark done',
    ])
    expect(actsOn(row, {})).toEqual([])
  })

  it('moves the lit row round the list, and nowhere in an empty one', () => {
    expect(movedTo(0, 3, 1)).toBe(1)
    expect(movedTo(2, 3, 1)).toBe(0)
    expect(movedTo(0, 3, -1)).toBe(2)
    expect(movedTo(0, 0, 1)).toBe(-1)
  })

  it('jumps to what wants somebody first, then every agent, each once', () => {
    const store = held({
      tasks: [task(), blocked(), task({ id: 'tade/window', project: 'tade' })],
    })
    const jumps = jumpsOf(store)
    expect(jumps.tasks[0]?.id).toBe('sentry/blocked')
    expect(new Set(jumps.tasks.map((one) => one.id)).size).toBe(jumps.tasks.length)
    expect(jumps.tasks.find((one) => one.id === 'tade/window')?.path).toBe('/t/tade/window')
    expect(jumps.screens.map((one) => one.label)).toContain('Overview')
  })
})

describe('the presses on a card', () => {
  it('say what they do in a word, and the tool an approval is for', () => {
    expect(quickWord('answer', { approval: { tool: 'Bash' } })).toBe('Allow Bash')
    expect(quickWord('park', { parked: false })).toBe('Set aside')
    expect(quickWord('park', { parked: true })).toBe('Resume')
    expect(quickWord('done', {}, true)).toBe('Sure?')
  })
})

describe('an absence, in a word', () => {
  it('has a word for each of the three, and the sentence is still there behind it', () => {
    const off = null
    const ungranted = { mine: false, busy: false }
    const busy = { mine: true, busy: true, whose: 'you' }
    const words = [off, ungranted, busy].map(reasonWord)
    expect(new Set(words).size).toBe(3)
    for (const talk of [off, ungranted, busy]) expect(reasonFor(talk)).not.toBe('')
    expect(reasonWord({ mine: true, busy: false })).toBe('')
    expect(reasonWord(undefined)).toBe('')
  })
})

describe('the icons', () => {
  const html = readFileSync(join(DIR, 'index.html'), 'utf8')
  const drawn = new Set([...html.matchAll(/<symbol id="i-([\w-]+)"/g)].map((one) => one[1]))

  it('are every one drawn in the shell’s sprite, and none drawn that is not named', () => {
    expect([...drawn].sort()).toEqual([...ICONS].sort())
  })

  it('are only ever asked for by a name the sprite has', () => {
    // A name nobody drew is a blank square where an icon should be, and no
    // test that does not look for it would see one.
    for (const name of [
      'shell.js',
      'overview.js',
      'palette.js',
      'quick.js',
      'desk.js',
      'pages.js',
    ]) {
      const text = readFileSync(join(DIR, name), 'utf8')
      for (const found of text.matchAll(/\bicon\('([\w-]+)'/g)) {
        expect(drawn.has(found[1] ?? ''), `${name} asks for ${found[1]}`).toBe(true)
      }
    }
  })
})

describe('what just changed', () => {
  const at = (rows: { id: string; state: string; agents?: number }[]) => statesOf(rows)

  it('says nothing on arriving, which is not a change to anything', () => {
    expect(transitionsOf(null, at([{ id: 'p/a', state: 'blocked', agents: 1 }]))).toEqual([])
  })

  it('names each crossing worth a toast, and nothing that is only a figure moving', () => {
    const was = at([
      { id: 'p/a', state: 'working', agents: 1 },
      { id: 'p/b', state: 'working', agents: 1 },
      { id: 'p/c', state: 'working', agents: 1 },
      { id: 'p/d', state: 'review', agents: 0 },
      { id: 'p/e', state: 'working', agents: 1 },
    ])
    const is = at([
      { id: 'p/a', state: 'blocked', agents: 1 },
      { id: 'p/b', state: 'failed', agents: 0 },
      { id: 'p/c', state: 'review', agents: 0 },
      { id: 'p/d', state: 'merged', agents: 0 },
      { id: 'p/e', state: 'working', agents: 1 },
      { id: 'p/f', state: 'working', agents: 1 },
    ])
    expect(transitionsOf(was, is)).toEqual([
      { id: 'p/a', kind: 'wants' },
      { id: 'p/b', kind: 'failed' },
      { id: 'p/c', kind: 'finished' },
      { id: 'p/d', kind: 'merged' },
      { id: 'p/f', kind: 'started' },
    ])
  })

  it('counts the rest into one past a few, rather than filling the screen', () => {
    const many = Array.from({ length: 7 }, (_, n) => ({ id: `p/${n}`, kind: 'wants' }))
    const shown = shownOf(many)
    expect(shown).toHaveLength(MOST)
    expect(shown.at(-1)?.word).toBe(`${7 - (MOST - 1)} more changed`)
  })
})

describe('the very first ask', () => {
  it('is connecting, with no bar: nothing was read, so nothing is behind', () => {
    const connection = { kind: 'unreachable' as const, sinceAt: 0 }
    expect(partsOf('connecting', connection, '—', 0).words).toBe('connecting')
    expect(barsFor('connecting', connection, emptyStore(), 0, 0)).toEqual([])
    // And a drop after that is reconnecting, with its bar, as before.
    expect(barsFor('reconnecting', connection, emptyStore(), 0, 0)).toHaveLength(1)
  })
})
