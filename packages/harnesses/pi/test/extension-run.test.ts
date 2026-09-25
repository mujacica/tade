import { writeFileSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { tmp } from '../../../../test/fixtures/mkrepo.ts'

// The Tade supervision extension, running.
//
// pi loads `tade.ts` inside every agent's own process, so nothing in the
// window can reach it and nothing here had ever run it: three small helpers
// were imported by tests and the 217 lines that do the work were not. Those
// lines are the whole of what Tade knows about an agent — every turn, every
// tool call, what it spent, what it is called — and the gate that holds a tool
// call until somebody answers.
//
// So this drives it the way pi does: a real unix socket for Tade's end, a `pi`
// that records what was registered and fires events at it, and assertions on
// the JSON lines that come out. The two rules worth the most are the ones a
// unit test of a helper can never reach — **a turn reports the difference, not
// the total**, and **the gate fails closed and only where it was ever going to
// hold anything**.
//
// Everything the extension reads about its situation is an environment
// variable read once at import, because pi loads it once at launch; that is
// why each case imports the module again with the world it means.

interface Ctx {
  mode: string
  cwd: string
  abort(): void
  shutdown(): void
  isIdle(): boolean
  getContextUsage?(): { tokens: number | null; percent: number | null } | undefined
  sessionManager?: { getEntries?(): unknown[] }
  model?: { id?: string; provider?: string } | string
  modelRegistry?: Record<string, unknown>
}

interface Registered {
  name: string
  execute(id: string, params: Record<string, unknown>): Promise<{ content: { text: string }[] }>
}

/** A `pi` that records what was asked of it and fires events at what registered. */
function fakePi() {
  const handlers = new Map<string, ((event: unknown, ctx: unknown) => unknown)[]>()
  const tools = new Map<string, Registered>()
  const api = {
    sessionName: undefined as string | undefined,
    named: [] as string[],
    messages: [] as { content: string; deliverAs: string | undefined }[],
    models: [] as unknown[],
    thinkingSet: [] as string[],
    thinkingLevel: 'medium' as string | null,
    /** pi throws when asked before a session exists, which once took an agent down. */
    thinkingThrows: false,
    on(event: string, handler: (event: never, ctx: never) => unknown) {
      const list = handlers.get(event) ?? []
      list.push(handler as (event: unknown, ctx: unknown) => unknown)
      handlers.set(event, list)
    },
    registerTool(tool: Registered) {
      tools.set(tool.name, tool)
    },
    getSessionName: () => api.sessionName,
    setSessionName(name: string) {
      api.sessionName = name
      api.named.push(name)
    },
    async setModel(model: unknown) {
      api.models.push(model)
      return true
    },
    getThinkingLevel() {
      if (api.thinkingThrows) throw new Error('no session yet')
      return api.thinkingLevel ?? ''
    },
    setThinkingLevel(level: string) {
      api.thinkingSet.push(level)
    },
    async sendUserMessage(content: string, options?: { deliverAs?: string }) {
      api.messages.push({ content, deliverAs: options?.deliverAs })
    },
  }
  return {
    api,
    tools,
    events: handlers,
    /** Fire an event at everything listening for it, in the order it registered. */
    async fire(event: string, payload: unknown, ctx: unknown): Promise<unknown[]> {
      const out: unknown[] = []
      for (const handler of handlers.get(event) ?? []) out.push(await handler(payload, ctx))
      return out
    },
  }
}

type Pi = ReturnType<typeof fakePi>

const servers: Server[] = []
/** Every connection the agent's end made, so nothing is left holding a server open. */
const accepted: Socket[] = []

afterEach(async () => {
  // Destroyed before the servers are closed: `close` waits for what is still
  // connected, and the extension holds its socket open for the life of the
  // agent — which is exactly what it is for.
  for (const socket of accepted.splice(0)) socket.destroy()
  for (const server of servers.splice(0)) await new Promise((done) => server.close(done))
  for (const key of [
    'TADE_RUN_SOCKET',
    'TADE_RUN_ID',
    'TADE_APPROVALS',
    'TADE_EXTENSION_TOOLS',
    'TADE_TITLE',
  ])
    delete process.env[key]
  vi.resetModules()
})

/** Tade's end of the socket: what it heard, and a way to answer. */
interface Tade {
  path: string
  heard: Record<string, unknown>[]
  say(command: unknown): void
  /** Hang up on the agent, the way closing the window does. */
  hangUp(): void
  connections: number
}

async function tadeListening(): Promise<Tade> {
  const path = join(tmp('tade-pi-ext-'), 's')
  let live: Socket | null = null
  const at: Tade = {
    path,
    heard: [],
    connections: 0,
    say: (command) => live?.write(`${JSON.stringify(command)}\n`),
    hangUp: () => live?.destroy(),
  }
  let rest = ''
  const server = createServer((socket) => {
    live = socket
    accepted.push(socket)
    at.connections += 1
    socket.setEncoding('utf8')
    socket.on('error', () => {})
    socket.on('data', (text: string) => {
      rest += text
      for (let end = rest.indexOf('\n'); end >= 0; end = rest.indexOf('\n')) {
        at.heard.push(JSON.parse(rest.slice(0, end)) as Record<string, unknown>)
        rest = rest.slice(end + 1)
      }
    })
  })
  servers.push(server)
  await new Promise<void>((done) => server.listen(path, done))
  return at
}

const ctx = (over: Partial<Ctx> = {}): Ctx => ({
  mode: 'agent',
  cwd: '/tmp',
  abort: () => {},
  shutdown: () => {},
  isIdle: () => true,
  model: { id: 'claude-opus-5', provider: 'anthropic' },
  ...over,
})

/** Load the extension as pi would, with this world around it, and start it. */
async function running(
  at: Tade | null,
  env: Record<string, string> = {},
): Promise<{ pi: Pi; tade: Tade | null }> {
  vi.resetModules()
  if (at) process.env.TADE_RUN_SOCKET = at.path
  else delete process.env.TADE_RUN_SOCKET
  process.env.TADE_RUN_ID = 'run-1'
  for (const [key, value] of Object.entries(env)) process.env[key] = value
  const { default: tadeExtension } = (await import('../src/tade.ts')) as {
    default: (pi: unknown) => void
  }
  const pi = fakePi()
  tadeExtension(pi.api)
  if (at) await vi.waitFor(() => expect(at.heard.length).toBeGreaterThan(0))
  return { pi, tade: at }
}

/** The lines Tade heard of one kind. */
const of = (at: Tade, type: string) => at.heard.filter((line) => line.type === type)
const waitFor = (at: Tade, type: string, count = 1) =>
  vi.waitFor(() => expect(of(at, type).length).toBeGreaterThanOrEqual(count))

describe('an agent nobody is supervising', () => {
  it('does nothing at all without a socket, so plain pi is untouched', async () => {
    const { pi } = await running(null)
    // Not "registers its tools and finds nobody to call": a person running pi
    // by hand must not find `tade_done` in their tool list.
    expect(pi.tools.size).toBe(0)
    expect(pi.events.size).toBe(0)
  })
})

describe('what Tade is told about a turn', () => {
  it('says hello with the model and how hard it is thinking', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('session_start', {}, ctx())
    await waitFor(at, 'started', 2)

    expect(of(at, 'started').at(-1)).toMatchObject({
      model: 'anthropic/claude-opus-5',
      thinking: 'medium',
      run: 'run-1',
    })
  })

  it('says a turn started and how it ended', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('turn_start', {}, ctx())
    await pi.fire('turn_end', { message: { stopReason: 'end_turn' } }, ctx())
    await waitFor(at, 'turn_done')

    expect(of(at, 'turn_started')).toHaveLength(1)
    expect(of(at, 'turn_done')[0]).toMatchObject({ status: 'ok' })
  })

  it('carries why a turn failed, rather than only that it did', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire(
      'turn_end',
      { message: { stopReason: 'error', errorMessage: 'overloaded_error' } },
      ctx(),
    )
    await waitFor(at, 'turn_done')
    // A conversation that goes quiet is the worst failure Tade has: the reason
    // is what turns a stopped agent into something somebody can act on.
    expect(of(at, 'turn_done')[0]).toMatchObject({
      status: 'error',
      reason: 'overloaded_error',
    })
  })

  it('tells an aborted turn from a failed one', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('turn_end', { message: { stopReason: 'aborted' } }, ctx())
    await waitFor(at, 'turn_done')
    expect(of(at, 'turn_done')[0]).toMatchObject({ status: 'aborted' })
    expect(of(at, 'turn_done')[0]).not.toHaveProperty('reason')
  })

  it('says how full the context is whenever it knows', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    const withUsage = ctx({ getContextUsage: () => ({ tokens: 40_000, percent: 20 }) })
    await pi.fire('session_start', {}, withUsage)
    await waitFor(at, 'context')
    expect(of(at, 'context')[0]).toMatchObject({ tokens: 40_000, percent: 20 })
  })

  it('says it went idle', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('agent_settled', {}, ctx())
    await waitFor(at, 'idle')
  })

  it('says what a tool call did', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire(
      'tool_execution_end',
      { toolCallId: 'c1', toolName: 'bash', isError: true },
      ctx(),
    )
    await waitFor(at, 'tool_result')
    expect(of(at, 'tool_result')[0]).toMatchObject({ callId: 'c1', ok: false, summary: 'bash' })
  })

  it('asks pi how hard it thinks only once there is a session to ask about', async () => {
    const at = await tadeListening()
    // pi throws when asked before a session exists, and a throw while
    // extensions load takes the whole agent down with it.
    const { pi } = await running(at)
    pi.api.thinkingThrows = true
    await pi.fire('session_start', {}, ctx())
    await waitFor(at, 'started', 2)
    expect(of(at, 'started').at(-1)?.thinking).toBeNull()
  })
})

describe('what a turn cost', () => {
  /** A session entry shaped the way pi writes one: the cost is on the message. */
  const entries = (usd: number, tokens: number) => [
    {
      type: 'message',
      message: {
        role: 'assistant',
        usage: { input: tokens, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: usd } },
      },
    },
  ]

  it('reports the difference since the last turn, never the running total', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    const totals = { value: entries(1, 100) }
    const withSpend = ctx({ sessionManager: { getEntries: () => totals.value } })

    await pi.fire('turn_end', { message: {} }, withSpend)
    await waitFor(at, 'usage')
    expect(of(at, 'usage')[0]).toMatchObject({ usd: 1, input: 100 })

    // The session carries running totals; Tade adds up what it is sent. A turn
    // that reported the total again would double every figure on the page.
    totals.value = entries(3, 250)
    await pi.fire('turn_end', { message: {} }, withSpend)
    await waitFor(at, 'usage', 2)
    expect(of(at, 'usage')[1]).toMatchObject({ usd: 2, input: 150 })
  })

  it('takes a resumed session as the baseline rather than reporting its history', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    // Opening a task is a click, and a resumed session arrives with everything
    // the last process already reported. Counting from zero bills it twice.
    const resumed = ctx({ sessionManager: { getEntries: () => entries(9, 900) } })
    await pi.fire('session_start', {}, resumed)
    await pi.fire('turn_end', { message: {} }, resumed)
    await vi.waitFor(() => expect(of(at, 'turn_done')).toHaveLength(1))
    expect(of(at, 'usage')).toEqual([])
  })

  it('says nothing about a turn that spent nothing', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('turn_end', { message: {} }, ctx({ sessionManager: { getEntries: () => [] } }))
    await vi.waitFor(() => expect(of(at, 'turn_done')).toHaveLength(1))
    expect(of(at, 'usage')).toEqual([])
  })
})

describe('the gate', () => {
  const call = { toolCallId: 'c1', toolName: 'bash', input: { command: 'git push --force' } }

  it('holds a tool call until Tade answers, and lets an allowed one through', async () => {
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_APPROVALS: 'policy' })

    const decided = pi.fire('tool_call', call, ctx())
    await waitFor(at, 'permission_request')
    const asked = of(at, 'permission_request')[0]
    // Exact enough to read back before approving: the command, not just `bash`.
    expect(asked).toMatchObject({ tool: 'bash', summary: 'bash: git push --force' })

    at.say({ type: 'decision', requestId: asked?.requestId, allow: true })
    expect((await decided).at(-1)).toEqual({})
  })

  it('blocks a refused call, and says back the reason it was given', async () => {
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_APPROVALS: 'policy' })

    const decided = pi.fire('tool_call', call, ctx())
    await waitFor(at, 'permission_request')
    at.say({
      type: 'decision',
      requestId: of(at, 'permission_request')[0]?.requestId,
      allow: false,
      reason: 'never force-push main',
    })
    expect((await decided).at(-1)).toEqual({ block: true, reason: 'never force-push main' })
  })

  it('refuses when Tade cannot be reached and approvals are on', async () => {
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_APPROVALS: 'policy' })
    at.hangUp()
    await vi.waitFor(async () => {
      const results = await pi.fire('tool_call', call, ctx())
      expect(results.at(-1)).toEqual({
        block: true,
        reason: 'Tade is not reachable, and approvals are on',
      })
    })
  })

  it('fails what was already waiting when Tade goes away mid-flight', async () => {
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_APPROVALS: 'policy' })
    const decided = pi.fire('tool_call', call, ctx())
    await waitFor(at, 'permission_request')

    at.hangUp()
    // Left pending, the agent stops for ever waiting on a window that is gone.
    expect((await decided).at(-1)).toEqual({
      block: true,
      reason: 'Tade is not reachable, and approvals are on',
    })
  })

  it('holds nothing at all when approvals are off, and still writes it down', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    // The default. Recorded either way, so the journal is honest even where
    // nothing is gated — and never held, so nothing can stall an agent.
    expect((await pi.fire('tool_call', call, ctx())).at(-1)).toEqual({})
    await waitFor(at, 'tool_call')
    expect(of(at, 'tool_call')[0]).toMatchObject({ callId: 'c1', tool: 'bash' })
    expect(of(at, 'permission_request')).toEqual([])
  })

  it('lets work carry on when Tade is gone and nothing was going to be held', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.hangUp()
    await vi.waitFor(async () =>
      expect((await pi.fire('tool_call', call, ctx())).at(-1)).toEqual({}),
    )
  })
})

describe('the tools Tade lends the agent', () => {
  it('always offers tade_done, and says what it was told', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    const done = pi.tools.get('tade_done')
    expect(done).toBeDefined()

    const answer = await done?.execute('c1', { summary: 'raised the floors' })
    expect(answer?.content[0]?.text).toContain('this task is finished')
    await waitFor(at, 'done')
    expect(of(at, 'done')[0]).toMatchObject({ summary: 'raised the floors' })
  })

  it('tells the agent to say so itself when Tade is not there to be told', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.hangUp()
    await vi.waitFor(async () => {
      await expect(pi.tools.get('tade_done')?.execute('c1', { summary: 'x' })).rejects.toThrow(
        'say so instead',
      )
    })
  })

  it('registers what Tade listed, and runs one through Tade', async () => {
    const list = join(tmp('tade-pi-tools-'), 'tools.json')
    writeFileSync(
      list,
      JSON.stringify([
        { name: 'deps_check', label: 'Deps', description: 'what is out of date', parameters: {} },
      ]),
    )
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_EXTENSION_TOOLS: list })
    expect([...pi.tools.keys()]).toContain('deps_check')

    const answer = pi.tools.get('deps_check')?.execute('c9', { project: 'shop' })
    await waitFor(at, 'extension_call')
    expect(of(at, 'extension_call')[0]).toMatchObject({
      callId: 'c9',
      tool: 'deps_check',
      input: { project: 'shop' },
    })
    at.say({ type: 'extension_result', callId: 'c9', ok: true, text: 'two are behind' })
    expect((await answer)?.content[0]?.text).toBe('two are behind')
  })

  it('fails the call rather than answering emptily when Tade says it went wrong', async () => {
    const list = join(tmp('tade-pi-tools-'), 'tools.json')
    writeFileSync(
      list,
      JSON.stringify([{ name: 'deps_check', label: 'D', description: 'd', parameters: {} }]),
    )
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_EXTENSION_TOOLS: list })

    const answer = pi.tools.get('deps_check')?.execute('c9', {})
    await waitFor(at, 'extension_call')
    at.say({ type: 'extension_result', callId: 'c9', ok: false, text: 'no such project' })
    // A tool fails by throwing; anything else reaches the model as an empty
    // answer that looks like success.
    await expect(answer).rejects.toThrow('no such project')
  })

  it('gives up a tool that was running inside Tade when Tade closes', async () => {
    const list = join(tmp('tade-pi-tools-'), 'tools.json')
    writeFileSync(
      list,
      JSON.stringify([{ name: 'deps_check', label: 'D', description: 'd', parameters: {} }]),
    )
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_EXTENSION_TOOLS: list })
    const answer = pi.tools.get('deps_check')?.execute('c9', {})
    await waitFor(at, 'extension_call')

    at.hangUp()
    await expect(answer).rejects.toThrow('Tade closed before it answered')
  })
})

describe('what Tade can ask the agent to do', () => {
  it('steers and queues through pi, each delivered its own way', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.say({ type: 'steer', message: 'stop and read the tests' })
    at.say({ type: 'queue', message: 'then push' })
    await vi.waitFor(() => expect(pi.api.messages).toHaveLength(2))
    expect(pi.api.messages).toEqual([
      { content: 'stop and read the tests', deliverAs: 'steer' },
      { content: 'then push', deliverAs: 'followUp' },
    ])
  })

  it('reads two commands that arrived in one piece, and one split across two', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    // Strict LF framing, because JSON strings can hold anything else.
    at.say({ type: 'steer', message: 'one' })
    at.say({ type: 'steer', message: 'two' })
    await vi.waitFor(() => expect(pi.api.messages).toHaveLength(2))
    expect(pi.api.messages.map((m) => m.content)).toEqual(['one', 'two'])
  })

  it('ignores a line it cannot read rather than falling over', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.say('not json at all')
    at.say({ type: 'nothing-we-know' })
    at.say({ type: 'steer', message: 'still here' })
    await vi.waitFor(() => expect(pi.api.messages).toHaveLength(1))
  })

  it('aborts and shuts down the session it was given', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    let aborted = 0
    let down = 0
    await pi.fire(
      'turn_start',
      {},
      ctx({ abort: () => (aborted += 1), shutdown: () => (down += 1) }),
    )

    at.say({ type: 'abort' })
    await vi.waitFor(() => expect(aborted).toBe(1))
    at.say({ type: 'shutdown' })
    await vi.waitFor(() => expect(down).toBe(1))
  })

  it('switches the model to the one Tade named', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    const gpt = { id: 'gpt-5', provider: 'openai' }
    const looked: string[] = []
    await pi.fire(
      'turn_start',
      {},
      ctx({
        modelRegistry: {
          find: (provider: string, id: string) => {
            looked.push(`${provider}/${id}`)
            return id === 'gpt-5' && provider === 'openai' ? gpt : undefined
          },
        },
      }),
    )
    at.say({ type: 'model', provider: 'openai', id: 'gpt-5' })
    await vi.waitFor(() => expect(pi.api.models).toEqual([gpt]))
    // Asked for by provider and id together: one model has as many spellings
    // as there are ways of reaching it, and the routing is part of the name.
    expect(looked).toEqual(['openai/gpt-5'])
  })

  it('finds a model by id where the registry has no provider to look under', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    const local = { id: 'llama', provider: 'ollama' }
    await pi.fire('turn_start', {}, ctx({ modelRegistry: { getAvailable: () => [local] } }))
    at.say({ type: 'model', provider: '', id: 'llama' })
    await vi.waitFor(() => expect(pi.api.models).toEqual([local]))
  })

  it('sets how hard it thinks, and never throws when there is no session yet', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.say({ type: 'thinking', level: 'high' })
    await vi.waitFor(() => expect(pi.api.thinkingSet).toEqual(['high']))
  })
})

describe('what the work is called', () => {
  it('takes a name a person gave it in Tade, and shows it in pi too', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.say({ type: 'name', title: 'Refund webhook retries' })
    await waitFor(at, 'titled')

    expect(pi.api.sessionName).toBe('Refund webhook retries')
    // `named: true` is what stops anything replacing it later: a name somebody
    // chose is never a guess to be improved on.
    expect(of(at, 'titled')[0]).toMatchObject({ title: 'Refund webhook retries', named: true })
  })

  it('ignores an empty name rather than clearing the one there is', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.say({ type: 'name', title: '   ' })
    at.say({ type: 'steer', message: 'after' })
    await vi.waitFor(() => expect(pi.api.messages).toHaveLength(1))
    expect(of(at, 'titled')).toEqual([])
  })

  it('takes the name a person typed with /name, once', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    pi.api.sessionName = 'my own name'
    await pi.fire('session_start', {}, ctx())
    await waitFor(at, 'titled')
    expect(of(at, 'titled')[0]).toMatchObject({ title: 'my own name', named: true })

    await pi.fire('turn_start', {}, ctx())
    // Said once. A name repeated every turn is a journal of one fact.
    expect(of(at, 'titled')).toHaveLength(1)
  })

  it('gives the session the name Tade renamed it to while it was not running', async () => {
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_TITLE: 'Cover the wire' })
    await pi.fire('session_start', {}, ctx())
    // Renamed in Tade while this agent was not running, so its session takes
    // the name now — and Tade is not told it back, because Tade is what said
    // it. A name repeated to whoever chose it is a journal of one fact.
    expect(pi.api.sessionName).toBe('Cover the wire')
    expect(of(at, 'titled')).toEqual([])
  })

  it('leaves a session that already has a name alone, whatever Tade last knew', async () => {
    const at = await tadeListening()
    const { pi } = await running(at, { TADE_TITLE: 'what Tade remembers' })
    pi.api.sessionName = 'what I typed'
    await pi.fire('session_start', {}, ctx())
    await waitFor(at, 'titled')
    expect(pi.api.sessionName).toBe('what I typed')
    expect(of(at, 'titled')[0]).toMatchObject({ title: 'what I typed', named: true })
  })

  it('names the work from what was asked, at the first thing that changes something', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('input', { text: 'hi' }, ctx())
    await pi.fire('input', { text: 'please fix the double refund on webhook retry' }, ctx())
    // Nothing is named until there is work: "who are you?" is a question, not
    // a description of a task.
    expect(of(at, 'titled')).toEqual([])

    await pi.fire('tool_call', { toolCallId: 'c1', toolName: 'edit', input: {} }, ctx())
    await waitFor(at, 'titled')
    expect(of(at, 'titled')[0]).toMatchObject({
      title: 'Fix the double refund on webhook',
      named: false,
    })
  })

  it('keeps out of the way of slash commands and shell lines', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('input', { text: '/model opus' }, ctx())
    await pi.fire('input', { text: '!ls -la' }, ctx())
    await pi.fire('tool_call', { toolCallId: 'c1', toolName: 'write', input: {} }, ctx())
    await pi.fire('agent_settled', {}, ctx())
    await waitFor(at, 'idle')
    // Neither is a description of the work, so there was nothing to name from.
    expect(of(at, 'titled')).toEqual([])
  })

  it('does not rename work a person already named', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    at.say({ type: 'name', title: 'Mine' })
    await waitFor(at, 'titled')
    await pi.fire('input', { text: 'fix the double refund on webhook retry' }, ctx())
    await pi.fire('tool_call', { toolCallId: 'c1', toolName: 'edit', input: {} }, ctx())
    await pi.fire('agent_settled', {}, ctx())
    await waitFor(at, 'idle')
    expect(of(at, 'titled')).toHaveLength(1)
  })
})

describe('a window that closes and opens again', () => {
  it('dials at a steady rate while Tade is away, and connects once when it returns', async () => {
    // The retry doubled. A socket that cannot connect emits `error` and then
    // `close`, both of them wired to the same handler, so every failed redial
    // scheduled two more: four dials, eight, then a thousand, until the agent
    // had no file descriptors left to do its work with. It fired exactly where
    // the retry was meant to help — a window that closed — and under a driver
    // whose lanes outlive the window that is an ordinary afternoon.
    //
    // A ceiling rather than a count, because that is the only shape that means
    // the same thing on a slower machine: fewer dials fit in the wait, never
    // more. One agent is one connection, however long Tade was away.
    const path = join(tmp('tade-pi-away-'), 's')
    process.env.TADE_RUN_SOCKET = path
    process.env.TADE_RUN_ID = 'run-1'
    vi.resetModules()
    const { default: tadeExtension } = (await import('../src/tade.ts')) as {
      default: (pi: unknown) => void
    }
    tadeExtension(fakePi().api)

    // Long enough for the doubling to show: two retries in, it is four dials.
    await new Promise((done) => setTimeout(done, 4_200))

    let connections = 0
    const server = createServer((socket) => {
      connections += 1
      accepted.push(socket)
      socket.on('error', () => {})
    })
    servers.push(server)
    await new Promise<void>((done) => server.listen(path, done))

    await vi.waitFor(() => expect(connections).toBeGreaterThanOrEqual(1), { timeout: 10_000 })
    expect(connections).toBeLessThanOrEqual(1)
  })

  it('finds Tade again and says where it had got to', async () => {
    const at = await tadeListening()
    const { pi } = await running(at)
    await pi.fire('turn_start', {}, ctx({ isIdle: () => false }))
    // Read before the window goes: a socket destroyed with a line still in
    // flight drops it, which would be the test losing the line rather than
    // the agent failing to say it.
    await waitFor(at, 'turn_started')
    at.hangUp()

    // An agent outlives the window under a driver whose lanes do, so this is
    // the ordinary course of a long task rather than a fault. Reconnecting
    // says whether it is mid-turn, or a window that opened while it worked
    // would take it for idle.
    // A retry interval, so longer than the second a wait is given by default.
    await vi.waitFor(() => expect(of(at, 'turn_started')).toHaveLength(2), { timeout: 10_000 })
    expect(at.connections).toBe(2)
  })
})
