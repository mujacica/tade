import { seenSaid } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { shortClockOf } from '../src/assets/figures.js'
import {
  figuresAsOf,
  figuresOf,
  hereOf,
  machineFix,
  machineSaid,
  machinesOf,
  machineTone,
  machineWay,
  megabytesSaid,
  noFiguresSaid,
  percentSaid,
  roomSaid,
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

  it('says what to do about a machine that is not up, and nothing about one that is', () => {
    const row = (state: 'up' | 'closed' | 'asleep' | 'lost') => ({
      name: 'vps',
      way: 'to' as const,
      state,
      since: AT,
    })
    expect(machineFix(row('up'))).toBeNull()
    expect(machineFix(row('closed'))).toContain('tade app')
    expect(machineFix(row('asleep'))).toContain('wake it')
    expect(machineFix(row('lost'))).toContain('on and online')
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

describe('what each machine is doing, on the page', () => {
  const GB = 1024 ** 3
  const host = {
    at: AT,
    cores: 8,
    cpu: 23.4,
    load: 2.25,
    memory: { used: 20 * GB, total: 32 * GB },
    tade: { cpu: 91, memory: 783 * 1024 ** 2, processes: 8 },
    disk: { free: 112 * GB, total: 994 * GB, volumes: 1 },
    trail: { cpu: [null, 12, 23.4], memory: [61, 62, 62.5] },
  }

  it('puts this machine first, as up, only once it has looked', () => {
    expect(hereOf({ host })).toMatchObject({ name: 'This machine', way: 'here', state: 'up' })
    expect(hereOf({ host: null })).toBeNull()
    expect(hereOf({})).toBeNull()
    const here = hereOf({ host }) as NonNullable<ReturnType<typeof hereOf>>
    expect(machineSaid(here)).toBe('up')
    expect(machineWay(here)).toBe('the one this page is talking to')
    expect(machineFix(here)).toBeNull()
  })

  it('says each figure in the window’s words, and Tade’s share beside them', () => {
    expect(figuresOf(host)).toEqual({
      cpu: {
        label: 'CPU',
        said: '23%',
        under: 'load 2.25 · 8 cores',
        pressure: 'fine',
        trail: [null, 12, 23.4],
      },
      memory: {
        label: 'Memory',
        said: '63%',
        under: '20.0 GB of 32.0 GB',
        pressure: 'fine',
        trail: [61, 62, 62.5],
      },
      disk: {
        label: 'Disk',
        said: '112 GB free',
        under: 'of 994 GB',
        // Nine tenths full is amber before it is red, which is under a tenth free.
        pressure: 'warm',
        used: expect.closeTo(88.7, 1),
      },
      tade: 'Tade and its agents: 91% CPU · 783 MB · 8 processes',
      at: AT,
    })
  })

  it('says a disk running out in words as well as in red, and a full machine in amber then red', () => {
    const low = figuresOf({ ...host, disk: { free: 5 * GB, total: 100 * GB, volumes: 2 } })
    expect(low?.disk).toMatchObject({
      said: '5.0 GB free',
      under: 'of 100 GB · fullest of 2 · running out',
      pressure: 'tight',
    })
    expect(figuresOf({ ...host, cpu: 80 })?.cpu.pressure).toBe('warm')
    expect(figuresOf({ ...host, memory: { used: 31 * GB, total: 32 * GB } })?.memory.pressure).toBe(
      'tight',
    )
  })

  it('draws what a machine cannot say as a dash, never as nought, and no figures in words', () => {
    const blind = figuresOf({
      ...host,
      cpu: null,
      load: null,
      cores: null,
      memory: null,
      disk: null,
      tade: null,
      trail: { cpu: [], memory: [] },
    })
    expect(blind?.cpu).toMatchObject({ said: '—', under: 'cannot say' })
    expect(blind?.memory).toMatchObject({ said: '—', under: 'cannot say' })
    expect(blind?.disk).toMatchObject({ said: '—', under: 'cannot say', used: null })
    expect(blind?.tade).toBe('Tade and its agents: —')
    expect(figuresOf(null)).toBeNull()
    expect(noFiguresSaid({ name: 'vps', way: 'to', state: 'up', since: AT })).toContain(
      'an older Tade there says none',
    )
  })

  it('says when a machine that is not up last said its figures, and nothing for one that is', () => {
    const figures = figuresOf(host)
    expect(figuresAsOf({ name: 'mac', way: 'from', state: 'up', since: AT }, figures)).toBeNull()
    expect(figuresAsOf({ name: 'mac', way: 'from', state: 'lost', since: AT }, figures)).toBe(
      `as of ${shortClockOf(AT)}, when it last said them`,
    )
  })

  it('says sizes as the strip does', () => {
    expect(megabytesSaid(783 * 1024 ** 2)).toBe('783 MB')
    expect(megabytesSaid(1.5 * GB)).toBe('1.5 GB')
    expect(roomSaid(1.5 * 1024 ** 4)).toBe('1.5 TB')
    expect(roomSaid(112 * GB)).toBe('112 GB')
    expect(roomSaid(5 * GB)).toBe('5.0 GB')
    expect(roomSaid(840 * 1024 ** 2)).toBe('840 MB')
    expect(percentSaid(91)).toBe('91%')
    expect(percentSaid(2.5)).toBe('2.5%')
  })
})
