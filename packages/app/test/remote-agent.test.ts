import { type Held, heldFor } from '@tade/remotes-core'
import type { Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { whereYouAre } from '../src/inbox.ts'
import { goElsewhere, machineOf, screenOf } from '../src/machines.ts'
import { initialState, laneThere, laneWithKeyboard, withProjects } from '../src/model.ts'
import { NOW } from './screens/scenarios/fixtures.ts'

// An agent on another machine, opened in this window: what the fold keeps of
// its row for acting on it, its screen there read as text, and the terminal
// here that is it. How it is drawn is an agent here's drawing, held equal to
// one by `same-there.test.ts`.

const ESCAPES = '\x1b]0;pwned\x07\x1b[2J\x1b[31mred\x1b[0m\u009b6n\x1b]52;c;eA==\x07'

/** A row as the away protocol sends one, anything in it. */
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tade/intake-door',
    project: 'tade',
    name: 'intake-door',
    mark: 'needs-you',
    state: 'blocked',
    reason: 'wants approval',
    movedAt: new Date(NOW - 60_000).toISOString(),
    title: { words: 'The intake door', more: false },
    rev: 'r9',
    parked: false,
    lane: 'running',
    approval: { id: 'call-7', tool: 'Bash', since: new Date(NOW).toISOString() },
    can: [
      { verb: 'park', how: 'now' },
      { verb: 'answer', how: 'now' },
      { verb: 'steer', how: 'now' },
      { verb: 'stop', how: 'now' },
    ],
    cannot: [{ verb: 'reopen', why: 'its agent is running' }],
    ...over,
  }
}

function held(tasks: Record<string, unknown>[], over: Partial<Held> = {}): Held {
  const snapshot = {
    v: 1,
    fresh: { at: new Date(NOW).toISOString(), epoch: 'e1', rev: 41 },
    projects: [{ name: 'tade', title: null, open: true, counts: { tasks: 1, shown: 1 } }],
    tasks,
    queue: [],
  } as unknown as Snapshot
  return {
    ...heldFor('vps'),
    link: { kind: 'live', since: NOW - 60_000 },
    projection: snapshot,
    heardAt: NOW,
    ...over,
  }
}

const looking = (agent = 'tade/intake-door') =>
  goElsewhere(withProjects(initialState(), ['checkout']), {
    machine: 'vps',
    project: 'tade',
    agent,
  })

describe('what is kept of a row there, for acting on it', () => {
  it('keeps what an act echoes and names, and the verbs that machine offers', () => {
    const agent = machineOf(held([row()]), 0).projects[0]?.agents[0]
    expect(agent).toMatchObject({
      rev: 'r9',
      approval: { id: 'call-7', tool: 'Bash' },
      parked: false,
      lane: 'running',
      can: ['park', 'answer', 'steer', 'stop'],
    })
    expect(machineOf(held([row()]), 0).rev).toBe(41)
  })

  it('keeps nothing it would echo that is not a short token, and draws a tool’s name as text', () => {
    const agent = machineOf(
      held([
        row({
          rev: 'r 9; rm',
          approval: { id: 'x\x1b[2Jy', tool: `Bash${ESCAPES}` },
          lane: 'exploded',
          can: ['park', { verb: 7 }, { verb: 'ste er' }, { verb: 'stop' }],
        }),
      ]),
      0,
    ).projects[0]?.agents[0]
    expect(agent?.rev).toBeNull()
    expect(agent?.approval).toBeNull()
    expect(agent?.lane).toBe('none')
    expect(agent?.can).toEqual(['stop'])
    const named = machineOf(held([row({ approval: { id: 'c1', tool: `Bash${ESCAPES}` } })]), 0)
      .projects[0]?.agents[0]?.approval
    expect(named?.tool).toBe('Bash␛red␛')
  })
})

describe('the command an approval there is for', () => {
  it('keeps the command that machine sent whole, every line of it, and what it did not send', () => {
    const command = { text: `npm i stripe@15 &&\n  ./scripts/x.sh ${ESCAPES}`, notShown: 12 }
    const approval = machineOf(
      held([row({ approval: { id: 'call-7', tool: 'Bash', since: 'x', command } })]),
      0,
    ).projects[0]?.agents[0]?.approval
    // Read whole: its line break kept, and every escape a mark rather than taken out.
    expect(approval?.command?.text).toBe(
      'npm i stripe@15 &&\n  ./scripts/x.sh ␛]0;pwned␛␛[2J␛[31mred␛[0m␛6n␛]52;c;eA==␛',
    )
    expect(approval?.command?.notShown).toBe(12)
  })

  it('cuts a command past its bound and counts what it cut, and reads anything else as none sent', () => {
    const long = { text: 'x'.repeat(9_000), notShown: 3 }
    const cut = machineOf(held([row({ approval: { id: 'c', tool: 'Bash', command: long } })]), 0)
      .projects[0]?.agents[0]?.approval?.command
    expect([...(cut?.text ?? '')]).toHaveLength(8_000)
    expect(cut?.notShown).toBe(1_003)
    for (const odd of [null, 'rm -rf /', { text: 7 }, { words: 'npm i' }]) {
      const none = machineOf(held([row({ approval: { id: 'c', tool: 'Bash', command: odd } })]), 0)
      expect(none.projects[0]?.agents[0]?.approval?.command).toBeNull()
    }
    const counted = machineOf(
      held([row({ approval: { id: 'c', tool: 'Bash', command: { text: 'ls', notShown: -4 } } })]),
      0,
    ).projects[0]?.agents[0]?.approval?.command
    expect(counted).toEqual({ text: 'ls', notShown: 0 })
  })
})

describe('an agent’s screen there, read as text', () => {
  it('keeps the rows as text, indent and all, and says when that machine read them', () => {
    const read = screenOf(
      'tade/a',
      {
        screen: {
          lines: [`  ${ESCAPES}indented`, 'plain   ', 7],
          at: new Date(NOW - 5_000).toISOString(),
          above: 3,
        },
        why: null,
      },
      -1_000,
    )
    expect(read.lines).toEqual(['  ␛red␛indented', 'plain', ''])
    expect(read.at).toBe(NOW - 6_000)
    expect(read.above).toBe(3)
    expect(read.why).toBeNull()
  })

  it('keeps a screen to its bound, and counts what it left out', () => {
    const lines = Array.from({ length: 100 }, (_, n) => `row ${n} ${'x'.repeat(400)}`)
    const read = screenOf('tade/a', { screen: { lines, at: null, above: 0 } }, 0)
    expect(read.lines).toHaveLength(60)
    expect(read.lines[0]?.startsWith('row 40 ')).toBe(true)
    expect(Math.max(...read.lines.map((one) => [...one].length))).toBeLessThanOrEqual(240)
    expect(read.above).toBe(40)
  })

  it('says why there is none, in this window’s words, and reads anything else as no screen', () => {
    expect(screenOf('tade/a', { screen: null, why: 'not read yet' }, 0).why).toBe(
      'reading its screen…',
    )
    expect(screenOf('tade/a', { screen: null, why: 'no agent' }, 0).why).toBe(
      'no agent is running there',
    )
    for (const odd of [null, 'html', { screen: 'x' }, { why: '\x1b[2J' }]) {
      expect(screenOf('tade/a', odd, 0).why).toBe('that machine answered with no screen')
    }
  })
})

describe('a terminal here that is the agent there', () => {
  const LANE = 'remotes/vps/1'
  const attached = (over: Partial<ReturnType<typeof looking>> = {}) => {
    const state = looking()
    return {
      ...state,
      elsewhere: { ...state.elsewhere!, lane: LANE },
      terminals: [{ id: LANE, project: '', name: 'vps · intake-door' }],
      ...over,
    }
  }

  it('is the pane’s and has its keyboard — but not while the panel below has it, or it has gone', () => {
    expect(laneThere(attached())).toBe(LANE)
    expect(laneWithKeyboard(attached())).toBe(LANE)
    // One lane is drawn in one place: in front below, the pane reads it over the link.
    expect(laneThere(attached({ bottom: LANE }))).toBeNull()
    // A terminal that closed is not a lane to draw or type into.
    expect(laneThere(attached({ terminals: [] }))).toBeNull()
    // The orchestrator's line open is typing there, not into the lane.
    expect(laneWithKeyboard(attached({ dictation: '' }))).toBeNull()
    // An agent here in front is in front, whatever is remembered of a place there.
    expect(laneThere(attached({ focused: 'checkout/one' }))).toBeNull()
  })
})

describe('where you are, told to the orchestrator', () => {
  it('names the agent there you opened, as another machine’s and not one here', () => {
    expect(
      whereYouAre({
        project: 'checkout',
        agent: null,
        projects: ['checkout'],
        elsewhere: { machine: 'vps', project: 'tade', agent: 'tade/intake-door' },
      }),
    ).toBe(
      "You are looking at tade/intake-door on vps, an agent of another machine's Tade — not one here.",
    )
  })
})
