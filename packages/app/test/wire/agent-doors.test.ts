import { NotOffered } from '@tade/web'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initialState } from '../../src/model.ts'
import { agentMenuDoors, LISTS_MS } from '../../src/wire/agent-doors.ts'
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

  it('refuses a model or an account the machine does not offer, calling nothing', async () => {
    const made = windowOf()
    const by = 'device 00112233445566aa'
    await expect(made.doors.model(TASK, 'gpt-9', by)).rejects.toBeInstanceOf(NotOffered)
    // Another harness's account is no account of this agent's.
    await expect(made.doors.account(TASK, 'other', by)).rejects.toBeInstanceOf(NotOffered)
    await expect(made.doors.account(TASK, 'nobody', by)).rejects.toBeInstanceOf(NotOffered)
    expect(made.called).toEqual([])
  })

  it('moves to an account of its own harness, or back to its own sign-in', async () => {
    const made = windowOf()
    await made.doors.account(TASK, 'work', 'device 00112233445566aa')
    await made.doors.account(TASK, '', 'device 00112233445566aa')
    expect(made.called).toEqual(['account work', 'account null'])
  })
})

describe('an agent’s menu, asked while its lists are slow', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** A window with one agent, not running, whose sign-ins are never answered. */
  function slowAccounts() {
    const wire = {
      opts: {
        config: { accounts: {} },
        client: {
          lane: () => null,
          // Not known, so it offers what the window's row does before it knows.
          agentHarness: () => Promise.reject(new Error('not asked here')),
          // A harness asked who it is signed in as that never says.
          accounts: () => new Promise(() => {}),
        },
      },
      live: {
        factsOf: () => ({}),
        queueFacts: () => ({ finished: new Map() }),
        changes: () => [],
        vitals: () => null,
      },
      note: () => {},
      state: initialState(),
    } as unknown as Wiring
    return agentMenuDoors(wire, { removeExactly: () => Promise.resolve(), handsOver: () => null })
  }

  it('answers with every item by its own deadline, saying on the account item why it has no list', async () => {
    vi.useFakeTimers()
    let answered: Awaited<ReturnType<ReturnType<typeof slowAccounts>['menu']>> | undefined
    void slowAccounts()
      .menu(TASK)
      .then((menu) => {
        answered = menu
      })
    await vi.advanceTimersByTimeAsync(LISTS_MS - 1)
    expect(answered).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    const ids = (answered?.items ?? []).map((one) => one.id)
    for (const id of ['open', 'start', 'rename', 'model', 'account', 'park', 'remove']) {
      expect(ids, id).toContain(id)
    }
    const account = answered?.items.find((one) => one.id === 'account')
    expect(account?.act).toMatchObject({ why: 'the accounts could not be read now' })
  })
})
