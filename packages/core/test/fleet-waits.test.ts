import { describe, expect, it } from 'vitest'
import type { Finished } from '../src/done.ts'
import type { EventType, TadeEvent } from '../src/events.ts'
import {
  type Fleet,
  type FleetMachine,
  followWait,
  parseWait,
  queuedThere,
  queuedThereSays,
  SILENT_DAYS,
  thereSays,
  waitThereProblem,
} from '../src/fleet-waits.ts'
import type { StartCondition } from '../src/model.ts'
import { hubOf, placeQueued } from '../src/placement.ts'
import { checkPlan, type Plan } from '../src/plan.ts'
import {
  checkWaits,
  describeQueueState,
  type Queued,
  type QueueFacts,
  queueStateOf,
  readyToStart,
} from '../src/queue.ts'

const NOW = Date.parse('2026-11-22T14:00:00Z')
const DAY = 86_400_000

let seq = 0
function line(
  type: EventType,
  task: string | null,
  detail: Record<string, unknown> = {},
): TadeEvent {
  seq++
  return {
    seq,
    ts: new Date(NOW).toISOString(),
    type,
    urgency: 'notable',
    task,
    lane: null,
    run: null,
    detail,
  }
}

function machine(name: string, lines: TadeEvent[], over: Partial<FleetMachine> = {}): FleetMachine {
  return { name, heardAt: NOW - 60_000, lines, ...over }
}

function queued(task: string, start: Partial<StartCondition> = {}): Queued {
  return {
    task,
    project: task.split('/')[0] ?? '',
    parked: false,
    start: { after: [], prompt: 'do it', touches: [], ...start },
  }
}

function facts(over: {
  finished?: string[]
  events?: TadeEvent[]
  elsewhere?: Fleet
  tasks?: string[]
}): QueueFacts {
  const finished = new Map<string, Finished>()
  for (const task of over.finished ?? []) finished.set(task, { at: '', by: 'agent', summary: '' })
  return {
    tasks: new Map(
      (over.tasks ?? []).map((task) => [task, { state: 'queued' as const, reason: '' }]),
    ),
    finished,
    events: over.events ?? [],
    now: NOW,
    ...(over.elsewhere ? { elsewhere: over.elsewhere } : {}),
  }
}

const clock = (at: number) => new Date(at).toISOString().slice(11, 16)

/** B on the Mac waits on A on vps — the test the phase is defined by. */
const b = queued('api/b', { after: [{ task: 'vps:api/a', why: 'it needs the migration' }] })

describe('a wait on another machine', () => {
  it('reads a machine-qualified id, and a bare one as this machine’s', () => {
    expect(parseWait('vps:api/a')).toEqual({ machine: 'vps', task: 'api/a' })
    expect(parseWait('api/a')).toEqual({ machine: null, task: 'api/a' })
    expect(parseWait('ipax.local:api/a')).toEqual({ machine: 'ipax.local', task: 'api/a' })
  })

  it('holds while the link is down and nothing of vps is kept, and never starts', () => {
    const state = queueStateOf(b, facts({}))
    expect(state.kind).toBe('waiting')
    expect(readyToStart([b], facts({}), new Map())).toEqual([])
    if (state.kind !== 'waiting') throw new Error('not waiting')
    expect(state.there?.[0]?.why).toBe("no other machine's journal is kept here")
  })

  it('holds while the copy of vps’s journal has no task_done, and says when vps was last heard', () => {
    const vps = machine('ipax', [line('task_created', 'api/a')], {
      called: 'vps',
      heardAt: Date.parse('2026-11-22T14:02:00Z') - DAY / 24,
    })
    const given = facts({ elsewhere: { self: 'mac', machines: [vps] } })
    const state = queueStateOf(b, given)
    expect(state.kind).toBe('waiting')
    expect(describeQueueState(state, clock)).toBe(
      'after vps:api/a (vps:api/a: vps last heard 13:02)',
    )
  })

  it('starts on the look after A’s task_done reaches the copy', () => {
    const vps = machine('ipax', [line('task_created', 'api/a'), line('task_done', 'api/a')], {
      called: 'vps',
    })
    const given = facts({ elsewhere: { self: 'mac', machines: [vps] } })
    expect(queueStateOf(b, given)).toEqual({ kind: 'ready' })
    expect(readyToStart([b], given, new Map())).toEqual(['api/b'])
  })

  it('finds a machine by what it calls itself as well as by its name here', () => {
    const vps = machine('ipax', [line('task_created', 'api/a'), line('task_done', 'api/a')], {
      called: 'vps',
    })
    const byLabel = queued('api/b', { after: [{ task: 'ipax:api/a', why: '' }] })
    expect(queueStateOf(byLabel, facts({ elsewhere: { self: 'mac', machines: [vps] } }))).toEqual({
      kind: 'ready',
    })
  })

  it('a task_done somewhere else, or a seq that happens to match, releases nothing', () => {
    const vps = machine('ipax', [line('task_created', 'api/a')], { called: 'vps' })
    const other = machine('vps2', [line('task_done', 'api/a')])
    const given = facts({
      elsewhere: { self: 'mac', machines: [vps, other] },
      finished: ['api/a'],
      events: [line('task_done', 'api/a')],
    })
    expect(queueStateOf(b, given).kind).toBe('waiting')
  })

  it('follows A moved from vps to vps2 mid-wait, and is released by vps2’s task_done', () => {
    const vps = machine(
      'ipax',
      [
        line('task_created', 'api/a'),
        line('task_moved', 'api/a', { to: 'vps2', as: 'shop/a', how: 'queued' }),
        line('task_removed', 'api/a'),
      ],
      { called: 'vps' },
    )
    const taken = line('task_taken', 'shop/a', { from: 'ipax', was: 'api/a' })
    const before = machine('box2', [taken])
    const midway = facts({ elsewhere: { self: 'mac', machines: [vps, before] } })
    const waiting = queueStateOf(b, midway)
    // Removed on vps once it moved, which is not trouble: it went on.
    expect(waiting.kind).toBe('waiting')
    if (waiting.kind !== 'waiting') throw new Error('not waiting')
    expect(waiting.there?.[0]).toMatchObject({ machine: 'box2', task: 'shop/a' })
    const after = machine('box2', [taken, line('task_done', 'shop/a')])
    expect(queueStateOf(b, facts({ elsewhere: { self: 'mac', machines: [vps, after] } }))).toEqual({
      kind: 'ready',
    })
  })

  it('holds until both halves of a move are seen', () => {
    const vps = machine(
      'ipax',
      [
        line('task_created', 'api/a'),
        line('task_moved', 'api/a', { to: 'vps2', as: 'api/a', how: 'queued' }),
      ],
      { called: 'vps' },
    )
    const state = queueStateOf(b, facts({ elsewhere: { self: 'mac', machines: [vps] } }))
    expect(state.kind).toBe('waiting')
    if (state.kind !== 'waiting') throw new Error('not waiting')
    expect(state.there?.[0]?.why).toContain('no journal here shows it taken yet')
  })

  it('follows a task of this machine’s that moved away, which used to be refused', () => {
    const local = queued('api/b', { after: [{ task: 'api/a', why: '' }] })
    const moved = line('task_moved', 'api/a', { to: 'vps', as: 'api/a', how: 'queued' })
    const removed = line('task_removed', 'api/a')
    const taken = line('task_taken', 'api/a', { from: 'mac', was: 'api/a' })
    const vps = machine('ipax', [taken], { called: 'vps' })
    // Its task file is gone here: without the move followed this read as removed.
    const holding = facts({ events: [moved, removed], elsewhere: { self: 'mac', machines: [vps] } })
    expect(queueStateOf(local, holding).kind).toBe('waiting')
    const done = machine('ipax', [taken, line('task_done', 'api/a')], { called: 'vps' })
    expect(
      queueStateOf(
        local,
        facts({ events: [moved, removed], elsewhere: { self: 'mac', machines: [done] } }),
      ),
    ).toEqual({ kind: 'ready' })
  })

  it('follows a task that came back here, and reads it from this machine’s own lines', () => {
    const vps = machine(
      'ipax',
      [
        line('task_taken', 'api/a', { from: 'mac', was: 'api/a' }),
        line('task_moved', 'api/a', { to: 'mac', as: 'api/a-2', how: 'queued' }),
      ],
      { called: 'vps' },
    )
    const back = line('task_taken', 'api/a-2', { from: 'ipax', was: 'api/a' })
    expect(followWait('vps:api/a', { self: 'mac', machines: [vps] }, [back])).toEqual({
      kind: 'here',
      task: 'api/a-2',
    })
  })

  it('a wait naming this machine is a wait here', () => {
    const own = queued('api/b', { after: [{ task: 'mac:api/a', why: '' }] })
    expect(
      queueStateOf(own, facts({ finished: ['api/a'], elsewhere: { self: 'mac', machines: [] } })),
    ).toEqual({ kind: 'ready' })
  })

  it('is held, never released, when the task was removed there before it finished', () => {
    const vps = machine('ipax', [line('task_created', 'api/a'), line('task_removed', 'api/a')], {
      called: 'vps',
    })
    expect(queueStateOf(b, facts({ elsewhere: { self: 'mac', machines: [vps] } }))).toEqual({
      kind: 'held',
      on: 'vps:api/a',
      because: 'vps:api/a was removed on vps before it finished',
    })
  })

  it(`says a machine silent for ${SILENT_DAYS} days or more, and offers the wait to be dropped — never drops it`, () => {
    const vps = machine('ipax', [line('task_created', 'api/a')], {
      called: 'vps',
      heardAt: NOW - 3 * DAY - 1000,
    })
    const state = queueStateOf(b, facts({ elsewhere: { self: 'mac', machines: [vps] } }))
    expect(state.kind).toBe('waiting')
    if (state.kind !== 'waiting') throw new Error('not waiting')
    const [one] = state.there ?? []
    expect(one?.silentDays).toBe(3)
    expect(thereSays(one as NonNullable<typeof one>, clock)).toBe(
      'vps:api/a: vps not heard from in 3 days — the wait can be dropped, by you',
    )
  })

  it('a start anyway goes past it, as with any wait', () => {
    const start = line('queue_changed', 'api/b', { change: 'start' })
    expect(queueStateOf(b, facts({ events: [start] }))).toEqual({ kind: 'ready' })
  })
})

describe('writing a wait on another machine', () => {
  const vps = machine('ipax', [line('task_created', 'api/a')], { called: 'vps' })
  const fleet: Fleet = { self: 'mac', machines: [vps] }
  const base = {
    task: 'api/b',
    current: [],
    replace: false,
    tasks: new Set(['api/b']),
    waits: () => [],
  }

  it('takes a task that machine’s journal made', () => {
    expect(
      checkWaits({ ...base, after: [{ task: 'vps:api/a', why: 'w' }], elsewhere: fleet }),
    ).toEqual({ ok: true, after: [{ task: 'vps:api/a', why: 'w' }] })
  })

  it('refuses a machine whose journal is not kept here, a task it never made, a bare name, and an approval', () => {
    const check = checkWaits({
      ...base,
      after: [
        { task: 'nas:api/a', why: '' },
        { task: 'vps:api/nope', why: '' },
        { task: 'vps:a', why: '' },
        { task: 'vps:api/a', why: '', approved: true },
      ],
      elsewhere: fleet,
    })
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error('took it')
    expect(check.problems).toEqual([
      'api/b cannot wait on nas:api/a: no machine called nas has its journal kept here (the ones kept are vps)',
      "api/b cannot wait on vps:api/nope: vps's journal here has no task called api/nope",
      'api/b cannot wait on vps:a: say which project on vps, as vps:<project>/a',
      "api/b cannot wait for vps:api/a's document to be approved: a document is approved on the machine that holds it, so wait for vps:api/a to finish instead",
    ])
  })

  it('refuses a loop that goes round through another machine, whichever side it is closed from', () => {
    // vps's api/a was made waiting on this machine's api/b, by this machine's own name.
    const looped: Fleet = {
      self: 'mac',
      machines: [
        machine('ipax', [line('task_created', 'api/a', { after: ['mac:api/b'] })], {
          called: 'vps',
        }),
      ],
    }
    expect(
      checkWaits({ ...base, after: [{ task: 'vps:api/a', why: 'w' }], elsewhere: looped }),
    ).toEqual({
      ok: false,
      problems: [
        'api/b cannot wait on vps:api/a: vps:api/a already waits on api/b, so neither could start',
      ],
    })
    // Closed by a wait on work here, which waits on vps's in turn, rewritten there since.
    const rewritten: Fleet = {
      self: 'mac',
      machines: [
        machine(
          'ipax',
          [
            line('task_created', 'api/a'),
            line('queue_changed', 'api/a', {
              change: 'after',
              after: [{ task: 'mac:api/b', why: 'its schema' }],
            }),
          ],
          { called: 'vps' },
        ),
      ],
    }
    expect(
      checkWaits({
        ...base,
        after: [{ task: 'api/c', why: 'w' }],
        tasks: new Set(['api/b', 'api/c']),
        waits: (task) => (task === 'api/c' ? ['vps:api/a'] : []),
        elsewhere: rewritten,
      }),
    ).toEqual({
      ok: false,
      problems: [
        'api/b cannot wait on api/c: api/c already waits on api/b through ipax:api/a, so none of them could start',
      ],
    })
  })

  it('refuses a loop through a wait that names this machine by the other machine’s own name for it', () => {
    // vps links here as `laptop`, which this machine is not called anywhere else.
    const named = (calls?: string): Fleet => ({
      self: 'mac',
      machines: [
        machine('ipax', [line('task_created', 'api/a', { after: ['laptop:api/b'] })], {
          called: 'vps',
          ...(calls === undefined ? {} : { calls }),
        }),
      ],
    })
    expect(
      checkWaits({ ...base, after: [{ task: 'vps:api/a', why: 'w' }], elsewhere: named('Laptop') }),
    ).toEqual({
      ok: false,
      problems: [
        'api/b cannot wait on vps:api/a: vps:api/a already waits on api/b, so neither could start',
      ],
    })
    // Before vps has dialled and said it, the walk ends there: a loop missed, never a wait refused.
    expect(
      checkWaits({ ...base, after: [{ task: 'vps:api/a', why: 'w' }], elsewhere: named() }).ok,
    ).toBe(true)
    // Its name for this machine is its own: written here, `laptop` is no machine.
    expect(waitThereProblem('api/b', 'laptop:api/a', named('laptop'), false)).toBe(
      'api/b cannot wait on laptop:api/a: no machine called laptop has its journal kept here (the ones kept are vps)',
    )
  })

  it('walks no wait of work there that has started, and reads a bare name there as its own', () => {
    const started: Fleet = {
      self: 'mac',
      machines: [
        machine(
          'ipax',
          [
            line('task_created', 'api/a', { after: ['mac:api/b'] }),
            line('queue_started', 'api/a', { after: ['mac:api/b'] }),
          ],
          { called: 'vps' },
        ),
      ],
    }
    expect(
      checkWaits({ ...base, after: [{ task: 'vps:api/a', why: 'w' }], elsewhere: started }).ok,
    ).toBe(true)
    // `api/b` written on vps is vps's own api/b, not this machine's.
    const bare: Fleet = {
      self: 'mac',
      machines: [
        machine('ipax', [line('task_created', 'api/a', { after: ['api/b'] })], { called: 'vps' }),
      ],
    }
    expect(
      checkWaits({ ...base, after: [{ task: 'vps:api/a', why: 'w' }], elsewhere: bare }).ok,
    ).toBe(true)
  })

  it('refuses one with no other machine kept at all', () => {
    expect(waitThereProblem('api/b', 'vps:api/a', undefined, false)).toBe(
      'api/b cannot wait on vps:api/a: no machine called vps has its journal kept here',
    )
  })
})

describe('a plan across machines', () => {
  const plan = (agents: Plan['agents']): Plan => ({ project: 'api', said: 'do it', agents })
  const agent = (name: string, over: Partial<Plan['agents'][number]> = {}) => ({
    name,
    said: 'do it',
    prompt: 'do it',
    after: [],
    touches: [],
    ...over,
  })
  const context = {
    workspace: () => 'checkout' as const,
    tasks: new Set<string>(),
    fleet: {
      machines: ['vps'],
      projectThere: (machine: string, project: string) =>
        machine === 'vps' && project === 'api' ? 'api' : null,
      elsewhere: {
        self: 'mac',
        machines: [machine('ipax', [line('task_created', 'api/x')], { called: 'vps' })],
      },
    },
  }

  it('takes an agent on a machine this one links to, waiting on one here and on a task there', () => {
    const check = checkPlan(
      plan([
        agent('a'),
        agent('b', {
          machine: 'vps',
          after: [
            { agent: 'a', why: '' },
            { agent: 'vps:api/x', why: '' },
          ],
        }),
      ]),
      context,
    )
    expect(check.ok).toBe(true)
    if (!check.ok) throw new Error('refused')
    expect(check.waitsOn.get('api/b')).toEqual([
      { task: 'api/a', why: '' },
      { task: 'vps:api/x', why: '' },
    ])
  })

  it('refuses a machine not in the fleet, a project the machine does not have, a race sent away, and an approval across two machines', () => {
    const check = checkPlan(
      {
        project: 'api',
        said: 'do it',
        agents: [
          agent('a', { machine: 'nas' }),
          agent('w', { project: 'web', machine: 'vps' }),
          agent('p', { produces: 'plan.md' }),
          agent('q', { machine: 'vps', after: [{ agent: 'p', why: '', approved: true }] }),
        ],
      },
      { ...context, workspace: () => 'worktree' as const },
    )
    expect(check.ok).toBe(false)
    if (check.ok) throw new Error('took it')
    expect(check.problems).toEqual(
      expect.arrayContaining([
        'a is for nas, which is not a machine this one links to: the ones linked are vps',
        "w is for vps, which has no one project that is web's repository: move web there first (Move to vps on Settings › Remotes), or leave its machine unsaid",
        "q waits for p's document to be approved, and the two run on different machines: a document is approved on the machine that holds it, so put them on one, or wait for p to finish",
      ]),
    )
    const race = checkPlan(
      {
        project: 'api',
        said: 'race',
        race: 'r',
        agents: [agent('one', { machine: 'vps' }), agent('two')],
      },
      { ...context, workspace: () => 'worktree' as const },
    )
    expect(race.ok).toBe(false)
    if (race.ok) throw new Error('took it')
    expect(race.problems).toContain(
      'one cannot run on vps: a race is a measurement of this machine, so every entrant runs here',
    )
  })

  it('reads `here` and this machine’s own name as no machine', () => {
    expect(checkPlan(plan([agent('a', { machine: 'here' })]), context).ok).toBe(true)
    expect(checkPlan(plan([agent('a', { machine: 'mac' })]), context).ok).toBe(true)
  })
})

describe('where queued work waits', () => {
  const remotes = (...names: string[]) =>
    Object.fromEntries(names.map((name) => [name, {}])) as never
  const facts = {
    hub: { name: 'vps', why: 'it is the one machine this one links to' },
    self: 'mac',
    hubUp: true,
    projectThere: 'api',
    startsNow: false,
    waitsHere: [],
    filesHere: false,
    measurement: false,
  }

  it('the hub is machine.hub, or the one remote, and none for here, several, or one gone', () => {
    expect(hubOf({ machine: { pinned: [] }, remotes: remotes('vps') }).hub?.name).toBe('vps')
    expect(hubOf({ machine: { pinned: [] }, remotes: remotes('vps', 'nas') }).hub).toBeNull()
    expect(
      hubOf({ machine: { pinned: [], hub: 'nas' }, remotes: remotes('vps', 'nas') }).hub,
    ).toEqual({ name: 'nas', why: 'machine.hub names it' })
    expect(hubOf({ machine: { pinned: [], hub: 'here' }, remotes: remotes('vps') }).hub).toBeNull()
    expect(hubOf({ machine: { pinned: [], hub: 'old' }, remotes: remotes('vps') })).toEqual({
      hub: null,
      gone: 'machine.hub names old, which is not a remote here, so no queued work is sent anywhere',
    })
  })

  it('work queued for later on a hub project goes to the hub, and says where and why', () => {
    expect(placeQueued(facts)).toEqual({
      on: 'vps',
      project: 'api',
      why: 'placed on vps from mac: it waits for later and nothing ties it to mac, and vps is the hub (it is the one machine this one links to), so closing the lid strands nothing',
    })
  })

  it('stays where something ties it, and says what', () => {
    expect(placeQueued({ ...facts, startsNow: true })).toEqual({ on: null, why: null })
    expect(placeQueued({ ...facts, hub: null })).toEqual({ on: null, why: null })
    expect(placeQueued({ ...facts, projectThere: null }).why).toBe(
      'stays on mac: vps has no one project that is this repository',
    )
    expect(placeQueued({ ...facts, waitsHere: ['api/a'] }).why).toBe(
      'stays on mac: it builds on api/a, which works here',
    )
    expect(placeQueued({ ...facts, filesHere: true }).why).toBe(
      'stays on mac: it has files only this machine holds',
    )
    expect(placeQueued({ ...facts, measurement: true }).why).toBe(
      'stays on mac: it is a measurement of this machine',
    )
    expect(placeQueued({ ...facts, hubUp: false }).why).toBe(
      'stays on mac: vps is not linked now, so it was not sent there',
    )
  })
})

describe("another machine's queued work, as the hub draws it", () => {
  const clock = (at: number) => new Date(at).toISOString().slice(11, 16)

  it('is work made with a start there and not yet started, finished, removed or moved', () => {
    const mac = machine(
      'mac',
      [
        line('task_created', 'tade/tied', { after: [] }),
        line('task_created', 'tade/later', { after: ['tade/tied'], at: '2026-11-23T02:00:00Z' }),
        line('task_created', 'tade/now', {}),
        line('task_created', 'tade/started', { after: [] }),
        line('queue_started', 'tade/started', { after: [] }),
        line('task_created', 'tade/done', { after: [] }),
        line('task_done', 'tade/done'),
        line('task_created', 'tade/gone', { after: [] }),
        line('task_removed', 'tade/gone'),
        line('task_created', 'tade/placed', { after: [] }),
        line('task_moved', 'tade/placed', { to: 'vps', as: 'tade/placed' }),
      ],
      { called: 'laptop', heardAt: NOW - 3_600_000 },
    )
    expect(queuedThere({ self: 'vps', machines: [mac] }, NOW)).toEqual([
      {
        machine: 'laptop',
        task: 'tade/tied',
        project: 'tade',
        heardAt: NOW - 3_600_000,
        silentDays: null,
      },
      {
        machine: 'laptop',
        task: 'tade/later',
        project: 'tade',
        heardAt: NOW - 3_600_000,
        silentDays: null,
      },
    ])
  })

  it('comes back when work moved away is taken back there', () => {
    const mac = machine('mac', [
      line('task_created', 'tade/back', { after: [] }),
      line('task_moved', 'tade/back', { to: 'vps', as: 'tade/back' }),
      line('task_created', 'tade/back', { after: [] }),
      line('task_taken', 'tade/back', { from: 'vps', was: 'tade/back' }),
    ])
    expect(queuedThere({ self: 'vps', machines: [mac] }, NOW).map((one) => one.task)).toEqual([
      'tade/back',
    ])
  })

  it('is nothing with no other machine kept here', () => {
    expect(queuedThere(undefined, NOW)).toEqual([])
    expect(queuedThere({ self: 'vps', machines: [] }, NOW)).toEqual([])
  })

  it('says it waits for that machine, and when it was last heard', () => {
    const [heard] = queuedThere(
      { self: 'vps', machines: [machine('mac', [line('task_created', 'tade/a', { after: [] })])] },
      NOW,
    )
    expect(heard && queuedThereSays(heard, clock)).toBe('waits for mac (mac last heard 13:59)')
    expect(queuedThereSays({ machine: 'mac', heardAt: null, silentDays: null }, clock)).toBe(
      'waits for mac (mac not heard from here yet)',
    )
    const [silent] = queuedThere(
      {
        self: 'vps',
        machines: [
          machine('mac', [line('task_created', 'tade/a', { after: [] })], {
            heardAt: NOW - (SILENT_DAYS + 1) * DAY,
          }),
        ],
      },
      NOW,
    )
    expect(silent?.silentDays).toBe(SILENT_DAYS + 1)
    expect(silent && queuedThereSays(silent, clock)).toBe(
      `waits for mac (mac not heard from in ${SILENT_DAYS + 1} days)`,
    )
  })
})
