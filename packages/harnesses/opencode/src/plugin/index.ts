import { connect, type Socket } from 'node:net'

// Tade's plugin for OpenCode V2: the half of the OpenCode harness that runs
// inside OpenCode, in the private server a lane's TUI starts (`--standalone`).
//
// OpenCode loads it from this folder because the run's config says so
// (`OPENCODE_CONFIG_CONTENT`, `src/config.ts`), so it is deliberately
// SELF-CONTAINED: it runs under OpenCode's own module resolution (Bun's, in
// its binary), not ours, and imports nothing but Node's own modules. It speaks
// the same JSONL shapes as `WorkerSignal` / `WorkerCommand` in
// @tade/harnesses-core over the run's socket, and the Tade side validates.
//
// What it does, all of it through OpenCode's own plugin API (`setup(ctx)`):
// - says what the session is doing — turns, replies, tool calls, what each
//   step used, a server that went down, a retry — from OpenCode's events;
// - gates every permission OpenCode evaluates under approvals
//   (`ctx.permission.hook('evaluate')`), holding the call until Tade answers
//   and refusing it when Tade cannot be asked;
// - takes what Tade says to the agent — a message into the turn or after it,
//   a stop, a name, another model — through the session API, so it lands in
//   the conversation exactly as if it were typed, and shows in the TUI;
// - puts back what the person's shell commands should see, where the account
//   folder moved OpenCode's own (`TADE_OPENCODE_SHELL_ENV`).
//
// Without TADE_RUN_SOCKET and TADE_OPENCODE_SESSION in the environment it is
// inert, so a person's own `opencode` is never touched by it.

type Json = Record<string, unknown>

/** The slice of OpenCode's plugin context this uses: structural, so nothing of OpenCode's is imported. */
interface Context {
  event: { subscribe(options?: unknown): AsyncIterable<{ type: string; data?: unknown }> }
  permission: { hook(name: 'evaluate', run: (event: Evaluation) => unknown): Promise<unknown> }
  shell?: { hook(name: 'create.before', run: (event: ShellCreate) => unknown): Promise<unknown> }
  session: {
    get(input: { sessionID: string }): Promise<unknown>
    create(input: {
      id: string
      title?: string
      model?: { providerID: string; id: string; variant?: string }
    }): Promise<unknown>
    prompt(input: {
      sessionID: string
      text: string
      delivery?: 'steer' | 'queue'
    }): Promise<unknown>
    interrupt(input: { sessionID: string }): Promise<unknown>
    update(input: { sessionID: string; title?: string }): Promise<unknown>
    /** The messages the next step is sent: everything after the last compaction. */
    context?(input: { sessionID: string }): Promise<unknown>
    switchModel(input: {
      sessionID: string
      model: { providerID: string; id: string; variant?: string }
    }): Promise<unknown>
  }
  mcp?: { list(input?: unknown): Promise<unknown> }
  model?: { list(input?: unknown): Promise<unknown> }
}

interface Evaluation {
  readonly sessionID: string
  readonly action: string
  readonly resources: ReadonlyArray<string>
  readonly metadata?: Record<string, unknown>
  readonly source?: { type?: string; id?: string; messageID?: string }
  effect: 'allow' | 'ask' | 'deny'
  message?: string
}

interface ShellCreate {
  env: Record<string, string | undefined>
}

const SOCKET = process.env.TADE_RUN_SOCKET
const SESSION = process.env.TADE_OPENCODE_SESSION
const RUN = process.env.TADE_RUN_ID ?? 'unknown'
/**
 * Whether tool calls are gated. Under `policy` a gate that cannot be asked
 * refuses; under `bypass` nothing was ever going to be held, so losing Tade
 * costs the journal and nothing else.
 */
const GATED = process.env.TADE_APPROVALS === 'policy'

/** How long to wait before looking for Tade again: a closed window costs nothing, a reopened one is found at once. */
const RETRY_MS = 2_000

/** Tade's own tools, as OpenCode names an MCP server's: `<server>_<tool>`. */
const OURS = 'tade_'

/** A tool as Tade names it: Tade's own lose their server's prefix. */
export function toolName(name: string): string {
  return name.startsWith(OURS) ? name.slice(OURS.length) : name
}

/** The files a call of OpenCode's own tools writes, by their own fields. */
export function writesOf(tool: string, input: unknown): string[] {
  const fields = (input ?? {}) as Json
  if (tool === 'edit' || tool === 'write') {
    return typeof fields.path === 'string' && fields.path ? [fields.path] : []
  }
  if (tool === 'patch' && typeof fields.patchText === 'string') {
    const files: string[] = []
    for (const match of fields.patchText.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)) {
      const file = match[1]?.trim()
      if (file && !files.includes(file)) files.push(file)
    }
    return files
  }
  return []
}

/** One line, exact enough to read back before approving: what OpenCode is asking to do, to what. */
export function describePermission(action: string, resources: readonly string[]): string {
  const what = resources.filter(Boolean).join(', ')
  return what ? `${action}: ${what}` : action
}

const obj = (value: unknown): Json | null =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Json) : null
const str = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null
const count = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0

/**
 * About how many tokens a compacted conversation holds, at four characters a
 * token: OpenCode says nothing of how full one is until its next step, and
 * a context still read as full is compacted again. Its own instructions and
 * tools are not in it, so it reads emptier than it is until that step says.
 */
export function tokensHeld(context: unknown): number {
  const said = obj(context)
  const messages = Array.isArray(said?.data) ? said.data : Array.isArray(context) ? context : []
  let chars = 0
  for (const raw of messages as unknown[]) {
    const message = obj(raw)
    if (!message) continue
    for (const text of [message.summary, message.text, obj(message.metadata)?.recent]) {
      if (typeof text === 'string') chars += text.length
    }
    if (Array.isArray(message.content)) chars += JSON.stringify(message.content).length
  }
  return Math.ceil(chars / 4)
}

/** `provider/id`, as a model reference names it. */
function modelName(model: unknown): string | null {
  const ref = obj(model)
  const id = str(ref?.id)
  if (!id) return null
  const provider = str(ref?.providerID)
  return provider ? `${provider}/${id}` : id
}

/** A model as OpenCode's session API takes one, from `provider/model#variant`. */
function refOf(said: string): { providerID: string; id: string; variant?: string } | null {
  const [name, variant] = said.split('#', 2)
  const at = name?.indexOf('/') ?? -1
  if (!name || at <= 0 || at === name.length - 1) return null
  return { providerID: name.slice(0, at), id: name.slice(at + 1), ...(variant ? { variant } : {}) }
}

/** `provider/id` of a reference. */
function nameOf(ref: { providerID: string; id: string }): string {
  return `${ref.providerID}/${ref.id}`
}

/** What OpenCode says went wrong, in its words. */
function errorText(error: unknown): string {
  const said = obj(error)
  return str(said?.message) ?? str(said?.type) ?? str(error) ?? 'OpenCode did not say why'
}

/** What the person's own shell commands should see: OpenCode's folders moved for the account, put back. */
function shellEnv(): Record<string, string | null> {
  try {
    const said = JSON.parse(process.env.TADE_OPENCODE_SHELL_ENV ?? '{}') as unknown
    const out: Record<string, string | null> = {}
    for (const [key, value] of Object.entries(obj(said) ?? {})) {
      if (typeof value === 'string' || value === null) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export default {
  id: 'tade',
  setup: async (ctx: Context) => {
    if (!SOCKET || !SESSION) return
    const session = SESSION

    let socket: Socket | null = null
    let connected = false
    let stopped = false
    let buffer = ''
    let counter = 0
    /** Whether a turn is running in the session, as OpenCode last said. */
    let busy = false
    /** The model the session is on, as OpenCode last said. */
    let model: string | null = null
    /**
     * The last turn that ended while Tade was away, said when it is back: a
     * turn nobody heard end is one a hand-over or a done rule waits on for ever.
     */
    let missed: Json | null = null
    /** Tool calls by id: their names arrive before they run, their input as they are called. */
    const names = new Map<string, string>()
    const inputs = new Map<string, unknown>()
    /** Each step's model, by the assistant message it writes. */
    const steps = new Map<string, string | null>()
    /** Permissions held until Tade answers, by request id. */
    const pending = new Map<string, (decision: { allow: boolean; reason: string }) => void>()
    /** The servers said to be down, so each is said once until it comes back. */
    const down = new Set<string>()
    /** How many tokens each model holds, once OpenCode has said. */
    let windows: Map<string, number> | null = null

    const send = (message: Json): void => {
      if (!socket || !connected) return
      const at = typeof message.at === 'number' ? message.at : Date.now()
      socket.write(`${JSON.stringify({ ...message, run: RUN, at })}\n`)
    }

    const problem = (text: string): void => send({ type: 'problem', text })

    /** Ask OpenCode something, and say so rather than throw when it cannot. */
    const attempt = async (what: string, work: () => Promise<unknown>): Promise<void> => {
      try {
        await work()
      } catch (err) {
        problem(`OpenCode could not ${what}: ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    /** The name a person gave the work while this agent was not running: the session takes it once. */
    let given = process.env.TADE_TITLE?.trim() || null

    const sayStarted = async (): Promise<void> => {
      try {
        const got = obj(await ctx.session.get({ sessionID: session }))
        const info = obj(got?.data) ?? got
        model = modelName(info?.model) ?? model
        if (given && str(info?.title) !== given) {
          const title = given
          given = null
          await attempt('take the name it was given', () =>
            ctx.session.update({ sessionID: session, title }),
          )
        }
      } catch {
        // Not made yet, or not readable yet: the model is said when a step names it.
      }
      send({ type: 'started', sessionId: session, model, thinking: null })
    }

    const failPending = (reason: string): void => {
      for (const [, resolve] of pending) resolve({ allow: false, reason })
      pending.clear()
    }

    const handle = (line: string): void => {
      let command: Json
      try {
        command = JSON.parse(line) as Json
      } catch {
        return
      }
      switch (command.type) {
        case 'decision': {
          const id = String(command.requestId)
          const resolve = pending.get(id)
          if (!resolve) return
          pending.delete(id)
          resolve({ allow: command.allow === true, reason: String(command.reason ?? '') })
          return
        }
        case 'steer':
        case 'queue': {
          const text = String(command.message ?? '')
          if (!text) return
          void attempt('take a message from Tade', () =>
            ctx.session.prompt({
              sessionID: session,
              text,
              delivery: command.type === 'queue' ? 'queue' : 'steer',
            }),
          )
          return
        }
        case 'abort':
          void attempt('stop the turn', () => ctx.session.interrupt({ sessionID: session }))
          return
        case 'name': {
          const title = String(command.title ?? '').trim()
          if (!title) return
          void attempt('rename the session', async () => {
            await ctx.session.update({ sessionID: session, title })
            send({ type: 'titled', title, named: true })
          })
          return
        }
        case 'model': {
          const id = String(command.id ?? '')
          const at = id.indexOf('/')
          const providerID = String(command.provider || (at > 0 ? id.slice(0, at) : ''))
          const modelID = command.provider || at <= 0 ? id : id.slice(at + 1)
          const [bare, variant] = modelID.split('#', 2)
          if (!providerID || !bare) return
          void attempt(`switch to ${providerID}/${bare}`, () =>
            ctx.session.switchModel({
              sessionID: session,
              model: { providerID, id: bare, ...(variant ? { variant } : {}) },
            }),
          )
          return
        }
        case 'shutdown':
          stopped = true
          socket?.destroy()
          return
      }
    }

    /**
     * Connect, and keep trying: under a driver whose lanes outlive the window,
     * Tade going away and coming back is an ordinary afternoon, and the socket
     * is put back where this looks because its path is made from the run.
     */
    const dial = (): void => {
      if (stopped) return
      const one = connect(SOCKET)
      socket = one
      one.on('connect', () => {
        connected = true
        buffer = ''
        void sayStarted().then(() => {
          if (missed) send(missed)
          missed = null
          // Where it is now: a window that opened while it worked would take
          // it for idle, or idle for working.
          send({ type: busy ? 'turn_started' : 'idle' })
        })
      })
      one.setEncoding('utf8')
      one.on('data', (chunk: string) => {
        buffer += chunk
        let end = buffer.indexOf('\n')
        while (end >= 0) {
          handle(buffer.slice(0, end).replace(/\r$/, ''))
          buffer = buffer.slice(end + 1)
          end = buffer.indexOf('\n')
        }
      })
      // `error` then `close` on a failed dial: answered once, or every failed
      // dial schedules two more.
      const drop = () => {
        if (socket !== one) return
        socket = null
        const was = connected
        connected = false
        if (GATED && was) failPending('Tade is not reachable, and approvals are on')
        if (stopped) return
        const timer = setTimeout(dial, RETRY_MS)
        timer.unref?.()
      }
      one.on('close', drop)
      one.on('error', drop)
      one.unref()
    }
    dial()

    // What the person's own commands see: the folders an account moved put back.
    const restore = shellEnv()
    await ctx.shell?.hook('create.before', (event: ShellCreate) => {
      for (const [key, value] of Object.entries(restore)) {
        if (value === null) delete event.env[key]
        else event.env[key] = value
      }
      // Nothing an agent runs is Tade's run: an `opencode` it starts itself
      // must not load this plugin and speak for the lane.
      delete event.env.OPENCODE_CONFIG_CONTENT
      delete event.env.TADE_OPENCODE_SESSION
      delete event.env.TADE_OPENCODE_SHELL_ENV
      delete event.env.TADE_OPENCODE_MODEL
    })

    // The gate. Under approvals every permission OpenCode evaluates is held
    // here until Tade answers, so policy lives in one place. Tade's own tools
    // are Tade's to answer, and are let through; a rule OpenCode was told
    // denies is final whatever Tade says.
    await ctx.permission.hook('evaluate', async (event: Evaluation) => {
      if (!GATED || event.effect === 'deny') return
      if (event.action.startsWith(OURS)) {
        event.effect = 'allow'
        return
      }
      if (!connected) {
        event.effect = 'deny'
        event.message = 'Tade is not reachable, and approvals are on'
        return
      }
      const call = event.source?.id ?? ''
      const tool = toolName(names.get(call) ?? event.action)
      const requestId = `${RUN}-${++counter}`
      const decision = await new Promise<{ allow: boolean; reason: string }>((resolve) => {
        pending.set(requestId, resolve)
        send({
          type: 'permission_request',
          requestId,
          tool,
          input: inputs.get(call) ?? { action: event.action, resources: [...event.resources] },
          summary: describePermission(event.action, event.resources),
        })
      })
      event.effect = decision.allow ? 'allow' : 'deny'
      if (!decision.allow) event.message = decision.reason || 'Tade said no'
    })

    /** How full the context is after a step, out of the model's window where OpenCode says it. */
    const sayContext = async (tokens: number, on: string | null): Promise<void> => {
      if (tokens <= 0) return
      if (windows === null && ctx.model) {
        try {
          const listed: unknown = await ctx.model.list()
          const data = obj(listed)?.data
          const all = Array.isArray(data) ? data : Array.isArray(listed) ? listed : []
          windows = new Map()
          for (const raw of all as unknown[]) {
            const one = obj(raw)
            const name = modelName(one)
            const limit = count(obj(one?.limit)?.context)
            if (name && limit > 0) windows.set(name, limit)
          }
        } catch (err) {
          windows = new Map()
          problem(
            `OpenCode would not list its models, so how full the context is is said in tokens alone: ${String(err)}`,
          )
        }
      }
      const limit = on ? windows?.get(on) : undefined
      send({
        type: 'context',
        tokens,
        percent: limit ? Math.min(100, Math.round((tokens / limit) * 100)) : null,
      })
    }

    /**
     * What one call to a model used, as OpenCode says on its ending — a step's
     * or a compaction's, which share a shape: input apart from what was read
     * from the cache, and reasoning paid for as output.
     */
    const sayUsage = (
      data: Json,
      on: string | null,
    ): { input: number; cacheRead: number; cacheWrite: number } => {
      const tokens = obj(data.tokens)
      const cache = obj(tokens?.cache)
      const input = count(tokens?.input)
      const output = count(tokens?.output) + count(tokens?.reasoning)
      const cacheRead = count(cache?.read)
      const cacheWrite = count(cache?.write)
      const total = input + output + cacheRead + cacheWrite
      const usd = count(data.cost)
      if (total > 0 || usd > 0) {
        send({ type: 'usage', model: on, input, output, cacheRead, cacheWrite, tokens: total, usd })
      }
      return { input, cacheRead, cacheWrite }
    }

    /** A turn is over: said now, or kept for when Tade is back. */
    const ended = (status: 'ok' | 'error' | 'aborted', reason?: string): void => {
      busy = false
      const said: Json = { type: 'turn_done', status, ...(reason ? { reason } : {}) }
      if (connected) {
        send(said)
        send({ type: 'idle' })
      } else missed = { ...said, at: Date.now() }
    }

    const onEvent = async (type: string, data: Json): Promise<void> => {
      const sid = str(data.sessionID)
      // Every session in this server is this lane's, and only its own is the
      // conversation: a subagent's steps still cost, and its tools are still
      // gated, but its turns are not the agent's.
      const own = sid === session
      switch (type) {
        case 'session.execution.started':
          if (!own) return
          busy = true
          send({ type: 'turn_started' })
          return
        case 'session.execution.succeeded':
          if (own) ended('ok')
          return
        case 'session.execution.failed':
          if (own) ended('error', errorText(data.error))
          return
        case 'session.execution.interrupted':
          if (own) ended('aborted')
          return
        case 'session.compaction.failed':
          // What a compaction used is its own call's, said on its ending and
          // never on a step: a failed one may still have paid for some.
          sayUsage(data, modelName(data.model) ?? (own ? model : null))
          return
        case 'session.compaction.ended':
          sayUsage(data, modelName(data.model) ?? (own ? model : null))
          if (own && ctx.session.context) {
            const held = tokensHeld(await ctx.session.context({ sessionID: session }))
            await sayContext(held, modelName(data.model) ?? model)
          }
          return
        case 'session.retry.scheduled':
          if (own) {
            problem(
              `OpenCode is trying the model again (attempt ${String(data.attempt ?? '?')}): ${errorText(data.error)}`,
            )
          }
          return
        case 'session.text.delta':
          if (own && typeof data.delta === 'string') {
            send({ type: 'message_delta', text: data.delta })
          }
          return
        case 'session.text.ended':
          if (own && typeof data.text === 'string' && data.text.trim()) {
            send({ type: 'message', text: data.text.trim() })
          }
          return
        case 'session.tool.input.started': {
          const id = str(data.id)
          const name = str(data.name)
          if (id && name) names.set(id, name)
          return
        }
        case 'session.tool.called': {
          const id = str(data.id)
          if (!id) return
          const input = obj(data.input) ?? {}
          inputs.set(id, input)
          if (!own) return
          const tool = toolName(names.get(id) ?? 'tool')
          send({ type: 'tool_call', callId: id, tool, input, writes: writesOf(tool, input) })
          return
        }
        case 'session.tool.success':
        case 'session.tool.failed': {
          const id = str(data.id)
          if (!id) return
          names.delete(id)
          inputs.delete(id)
          if (!own) return
          const ok = type === 'session.tool.success'
          send({
            type: 'tool_result',
            callId: id,
            ok,
            summary: ok ? '' : errorText(data.error).slice(0, 300),
          })
          return
        }
        case 'session.step.started': {
          const id = str(data.assistantMessageID)
          if (id) steps.set(id, modelName(data.model))
          if (own) {
            const now = modelName(data.model)
            if (now && now !== model) {
              model = now
              send({ type: 'started', sessionId: session, model, thinking: null })
            }
          }
          return
        }
        case 'session.step.ended': {
          const id = str(data.assistantMessageID) ?? ''
          const on = steps.get(id) ?? (own ? model : null)
          steps.delete(id)
          const { input, cacheRead, cacheWrite } = sayUsage(data, on)
          if (own) await sayContext(input + cacheRead + cacheWrite, on)
          return
        }
        case 'session.model.selected':
          if (own) {
            model = modelName(data.model) ?? model
            send({ type: 'started', sessionId: session, model, thinking: null })
          }
          return
        case 'session.renamed':
          if (own && typeof data.title === 'string' && data.title.trim()) {
            send({ type: 'titled', title: data.title.trim(), named: false })
          }
          return
        case 'mcp.status.changed':
          await sayServers()
          return
      }
    }

    /** A tool server OpenCode gave up on: said once each time it goes down. */
    const sayServers = async (): Promise<void> => {
      if (!ctx.mcp) return
      let listed: unknown
      try {
        listed = await ctx.mcp.list()
      } catch (err) {
        problem(
          `OpenCode would not say how its tool servers stand, so one that went down may not be said: ${String(err)}`,
        )
        return
      }
      const said = obj(listed)
      const rows = Array.isArray(said?.data) ? said.data : Array.isArray(listed) ? listed : []
      for (const raw of rows as unknown[]) {
        const row = obj(raw)
        const name = str(row?.name) ?? str(row?.server)
        const status = obj(row?.status) ?? row
        const state = str(status?.status)
        if (!name || !state) continue
        if (state === 'failed' || state === 'needs_auth') {
          if (down.has(name)) continue
          down.add(name)
          send({
            type: 'server_down',
            server: name,
            why: `${state === 'needs_auth' ? 'needs signing in' : 'failed'}: ${str(status?.error) ?? 'OpenCode did not say why'}`,
          })
        } else if (state === 'connected') down.delete(name)
      }
    }

    // The session this lane is for, made if the line could not make it, and
    // its first instruction said into it: once, at the launch that carries it.
    const opening = process.env.TADE_OPENCODE_OPENING
    delete process.env.TADE_OPENCODE_OPENING
    void (async () => {
      const wanted = process.env.TADE_OPENCODE_MODEL ? refOf(process.env.TADE_OPENCODE_MODEL) : null
      const title = process.env.TADE_TITLE?.trim() || process.env.TADE_CALLED?.trim() || undefined
      // The server may still be settling while plugins load: tried again for a while.
      for (let tries = 0; tries < 20; tries++) {
        try {
          let info: Json | null = null
          try {
            const got = obj(await ctx.session.get({ sessionID: session }))
            info = obj(got?.data) ?? got
          } catch {
            info = null
          }
          if (!info?.id) {
            await ctx.session.create({
              id: session,
              ...(title ? { title } : {}),
              ...(wanted ? { model: wanted } : {}),
            })
          } else if (wanted && !obj(info.time)?.busy && modelName(info.model) !== nameOf(wanted)) {
            // Made, never run, and on another model than the task's.
            await ctx.session.switchModel({ sessionID: session, model: wanted })
          }
          if (opening) await ctx.session.prompt({ sessionID: session, text: opening })
          return
        } catch (err) {
          if (tries === 19) {
            problem(
              `OpenCode would not take this agent's first instruction: ${err instanceof Error ? err.message : String(err)}`,
            )
          }
          await new Promise((resolve) => setTimeout(resolve, 500))
        }
      }
    })()

    // Read OpenCode's events for as long as the server runs. One that throws
    // is said and the reading goes on: a plugin that stopped listening would
    // leave the window drawing a turn that never ends.
    void (async () => {
      for (;;) {
        try {
          for await (const event of ctx.event.subscribe()) {
            await onEvent(event.type, obj(event.data) ?? {}).catch((err: unknown) =>
              problem(`Tade's OpenCode plugin could not read ${event.type}: ${String(err)}`),
            )
          }
          return
        } catch (err) {
          problem(
            `Tade's OpenCode plugin lost OpenCode's events, and listens again: ${String(err)}`,
          )
          await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
        }
      }
    })()

    return () => {
      stopped = true
      failPending('OpenCode closed this session')
      socket?.destroy()
    }
  },
}
