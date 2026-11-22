import { seenSaid } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { shortClockOf } from '../src/assets/figures.js'
import { machineSaid, machinesOf, machineTone, machineWay } from '../src/assets/machines.js'

// The person's other machines on the page: which are up, and which closed,
// slept or went quiet — in the window's own words (`seenSaid`), so a phone and
// the orchestrator never say two different things about the same machine.

const AT = '2026-11-22T14:02:00.000Z'

describe('the machines a page draws', () => {
  it('puts the ones that are not up first, then by name, and reads none from an older Tade', () => {
    const rows = machinesOf({
      machines: [
        { name: 'lab', way: 'to', state: 'up', since: AT },
        { name: 'mac', way: 'from', state: 'closed', since: AT },
        { name: 'box', way: 'to', state: 'up', since: AT },
      ],
    })
    expect(rows.map((one) => one.name)).toEqual(['mac', 'box', 'lab'])
    expect(machinesOf({})).toEqual([])
    expect(machinesOf(null)).toEqual([])
  })

  it('says each state in the window’s own words', () => {
    const clock = () => shortClockOf(AT)
    for (const state of ['up', 'asleep', 'closed', 'lost'] as const) {
      expect(machineSaid({ name: 'mac', way: 'from', state, since: AT })).toBe(
        seenSaid({ state, at: Date.parse(AT), since: null }, clock),
      )
    }
  })

  it('says which way it is linked, and draws a silence louder than a goodbye', () => {
    expect(machineWay({ name: 'mac', way: 'from', state: 'up', since: AT })).toBe(
      'it links to this machine',
    )
    expect(machineWay({ name: 'vps', way: 'to', state: 'up', since: AT })).toBe(
      'this machine links to it',
    )
    expect(machineTone({ name: 'mac', way: 'from', state: 'lost', since: AT })).toBe('t-wants')
    expect(machineTone({ name: 'mac', way: 'from', state: 'closed', since: AT })).toBe('')
  })
})
