import { describe, expect, it } from 'vitest'
import { activitySaid, agentOf, momentsBefore } from '../src/agent.ts'
import { AgentOutSchema, MomentsPageSchema } from '../src/protocol.ts'
import { projector } from '../src/reading.ts'
import {
  agentHeld,
  EVERY,
  earlierActivity,
  HELD_KEY,
  input,
  NOW,
  PRIVATE,
  reach,
  task,
} from './fixtures.ts'

// One agent, as a device looking at it may read it.

const TASK = 'sentry/away-projection'
const tasks = input().tasks

describe('one agent, for one device', () => {
  it('is a strict answer, whatever the grant', () => {
    for (const granted of [[], EVERY]) {
      const answer = agentOf(reach(granted), tasks, TASK, agentHeld())
      expect(() => AgentOutSchema.parse(answer)).not.toThrow()
    }
  })

  it('withholds the screen from a device not granted it, and says that is why', () => {
    const answer = agentOf(reach(EVERY.filter((one) => one !== 'lanes')), tasks, TASK, agentHeld())
    expect(answer.screen).toBeNull()
    // **Not granted, and never *no agent***: the second would be the page
    // blaming the work for the reader's own reach.
    expect(answer.why).toBe('not granted')
    // Not one row of it, under any name.
    expect(JSON.stringify(answer)).not.toContain('Reading the adapter')
    // What it has been doing is Tade's own words and needs no grant.
    expect(answer.activity.length).toBeGreaterThan(0)
  })

  it('gives the cleaned screen to a device granted it', () => {
    const answer = agentOf(reach(['lanes']), tasks, TASK, agentHeld())
    expect(answer.why).toBeNull()
    expect(answer.screen?.lines).toContain('  4 files touched, the tests pass')
    expect(answer.screen?.at).toBe('2026-10-08T14:29:58.000Z')
    expect(answer.screen?.taken).toBeGreaterThan(0)
    const said = JSON.stringify(answer)
    for (const one of [PRIVATE.root, PRIVATE.credential, PRIVATE.opaque, HELD_KEY, 'testperson']) {
      expect(said).not.toContain(one)
    }
  })

  it('answers a task in a project this device may not read as one that is not there', () => {
    const hidden = agentOf(reach(EVERY, ['tade']), tasks, TASK, agentHeld())
    const missing = agentOf(reach(EVERY), tasks, 'sentry/nothing-here', agentHeld())
    // **The same bytes but the name**, so a deep link is not a way of finding
    // out which projects exist.
    expect({ ...hidden, task: '' }).toEqual({ ...missing, task: '' })
    expect(hidden).toMatchObject({ here: false, activity: [], screen: null, why: 'not here' })
  })

  it('tells nothing read yet apart from nothing running', () => {
    const working = agentOf(reach(['lanes']), tasks, TASK, null)
    expect(working.why).toBe('not read yet')
    const idle = agentOf(reach(['lanes']), [task({ agents: 0, lanes: 0 })], TASK, null)
    expect(idle.why).toBe('no agent')
    const gone = agentOf(
      reach(['lanes']),
      tasks,
      TASK,
      agentHeld({ lane: { kind: 'none', why: 'could not read' } }),
    )
    expect(gone.why).toBe('could not read')
  })

  it('carries as much activity as the budget allows, and where the moments before are read from', () => {
    const answer = agentOf(reach(), tasks, TASK, agentHeld(), {
      lines: 10,
      width: 80,
      activity: 2,
    })
    expect(answer.activity.map((one) => one.id)).toEqual(['107', '106'])
    // The number of the last one looked at: the moments before it are read by it.
    expect(answer.earlier).toBe('106')
    expect(agentOf(reach(), tasks, TASK, agentHeld()).earlier).toBe('100')
    expect(agentOf(reach(), tasks, TASK, agentHeld({ earlier: null })).earlier).toBeNull()
  })
})

describe('an agent’s moments before a cursor', () => {
  it('are its moments read further back, said in Tade’s words, with where the ones before are', () => {
    const page = momentsBefore(TASK, true, { activity: earlierActivity(), earlier: null })
    expect(() => MomentsPageSchema.parse(page)).not.toThrow()
    expect(page.activity.map((one) => [one.id, one.said])).toEqual([
      ['60', 'its agent stopped'],
      ['59', 'committed'],
      ['58', 'tests failed'],
      ['57', 'its agent started'],
      ['56', 'was made'],
    ])
    expect(page).toMatchObject({ earlier: null, why: null })
    expect(
      momentsBefore(TASK, true, { activity: earlierActivity().slice(0, 2), earlier: '59' }).earlier,
    ).toBe('59')
  })

  it('are nothing for a task out of reach, and say a journal that could not be read', () => {
    expect(momentsBefore(TASK, false, { activity: earlierActivity(), earlier: '9' })).toMatchObject(
      {
        activity: [],
        earlier: null,
        why: 'not here',
      },
    )
    expect(momentsBefore(TASK, true, 'unread')).toMatchObject({ activity: [], why: 'unread' })
    expect(momentsBefore(TASK, true, null)).toMatchObject({
      activity: [],
      earlier: null,
      why: null,
    })
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
    const answer = agentOf(reach(), tasks, TASK, agentHeld())
    expect(answer.activity.map((one) => one.said)).not.toContain('is not-a-state')
    expect(JSON.stringify(answer.activity)).not.toContain('testperson')
  })
})

describe('a projector answers it out of what it was handed', () => {
  it('asks the window about the agent at the moment it is asked', () => {
    const asked: string[] = []
    const held = projector(input({ reach: reach(['lanes']) }), NOW, {
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
    const held = projector(input({ reach: reach(['lanes']) }), NOW)
    expect(held.agent(TASK).why).toBe('not read yet')
  })
})
