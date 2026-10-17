import { isText } from '@tade/core'
import { type Held, heldFor } from '@tade/remotes-core'
import type { Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { whereYouAre } from '../src/inbox.ts'
import {
  ageThere,
  elsewhereOf,
  goElsewhere,
  type Machines,
  machineOf,
  skewOf,
} from '../src/machines.ts'
import { focusTask, initialState, selectProject, withProjects, withTasks } from '../src/model.ts'
import { menuPanel } from '../src/panels/menu/state.ts'
import { spendPanel } from '../src/panels/spend/state.ts'
import { PLAIN } from '../src/skin.ts'
import { draw } from '../src/view.ts'
import { frame, NOW } from './screens/scenarios/fixtures.ts'

// What another machine's Tade said about its work, read for the window
// (`machines.ts`). The projection comes over the link read for its shape and
// not field by field, so what is here is a remote that sends anything — and
// the one promise held whatever it sends: nothing it wrote reaches this
// machine's terminal as anything but text.

/** Everything a terminal reads as an instruction, in one title. */
const ESCAPES = [
  '\x1b]0;pwned\x07', // the window's title
  '\x1b[2J\x1b[H', // clear the screen, cursor home
  '\x1b[?1049h', // the alternate screen
  '\x1b]52;c;cm0gLXJmIH4=\x07', // the clipboard
  '\u009b6n', // ask where the cursor is, eight-bit
  '\x1bP+q544e\x1b\\', // a device control string
  '\x1b]8;;https://evil.example\x1b\\', // a link
  '\x1b[31mfix the build\x1b[0m',
  '‮', // reorder what comes after
  '\x07\x08\x00',
].join('')

/** A projection as a remote might send one: the away protocol's names, anything in them. */
function projection(over: Record<string, unknown> = {}): Snapshot {
  return {
    v: 1,
    fresh: { at: new Date(NOW).toISOString(), epoch: 'e1', rev: 4 },
    pages: { tasks: { total: 3, omitted: 0 } },
    projects: [{ name: 'tade', title: null, open: true, counts: { tasks: 3, shown: 3 } }],
    tasks: [
      {
        id: 'tade/remote-link',
        project: 'tade',
        name: 'remote-link',
        mark: 'working',
        state: 'working',
        reason: 'agent running',
        movedAt: new Date(NOW - 4 * 60_000).toISOString(),
        title: { words: ESCAPES, more: false },
        spend: { usd: 1.5, usdExact: 1.5, usdEstimated: 0, usdListed: 0, tokens: 4000 },
      },
      {
        id: 'tade/intake-door',
        project: 'tade',
        name: 'intake-door',
        mark: 'needs-you',
        state: 'blocked',
        reason: `wants approval ${ESCAPES}`,
        movedAt: new Date(NOW - 12 * 60_000).toISOString(),
        title: null,
        spend: { usd: 0.25, usdExact: 0, usdEstimated: 0.25, usdListed: 0, tokens: 1000 },
      },
      {
        id: 'tade/linear',
        project: 'tade',
        name: 'linear',
        mark: 'stopped',
        state: 'queued',
        reason: 'queued',
        movedAt: null,
        title: null,
        spend: null,
      },
    ],
    queue: [{ task: 'tade/linear', state: { kind: 'paused' } }],
    ...over,
  } as unknown as Snapshot
}

/** What a link holds for `vps` once that projection arrived, at `NOW`. */
function held(over: Partial<Held> = {}, snapshot: Snapshot | null = projection()): Held {
  return {
    ...heldFor('vps'),
    link: { kind: 'live', since: NOW - 60_000 },
    projection: snapshot,
    heardAt: NOW,
    ...over,
  }
}

/** Every code point in anything, however deep, that is not text. */
function notText(value: unknown): number[] {
  const out: number[] = []
  const walk = (one: unknown): void => {
    if (typeof one === 'string')
      for (const char of one) {
        const point = char.codePointAt(0) ?? 0
        if (!isText(point)) out.push(point)
      }
    else if (Array.isArray(one)) one.forEach(walk)
    else if (typeof one === 'object' && one !== null) Object.values(one).forEach(walk)
  }
  walk(value)
  return out
}

const here = () =>
  focusTask(
    withTasks(withProjects(initialState(), ['checkout']), [
      { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
    ]),
    'checkout/refunds',
  )

describe('a remote’s projection, read for the window', () => {
  it('is text and nothing else, whatever the remote wrote in a title', () => {
    const machine = machineOf(held(), 0)
    expect(notText(machine)).toEqual([])
    const agent = machine.projects[0]?.agents[0]
    // What was taken out is marked where it was, never dropped in silence.
    expect(agent?.title).toBe('␛fix the build␛')
    expect(machine.projects[0]?.agents[1]?.reason).toBe('wants approval ␛fix the build␛')
  })

  it('draws a title full of escapes without one escape byte, wherever it is drawn', () => {
    const machines: Machines = { here: 'this Mac', remotes: [machineOf(held(), 0)] }
    const standing = goElsewhere(here(), { machine: 'vps', project: 'tade' })
    const screens = [
      draw(here(), frame({ skin: PLAIN, width: 160, machines })),
      draw(standing, frame({ skin: PLAIN, width: 160, machines })),
      draw(standing, frame({ skin: PLAIN, width: 60, height: 20, machines })),
      draw({ ...standing, panel: spendPanel() }, frame({ skin: PLAIN, width: 160, machines })),
      draw(
        { ...standing, panel: menuPanel({ kind: 'machine', machine: 'vps' }, 'vps') },
        frame({ skin: PLAIN, width: 160, machines }),
      ),
    ]
    for (const drawn of screens) {
      // The plain skin paints nothing. What is left is the terminal library's
      // own: the reset after a cut (`…`), and the empty link an overlay closes
      // with — never one with an address. Anything else came from the remote.
      const text = drawn.rows.join('\n').replaceAll('\x1b[0m', '').replaceAll('\x1b]8;;\x07', '')
      expect(text).not.toContain('\x1b')
      expect(text).not.toContain('\u009b')
      expect(text).not.toContain('pwned')
      expect(notText(text.replaceAll('\n', ''))).toEqual([])
    }
    expect(screens[1]?.rows.join('\n')).toContain('fix the build')
  })

  it('reads a projection of the wrong shape as what it can, and never throws', () => {
    const odd = projection({
      projects: [7, null, { name: 42 }, { name: 'web', open: true, title: { words: 9 } }],
      tasks: [
        'not a row',
        { id: 'web/a', project: 'web', name: 'a', mark: 'exploded', state: 'working' },
        { id: 'web/b', project: 'web', name: '', mark: 'done' },
        { id: 7, project: 'web', name: 'c' },
        { id: 'web/d', project: 'web', name: 'x'.repeat(5000), mark: 'done' },
      ],
      queue: 'nope',
      pages: null,
    })
    const machine = machineOf(held({}, odd), 0)
    const web = machine.projects.find((one) => one.name === 'web')
    expect(web?.title).toBeNull()
    expect(web?.agents.map((one) => one.mark)).toEqual(['stopped', 'done'])
    // A name a remote sent five thousand characters of is bounded here.
    expect([...(web?.agents[1]?.name ?? '')].length).toBeLessThanOrEqual(80)
    expect(machine.spend?.partial).toBe(false)
  })

  it('carries the remote’s own marks, counted the way a tab here counts them', () => {
    const [project] = machineOf(held(), 0).projects
    expect(project?.agents.map((one) => [one.name, one.mark, one.counts, one.queued])).toEqual([
      ['remote-link', 'working', 'working', false],
      ['intake-door', 'needs-you', 'needs-you', false],
      ['linear', 'stopped', 'parked', true],
    ])
  })

  it('leaves out a project closed there, and says how many tasks the remote held back', () => {
    const machine = machineOf(
      held(
        {},
        projection({
          projects: [
            { name: 'tade', open: true, counts: { tasks: 9, shown: 3 } },
            { name: 'old', open: false },
          ],
          pages: { tasks: { total: 9, omitted: 6 } },
        }),
      ),
      0,
    )
    expect(machine.projects.map((one) => [one.name, one.more])).toEqual([['tade', 6]])
    expect(machine.spend?.partial).toBe(true)
  })

  it('adds up what its agents spent, the three kinds of dollar kept apart', () => {
    expect(machineOf(held(), 0).spend).toMatchObject({
      usd: 1.75,
      usdExact: 1.5,
      usdEstimated: 0.25,
      tokens: 5000,
    })
  })
})

describe('ages, from the remote’s own moments', () => {
  it('moves the remote’s moments into this clock, so a clock an hour ahead is not an hour off', () => {
    const ahead = 3_600_000
    const snapshot = projection({
      fresh: { at: new Date(NOW + ahead).toISOString(), epoch: 'e1', rev: 4 },
      tasks: [
        {
          id: 'tade/a',
          project: 'tade',
          name: 'a',
          mark: 'working',
          movedAt: new Date(NOW + ahead - 4 * 60_000).toISOString(),
        },
      ],
    })
    const one = held({}, snapshot)
    const skew = skewOf(one)
    expect(skew).toBe(-ahead)
    const machine = machineOf(one, skew ?? 0)
    const agent = machine.projects[0]?.agents[0]
    expect(agent && ageThere(agent, machine, NOW)).toBe(4 * 60_000)
  })

  it('stops counting while the link is down, and keeps every row as it last was', () => {
    const asOf = NOW - 8 * 60_000
    const down = machineOf(
      held({
        link: {
          kind: 'down',
          since: asOf,
          tries: 2,
          problem: 'timed out',
          said: `gone ${ESCAPES}`,
        },
        heardAt: asOf,
      }),
      0,
    )
    expect(down.link).toBe('down')
    expect(down.said).toBe('gone ␛fix the build␛')
    expect(down.projects[0]?.agents).toHaveLength(3)
    const agent = down.projects[0]?.agents[0]
    // Moved four minutes before NOW, which is after it was last heard from: no age below nought.
    expect(agent && ageThere(agent, down, NOW + 3_600_000)).toBe(0)
  })

  it('says nothing about a remote nothing has been heard from', () => {
    const machine = machineOf(held({ link: { kind: 'idle' }, heardAt: null }, null), 0)
    expect(machine).toMatchObject({ link: 'linking', heard: false, projects: [], spend: null })
  })
})

describe('standing in a project on another machine', () => {
  it('puts nothing of this machine in front, and keeps where you were here', () => {
    const away = goElsewhere(here(), { machine: 'vps', project: 'tade' })
    expect(elsewhereOf(away)).toEqual({ machine: 'vps', project: 'tade' })
    expect(away.focused).toBeNull()
    expect(away.spots.checkout?.focused).toBe('checkout/refunds')
    // Coming back is the project's tab, and lands where you were.
    const back = selectProject(away, 'checkout')
    expect(elsewhereOf(back)).toBeNull()
    expect(back.elsewhere).toBeNull()
    expect(back.focused).toBe('checkout/refunds')
  })

  it('gives way to an agent here put in front, and lets go of the place', () => {
    const away = goElsewhere(here(), { machine: 'vps', project: 'tade' })
    const raised = { ...away, focused: 'checkout/refunds' }
    expect(elsewhereOf(raised)).toBeNull()
    expect(focusTask(away, 'checkout/refunds').elsewhere).toBeNull()
    // However it came in front, the next beat lets go of the place, so closing
    // that agent later is not a way back to another machine nobody asked for.
    const beat = withTasks(raised, [
      { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
    ])
    expect(beat.elsewhere).toBeNull()
  })

  it('a status beat does not write the spot here over while you stand there', () => {
    const away = goElsewhere(here(), { machine: 'vps', project: 'tade' })
    const beat = withTasks(away, [
      { task: 'checkout/refunds', state: 'working', lane: 'checkout/refunds/agent' },
    ])
    expect(beat.spots.checkout?.focused).toBe('checkout/refunds')
    expect(elsewhereOf(beat)).toEqual({ machine: 'vps', project: 'tade' })
  })

  it('tells the orchestrator it is another machine’s, so a project here with the name is not taken for it', () => {
    expect(
      whereYouAre({
        project: 'checkout',
        agent: null,
        projects: ['checkout', 'tade'],
        elsewhere: { machine: 'vps', project: 'tade' },
      }),
    ).toBe("You are looking at tade on vps, another machine's Tade — not a project here.")
  })
})
