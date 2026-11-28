import { join } from 'node:path'
import { until } from '@tade/drivers-core/conformance'
import { SignalChannel, type WorkerCommand, type WorkerSignal } from '@tade/harnesses-core'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'
import { namesServer, serverState, TOOLS_WAIT_MS } from '../src/plugin/index.ts'

// Tade's OpenCode plugin, loaded the way OpenCode loads it — a default export
// whose `setup` is handed a context — against a stand-in for that context and
// a real run socket. What it does inside the real OpenCode is the live test's;
// this holds every path through it, including the ones a scripted model never
// takes: Tade gone under approvals, a turn that ended while nobody listened.

const SESSION = 'ses_tadetest00000000000000001'

interface Evaluation {
  sessionID: string
  action: string
  resources: string[]
  source?: { type: string; id: string }
  effect: 'allow' | 'ask' | 'deny'
  message?: string
}

/** A stand-in for the slice of OpenCode's plugin context the plugin uses. */
function context() {
  const queue: Array<{ type: string; data: unknown }> = []
  let wake: (() => void) | null = null
  const calls: Array<{ what: string; input: unknown }> = []
  let evaluate: ((event: Evaluation) => Promise<void> | void) | null = null
  let shell: ((event: { env: Record<string, string | undefined> }) => void) | null = null
  let exists = false
  const record = (what: string) => async (input: unknown) => {
    calls.push({ what, input })
    return {}
  }
  const ctx = {
    event: {
      subscribe: () => ({
        async *[Symbol.asyncIterator]() {
          for (;;) {
            const next = queue.shift()
            if (next) yield next
            else await new Promise<void>((resolve) => (wake = resolve))
          }
        },
      }),
    },
    permission: {
      hook: async (_name: string, run: (event: Evaluation) => Promise<void>) => {
        evaluate = run
      },
    },
    shell: {
      hook: async (
        _name: string,
        run: (event: { env: Record<string, string | undefined> }) => void,
      ) => {
        shell = run
      },
    },
    session: {
      get: async () => {
        if (!exists) throw new Error('Session not found')
        return { id: SESSION, title: 'Old', model: { providerID: 'openai', id: 'gpt-5.5' } }
      },
      create: async (input: unknown) => {
        exists = true
        calls.push({ what: 'create', input })
        return {}
      },
      prompt: record('prompt'),
      interrupt: record('interrupt'),
      update: record('update'),
      switchModel: record('switchModel'),
      // What a compacted session holds: its summary and what came after it.
      context: async () => ({
        data: [
          { id: 'msg_c', type: 'compaction', status: 'completed', summary: 'x'.repeat(360) },
          { id: 'msg_u', type: 'user', text: 'y'.repeat(40) },
          { id: 'msg_i', type: 'idle', outcome: 'succeeded' },
        ],
      }),
    },
    mcp: {
      list: async () => [{ name: 'sentry', status: { status: 'failed', error: 'spawn ENOENT' } }],
    },
    model: {
      list: async () => [{ id: 'gpt-5.5', providerID: 'openai', limit: { context: 1000 } }],
    },
  }
  return {
    ctx,
    calls,
    exists: (yes: boolean) => {
      exists = yes
    },
    emit(type: string, data: Record<string, unknown>) {
      queue.push({ type, data: { sessionID: SESSION, ...data } })
      wake?.()
      wake = null
    },
    evaluate: (event: Evaluation) => (evaluate as NonNullable<typeof evaluate>)(event),
    shell: (env: Record<string, string | undefined>) => {
      const event = { env: { ...env } }
      shell?.(event)
      return event.env
    },
  }
}

type Plugin = { id: string; setup(ctx: unknown): Promise<(() => void) | undefined> }

/** The plugin, loaded afresh under this environment: it reads it once, as it loads. */
async function load(env: Record<string, string | undefined>): Promise<Plugin> {
  vi.resetModules()
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string)
  return (await import('../src/plugin/index.ts')).default as Plugin
}

describe('Tade’s plugin inside OpenCode', () => {
  const cleanups: Array<() => unknown> = []
  afterEach(async () => {
    for (const one of cleanups.splice(0).reverse()) await one()
    vi.unstubAllEnvs()
  })

  async function supervised(env: Record<string, string> = {}) {
    const socket = join(tmp('tade-oc-plugin-'), 'run.sock')
    const signals: WorkerSignal[] = []
    const channel = await SignalChannel.listen({
      path: socket,
      run: 'app/x/agent',
      onSignal: (signal) => signals.push(signal),
    })
    cleanups.push(() => channel.close())
    const plugin = await load({
      TADE_RUN_SOCKET: socket,
      TADE_RUN_ID: 'app/x/agent',
      TADE_OPENCODE_SESSION: SESSION,
      ...env,
    })
    const stand = context()
    stand.exists(true)
    const stop = await plugin.setup(stand.ctx)
    cleanups.push(() => stop?.())
    await until(() => signals.some((s) => s.type === 'idle'), { timeout: 5_000 })
    const send = (command: WorkerCommand) => channel.send(command)
    return { channel, signals, stand, send }
  }

  it('is inert without a run, so a person’s own opencode is never touched', async () => {
    const plugin = await load({ TADE_RUN_SOCKET: undefined, TADE_OPENCODE_SESSION: undefined })
    expect(plugin.id).toBe('tade')
    const stand = context()
    expect(await plugin.setup(stand.ctx)).toBeUndefined()
    expect(stand.calls).toEqual([])
  })

  it('says where the session is on connecting, then its turns, replies, tools and what each step used', async () => {
    const { signals, stand } = await supervised()
    expect(signals[0]).toMatchObject({
      type: 'started',
      sessionId: SESSION,
      model: 'openai/gpt-5.5',
    })
    stand.emit('session.execution.started', {})
    stand.emit('session.step.started', {
      assistantMessageID: 'msg_1',
      model: { providerID: 'openai', id: 'gpt-5.5' },
    })
    stand.emit('session.tool.input.started', { id: 'call_1', name: 'write' })
    stand.emit('session.tool.called', { id: 'call_1', input: { path: 'a.txt', content: 'x' } })
    stand.emit('session.tool.failed', { id: 'call_1', error: { message: 'disk full' } })
    stand.emit('session.tool.input.started', { id: 'call_2', name: 'tade_tade_done' })
    stand.emit('session.tool.called', { id: 'call_2', input: { summary: 's' } })
    stand.emit('session.tool.success', { id: 'call_2', content: [{ type: 'text', text: 'ok' }] })
    stand.emit('session.text.delta', { delta: 'All ' })
    stand.emit('session.text.ended', { text: 'All done. ' })
    stand.emit('session.step.ended', {
      assistantMessageID: 'msg_1',
      cost: 0,
      tokens: { input: 300, output: 40, reasoning: 10, cache: { read: 200, write: 0 } },
    })
    stand.emit('session.retry.scheduled', { attempt: 2, error: { message: 'overloaded' } })
    stand.emit('session.execution.succeeded', {})
    // Another session in this server — a subagent's — is not the agent's turn.
    stand.emit('session.execution.started', { sessionID: 'ses_child' })
    await until(() => signals.filter((s) => s.type === 'idle').length === 2, { timeout: 5_000 })
    const said = signals.slice(2).map(({ run: _run, at: _at, ...rest }) => rest)
    expect(said).toEqual([
      { type: 'turn_started' },
      {
        type: 'tool_call',
        callId: 'call_1',
        tool: 'write',
        input: { path: 'a.txt', content: 'x' },
        writes: ['a.txt'],
      },
      { type: 'tool_result', callId: 'call_1', ok: false, summary: 'disk full' },
      {
        type: 'tool_call',
        callId: 'call_2',
        tool: 'tade_done',
        input: { summary: 's' },
        writes: [],
      },
      { type: 'tool_result', callId: 'call_2', ok: true, summary: '' },
      { type: 'message_delta', text: 'All ' },
      { type: 'message', text: 'All done.' },
      {
        type: 'usage',
        model: 'openai/gpt-5.5',
        input: 300,
        output: 50,
        cacheRead: 200,
        cacheWrite: 0,
        tokens: 550,
        usd: 0,
      },
      { type: 'context', tokens: 500, percent: 50 },
      { type: 'problem', text: expect.stringContaining('attempt 2): overloaded') },
      { type: 'turn_done', status: 'ok' },
      { type: 'idle' },
    ])
  })

  it('says how full the context is once a compaction of its own session ends', async () => {
    const { signals, stand } = await supervised()
    const model = { providerID: 'openai', id: 'gpt-5.5', variant: 'default' }
    // Another session's compaction is not this conversation's.
    stand.emit('session.compaction.ended', { sessionID: 'ses_child', model, text: 's' })
    stand.emit('session.compaction.ended', { model, text: 's', tokens: { input: 900, output: 90 } })
    await until(() => signals.some((s) => s.type === 'context'), { timeout: 5_000 })
    // 400 characters held, four a token, of the model's 1000.
    expect(signals.filter((s) => s.type === 'context')).toMatchObject([
      { type: 'context', tokens: 100, percent: 10 },
    ])
  })

  it('says what a compaction used, done or failed, a subagent’s too', async () => {
    const { signals, stand } = await supervised()
    const model = { providerID: 'openai', id: 'gpt-5.5-mini' }
    stand.emit('session.compaction.ended', {
      sessionID: 'ses_child',
      model,
      text: 's',
      cost: 0.02,
      tokens: { input: 900, output: 80, reasoning: 10, cache: { read: 100, write: 0 } },
    })
    // A failed one names no model: it is said on the one the session is on.
    stand.emit('session.compaction.failed', {
      error: { type: 'compaction.failed', message: 'too long' },
      cost: 0.01,
      tokens: { input: 500, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    })
    // One that failed before its model answered used nothing.
    stand.emit('session.compaction.failed', { error: { type: 'aborted', message: 'cancelled' } })
    stand.emit('session.execution.started', {})
    await until(() => signals.some((s) => s.type === 'turn_started'), { timeout: 5_000 })
    expect(
      signals.filter((s) => s.type === 'usage').map(({ run: _run, at: _at, ...rest }) => rest),
    ).toEqual([
      {
        type: 'usage',
        model: 'openai/gpt-5.5-mini',
        input: 900,
        output: 90,
        cacheRead: 100,
        cacheWrite: 0,
        tokens: 1090,
        usd: 0.02,
      },
      {
        type: 'usage',
        model: 'openai/gpt-5.5',
        input: 500,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        tokens: 500,
        usd: 0.01,
      },
    ])
  })

  it('says what a failed step used, on the model it ran on, a subagent’s too', async () => {
    const { signals, stand } = await supervised()
    stand.emit('session.step.started', {
      sessionID: 'ses_child',
      assistantMessageID: 'msg_c',
      model: { providerID: 'anthropic', id: 'claude-haiku-5-5' },
    })
    stand.emit('session.step.failed', {
      sessionID: 'ses_child',
      assistantMessageID: 'msg_c',
      error: { type: 'provider.overloaded', message: 'overloaded' },
      cost: 0.03,
      tokens: { input: 700, output: 20, reasoning: 5, cache: { read: 300, write: 10 } },
    })
    // One that failed before its model answered says nothing of what it used.
    stand.emit('session.step.started', {
      assistantMessageID: 'msg_2',
      model: { providerID: 'openai', id: 'gpt-5.5' },
    })
    stand.emit('session.step.failed', {
      assistantMessageID: 'msg_2',
      error: { type: 'aborted', message: 'cancelled' },
    })
    stand.emit('session.execution.started', {})
    await until(() => signals.some((s) => s.type === 'turn_started'), { timeout: 5_000 })
    expect(
      signals.filter((s) => s.type === 'usage').map(({ run: _run, at: _at, ...rest }) => rest),
    ).toEqual([
      {
        type: 'usage',
        model: 'anthropic/claude-haiku-5-5',
        input: 700,
        output: 25,
        cacheRead: 300,
        cacheWrite: 10,
        tokens: 1035,
        usd: 0.03,
      },
    ])
  })

  it('says a turn that failed or was stopped, and a server OpenCode gave up on, once', async () => {
    const { signals, stand } = await supervised()
    stand.emit('session.execution.started', {})
    stand.emit('session.execution.failed', {
      error: { type: 'provider.quota', message: 'No credit' },
    })
    stand.emit('session.execution.started', {})
    stand.emit('session.execution.interrupted', { reason: 'user' })
    stand.emit('mcp.status.changed', { server: 'sentry' })
    stand.emit('mcp.status.changed', { server: 'sentry' })
    await until(() => signals.filter((s) => s.type === 'server_down').length === 1, {
      timeout: 5_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(signals.filter((s) => s.type === 'turn_done')).toMatchObject([
      { status: 'error', reason: 'No credit' },
      { status: 'aborted' },
    ])
    expect(signals.filter((s) => s.type === 'server_down')).toMatchObject([
      { server: 'sentry', why: 'failed: spawn ENOENT' },
    ])
  })

  it('says what Tade says to the agent through the session API', async () => {
    const { signals, stand, send } = await supervised()
    send({ type: 'steer', message: 'look at the tests too' })
    send({ type: 'queue', message: 'then commit' })
    send({ type: 'abort' })
    send({ type: 'name', title: 'Fix the login' })
    send({ type: 'model', provider: 'anthropic', id: 'claude-sonnet-5#high' })
    send({ type: 'thinking', level: 'high' })
    await until(() => stand.calls.length === 5, { timeout: 5_000 })
    expect(stand.calls).toEqual([
      {
        what: 'prompt',
        input: { sessionID: SESSION, text: 'look at the tests too', delivery: 'steer' },
      },
      { what: 'prompt', input: { sessionID: SESSION, text: 'then commit', delivery: 'queue' } },
      { what: 'interrupt', input: { sessionID: SESSION } },
      { what: 'update', input: { sessionID: SESSION, title: 'Fix the login' } },
      {
        what: 'switchModel',
        input: {
          sessionID: SESSION,
          model: { providerID: 'anthropic', id: 'claude-sonnet-5', variant: 'high' },
        },
      },
    ])
    await until(() => signals.some((s) => s.type === 'titled'), { timeout: 5_000 })
    expect(signals.find((s) => s.type === 'titled')).toMatchObject({
      title: 'Fix the login',
      named: true,
    })
  })

  it('holds every permission for Tade under approvals, lets Tade’s own tools through, and refuses when Tade is gone', async () => {
    const { channel, signals, stand, send } = await supervised({ TADE_APPROVALS: 'policy' })
    stand.emit('session.tool.input.started', { id: 'call_9', name: 'shell' })
    stand.emit('session.tool.called', { id: 'call_9', input: { command: 'rm -rf build' } })
    await until(() => signals.some((s) => s.type === 'tool_call'), { timeout: 5_000 })
    const asked: Evaluation = {
      sessionID: SESSION,
      action: 'shell',
      resources: ['rm -rf build'],
      source: { type: 'tool', id: 'call_9' },
      effect: 'allow',
    }
    const held = stand.evaluate(asked)
    await until(() => signals.some((s) => s.type === 'permission_request'), { timeout: 5_000 })
    const request = signals.find((s) => s.type === 'permission_request')
    expect(request).toMatchObject({
      tool: 'shell',
      input: { command: 'rm -rf build' },
      summary: 'shell: rm -rf build',
    })
    send({
      type: 'decision',
      requestId: (request as { requestId: string }).requestId,
      allow: false,
      reason: 'not that',
    })
    await held
    expect(asked).toMatchObject({ effect: 'deny', message: 'not that' })

    const allowed: Evaluation = {
      sessionID: SESSION,
      action: 'read',
      resources: ['a.ts'],
      effect: 'ask',
    }
    const waiting = stand.evaluate(allowed)
    await until(() => signals.filter((s) => s.type === 'permission_request').length === 2, {
      timeout: 5_000,
    })
    const second = signals.filter((s) => s.type === 'permission_request')[1] as {
      requestId: string
    }
    send({ type: 'decision', requestId: second.requestId, allow: true, reason: '' })
    await waiting
    expect(allowed.effect).toBe('allow')

    const ours: Evaluation = {
      sessionID: SESSION,
      action: 'tade_tade_done',
      resources: ['*'],
      effect: 'ask',
    }
    await stand.evaluate(ours)
    expect(ours.effect).toBe('allow')
    const denied: Evaluation = {
      sessionID: SESSION,
      action: 'shell',
      resources: ['ls'],
      effect: 'deny',
    }
    await stand.evaluate(denied)
    expect(denied.effect).toBe('deny')

    // Tade gone: a call held then is refused, and one asked after is refused at once.
    const stranded: Evaluation = {
      sessionID: SESSION,
      action: 'edit',
      resources: ['a.ts'],
      effect: 'allow',
    }
    const pending = stand.evaluate(stranded)
    await until(() => signals.filter((s) => s.type === 'permission_request').length === 3, {
      timeout: 5_000,
    })
    await channel.close()
    await pending
    expect(stranded).toMatchObject({
      effect: 'deny',
      message: expect.stringContaining('approvals'),
    })
    const after: Evaluation = {
      sessionID: SESSION,
      action: 'edit',
      resources: ['b.ts'],
      effect: 'allow',
    }
    await stand.evaluate(after)
    expect(after.effect).toBe('deny')
  })

  it('holds nothing without approvals', async () => {
    const { signals, stand } = await supervised({ TADE_APPROVALS: 'bypass' })
    const asked: Evaluation = {
      sessionID: SESSION,
      action: 'shell',
      resources: ['ls'],
      effect: 'allow',
    }
    await stand.evaluate(asked)
    expect(asked.effect).toBe('allow')
    expect(signals.some((s) => s.type === 'permission_request')).toBe(false)
  })

  it('says a turn that ended while Tade was away once it is back, stamped when it ended', async () => {
    const socket = join(tmp('tade-oc-plugin-'), 'run.sock')
    let signals: WorkerSignal[] = []
    let channel = await SignalChannel.listen({
      path: socket,
      run: 'app/x/agent',
      onSignal: (signal) => signals.push(signal),
    })
    const plugin = await load({
      TADE_RUN_SOCKET: socket,
      TADE_RUN_ID: 'app/x/agent',
      TADE_OPENCODE_SESSION: SESSION,
    })
    const stand = context()
    stand.exists(true)
    const stop = await plugin.setup(stand.ctx)
    cleanups.push(() => stop?.())
    await until(() => signals.some((s) => s.type === 'idle'), { timeout: 5_000 })
    stand.emit('session.execution.started', {})
    await until(() => signals.some((s) => s.type === 'turn_started'), { timeout: 5_000 })
    await channel.close()
    const ended = Date.now()
    stand.emit('session.execution.succeeded', {})
    await new Promise((resolve) => setTimeout(resolve, 200))
    signals = []
    channel = await SignalChannel.listen({
      path: socket,
      run: 'app/x/agent',
      onSignal: (signal) => signals.push(signal),
    })
    cleanups.push(() => channel.close())
    await until(() => signals.some((s) => s.type === 'idle'), { timeout: 10_000 })
    expect(signals.map((s) => s.type)).toEqual(['started', 'turn_done', 'idle'])
    expect((signals[1] as { at: number }).at).toBeLessThan(ended + 200)
  })

  it('makes the session it is for when the line could not, and says the first instruction into it', async () => {
    const socket = join(tmp('tade-oc-plugin-'), 'run.sock')
    const plugin = await load({
      TADE_RUN_SOCKET: socket,
      TADE_RUN_ID: 'app/x/agent',
      TADE_OPENCODE_SESSION: SESSION,
      TADE_OPENCODE_OPENING: 'fix the flaky test',
      TADE_OPENCODE_MODEL: 'openai/gpt-5.5#high',
      TADE_CALLED: 'Fix the flaky test',
    })
    const stand = context()
    const stop = await plugin.setup(stand.ctx)
    cleanups.push(() => stop?.())
    await until(() => stand.calls.some((call) => call.what === 'prompt'), { timeout: 10_000 })
    expect(stand.calls).toEqual([
      {
        what: 'create',
        input: {
          id: SESSION,
          title: 'Fix the flaky test',
          model: { providerID: 'openai', id: 'gpt-5.5', variant: 'high' },
        },
      },
      { what: 'prompt', input: { sessionID: SESSION, text: 'fix the flaky test' } },
    ])
    // Nothing an agent runs is told it, or speaks for the lane.
    expect(process.env.TADE_OPENCODE_OPENING).toBeUndefined()
  })

  /** A run whose config lists Tade's own tool server, as every lane's does. */
  const WITH_TOOLS = JSON.stringify({
    mcp: { servers: { tade: { type: 'local', command: ['x'] } } },
  })

  it('says the first instruction only once Tade’s tool server has connected, so the turn is offered its tools', async () => {
    const { stand } = await supervised({
      TADE_OPENCODE_OPENING: 'fix the flaky test',
      OPENCODE_CONFIG_CONTENT: WITH_TOOLS,
    })
    let state = 'pending'
    let asked = 0
    const mcp = stand.ctx.mcp as { list: () => Promise<unknown> }
    mcp.list = async () => {
      asked++
      return { data: [{ name: 'tade', status: { status: state } }] }
    }
    // Not listed yet, then pending: asked again and again, and nothing said.
    await until(() => asked >= 3, { timeout: 10_000 })
    expect(stand.calls.some((call) => call.what === 'prompt')).toBe(false)
    state = 'connected'
    await until(() => stand.calls.some((call) => call.what === 'prompt'), { timeout: 10_000 })
    expect(stand.calls.filter((call) => call.what === 'prompt')).toEqual([
      { what: 'prompt', input: { sessionID: SESSION, text: 'fix the flaky test' } },
    ])
  })

  it('says the first instruction without Tade’s tools after a while, and says that it did', async () => {
    // The plugin's clock, from before it loads, moving with the real one
    // until it is moved past the wait.
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'], shouldAdvanceTime: true })
    cleanups.push(() => vi.useRealTimers())
    // The stand-in never lists a server called tade.
    const { signals, stand } = await supervised({
      TADE_OPENCODE_OPENING: 'fix the flaky test',
      OPENCODE_CONFIG_CONTENT: WITH_TOOLS,
    })
    expect(stand.calls.some((call) => call.what === 'prompt')).toBe(false)
    await vi.advanceTimersByTimeAsync(TOOLS_WAIT_MS + 1_000)
    await until(() => stand.calls.some((call) => call.what === 'prompt'), { timeout: 10_000 })
    await until(() => signals.some((s) => s.type === 'problem'), { timeout: 10_000 })
    expect(signals.find((s) => s.type === 'problem')).toMatchObject({
      text: expect.stringContaining("went without Tade's tools"),
    })
  })

  it('reads how OpenCode says a tool server stands, and whether a run’s config lists one', () => {
    const listed = { data: [{ name: 'sentry', status: { status: 'failed' } }] }
    expect(serverState(listed, 'tade')).toBeNull()
    expect(serverState({ data: [{ name: 'tade', status: { status: 'pending' } }] }, 'tade')).toBe(
      'pending',
    )
    expect(serverState([{ server: 'tade', status: 'connected' }], 'tade')).toBe('connected')
    expect(serverState(null, 'tade')).toBeNull()
    expect(namesServer(JSON.parse(WITH_TOOLS), 'tade')).toBe(true)
    expect(namesServer({ mcp: { servers: { sentry: {} } } }, 'tade')).toBe(false)
    expect(namesServer({}, 'tade')).toBe(false)
    expect(namesServer(null, 'tade')).toBe(false)
  })

  it('gives the agent’s own commands the folders the account moved back, and none of Tade’s run', async () => {
    const { stand } = await supervised({
      TADE_OPENCODE_SHELL_ENV: JSON.stringify({
        XDG_DATA_HOME: '/home/me/.data',
        XDG_STATE_HOME: null,
      }),
    })
    expect(
      stand.shell({
        XDG_DATA_HOME: '/account/data',
        XDG_STATE_HOME: '/account/state',
        OPENCODE_CONFIG_CONTENT: '{}',
        TADE_OPENCODE_SESSION: SESSION,
        PATH: '/bin',
      }),
    ).toEqual({ XDG_DATA_HOME: '/home/me/.data', PATH: '/bin' })
  })
})
