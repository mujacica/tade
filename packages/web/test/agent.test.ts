import { describe, expect, it } from 'vitest'
import { activitySaid, agentOf } from '../src/agent.ts'
import { AgentOutSchema } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import {
  agentHeld,
  earlierActivity,
  HELD_KEY,
  input,
  NOW,
  PRIVATE,
  reach,
  task,
} from './fixtures.ts'

// One agent, as a device looking at it reads it.

const TASK = 'sentry/away-projection'
const tasks = input().tasks

describe('one agent, for one device', () => {
  it('is a strict answer', () => {
    const answer = agentOf(tasks, TASK, agentHeld())
    expect(() => AgentOutSchema.parse(answer)).not.toThrow()
  })

  it('gives the cleaned screen', () => {
    const answer = agentOf(tasks, TASK, agentHeld())
    expect(answer.why).toBeNull()
    expect(answer.screen?.lines).toContain('  4 files touched, the tests pass')
    expect(answer.screen?.at).toBe('2026-10-08T14:29:58.000Z')
    expect(answer.screen?.taken).toBeGreaterThan(0)
    const said = JSON.stringify(answer)
    for (const one of [PRIVATE.root, PRIVATE.credential, PRIVATE.opaque, HELD_KEY, 'testperson']) {
      expect(said).not.toContain(one)
    }
  })

  it('answers a task that is not there as not here', () => {
    const missing = agentOf(tasks, 'sentry/nothing-here', agentHeld())
    expect(missing).toMatchObject({ here: false, activity: [], screen: null, why: 'not here' })
  })

  it('tells nothing read yet apart from nothing running', () => {
    const working = agentOf(tasks, TASK, null)
    expect(working.why).toBe('not read yet')
    const idle = agentOf([task({ agents: 0, lanes: 0 })], TASK, null)
    expect(idle.why).toBe('no agent')
    const gone = agentOf(tasks, TASK, agentHeld({ lane: { kind: 'none', why: 'could not read' } }))
    expect(gone.why).toBe('could not read')
  })

  it('carries as much activity as the budget allows, and where the moments before are read from', () => {
    const answer = agentOf(tasks, TASK, agentHeld(), {
      lines: 10,
      width: 80,
      activity: 2,
    })
    expect(answer.activity.map((one) => one.id)).toEqual(['107', '106'])
    // The number of the last one looked at: the moments before it are read by it.
    expect(answer.earlier).toBe('106')
    expect(agentOf(tasks, TASK, agentHeld()).earlier).toBe('100')
    expect(agentOf(tasks, TASK, agentHeld({ earlier: null })).earlier).toBeNull()
  })
})

describe('an agent’s moments as Tade says them', () => {
  it('says each in Tade’s words, down to its making', () => {
    expect(earlierActivity().map((one) => activitySaid(one))).toEqual([
      'its agent stopped',
      'committed',
      'tests failed',
      'its agent started',
      'was made',
    ])
  })
})

describe('what Tade says about a moment', () => {
  it('says a tool by its name, and a name that is a path not at all', () => {
    expect(activitySaid({ at: NOW, kind: 'used', what: 'Bash', ok: null })).toBe('used Bash')
    expect(
      activitySaid({ at: NOW, kind: 'used', what: `${PRIVATE.root}/bin/tool`, ok: null }),
    ).toBe('used a tool')
    expect(activitySaid({ at: NOW, kind: 'asked', what: 'Bash: rm -rf /', ok: null })).toBe(
      'asked to use a tool',
    )
  })

  it('says a state only where it is one of `deriveState`’s', () => {
    expect(activitySaid({ at: NOW, kind: 'state', what: 'blocked', ok: null })).toBe('is blocked')
    expect(activitySaid({ at: NOW, kind: 'state', what: 'whatever', ok: null })).toBeNull()
  })

  it('says how a check went, and nothing about a check with no name', () => {
    expect(activitySaid({ at: NOW, kind: 'checked', what: 'tests', ok: false })).toBe(
      'tests failed',
    )
    expect(activitySaid({ at: NOW, kind: 'checked', what: '', ok: true })).toBeNull()
  })

  it('leaves out a moment there is nothing honest to say about', () => {
    const answer = agentOf(tasks, TASK, agentHeld())
    expect(answer.activity.map((one) => one.said)).not.toContain('is not-a-state')
    expect(JSON.stringify(answer.activity)).not.toContain('testperson')
  })
})

describe('a projector answers it out of what it was handed', () => {
  it('asks the window about the agent at the moment it is asked', () => {
    const asked: string[] = []
    const held = projector(input({ reach: reach() }), NOW, {
      agent: (one) => {
        asked.push(one)
        return agentHeld()
      },
    })
    expect(asked).toEqual([])
    expect(held.agent(TASK).screen).not.toBeNull()
    expect(asked).toEqual([TASK])
  })

  it('answers not read yet where nothing was handed over', () => {
    const held = projector(input({ reach: reach() }), NOW)
    expect(held.agent(TASK).why).toBe('not read yet')
  })
})
