import { connect } from 'node:net'
import { join } from 'node:path'
import { type Arm, LOCAL, type Plan } from '@tade/core'
import type { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it } from 'vitest'
import { tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost, type ToolHostOptions } from '../src/tool-host.ts'

// An agent the orchestrator starts, against a workbench that only records.
//
// What is under test is what is settled before anything starts — the model it
// was asked to run on — and what goes with it: the files attached to what the
// orchestrator is answering, and nothing with a start that says nothing.

/** One call over the socket, framed the way the orchestrator's tools frame it. */
function call(
  path: string,
  method: string,
  params: Record<string, unknown>,
): Promise<{ result?: unknown; error?: { message: string } }> {
  return new Promise((resolve, reject) => {
    const socket = connect(path)
    let buffer = Buffer.alloc(0)
    socket.on('error', reject)
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const split = buffer.indexOf('\r\n\r\n')
      if (split < 0) return
      const header = buffer.subarray(0, split).toString('utf8')
      const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
      if (buffer.byteLength < split + 4 + length) return
      socket.end()
      resolve(JSON.parse(buffer.subarray(split + 4, split + 4 + length).toString('utf8')))
    })
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), 'utf8')
    socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
    socket.write(body)
  })
}

describe('starting an agent for the orchestrator', () => {
  let host: ToolHost | null = null
  const started: Array<Record<string, unknown>> = []
  let handedOff = 0

  const tade = {
    // Among what the task's own harness offers.
    async resolveModelFor(_task: string, _cwd: string, said: string) {
      if (said === 'opus') return { provider: 'openrouter', id: 'anthropic/claude-opus-5' }
      throw new Error(`"${said}" could be gpt-4o, gpt-5: say which`)
    },
    async startAgent(request: Record<string, unknown>) {
      started.push(request)
      return { id: `${String(request.task)}/agent`, alive: true }
    },
  } as unknown as Workbench

  async function listen(over: Partial<ToolHostOptions> = {}): Promise<string> {
    started.length = 0
    handedOff = 0
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({
      tade,
      path,
      handOff: async (task) => {
        handedOff++
        return {
          note: `An attachment is at ~/.tade/projects/${task}/attachments/shot.png.`,
          images: [{ data: 'iVBORw0K', mimeType: 'image/png' }],
        }
      },
      ...over,
    })
    return path
  }

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('starts it on the model that was named', async () => {
    const path = await listen({ handOff: undefined })
    const answer = await call(path, 'worker/start', {
      task: 'app/refunds',
      cwd: '/src/app',
      prompt: 'fix the double charge',
      model: 'opus',
    })
    expect(answer.error).toBeUndefined()
    expect(started).toEqual([
      {
        task: 'app/refunds',
        cwd: '/src/app',
        prompt: 'fix the double charge',
        model: { provider: 'openrouter', id: 'anthropic/claude-opus-5' },
      },
    ])
  })

  it('starts nothing when it cannot tell which model was meant, and says what to ask', async () => {
    const path = await listen()
    const answer = await call(path, 'worker/start', {
      task: 'app/refunds',
      cwd: '/src/app',
      prompt: 'fix the double charge',
      model: 'gpt',
    })
    expect(answer.error?.message).toMatch(/say which/)
    // Not on some other model, and not with the files either: nothing at all.
    expect(started).toEqual([])
    expect(handedOff).toBe(0)
  })

  it('hands what was attached to the agent, after what it is told', async () => {
    const path = await listen()
    await call(path, 'worker/start', {
      task: 'app/refunds',
      cwd: '/src/app',
      prompt: 'look at this',
    })
    expect(started[0]).toMatchObject({
      prompt:
        'look at this\n\nAn attachment is at ~/.tade/projects/app/refunds/attachments/shot.png.',
      images: [{ mimeType: 'image/png' }],
    })
  })

  it('sends nothing with a start that says nothing, which only opens the agent', async () => {
    const path = await listen()
    await call(path, 'worker/start', { task: 'app/refunds', cwd: '/src/app', prompt: '' })
    expect(handedOff).toBe(0)
    expect(started).toEqual([{ task: 'app/refunds', cwd: '/src/app', prompt: '' }])
  })
})

describe('writing a note down', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('keeps the words and the headline apart, and takes neither for the other', async () => {
    const written: unknown[][] = []
    const tade = {
      remember: (...args: unknown[]) => {
        written.push(args)
        return { ok: true }
      },
    } as unknown as Workbench
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade, path })

    await call(path, 'memory/remember', {
      text: 'refunds go through the ledger service',
      summary: 'Refunds via the ledger',
      scope: 'app/refunds',
      by: 'orchestrator',
    })
    expect(written[0]).toEqual([
      'refunds go through the ledger service',
      'app/refunds',
      'orchestrator',
      'Refunds via the ledger',
    ])

    // A note taken without one is taken without one: nothing is made up here.
    await call(path, 'memory/remember', { text: 'we pin majors', scope: null })
    expect(written[1]).toEqual(['we pin majors', null, 'tade', null])
  })
})

describe('where everything stands', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('is the window’s answer, and says so when there is no window to ask', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    const seen = { projects: [{ name: 'app', tasks: [{ id: 'app/refunds', state: 'blocked' }] }] }
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      status: async () => seen,
    })
    expect((await call(path, 'status/read', {})).result).toEqual(seen)
    await host.close()

    const bare = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path: bare })
    expect((await call(bare, 'status/read', {})).error?.message).toMatch(/no window to ask/)
  })
})

describe('where every sign-in stands against its plan', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('reads every login, and never turns one that could not say into nothing used', async () => {
    const NOW = Date.now()
    const path = join(tmp('tade-limits-'), 'tools.sock')
    host = await ToolHost.listen({
      tade: {
        // Two accounts across two harnesses, one that reports nothing, and a
        // window that has already started over.
        planUsage: () => [
          {
            harness: 'claude-code',
            account: null,
            can: 'while-working',
            pays: 'plan',
            why: 'reports it as one of its agents replies',
            said: {
              at: NOW - 60_000,
              windows: [{ label: '5h', used: 94, resetsAt: NOW + 900_000 }],
            },
          },
          {
            harness: 'codex',
            account: 'work',
            can: 'while-working',
            pays: 'plan',
            why: 'says it as each turn ends',
            said: { at: NOW, windows: [{ label: '5h', used: 20, resetsAt: NOW + 3_600_000 }] },
          },
          {
            harness: 'claude-code',
            account: 'reviews',
            can: 'while-working',
            pays: 'per-token',
            why: 'reports it as one of its agents replies',
            said: {
              at: NOW - 6 * 3_600_000,
              windows: [{ label: '5h', used: 41, resetsAt: NOW - 1 }],
            },
          },
          {
            harness: 'pi',
            account: null,
            can: 'none',
            pays: 'per-token',
            why: 'prices every turn instead',
            said: null,
          },
        ],
      } as unknown as Workbench,
      path,
    })
    const report = (await call(path, 'plan/limits', {})).result as {
      signIns: Array<{ label: string; windows: unknown[]; pressure: string | null }>
      pressed: Array<{ label: string }>
      instead: Array<{ label: string }>
    }
    expect(report.signIns.map((one) => one.label)).toEqual([
      'claude-code',
      'codex @work',
      'claude-code @reviews',
      'pi',
    ])
    // The one at its limit is named, and the two that could not say have no
    // figure at all rather than a zero that would read as a plan with room.
    expect(report.pressed.map((one) => one.label)).toEqual(['claude-code'])
    expect(report.signIns.slice(2).map((one) => one.windows)).toEqual([[], []])
    expect(report.signIns.slice(2).map((one) => one.pressure)).toEqual([null, null])
    // And what else there is, which is what somebody can be told to move to.
    expect(report.instead.map((one) => one.label)).toEqual([
      'codex @work',
      'claude-code @reviews',
      'pi',
    ])
  })
})

describe('a plan that spans repositories, as it reaches the window', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('carries each agent’s own project and the name of the change, and leaves them off when unsaid', async () => {
    const path = join(tmp('tade-plan-'), 'tools.sock')
    const made: Plan[] = []
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      queue: {
        describe: async () => '',
        change: async () => '',
        schedule: async () => '',
        plan: async (plan) => {
          made.push(plan)
          return 'made'
        },
      },
    })
    await call(path, 'queue/plan', {
      project: 'api',
      said: 'widen the scopes and bump the client',
      effort: 'oauth-scopes',
      agents: [
        { name: 'oauth-scopes', said: 'widen', prompt: 'widen them' },
        {
          name: 'oauth-scopes',
          project: 'cli',
          said: 'bump',
          prompt: 'bump it',
          after: [{ agent: 'api/oauth-scopes', why: 'scopes first' }],
        },
      ],
    })
    expect(made[0]?.effort).toBe('oauth-scopes')
    // Unsaid is absent, not empty: the plan's own project is the default, and
    // an empty string would be a project nobody has. Reading is all this does
    // — a plan that spans repositories and leans on that default is refused by
    // `checkPlan`, which is downstream of here and not what this is about.
    expect(made[0]?.agents[0]).not.toHaveProperty('project')
    expect(made[0]?.agents[1]?.project).toBe('cli')
    expect(made[0]?.agents[1]?.after).toEqual([{ agent: 'api/oauth-scopes', why: 'scopes first' }])

    await call(path, 'queue/plan', {
      project: 'api',
      said: 'just the one',
      agents: [{ name: 'a', said: 'a', prompt: 'a' }],
    })
    expect(made[1]).not.toHaveProperty('effort')
  })
})

describe('putting work on a clock', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('hands the window a watch as asked, looking as often as the watch says when no rule is given', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    const asked: Record<string, unknown>[] = []
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      queue: {
        describe: async () => '',
        change: async () => '',
        plan: async () => '',
        schedule: async (req) => {
          asked.push(req as unknown as Record<string, unknown>)
          return 'scheduled'
        },
      },
    })
    const base = { name: 'New errors', project: 'app', said: 'fix new errors as they come' }
    // An empty rule is no rule: the watch's own.
    expect(
      (
        await call(path, 'queue/schedule', {
          ...base,
          when: {},
          watch: 'sentry.new-errors',
          input: { query: 'level:error' },
          found: 'ask',
          most: 3,
        })
      ).result,
    ).toBe('scheduled')
    expect(asked[0]).toEqual({
      ...base,
      watch: 'sentry.new-errors',
      input: { query: 'level:error' },
      found: 'ask',
      most: 3,
    })
    expect(
      (await call(path, 'queue/schedule', { ...base, watch: 'sentry.new-errors', input: 'all' }))
        .error?.message,
    ).toMatch(/input is what the watch is turned on with/)
    expect(
      (await call(path, 'queue/schedule', { ...base, when: { every: 3 }, agent: 'x' })).error
        ?.message,
    ).toMatch(/when is not a rule/)
  })
})

describe('changing how Tade is set up', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
  })

  it('hands each act to the window, with what it was given', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    const asked: Record<string, unknown>[] = []
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      config: {
        settings: async (find) => {
          asked.push({ settings: find })
          return 'agents.commit = own-files'
        },
        change: async (req) => {
          asked.push({ change: req })
          // The boundary lives in the window, so a refusal reaches the model
          // as a tool that failed rather than as an answer it can argue with.
          if (req.path.startsWith('approvals.')) throw new Error('not mine to change')
          return 'Saved.'
        },
        openProject: async (req) => {
          asked.push({ open: req })
          return 'Opened payments.'
        },
        closeProject: async (req) => {
          asked.push({ close: req })
          return 'Closed payments.'
        },
        renameProject: async (req) => {
          asked.push({ rename: req })
          return 'payments shows as Payments.'
        },
        reorderProjects: async (req) => {
          asked.push({ reorder: req })
          return 'The tabs are now payments, docs.'
        },
        configureProject: async (req) => {
          asked.push({ configure: req })
          return 'Saved.'
        },
      },
    })
    expect((await call(path, 'config/settings', { find: 'commit' })).result).toContain(
      'agents.commit',
    )
    expect(
      (
        await call(path, 'config/change', {
          path: 'agents.commit',
          value: 'as-you-go',
          said: 'commit as you go',
        })
      ).result,
    ).toBe('Saved.')
    expect(
      (await call(path, 'config/change', { path: 'approvals.mode', value: 'bypass' })).error
        ?.message,
    ).toMatch(/not mine to change/)
    expect(
      (await call(path, 'project/open', { path: '~/src/payments', create: true })).result,
    ).toBe('Opened payments.')
    expect(
      (await call(path, 'project/close', { project: 'payments', said: 'close payments' })).result,
    ).toBe('Closed payments.')
    expect(
      (
        await call(path, 'project/rename', {
          project: 'payments',
          name: 'Payments',
          said: 'call payments Payments',
        })
      ).result,
    ).toBe('payments shows as Payments.')
    expect((await call(path, 'project/reorder', { order: ['payments', 'docs'] })).result).toBe(
      'The tabs are now payments, docs.',
    )
    // An order that is not a list is refused here rather than reaching the
    // window as `[object Object]`: what comes over this socket is whatever a
    // model put in a tool call, and every other argument is read as text.
    expect((await call(path, 'project/reorder', { order: 'payments' })).error?.message).toMatch(
      /a list of their names/,
    )
    expect(
      (
        await call(path, 'project/configure', {
          project: 'payments',
          setting: 'budget.usd_per_day',
          value: '20',
          said: 'give payments a budget of 20 a day',
        })
      ).result,
    ).toBe('Saved.')
    expect(asked).toEqual([
      { settings: 'commit' },
      { change: { path: 'agents.commit', value: 'as-you-go', said: 'commit as you go' } },
      { change: { path: 'approvals.mode', value: 'bypass', said: '' } },
      { open: { path: '~/src/payments', create: true } },
      { close: { project: 'payments', said: 'close payments' } },
      { rename: { project: 'payments', name: 'Payments', said: 'call payments Payments' } },
      { reorder: { order: ['payments', 'docs'] } },
      {
        configure: {
          project: 'payments',
          setting: 'budget.usd_per_day',
          value: '20',
          said: 'give payments a budget of 20 a day',
        },
      },
    ])
  })

  it('says there is nothing to configure with when no window is holding the config', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path })
    for (const method of [
      'config/settings',
      'config/change',
      'project/open',
      'project/close',
      'project/rename',
      'project/reorder',
      'project/configure',
    ]) {
      expect((await call(path, method, {})).error?.message, method).toMatch(/window open/)
    }
  })
})

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
  let arm: Arm = LOCAL
  let statusAsked = 0

  const held = [
    {
      run: 'sentry/flake/agent',
      task: 'sentry/flake',
      requestId: 'perm_1',
      tool: 'bash',
      summary: 'bash: rm -rf /Users/testperson/work',
      tier: 'hard' as const,
      rule: 'force',
      reason: 'deletes a folder',
      at: 1,
    },
  ]

  const tade = {
    pendingApprovals: () => held,
    async steerAgent(task: string, said: string) {
      told.push({ task, said })
    },
    async decideApproval() {},
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
    statusAsked = 0
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
