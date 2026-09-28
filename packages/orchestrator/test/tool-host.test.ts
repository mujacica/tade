import { connect } from 'node:net'
import { join } from 'node:path'
import type { Plan } from '@tade/core'
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
      handOff: async (cwd) => {
        handedOff++
        return {
          note: `An attachment is in ${cwd}/.tade/attachments/shot.png.`,
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
      prompt: 'look at this\n\nAn attachment is in /src/app/.tade/attachments/shot.png.',
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
    // an empty string would be a project nobody has.
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
    expect(asked).toEqual([
      { settings: 'commit' },
      { change: { path: 'agents.commit', value: 'as-you-go', said: 'commit as you go' } },
      { change: { path: 'approvals.mode', value: 'bypass', said: '' } },
      { open: { path: '~/src/payments', create: true } },
      { close: { project: 'payments', said: 'close payments' } },
    ])
  })

  it('says there is nothing to configure with when no window is holding the config', async () => {
    const path = join(tmp('tade-tools-'), 'tools.sock')
    host = await ToolHost.listen({ tade: {} as Workbench, path })
    for (const method of ['config/settings', 'config/change', 'project/open', 'project/close']) {
      expect((await call(path, method, {})).error?.message, method).toMatch(/window open/)
    }
  })
})
