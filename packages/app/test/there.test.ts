import { type AgentMark, markOf, TaskId } from '@tade/core'
import { type Held, heldFor } from '@tade/remotes-core'
import type { Snapshot } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { type Machine, machineOf } from '../src/machines.ts'
import { menuItems, queueMenuItems } from '../src/panels/menu/state.ts'
import {
  isThere,
  paneThere,
  queuedThere,
  refOf,
  scheduleThere,
  there,
  thereItems,
  thereScheduleItems,
} from '../src/there.ts'
import { NOW } from './screens/scenarios/fixtures.ts'

// Another machine's rows as this machine's own (`there.ts`): the machine
// travels in the id every control carries, the mark is the one that machine
// drew, and its menu is the menu a row here has — every item carried there or
// off with words, never one that does nothing.

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'tade/door',
    project: 'tade',
    name: 'door',
    mark: 'working',
    state: 'working',
    reason: 'running the suite',
    movedAt: new Date(NOW - 60_000).toISOString(),
    title: { words: 'The door', more: false },
    rev: 'r9',
    parked: false,
    lane: 'running',
    approval: null,
    can: [
      { verb: 'stop', how: 'now' },
      { verb: 'park', how: 'now' },
    ],
    cannot: [{ verb: 'done', why: 'the journal already says it is finished' }],
    ...over,
  }
}

function machine(rows: Record<string, unknown>[], over: Partial<Held> = {}): Machine {
  const snapshot = {
    v: 1,
    fresh: { at: new Date(NOW).toISOString(), epoch: 'e1', rev: 41 },
    projects: [{ name: 'tade', title: null, open: true, counts: { tasks: 1, shown: 1 } }],
    tasks: rows,
    queue: [],
  } as unknown as Snapshot
  return machineOf(
    {
      ...heldFor('vps'),
      link: { kind: 'live', since: NOW - 60_000 },
      projection: snapshot,
      heardAt: NOW,
      ...over,
    },
    0,
  )
}

describe('an id that carries its machine', () => {
  it('goes there and back, and an id here is never read as one there', () => {
    expect(refOf(there('vps', 'tade/door'))).toEqual({ machine: 'vps', id: 'tade/door' })
    expect(refOf('tade/door')).toEqual({ machine: null, id: 'tade/door' })
    expect(isThere(there('my mac', 'nightly'))).toBe(true)
    // A task id here can never begin like one there.
    expect(TaskId.safeParse(there('vps', 'tade/door')).success).toBe(false)
    expect(isThere('tade/door')).toBe(false)
  })
})

describe('an agent there, as a row here', () => {
  it('is drawn with the mark that machine drew, for every mark there is', () => {
    const marks: AgentMark[] = [
      'working',
      'idle',
      'needs-you',
      'failed',
      'done',
      'stopped',
      'parked',
    ]
    for (const mark of marks) {
      const one = machine([row({ mark })])
      const agent = one.projects[0]!.agents[0]!
      expect(markOf(paneThere(agent, one.projects[0]!, one)), mark).toBe(mark)
    }
  })

  it('carries its machine in its id, and its approval as that machine sent it', () => {
    const one = machine([
      row({ mark: 'needs-you', approval: { id: 'call-7', tool: 'Bash', command: 'rm -rf x' } }),
    ])
    const pane = paneThere(one.projects[0]!.agents[0]!, one.projects[0]!, one)
    expect(refOf(pane.task)).toEqual({ machine: 'vps', id: 'tade/door' })
    expect(pane.approval).toMatchObject({ tool: 'Bash', id: 'call-7' })
  })

  it('offers the menu a row here has, item for item, each carried or off with why', () => {
    const one = machine([row()])
    const agent = one.projects[0]!.agents[0]!
    const items = thereItems(agent, one.projects[0]!, one)
    const here = menuItems({ lane: 'there', state: 'working', finished: null }, 0)
    expect(items.map((item) => item.id)).toEqual(here.map((item) => item.id))
    const off = (id: string) => items.find((item) => item.id === id)?.off
    // What that machine offers is on.
    expect(off('stop')).toBeUndefined()
    expect(off('park')).toBeUndefined()
    expect(off('open')).toBeUndefined()
    // What it says not, with its own sentence.
    expect(off('mark-done')).toBe('the journal already says it is finished')
    // What it says nothing about is offered as it is here, and that machine answers the press.
    expect(off('rename')).toBeUndefined()
    // What no link carries.
    expect(off('changes')).toBe('read on vps')
    expect(off('editor')).toBe('files on vps')
    expect(off('copy-branch')).toBe('vps sent none')
  })

  it('offers nothing but says why while its link is down', () => {
    const one = machine([row()], {
      link: { kind: 'down', since: NOW, tries: 1, problem: 'timed out', said: 'gone quiet' },
    })
    const items = thereItems(one.projects[0]!.agents[0]!, one.projects[0]!, one)
    expect(items.every((item) => typeof item.off === 'string' && item.off !== '')).toBe(true)
    expect(items.find((item) => item.id === 'stop')?.off).toBe('vps is not linked right now')
  })

  it('offers queued work the queue’s menu, and what it waits on is that machine’s words', () => {
    const one = machine([
      row({ state: 'queued', queue: 'waiting', reason: 'after tade/base', can: [] }),
    ])
    const agent = one.projects[0]!.agents[0]!
    expect(agent.queued).toBe(true)
    const pane = queuedThere(agent, one.projects[0]!, one)
    const items = thereItems(agent, one.projects[0]!, one)
    expect(items.map((item) => item.id)).toEqual(queueMenuItems(pane.queued).map((item) => item.id))
    expect(items.find((item) => item.id === 'queue-after')?.off).toBe('chosen on vps')
  })
})

describe('a schedule there, as a schedule here', () => {
  const nightly = {
    id: 'nightly',
    name: 'Nightly',
    project: 'tade',
    kind: 'agent' as const,
    when: 'every day at 03:00',
    paused: false,
    next: NOW + 3_600_000,
    watch: null,
  }

  it('carries its machine in its id and says only what that machine said', () => {
    const view = scheduleThere(nightly, 'vps')
    expect(refOf(view.id)).toEqual({ machine: 'vps', id: 'nightly' })
    expect(view).toMatchObject({ name: 'Nightly', when: 'every day at 03:00', paused: false })
    expect(view.next).toEqual([NOW + 3_600_000])
    expect(view.runs).toEqual([])
    expect(scheduleThere({ ...nightly, next: null }, 'vps').next).toEqual([])
  })

  it('offers its menu, and nothing but opening it while its link is down', () => {
    const view = scheduleThere(nightly, 'vps')
    expect(thereScheduleItems(view, machine([])).every((item) => !item.off)).toBe(true)
    const down = machine([], {
      link: { kind: 'down', since: NOW, tries: 1, problem: 'timed out', said: 'gone quiet' },
    })
    const items = thereScheduleItems(view, down)
    expect(items.find((item) => item.id === 'schedule-open')?.off).toBeUndefined()
    expect(items.find((item) => item.id === 'schedule-pause')?.off).toBe(
      'vps is not linked right now',
    )
  })
})
