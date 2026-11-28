import { Moved, NotThere, noFacts, type TaskFacts, taskRev } from '@tade/web'
import { describe, expect, it } from 'vitest'
import type { AgentMenuDoors } from '../../src/wire/agent-doors.ts'
import type { ActingDeps } from '../../src/wire/web-acting.ts'
import { agentActing } from '../../src/wire/web-agent.ts'

// The window's end of the rest of an agent's menu from away: each verb reaches
// the door a press on the window's row goes through, with the device as who
// asked, and re-reads what it assumes at the act — the lane, the count of
// starts — so a press from a screen that has moved does nothing.

const TASK = 'app/one'
const DEVICE = { how: 'remote' as const, device: '00112233445566aa' }

/** A window holding one task, its lane as `lane` says, and doors that write down every call. */
function windowOf(lane: 'none' | 'running' | 'stopped', starts = 1) {
  const calls: { door: string; args: unknown[] }[] = []
  let alive = lane === 'running'
  const facts: TaskFacts = { ...noFacts(), lane, starts, agents: lane === 'none' ? 0 : 1 }
  const door =
    (name: string, answer: unknown) =>
    (...args: unknown[]) => {
      calls.push({ door: name, args })
      return Promise.resolve(answer)
    }
  const menus: AgentMenuDoors = {
    remove: door('remove', undefined) as AgentMenuDoors['remove'],
    rename: door('rename', 'the migration') as AgentMenuDoors['rename'],
    model: door('model', 'anthropic/claude-opus-5') as AgentMenuDoors['model'],
    account: door('account', 'runs as work') as AgentMenuDoors['account'],
    menu: () => Promise.resolve(null),
  }
  const deps = {
    seen: (task: string) => (task === TASK ? facts : null),
    tade: {
      lanes: () => (lane === 'none' && !alive ? [] : [{ id: `${TASK}/agent`, alive }]),
      events: () =>
        Promise.resolve(Array.from({ length: starts + (alive && lane !== 'running' ? 1 : 0) })),
    },
    lifecycle: {
      agents: () => ({
        stopExactly: door('stop', undefined),
        reopenExactly: (task: string, by: string) => {
          calls.push({ door: 'start', args: [task, by] })
          alive = true
          return Promise.resolve('opened' as const)
        },
      }),
    },
    menus: () => menus,
  } as unknown as ActingDeps & { menus: () => AgentMenuDoors }
  return { acting: agentActing(deps), calls, was: taskRev(facts) }
}

describe('each verb of an agent’s menu, at the window', () => {
  it('reaches its own door with the device as who asked', async () => {
    const cases = [
      ['rename', { title: 'the migration' }, ['the migration']],
      ['model', { model: 'claude-opus-5' }, ['claude-opus-5']],
      ['account', { account: 'work' }, ['work']],
      ['remove', { confirm: true }, []],
    ] as const
    for (const [verb, call, args] of cases) {
      const made = windowOf('running')
      const said = await (
        made.acting[verb] as (call: unknown, from: typeof DEVICE) => Promise<{ did: boolean }>
      )({ task: TASK, was: made.was, ...call }, DEVICE)
      expect(said.did, verb).toBe(true)
      expect(made.calls, verb).toEqual([
        { door: verb, args: [TASK, ...args, 'device 00112233445566aa'] },
      ])
    }
  })

  it('starts one that never ran, and one that stopped, saying nothing to either', async () => {
    for (const lane of ['none', 'stopped'] as const) {
      const made = windowOf(lane)
      const said = await made.acting.start({ task: TASK, was: made.was }, DEVICE)
      expect(said.did, lane).toBe(true)
      expect(said.said, lane).toContain('nothing said to it')
      expect(made.calls).toEqual([{ door: 'start', args: [TASK, 'device 00112233445566aa'] }])
    }
  })

  it('refuses a start where its agent is running, and reaches no door', async () => {
    const made = windowOf('running')
    await expect(made.acting.start({ task: TASK, was: made.was }, DEVICE)).rejects.toBeInstanceOf(
      Moved,
    )
    expect(made.calls).toEqual([])
  })

  it('refuses a model where nothing is running', async () => {
    for (const [verb, call] of [['model', { model: 'claude-opus-5' }]] as const) {
      const made = windowOf('stopped')
      await expect(
        (made.acting[verb] as (call: unknown, from: typeof DEVICE) => Promise<unknown>)(
          { task: TASK, was: made.was, ...call },
          DEVICE,
        ),
        verb,
      ).rejects.toBeInstanceOf(Moved)
      expect(made.calls, verb).toEqual([])
    }
  })

  it('refuses a screen that has moved, and a task it does not have', async () => {
    const made = windowOf('running')
    await expect(
      made.acting.rename({ task: TASK, was: 'p0.old', title: 'x' }, DEVICE),
    ).rejects.toBeInstanceOf(Moved)
    await expect(
      made.acting.rename({ task: 'app/nobody', was: made.was, title: 'x' }, DEVICE),
    ).rejects.toBeInstanceOf(NotThere)
    expect(made.calls).toEqual([])
  })

  it('runs one act per task at a time', async () => {
    const made = windowOf('running')
    const first = made.acting.rename({ task: TASK, was: made.was, title: 'one' }, DEVICE)
    const second = made.acting.rename({ task: TASK, was: made.was, title: 'two' }, DEVICE)
    await expect(second).rejects.toBeInstanceOf(Moved)
    await first
    expect(made.calls).toHaveLength(1)
  })
})
