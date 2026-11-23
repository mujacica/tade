import { NotOffered } from '@tade/web'
import { describe, expect, it } from 'vitest'
import { initialState } from '../../src/model.ts'
import { agentMenuDoors } from '../../src/wire/agent-doors.ts'
import type { Wiring } from '../../src/wire/context.ts'

// The window's own doors for an agent's menu, asked by name: a model, an
// account, a harness or a machine is one the machine itself offers, asked
// again at the act, and a name that is the right shape and in no list reaches
// nothing — the workbench is never called with it.

const TASK = 'app/one'

/** A window whose workbench writes down what it was asked, offering one model and one account. */
function windowOf() {
  const called: string[] = []
  const wire = {
    opts: {
      config: { accounts: { work: { harness: 'pi' }, other: { harness: 'codex' } } },
      client: {
        agentModels: () =>
          Promise.resolve({
            harness: 'pi',
            models: [{ id: 'anthropic/claude-opus-5' }],
            why: null,
          }),
        agentHarness: () =>
          Promise.resolve({ harness: 'pi', account: null, capabilities: {} as never }),
        setAgentModel: (_task: string, model: string) => {
          called.push(`model ${model}`)
          return Promise.resolve({ provider: 'anthropic', id: `anthropic/${model}` })
        },
        setAgentAccount: (req: { account: string | null }) => {
          called.push(`account ${req.account}`)
          return Promise.resolve({
            account: req.account,
            restarted: false,
            carried: true,
            ownName: null,
          })
        },
        setAgentHarness: (req: { harness: string }) => {
          called.push(`harness ${req.harness}`)
          return Promise.resolve({ harness: req.harness, restarted: false })
        },
      },
    },
    live: { worktreeOf: () => '/work', refresh: () => Promise.resolve() },
    draw: () => {},
    note: () => {},
    put: () => {},
    now: () => 0,
    state: initialState(),
  } as unknown as Wiring
  const handed: string[] = []
  const doors = agentMenuDoors(wire, {
    removeExactly: () => Promise.resolve(),
    handsOver: () => ({
      handItems: () => [
        { id: 'hand:vps', label: 'Hand to vps' },
        { id: 'hand:mini', label: 'Hand to mini', off: 'not linked now' },
      ],
      handOver: (_task, machine) => {
        handed.push(machine)
        return Promise.resolve(`handed to ${machine}`)
      },
    }),
  })
  return { doors, called, handed }
}

describe('an agent’s menu doors, asked by name', () => {
  it('switches to a model its harness offers, by its bare name or its whole id', async () => {
    const made = windowOf()
    await made.doors.model(TASK, 'claude-opus-5', 'device 00112233445566aa')
    expect(made.called).toEqual(['model claude-opus-5'])
  })

  it('refuses a model, an account or a harness the machine does not offer, calling nothing', async () => {
    const made = windowOf()
    const by = 'device 00112233445566aa'
    await expect(made.doors.model(TASK, 'gpt-9', by)).rejects.toBeInstanceOf(NotOffered)
    // Another harness's account is no account of this agent's.
    await expect(made.doors.account(TASK, 'other', by)).rejects.toBeInstanceOf(NotOffered)
    await expect(made.doors.account(TASK, 'nobody', by)).rejects.toBeInstanceOf(NotOffered)
    await expect(made.doors.harness(TASK, 'nothing-here', by)).rejects.toBeInstanceOf(NotOffered)
    expect(made.called).toEqual([])
  })

  it('moves to an account of its own harness, or back to its own sign-in', async () => {
    const made = windowOf()
    await made.doors.account(TASK, 'work', 'device 00112233445566aa')
    await made.doors.account(TASK, '', 'device 00112233445566aa')
    expect(made.called).toEqual(['account work', 'account null'])
  })

  it('hands work only to a machine its own menu offers it to now', async () => {
    const made = windowOf()
    const by = 'device 00112233445566aa'
    await expect(made.doors.move(TASK, 'vps', by)).resolves.toBe('handed to vps')
    await expect(made.doors.move(TASK, 'mini', by)).rejects.toBeInstanceOf(NotOffered)
    await expect(made.doors.move(TASK, 'elsewhere', by)).rejects.toBeInstanceOf(NotOffered)
    expect(made.handed).toEqual(['vps'])
  })
})
