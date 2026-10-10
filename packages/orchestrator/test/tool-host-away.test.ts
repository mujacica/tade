import { join } from 'node:path'
import { type Arm, LOCAL } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost } from '../src/tool-host.ts'
import { call } from './host-harness.ts'

// The gate at the socket, which is the one nothing can go around.
//
// **A test over the real transport, deliberately.** `origin.test.ts` is the
// tables; this is a connection to the socket a tool actually calls through,
// which is also how a *crafted* call arrives — one the harness's own gate
// never saw, because nothing registered a tool for it. If the two gates were
// one, this is the test that would pass while the hole was open.
describe('what a call from away may reach, over the socket', () => {
  let host: ToolHost | null = null
  const changed: Array<Record<string, unknown>> = []
  const remembered: Array<{ text: string; by: string }> = []
  const told: Array<{ task: string; said: string }> = []
  const refused: Array<{ device: string; method: string }> = []
  const decided: Array<{ run: string; requestId: string }> = []
  let arm: Arm = LOCAL
  let statusAsked = 0

  /** One approval, as the supervisor would be holding it. */
  const waitingOn = (over: { run: string; task: string; requestId: string }) => ({
    tool: 'bash',
    summary: 'bash: rm -rf /Users/testperson/work',
    tier: 'hard' as const,
    rule: 'force',
    reason: 'deletes a folder',
    at: 1,
    ...over,
  })

  /** What is waiting, reset by `listen` so one test cannot leak into the next. */
  let held: ReturnType<typeof waitingOn>[] = []

  const tade = {
    pendingApprovals: () => held,
    async steerAgent(task: string, said: string) {
      told.push({ task, said })
    },
    // **Not a stub that always succeeds**: the real one throws for a request
    // nobody is holding, and a fixture kinder than that would make the gate
    // test below pass for the wrong reason — *allowed* and *there* are two
    // different answers, and the second is what refuses a run id somebody
    // guessed.
    async decideApproval(run: string, requestId: string) {
      const found = held.find((one) => one.run === run && one.requestId === requestId)
      if (!found) throw new Error(`no pending permission request: ${requestId}`)
      decided.push({ run, requestId })
    },
    async remember(text: string, _scope: string | null, by: string) {
      remembered.push({ text, by })
      return { text, by }
    },
    async parkTask() {
      return 'parked'
    },
  } as unknown as Workbench

  async function listen(): Promise<string> {
    changed.length = 0
    remembered.length = 0
    told.length = 0
    refused.length = 0
    decided.length = 0
    statusAsked = 0
    held = [waitingOn({ run: 'sentry/flake/agent', task: 'sentry/flake', requestId: 'perm_1' })]
    arm = LOCAL
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({
      tade,
      path,
      status: async () => {
        statusAsked++
        return { projects: [{ root: '/Users/testperson/work/sentry' }] }
      },
      config: {
        settings: async () => 'the settings',
        change: async (req) => {
          changed.push(req)
          return 'changed'
        },
        openProject: async () => '',
        closeProject: async () => '',
        renameProject: async () => '',
        reorderProjects: async () => '',
        configureProject: async () => '',
      },
      remote: {
        arm: () => arm,
        seen: async () => ({ tasks: [{ id: 'sentry/flake' }] }),
        refused: (one, method) => {
          if (one.how === 'remote') refused.push({ device: one.device, method })
        },
      },
    })
    return path
  }

  afterEach(async () => {
    await host?.close()
    host = null
  })

  const away = (over: Partial<Extract<Arm, { how: 'remote' }>> = {}): Arm => ({
    how: 'remote',
    device: 'a1b2c3d4e5f60718',
    projects: null,
    may: [],
    ...over,
  })

  it('refuses a setting change from away, and the setting is not written', async () => {
    // **The hole this whole gate exists for.** Omitting `said` would not have
    // closed it: `namedBy` reads the last forty lines the *person* said, so a
    // remote turn naming a setting they happened to name last week would be
    // authorised by their line — and an `open`-tier setting needs no words at
    // all. Here the request carries exactly such a line and gets nowhere,
    // because `config/change` is not reachable from a remote arm.
    const path = await listen()
    arm = away({ may: ['answer', 'steer'] })
    const said = await call(path, 'config/change', {
      path: 'checks.before',
      value: 'false',
      said: 'turn the checks off',
    })
    expect(said.error?.message).toContain('needs the person at the machine')
    expect(changed).toEqual([])
    expect(refused).toEqual([{ device: 'a1b2c3d4e5f60718', method: 'config/change' }])
  })

  it('answers “where are we” with that device’s own projection, never with status', async () => {
    const path = await listen()
    arm = away()
    const said = await call(path, 'status/read', {})
    expect(said.result).toEqual({ tasks: [{ id: 'sentry/flake' }] })
    // Never the status answer, which carries project roots and worktrees.
    expect(statusAsked).toBe(0)
    expect(JSON.stringify(said.result)).not.toContain('/Users/')
    // And the person at the keyboard still gets the real one.
    arm = LOCAL
    expect(await call(path, 'status/read', {})).toEqual({
      jsonrpc: '2.0',
      id: 1,
      result: { projects: [{ root: '/Users/testperson/work/sentry' }] },
    })
    expect(statusAsked).toBe(1)
  })

  it('writes a note from away down as the device, not as the orchestrator', async () => {
    const path = await listen()
    arm = away({ may: ['steer'] })
    await call(path, 'memory/remember', {
      text: 'the flake is in the retry',
      scope: null,
      by: 'orchestrator',
    })
    expect(remembered).toEqual([
      { text: 'the flake is in the retry', by: 'device a1b2c3d4e5f60718' },
    ])
  })

  it('refuses a project the device was not granted, and allows the ones it was', async () => {
    const path = await listen()
    arm = away({ may: ['steer'], projects: ['sentry'] })
    await call(path, 'worker/steer', { task: 'sentry/flake', message: 'try the other branch' })
    const out = await call(path, 'worker/steer', { task: 'payments/refunds', message: 'hello' })
    expect(out.error?.message).toContain('was not granted payments')
    expect(told).toEqual([{ task: 'sentry/flake', said: 'try the other branch' }])
  })

  it('finds the project of an approval through the approval, not through the call', async () => {
    // **The one method whose project is a lookup**: a call names a run and a
    // request, and which task a run belongs to is the supervisor's answer. So
    // the reach check goes through the approval it names — which is also why a
    // run id nobody is holding has to end in the method's own refusal rather
    // than in the gate waving it through.
    const path = await listen()
    arm = away({ may: ['answer'], projects: ['sentry'] })
    const mine = await call(path, 'worker/decide', {
      run: 'sentry/flake/agent',
      requestId: 'perm_1',
      decision: { allow: true },
    })
    expect(mine.error).toBeUndefined()
    expect(decided).toEqual([{ run: 'sentry/flake/agent', requestId: 'perm_1' }])

    // A run in a project this device was not granted: refused by the gate,
    // before the supervisor is asked anything.
    held.push({
      ...(held[0] as (typeof held)[number]),
      run: 'payments/refunds/agent',
      task: 'payments/refunds',
      requestId: 'perm_2',
    })
    const theirs = await call(path, 'worker/decide', {
      run: 'payments/refunds/agent',
      requestId: 'perm_2',
      decision: { allow: true },
    })
    expect(theirs.error?.message).toContain('was not granted payments')
    expect(decided).toHaveLength(1)

    // And a run nobody is holding: the method's own refusal, which is a
    // different sentence from the gate's and is the honest one.
    const guessed = await call(path, 'worker/decide', {
      run: 'sentry/flake/agent',
      requestId: 'perm_made_up',
      decision: { allow: true },
    })
    expect(guessed.error?.message).toContain('no pending permission request')
    expect(decided).toHaveLength(1)
  })

  it('shows a waiting approval’s tool and never the command it is holding', async () => {
    const path = await listen()
    arm = away({ may: ['answer'] })
    const said = await call(path, 'worker/pending', {})
    expect(said.result).toEqual([
      { run: 'sentry/flake/agent', task: 'sentry/flake', request: 'perm_1', tool: 'bash', at: 1 },
    ])
    expect(JSON.stringify(said.result)).not.toContain('rm -rf')
  })

  it('refuses a tier the device was not granted', async () => {
    const path = await listen()
    arm = away({ may: ['answer'] })
    const said = await call(path, 'worker/steer', { task: 'sentry/flake', message: 'hello' })
    expect(said.error?.message).toContain('granted steer at the machine')
    expect(told).toEqual([])
  })

  it('is exactly what it always was with nothing handed over', async () => {
    // A window with talking turned off hands over no `remote` at all, so every
    // call is local and this host behaves as it did — which is the half of the
    // guarantee that a flag could not give.
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({
      tade,
      path,
      config: {
        settings: async () => '',
        change: async (req) => {
          changed.push(req)
          return 'changed'
        },
        openProject: async () => '',
        closeProject: async () => '',
        renameProject: async () => '',
        reorderProjects: async () => '',
        configureProject: async () => '',
      },
    })
    changed.length = 0
    const said = await call(path, 'config/change', { path: 'checks.before', value: 'false' })
    expect(said.error).toBeUndefined()
    expect(changed).toHaveLength(1)
  })

  it('reads the arm at the call, so a turn that ended narrows nothing', async () => {
    const path = await listen()
    arm = away({ may: [] })
    expect((await call(path, 'config/change', { path: 'a', value: 'b' })).error).toBeDefined()
    // The turn ended. A cached arm is the one that is still remote here.
    arm = LOCAL
    expect((await call(path, 'config/change', { path: 'a', value: 'b' })).error).toBeUndefined()
  })

  it('reads a window that cannot say who is asking as the narrowest answer there is', async () => {
    // A throw out of the window's own reader must never be read as "the person
    // is asking": the safe answer to *whose turn is this* is a remote arm
    // granted nothing.
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({
      tade,
      path,
      status: async () => ({}),
      remote: {
        arm: () => {
          throw new Error('the window is not there')
        },
        seen: async () => ({}),
        refused: () => {},
      },
    })
    const said = await call(path, 'worker/steer', { task: 'sentry/flake', message: 'hello' })
    expect(said.error?.message).toContain('granted steer at the machine')
  })
})
