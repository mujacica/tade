import { seenSaid } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { shortClockOf } from '../src/assets/figures.js'
import {
  machineSaid,
  machinesOf,
  machinesUpOf,
  storesDrawn,
  wantsAnywhere,
  wantsElsewhere,
} from '../src/assets/machines.js'

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

  it('draws each machine up or down in the header, this one first and up while it is heard', () => {
    const store = {
      machines: [
        { name: 'vps', way: 'to', state: 'up', since: AT },
        { name: 'mac', way: 'from', state: 'lost', since: AT },
      ],
    }
    const rows = machinesUpOf(store, true)
    expect(rows.map((one) => [one.name, one.up, one.short, one.tone])).toEqual([
      ['This machine', true, 'up', 't-done'],
      ['mac', false, `lost ${shortClockOf(AT)}`, 't-wants'],
      ['vps', true, 'up', 't-done'],
    ])
    // The whole sentence is the label; the header has room for its first words.
    expect(rows[1]?.said).toBe(machineSaid(store.machines[1] as never))
    // A page that does not hear the door says so of the machine it talks to.
    expect(machinesUpOf(store, false)[0]).toMatchObject({ up: false, short: 'not answering' })
    // An older Tade that sends no machines is this one alone.
    expect(machinesUpOf({}, true).map((one) => one.name)).toEqual(['This machine'])
  })
})

describe('what wants you on every other machine', () => {
  const copy = (tasks: readonly [string, string, boolean][]) => ({
    rows: { tasks: new Map(tasks.map(([id, mark, wantsYou]) => [id, { id, mark, wantsYou }])) },
  })
  const seen = (name: string, state: 'up' | 'closed') => ({
    name,
    way: 'from' as const,
    state,
    since: AT,
  })

  it('is each up machine’s own wanting, in its own order, by machine name', () => {
    const store = {
      machines: [seen('mac', 'up'), seen('box', 'up')],
      copies: new Map([
        [
          'mac',
          copy([
            ['app/b', 'failed', true],
            ['app/a', 'needs-you', true],
            ['app/c', 'working', false],
          ]),
        ],
        ['box', copy([['app/z', 'needs-you', true]])],
      ]),
    }
    expect(wantsElsewhere(store).map((one) => `${one.machine} ${one.task.id}`)).toEqual([
      'box app/z',
      'mac app/a',
      'mac app/b',
    ])
  })

  it('leaves out a machine that is not up, or that the page has no row for', () => {
    const store = {
      machines: [seen('mac', 'closed')],
      copies: new Map([
        ['mac', copy([['app/a', 'needs-you', true]])],
        ['ghost', copy([['app/g', 'needs-you', true]])],
      ]),
    }
    expect(wantsElsewhere(store)).toEqual([])
    expect(wantsElsewhere(null)).toEqual([])
  })
})

describe('the stores the overview draws, and the badge', () => {
  const copy = (ids: string[]) => ({
    rows: { tasks: new Map(ids.map((id) => [id, { id, mark: 'needs-you', wantsYou: true }])) },
  })
  const store = {
    rows: { tasks: new Map([['here/a', { id: 'here/a', mark: 'needs-you', wantsYou: true }]]) },
    machines: [
      { name: 'mac', way: 'from', state: 'up', since: AT },
      { name: 'box', way: 'to', state: 'closed', since: AT },
    ],
    copies: new Map([
      ['mac', copy(['app/a', 'app/b'])],
      ['box', copy(['app/z'])],
    ]),
  }

  it('is this machine first and always up, then each copy by name, up where it is', () => {
    expect(storesDrawn(store).map((one) => [one.machine, one.up])).toEqual([
      ['', true],
      ['box', false],
      ['mac', true],
    ])
    expect(storesDrawn(store, 'mac').map((one) => one.machine)).toEqual(['mac'])
  })

  it('counts what wants you on every machine that is up, this one included', () => {
    // box is closed: what it said wanted you is its last word, not now.
    expect(wantsAnywhere(store)).toBe(3)
  })
})
