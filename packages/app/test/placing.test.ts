import type { Plan } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { type Places, placePlan } from '../src/wire/placing.ts'

// Where a plan's work waits, decided before anything is made: on the hub where
// it waits for later and nothing ties it here, in the order the plan's own
// waits give — an agent staying here ties whatever waits on it here too.

const LATER = '2099-01-01T03:00:00Z'
const NOW = Date.parse('2026-11-22T22:00:00Z')

const places = (up = true): Places => ({
  machines: () => ['vps'],
  up: () => up,
  projectThere: (_machine, project) => (project === 'api' ? 'api' : null),
  send: async () => '',
})

const agent = (name: string, over: Partial<Plan['agents'][number]> = {}) => ({
  name,
  said: name,
  prompt: name,
  after: [],
  touches: [],
  ...over,
})

function placed(plan: Plan, up = true, finished: readonly string[] = []) {
  return placePlan(plan, {
    config: { machine: { pinned: [] }, remotes: { vps: {} } as never },
    home: '/home/tade',
    self: 'mac',
    places: places(up),
    finished: (task) => finished.includes(task),
    now: NOW,
  })
}

const machineOf = (plan: Plan, name: string) =>
  plan.agents.find((one) => one.name === name)?.machine ?? null

describe('placing a plan', () => {
  it('sends later work to the hub, and keeps work that starts now here', () => {
    const { plan, why, byRule } = placed({
      project: 'api',
      said: 's',
      agents: [agent('now'), agent('tonight', { at: LATER })],
    })
    expect(machineOf(plan, 'now')).toBeNull()
    expect(machineOf(plan, 'tonight')).toBe('vps')
    expect([...byRule]).toEqual(['tonight'])
    expect(why.get('now')).toBeUndefined()
    expect(why.get('tonight')).toContain('placed on vps from mac')
  })

  it('keeps here what builds on an agent that stays here, and sends what builds on one that went', () => {
    const { plan, why } = placed({
      project: 'api',
      said: 's',
      agents: [
        agent('first'),
        agent('second', { after: [{ agent: 'first', why: 'builds on it' }] }),
        agent('away', { at: LATER }),
        agent('after-away', { after: [{ agent: 'away', why: 'builds on it' }] }),
      ],
    })
    expect(machineOf(plan, 'second')).toBeNull()
    expect(why.get('second')).toBe('stays on mac: it builds on first, which works here')
    expect(machineOf(plan, 'after-away')).toBe('vps')
  })

  it('keeps what the plan says, and keeps everything here where the hub is down or has not got the project', () => {
    const named = placed({
      project: 'api',
      said: 's',
      agents: [agent('pinned', { at: LATER, machine: 'here' }), agent('there', { machine: 'vps' })],
    })
    expect(machineOf(named.plan, 'pinned')).toBeNull()
    expect(machineOf(named.plan, 'there')).toBe('vps')
    expect(named.why.get('there')).toBe('planned for vps from mac')
    expect(named.byRule.size).toBe(0)
    const down = placed(
      { project: 'api', said: 's', agents: [agent('tonight', { at: LATER })] },
      false,
    )
    expect(machineOf(down.plan, 'tonight')).toBeNull()
    expect(down.why.get('tonight')).toBe(
      'stays on mac: vps is not linked now, so it was not sent there',
    )
    const web = placed({ project: 'web', said: 's', agents: [agent('tonight', { at: LATER })] })
    expect(machineOf(web.plan, 'tonight')).toBeNull()
  })

  it('a wait on finished work here ties nothing, and one on unfinished work does', () => {
    const plan = (finished: readonly string[]) =>
      placed(
        {
          project: 'api',
          said: 's',
          agents: [agent('next', { after: [{ agent: 'api/old', why: 'w' }] })],
        },
        true,
        finished,
      )
    // Finished, it starts now, so it starts where it was asked for.
    expect(machineOf(plan(['api/old']).plan, 'next')).toBeNull()
    expect(plan(['api/old']).why.get('next')).toBeUndefined()
    expect(plan([]).why.get('next')).toBe('stays on mac: it builds on api/old, which works here')
  })
})
