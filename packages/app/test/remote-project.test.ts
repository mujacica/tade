import { describe, expect, it } from 'vitest'
import { type Machine, NO_DETAIL, type RemoteProject } from '../src/machines.ts'
import { closingThere, remoteProjectItems } from '../src/wire/remote-project.ts'

// A project's tab on another machine: what its `≡` offers and whether its `×`
// may be pressed — every act there, and every one that cannot cross the link
// saying so rather than going missing.

function project(over: Partial<RemoteProject> = {}): RemoteProject {
  return {
    name: 'hello',
    title: null,
    agents: [],
    more: 0,
    watching: null,
    rev: 'p1',
    can: ['close'],
    cannot: [],
    ...over,
  }
}

function machine(over: Partial<Machine> = {}): Machine {
  return {
    name: 'ipax',
    link: 'live',
    rev: 4,
    said: null,
    asOf: null,
    heard: true,
    projects: [],
    spend: null,
    talk: { lines: [], rev: null, busy: false, whose: null, mine: true, more: 0 },
    closed: false,
    seen: [],
    detail: NO_DETAIL,
    ...over,
  }
}

const item = (items: ReturnType<typeof remoteProjectItems>, id: string) =>
  items.find((one) => one.id === id)

describe('a project’s tab on another machine', () => {
  it('may be closed there where that machine says so, and says why not everywhere else', () => {
    expect(closingThere(machine(), project())).toEqual({ ok: true })
    expect(closingThere(machine({ link: 'down' }), project())).toEqual({
      ok: false,
      why: 'ipax is not linked right now',
    })
    expect(
      closingThere(machine(), project({ can: [], cannot: [{ verb: 'close', why: 'not now' }] })),
    ).toEqual({ ok: false, why: 'not now' })
    // An older Tade there sends no revision, which no act can be made without.
    expect(closingThere(machine(), project({ rev: null })).ok).toBe(false)
    expect(closingThere(machine({ rev: null }), project()).ok).toBe(false)
  })

  it('offers every item a tab here has, each act that cannot cross the link off with where it is done', () => {
    const items = remoteProjectItems(machine(), project())
    expect(items.map((one) => one.id)).toEqual([
      'ask',
      'rename',
      'move-left',
      'move-right',
      'configure',
      'close',
    ])
    expect(item(items, 'ask')?.off).toBeUndefined()
    expect(item(items, 'close')).toMatchObject({ label: 'Close on ipax', danger: true })
    expect(item(items, 'close')?.off).toBeUndefined()
    for (const id of ['rename', 'move-left', 'move-right', 'configure'])
      expect(item(items, id)?.off).toMatch(/ipax/)
  })

  it('says a machine that is down, or will not be talked to, where its acts would be', () => {
    const down = remoteProjectItems(machine({ link: 'down' }), project())
    expect(item(down, 'ask')?.off).toBe('ipax is not linked right now')
    expect(item(down, 'close')?.off).toBe('ipax is not linked right now')
    const quiet = remoteProjectItems(machine({ talk: null }), project())
    expect(item(quiet, 'ask')?.off).toBe('talking to it from another screen is off there')
  })

  it('counts the agents that keep working there when it is closed', () => {
    const working = { mark: 'working' } as RemoteProject['agents'][number]
    const items = remoteProjectItems(machine(), project({ agents: [working, working] }))
    expect(item(items, 'close')?.note).toBe('2 agents keep working')
  })
})
