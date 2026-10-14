import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { type Arm, LOCAL, type Plan } from '@tade/core'
import { Workbench } from '@tade/workbench'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkrepo, tmp } from '../../../test/fixtures/mkrepo.ts'
import { ToolHost, type ToolHostOptions } from '../src/tool-host.ts'
import { call } from './host-harness.ts'

// An agent the orchestrator starts, against a workbench that only records.
//
// What is under test is what is settled before anything starts — the model it
// was asked to run on — and what goes with it: the files attached to what the
// orchestrator is answering, and nothing with a start that says nothing.

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

// On 2026-10-11 a design task was made three times over: steering it while it
// was queued answered "no agent running", so each time the person said more the
// orchestrator removed it and planned it again.
describe('steering work that has not started', () => {
  let host: ToolHost | null = null
  let client: Workbench | null = null

  afterEach(async () => {
    await host?.close()
    await client?.close().catch(() => {})
    host = null
    client = null
  })

  it('says what reaches queued work instead, and only of work whose agent never ran', async () => {
    const repo = mkrepo()
    const home = tmp('tade-steer-')
    writeFileSync(
      join(home, 'config.yaml'),
      `agents:\n  workspace: checkout\nprojects:\n  app:\n    root: ${repo.root}\n`,
    )
    // Its own sessions, so nothing of a real ~/.pi is read or written.
    const tade = await Workbench.open({ home, sessionsRoot: tmp('tade-sessions-') })
    client = tade
    const agent = (name: string) => ({ name, said: name, prompt: name, after: [], touches: [] })
    await tade.planTasks({ project: 'app', said: '', agents: [agent('design'), agent('ran')] })
    await tade.log.append({ type: 'run_started', task: 'app/ran', detail: {} })
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade, path })

    const queued = await call(path, 'worker/steer', { task: 'app/design', message: 'add ⌘K' })
    expect(queued.error?.message).toBe(
      'app/design has not started: tade_queue_change retell changes what it will be told; a note scoped to it (tade_remember about: app/design) is in what it is told when it starts',
    )
    // One that ran and stopped is not queued work, and neither is no task at all.
    const stopped = await call(path, 'worker/steer', { task: 'app/ran', message: 'hello' })
    expect(stopped.error?.message).toBe('no agent running on app/ran')
    const none = await call(path, 'worker/steer', { task: 'app/ghost', message: 'hello' })
    expect(none.error?.message).toBe('no agent running on app/ghost')
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

describe('changing queued work, from the tool to the window', () => {
  let host: ToolHost | null = null

  afterEach(async () => {
    await host?.close()
    host = null
    delete process.env.TADE_SOCKET
    vi.resetModules()
  })

  // The orchestrator once called `tade_queue_change` twelve times and was told
  // "say which" every time; its session shows it sent `{"change":"wait"}` and
  // nothing else. This is the other half of that finding: the tool the model
  // is given, the socket and the host carry a `task` that was sent, whole.
  it('hands the window the task the tool was called with', async () => {
    const path = join(tmp('tade-queue-'), 'tools.sock')
    const asked: Record<string, unknown>[] = []
    host = await ToolHost.listen({
      tade: {} as Workbench,
      path,
      queue: {
        describe: async () => '',
        change: async (req) => {
          asked.push(req)
          return 'done'
        },
        schedule: async () => '',
        plan: async () => '',
      },
    })
    vi.resetModules()
    process.env.TADE_SOCKET = path
    const { orchestratorTools } = await import('../src/tools-extension.ts')
    const tool = orchestratorTools().find((one) => one.name === 'tade_queue_change')
    const schema = tool?.parameters as { properties: Record<string, unknown>; required: string[] }
    expect(Object.keys(schema.properties)).toContain('task')
    expect(schema.required).toEqual(['change'])

    expect(
      await tool?.run({ change: 'wait', task: 'tade/perf-draw-gate-subjects' }, 'c1', { cwd: '/' }),
    ).toBe('done')
    expect(asked).toEqual([{ change: 'wait', task: 'tade/perf-draw-gate-subjects' }])

    // A wait written on queued work, and a retelling, carried whole. A plain
    // name, or the plan's own `agent` spelling, is the same wait.
    await tool?.run(
      {
        change: 'after',
        task: 'tade/lane-echo',
        after: [{ task: 'open-paints-first', why: 'app.ts' }, { agent: 'tade/docs', why: '' }, 'x'],
        replace: true,
      },
      'c2',
      { cwd: '/' },
    )
    await tool?.run(
      { change: 'retell', task: 'tade/lane-echo', prompt: 'only the echo', touches: ['app.ts'] },
      'c3',
      { cwd: '/' },
    )
    expect(asked.slice(1)).toEqual([
      {
        change: 'after',
        task: 'tade/lane-echo',
        after: [
          { task: 'open-paints-first', why: 'app.ts' },
          { task: 'tade/docs', why: '' },
          { task: 'x', why: '' },
        ],
        replace: true,
      },
      { change: 'retell', task: 'tade/lane-echo', prompt: 'only the echo', touches: ['app.ts'] },
    ])

    // What becomes of what waited on removed work is carried; anything but
    // the two answers is refused, saying what they are.
    await tool?.run({ change: 'remove', task: 'tade/lane-echo', dependents: 'inherit' }, 'c4', {
      cwd: '/',
    })
    expect(asked.at(-1)).toEqual({
      change: 'remove',
      task: 'tade/lane-echo',
      dependents: 'inherit',
    })
    await expect(
      tool?.run({ change: 'remove', task: 'tade/lane-echo', dependents: 'drop' }, 'c5', {
        cwd: '/',
      }),
    ).rejects.toThrow('dependents is hold, which leaves what waited on it held, or inherit')
    expect(asked).toHaveLength(4)
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
