import { isText } from '@tade/core'
import { type Held, heldFor } from '@tade/remotes-core'
import type { Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import type { Frame } from '../src/frame.ts'
import { whereYouAre } from '../src/inbox.ts'
import { goElsewhere, type Machines, machineOf, screenOf } from '../src/machines.ts'
import { initialState, withProjects } from '../src/model.ts'
import { PLAIN } from '../src/skin.ts'
import { controlsOf } from '../src/view/remote-agent.ts'
import { draw } from '../src/view.ts'
import { frame, NOW } from './screens/scenarios/fixtures.ts'

// An agent on another machine, opened in this window: what the fold keeps of
// its row for acting on it, its screen there read as text, and the pane that
// draws both — with a control only for what that machine says may be asked.

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

const machines = (one: Held): Machines => ({ here: 'this Mac', remotes: [machineOf(one, 0)] })

const looking = (agent = 'tade/intake-door') =>
  goElsewhere(withProjects(initialState(), ['checkout']), {
    machine: 'vps',
    project: 'tade',
    agent,
  })

/** A screen as that machine sends one, read the one way the window reads it. */
const screen = (lines: string[]): NonNullable<Frame['remoteScreen']> =>
  screenOf(
    'tade/intake-door',
    { screen: { lines, at: new Date(NOW - 2_000).toISOString(), above: 0 } },
    0,
  )

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

  it('draws the whole command on the card, wrapped under itself, with what was not sent counted', () => {
    const command = {
      text: `gh api repos/acme/checkout/hooks --method POST -f name=web -f config[url]=https://vps.example.com/hooks/github ${ESCAPES}\n./scripts/after.sh`,
      notShown: 40,
    }
    const one = held([row({ approval: { id: 'call-7', tool: 'Bash', command } })])
    const text = draw(
      looking(),
      frame({ skin: PLAIN, width: 90, machines: machines(one), remoteScreen: screen(['>']) }),
    ).rows.join('\n')
    expect(text).toContain('wants approval')
    expect(text).toContain('Bash  gh api repos/acme/checkout/hooks')
    // Its second line is a line of its own, and nothing of it is dropped before the count.
    expect(text).toContain('./scripts/after.sh')
    // Wrapped under itself where the pane runs out, never cut at its edge.
    expect(text).toContain('config[url]=https://vps.example.com/hooks/')
    expect(text).toMatch(/\n[^\n]*│ {8}github /)
    expect(text).toContain('… 40 characters not shown')
    expect(text).not.toContain('pwned\x07')
    const plain = text.replaceAll('\x1b[0m', '').replaceAll('\x1b]8;;\x07', '')
    expect(plain).not.toContain('\x1b')
  })

  it('says that machine sent no command, rather than asking for a yes on the tool’s name alone', () => {
    const text = draw(
      looking(),
      frame({ skin: PLAIN, width: 120, machines: machines(held([row()])) }),
    ).rows.join('\n')
    expect(text).toContain('wants approval')
    expect(text).toContain('Bash  vps did not send the command')
    expect(text).toContain('allow')
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

describe('the pane, looking at an agent there', () => {
  it('draws its screen, read-only, with a control for each thing that machine says may be asked', () => {
    const one = held([row()])
    const drawn = draw(
      looking(),
      frame({
        skin: PLAIN,
        width: 140,
        machines: machines(one),
        remoteScreen: screen(['> fixing the intake door', `  ${ESCAPES}`]),
      }),
    )
    const text = drawn.rows.join('\n')
    expect(text).toContain('The intake door')
    expect(text).toContain('> fixing the intake door')
    expect(text).toContain('its screen on vps · read-only')
    for (const label of ['type into it', 'steer…', 'park', 'stop', 'allow', 'deny']) {
      expect(text).toContain(label)
    }
    expect(text).not.toContain('open again')
    const actions = drawn.hits.flatMap((hit) =>
      hit.target.kind === 'action' ? [hit.target.name] : [],
    )
    for (const name of [
      'remote-attach',
      'remote-steer',
      'remote-park',
      'remote-stop',
      'remote-allow',
      'remote-deny',
      'remote-look:tade/intake-door',
    ]) {
      expect(actions).toContain(name)
    }
    // Nothing that machine's agent printed reaches this terminal as anything but text.
    const plain = text.replaceAll('\x1b[0m', '').replaceAll('\x1b]8;;\x07', '')
    expect(plain).not.toContain('\x1b')
    expect(plain).not.toContain('pwned')
    expect([...plain.replaceAll('\n', '')].every((char) => isText(char.codePointAt(0) ?? 0))).toBe(
      true,
    )
  })

  it('offers nothing while its link is down, and says so, keeping what it last read', () => {
    const down = held([row()], {
      link: { kind: 'down', since: NOW, tries: 1, problem: 'timed out', said: 'gone quiet' },
    })
    const text = draw(
      looking(),
      frame({
        skin: PLAIN,
        width: 140,
        machines: machines(down),
        remoteScreen: screen(['> last thing it said']),
      }),
    ).rows.join('\n')
    expect(text).toContain('vps is not linked: nothing can be asked of it until it is')
    expect(text).toContain('> last thing it said')
    expect(text).not.toContain('type into it')
    expect(controlsOf(machineOf(down, 0).projects[0]!.agents[0]!, machineOf(down, 0))).toEqual([])
  })

  it('offers what a stopped, parked or queued agent can be asked, and nothing it cannot', () => {
    const offered = (over: Record<string, unknown>) => {
      const machine = machineOf(held([row(over)]), 0)
      return controlsOf(machine.projects[0]!.agents[0]!, machine).map((one) => one.action)
    }
    expect(
      offered({ lane: 'stopped', approval: null, can: [{ verb: 'reopen' }, { verb: 'park' }] }),
    ).toEqual(['remote-reopen', 'remote-park'])
    expect(offered({ parked: true, can: [{ verb: 'park' }] })).toEqual([
      'remote-attach',
      'remote-unpark',
    ])
    expect(
      offered({ state: 'queued', lane: 'none', approval: null, can: [{ verb: 'queue' }] }),
    ).toEqual(['remote-start'])
  })

  it('says why there is no screen yet rather than drawing an empty one', () => {
    const text = draw(
      looking(),
      frame({
        skin: PLAIN,
        width: 140,
        machines: machines(held([row()])),
        remoteScreen: { ...screen([]), why: 'reading its screen…' },
      }),
    ).rows.join('\n')
    expect(text).toContain('reading its screen…')
  })

  it('lights the agent looked at down the side, and every row of one there is a press', () => {
    const one = held([row(), row({ id: 'tade/other', name: 'other', title: null })])
    const drawn = draw(looking(), frame({ skin: PLAIN, width: 140, machines: machines(one) }))
    const presses = drawn.hits.flatMap((hit) =>
      hit.target.kind === 'action' && hit.target.name.startsWith('remote-look:')
        ? [hit.target.name]
        : [],
    )
    expect(new Set(presses)).toEqual(
      new Set(['remote-look:tade/intake-door', 'remote-look:tade/other']),
    )
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
