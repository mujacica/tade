import { seenSaid } from '@tade/core'
import { describe, expect, it } from 'vitest'
import { shortClockOf } from '../src/assets/figures.js'
import {
  agentsElsewhere,
  figuresAsOf,
  figuresOf,
  hereOf,
  lastWordSaid,
  machineFix,
  machineSaid,
  machinesOf,
  machineTone,
  machineWay,
  megabytesSaid,
  noFiguresSaid,
  percentSaid,
  roomSaid,
  thereOf,
  wantsElsewhere,
  wasDoingSaid,
  wasWorking,
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

describe('what a machine that is not up was doing', () => {
  /** A copy as the page holds one (`store.js`): its tasks by id, and what it said of itself. */
  const copy = (marks: readonly string[], detach?: boolean | null) => ({
    rows: { tasks: new Map(marks.map((mark, at) => [`app/t${at}`, { id: `app/t${at}`, mark }])) },
    fresh: detach === undefined ? {} : { detach },
  })
  const row = (state: 'up' | 'closed' | 'asleep' | 'lost') => ({
    name: 'mac',
    way: 'from' as const,
    state,
    since: AT,
  })
  const at = shortClockOf(AT)

  it('counts the agents that were working at its last word, and none from no copy', () => {
    expect(wasWorking(copy(['working', 'done', 'working', 'needs-you']))).toHaveLength(2)
    expect(wasWorking(undefined)).toEqual([])
  })

  it('says a working agent stopped with the window where that machine’s agents die with it', () => {
    expect(wasDoingSaid(row('closed'), copy(['working'], false))).toBe(
      `stopped with the window, ${at} — reopens when mac’s window opens`,
    )
    expect(lastWordSaid(row('closed'), copy(['working', 'working', 'done'], false))).toBe(
      `closed ${at} · 2 agents were working; they reopen when its window opens`,
    )
  })

  it('says it may have moved on where they outlive the window, and as of its last word where nothing said', () => {
    expect(wasDoingSaid(row('lost'), copy(['working'], true))).toBe(
      `was working at ${at}; may have moved on`,
    )
    expect(lastWordSaid(row('asleep'), copy(['working'], true))).toBe(
      `asleep since ${at} · 1 agent was working; they may have moved on`,
    )
    expect(wasDoingSaid(row('lost'), copy(['working']))).toBe(
      `was working at ${at}, as of its last word`,
    )
    expect(lastWordSaid(row('lost'), copy(['working'], null))).toBe(
      `lost ${at} · 1 agent was working`,
    )
  })

  it('says nothing of a machine that is up, or of one this page holds no copy of', () => {
    expect(wasDoingSaid(row('up'), copy(['working'], false))).toBeNull()
    expect(lastWordSaid(row('up'), copy(['working'], false))).toBeNull()
    expect(lastWordSaid(row('closed'), undefined)).toBeNull()
    expect(lastWordSaid(row('closed'), copy(['done'], false))).toBe(
      `closed ${at} · nothing was working`,
    )
  })
})

describe('every other machine’s agents', () => {
  /** A store as the page holds one, with a copy per machine: tasks by id, agents counted. */
  const copy = (tasks: readonly [string, string, number][], at = AT) => ({
    rows: {
      tasks: new Map(tasks.map(([id, mark, agents]) => [id, { id, mark, agents, project: 'app' }])),
    },
    fresh: { at, detach: false },
  })
  const seen = (name: string, state: 'up' | 'closed' | 'asleep' | 'lost') => ({
    name,
    way: 'from' as const,
    state,
    since: AT,
  })
  const at = shortClockOf(AT)

  it('is a group a machine with an agent, by name, out of that machine’s own copy', () => {
    const store = {
      machines: [seen('mac', 'up'), seen('box', 'up')],
      copies: new Map([
        [
          'mac',
          copy([
            ['app/b', 'working', 1],
            ['app/a', 'done', 0],
            ['app/c', 'idle', 1],
          ]),
        ],
        ['box', copy([['app/z', 'working', 1]])],
        ['quiet', copy([['app/q', 'done', 0]])],
      ]),
    }
    const groups = agentsElsewhere(store)
    expect(groups.map((one) => one.machine)).toEqual(['box', 'mac'])
    expect(groups[1]?.agents.map((one) => one.id)).toEqual(['app/b', 'app/c'])
    expect(groups[1]).toMatchObject({ up: true, said: null, working: null, asOf: Date.parse(AT) })
  })

  it('says over a machine that is not up what its agents were doing, and under each that was working', () => {
    const store = {
      machines: [seen('mac', 'closed')],
      copies: new Map([['mac', copy([['app/b', 'working', 1]])]]),
    }
    expect(agentsElsewhere(store)[0]).toMatchObject({
      up: false,
      said: `closed ${at} · 1 agent was working; they reopen when its window opens`,
      working: `stopped with the window, ${at} — reopens when mac’s window opens`,
    })
  })

  it('draws a copy of a machine the page has no row for as of its last word, never as up', () => {
    const store = { machines: [], copies: new Map([['mac', copy([['app/b', 'working', 1]])]]) }
    expect(agentsElsewhere(store)[0]).toMatchObject({
      up: false,
      said: `as of ${at}`,
      working: null,
    })
  })

  it('is nothing for a page with no copies, or an older one that keeps none', () => {
    expect(agentsElsewhere({ machines: [], copies: new Map() })).toEqual([])
    expect(agentsElsewhere({ machines: [] })).toEqual([])
    expect(agentsElsewhere(null)).toEqual([])
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

describe('one other machine’s screen', () => {
  const NOW = Date.parse('2026-11-22T15:00:00.000Z')
  const at = shortClockOf(AT)
  const copy = { rows: { tasks: new Map() }, fresh: { at: AT } }
  const store = (state: 'up' | 'closed' | 'lost' | null) => ({
    had: true,
    machines: state === null ? [] : [{ name: 'mac', way: 'from', state, since: AT }],
    copies: new Map([['mac', copy]]),
  })

  it('is drawn out of that machine’s copy, its clock running while it is up and this page hears it', () => {
    const on = thereOf(store('up'), 'mac', true, NOW)
    expect(on.store).toBe(copy)
    expect(on).toMatchObject({ asOf: NOW, frozen: false, up: true, line: `mac · up since ${at}` })
  })

  it('is frozen at its last word where it is not up, or this page is not hearing the door', () => {
    expect(thereOf(store('closed'), 'mac', true, NOW)).toMatchObject({
      asOf: Date.parse(AT),
      frozen: true,
      up: false,
      line: `mac · closed ${at} · as of ${at}`,
    })
    expect(thereOf(store('lost'), 'mac', true, NOW).line).toBe(`mac · lost ${at} · as of ${at}`)
    expect(thereOf(store('up'), 'mac', false, NOW)).toMatchObject({
      frozen: true,
      line: `mac · up since ${at} · as of ${at}`,
    })
    // A copy of a machine with no row here is never drawn as up.
    expect(thereOf(store(null), 'mac', true, NOW)).toMatchObject({
      up: false,
      frozen: true,
      line: `mac · as of ${at}`,
    })
  })

  it('says nothing of it is held where the page has no copy, once the door was read', () => {
    const none = thereOf(store('up'), 'box', true, NOW)
    expect(none.store.had).toBe(true)
    expect(none.store.rows.tasks.size).toBe(0)
    expect(none.line).toMatch(/^box · nothing of it is held here/)
    expect(thereOf({ had: false }, 'box', true, NOW).store.had).toBe(false)
  })
})
