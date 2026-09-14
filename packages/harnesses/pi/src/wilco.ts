import { readFileSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { addSpent, nothingSpent, type Spent, spentBy } from './usage.ts'

// The Wilco supervision extension for pi.
//
// pi loads this file directly, so it is deliberately SELF-CONTAINED: no
// imports from the Wilco workspace, because the extension runs inside pi's
// module resolution, not ours. The one import is `usage.ts` beside it, which
// imports nothing: what a session spent has to be counted the same way here
// and from pi's files afterwards. It speaks the same JSONL shapes as
// `WorkerSignal` / `WorkerCommand` in @wilco/core; the Wilco side validates.
//
// Without WILCO_RUN_SOCKET in the environment this is inert, so a human
// running plain `pi` is never affected.

// Minimal structural types for the slice of pi's API we use.
interface ToolCallEvent {
  toolCallId: string
  toolName: string
  input: Record<string, unknown>
}
interface ToolResultEvent {
  toolCallId: string
  toolName: string
  isError: boolean
}
interface ToolCallResult {
  block?: boolean
  reason?: string
}
interface PiContext {
  mode: string
  cwd: string
  abort(): void
  shutdown(): void
  isIdle(): boolean
  getContextUsage?(): { tokens: number | null; percent: number | null } | undefined
  /** The harness prices each message against its own model catalog. */
  sessionManager?: { getEntries?(): unknown[] }
  model?: { id?: string; provider?: string } | string
  /** The harness's model catalog: finding a model to switch to, and asking one for a name. */
  modelRegistry?: {
    find?(provider: string, id: string): unknown
    getAvailable?(): Array<{ id: string; provider: string }>
    complete?(
      model: unknown,
      context: {
        systemPrompt?: string
        messages: Array<{ role: 'user'; content: string; timestamp: number }>
      },
      options?: { signal?: AbortSignal },
    ): Promise<{ content?: Array<{ type?: string; text?: string }> }>
  }
}

/** A tool as Wilco lists it for an agent: what pi needs to register it. */
interface ToolSpec {
  name: string
  label: string
  description: string
  parameters: Record<string, unknown>
}
interface PiApi {
  on(event: string, handler: (event: never, ctx: PiContext) => unknown): void
  registerTool?(tool: {
    name: string
    label: string
    description: string
    parameters: Record<string, unknown>
    execute(
      toolCallId: string,
      params: Record<string, unknown>,
    ): Promise<{ content: Array<{ type: 'text'; text: string }>; details: unknown }>
  }): void
  /** The name given to the session with `/name`, if one was. */
  getSessionName?(): string | undefined
  setSessionName?(name: string): void
  /** Switch this session's model, leaving the default for new sessions alone. */
  setModel?(model: unknown): Promise<boolean>
  sendUserMessage?(
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ): Promise<void> | void
}

type Json = Record<string, unknown>

const SOCKET = process.env.WILCO_RUN_SOCKET
/**
 * Whether tool calls are gated at all.
 *
 * This decides what happens when Wilco is not there, which under a driver
 * whose lanes outlive the window is the ordinary case rather than a fault.
 * Under `bypass` nothing was ever going to be held, so losing the connection
 * costs telemetry and nothing else and the agent works on. Under `policy` a
 * gate that cannot be asked has to refuse: quietly downgrading to ungated
 * would be the one outcome nobody asked for.
 */
const GATED = process.env.WILCO_APPROVALS === 'policy'

/**
 * How long to wait before looking for Wilco again. Long enough that a closed
 * window costs nothing, short enough that reopening feels immediate.
 */
const RETRY_MS = 2_000

/** Session totals as last reported, so each turn sends only the difference. */
let spent: Spent = nothingSpent()
/**
 * Whether `spent` has been set from the session this process opened. A resumed
 * session arrives with its whole history, which was reported by the process
 * that spent it; counting from zero would report all of it again on the first
 * turn, and opening a task is now a click.
 */
let seeded = false
const RUN = process.env.WILCO_RUN_ID ?? 'unknown'
/** Where Wilco listed the extension tools this agent may call. */
const TOOLS = process.env.WILCO_EXTENSION_TOOLS

/** How long a tool Wilco runs may take: a dependency update, a Seer analysis. */
const EXTENSION_CALL_MS = 10 * 60_000

export default function wilcoExtension(pi: PiApi): void {
  if (!SOCKET) return

  const pending = new Map<string, (result: ToolCallResult) => void>()
  /** Extension tools waiting on Wilco's answer, by call id. */
  const calls = new Map<string, (answer: { ok: boolean; text: string }) => void>()
  let socket: Socket | null = null
  let connected = false
  /** Set when pi is going away, so we stop trying to find Wilco. */
  let stopped = false
  let buffer = ''
  let latest: PiContext | null = null
  let counter = 0

  const send = (message: Json): void => {
    if (!socket || !connected) return
    socket.write(`${JSON.stringify({ ...message, run: RUN, at: Date.now() })}\n`)
  }

  const failPending = (reason: string): void => {
    for (const [, resolve] of pending) resolve({ block: true, reason })
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
        const resolve = pending.get(String(command.requestId))
        if (!resolve) return
        pending.delete(String(command.requestId))
        resolve(
          command.allow === true
            ? {}
            : { block: true, reason: String(command.reason || 'denied by Wilco') },
        )
        return
      }
      case 'steer':
      case 'queue': {
        void pi.sendUserMessage?.(String(command.message), {
          deliverAs: command.type === 'steer' ? 'steer' : 'followUp',
        })
        return
      }
      case 'extension_result': {
        const resolve = calls.get(String(command.callId))
        calls.delete(String(command.callId))
        resolve?.({ ok: command.ok === true, text: String(command.text ?? '') })
        return
      }
      case 'name': {
        // Named in Wilco: pi shows it too, and it is yours, so nothing renames it after.
        const title = String(command.title ?? '').trim()
        if (!title) return
        chosen = title
        titled = title
        pi.setSessionName?.(title)
        send({ type: 'titled', title, named: true })
        return
      }
      case 'model': {
        void switchModel(String(command.provider ?? ''), String(command.id ?? ''))
        return
      }
      case 'abort':
        latest?.abort()
        return
      case 'shutdown':
        stopped = true
        latest?.shutdown()
        return
    }
  }

  /**
   * Connect, and keep trying.
   *
   * An agent outlives the window under a driver whose lanes do, so Wilco going
   * away and coming back is the ordinary course of a long task, not a fault.
   * Without this the agent would run on for days reporting to nobody: no
   * journal, no spend, and — worse — no gate, because a gate with nothing at
   * the other end refuses everything. The socket path is derived from the run
   * id, so the window that reopens puts it back exactly where this is looking.
   */
  const dial = (): void => {
    if (stopped) return
    socket = connect(SOCKET)
    socket.on('connect', () => {
      connected = true
      buffer = ''
      send({ type: 'started', sessionId: null, model: latest ? modelOf(latest) : null })
    })
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      // Strict LF framing: JSON strings may contain other separators.
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        handle(buffer.slice(0, index).replace(/\r$/, ''))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })
    socket.on('close', drop)
    socket.on('error', drop)
    socket.unref()
  }

  const drop = () => {
    const wasConnected = connected
    connected = false
    // Wilco gone mid-flight. Only a gate has anything to say about that: with
    // approvals off, nothing was waiting on it, and failing a call that was
    // never going to be held would break work for no reason.
    if (GATED && wasConnected) failPending('Wilco is not reachable, and approvals are on')
    // A tool that runs inside Wilco has nowhere to run once it is gone.
    for (const [, resolve] of calls) resolve({ ok: false, text: 'Wilco closed before it answered' })
    calls.clear()
    if (stopped) return
    // Unref'd, so waiting to be picked up again never keeps pi alive by itself.
    const timer = setTimeout(dial, RETRY_MS)
    timer.unref?.()
  }

  dial()

  // Wilco's extension tools: listed at launch, run in Wilco, answered here.
  for (const spec of readTools(TOOLS)) {
    pi.registerTool?.({
      name: spec.name,
      label: spec.label,
      description: spec.description,
      parameters: spec.parameters,
      async execute(toolCallId, params) {
        if (!connected) {
          throw new Error(`Wilco is not open, so ${spec.name} cannot run right now`)
        }
        const answer = await new Promise<{ ok: boolean; text: string }>((resolve) => {
          calls.set(toolCallId, resolve)
          const timer = setTimeout(() => {
            calls.delete(toolCallId)
            resolve({ ok: false, text: `${spec.name} did not answer in time` })
          }, EXTENSION_CALL_MS)
          timer.unref?.()
          send({ type: 'extension_call', callId: toolCallId, tool: spec.name, input: params ?? {} })
        })
        // Thrown, so pi marks the call failed and the model reads why.
        if (!answer.ok) throw new Error(answer.text)
        return { content: [{ type: 'text', text: answer.text }], details: {} }
      },
    })
  }

  const remember = (_event: unknown, ctx: PiContext) => {
    latest = ctx
  }
  for (const event of ['agent_start', 'turn_start', 'message_end', 'tool_execution_start']) {
    pi.on(event, remember as never)
  }

  pi.on('turn_start', ((_event: unknown, ctx: PiContext) => {
    latest = ctx
    // Before this turn has spent anything, the session holds only what came
    // before this process: that is the baseline, not news.
    if (!seeded) {
      spent = sessionTotals(ctx)
      seeded = true
    }
    send({ type: 'turn_started' })
  }) as never)

  /**
   * Which model this session runs on, and how full its context is — said as
   * soon as the session opens and again whenever the model changes, so the
   * window shows what the agent actually has rather than what the config hoped
   * for. A resumed session is also the moment to take the spend baseline.
   */
  const sayVitals = (ctx: PiContext) => {
    latest = ctx
    send({ type: 'started', sessionId: null, model: modelOf(ctx) })
    const usage = ctx.getContextUsage?.()
    if (usage) send({ type: 'context', tokens: usage.tokens, percent: usage.percent })
  }
  pi.on('session_start', ((_event: unknown, ctx: PiContext) => {
    // Every session this process opens — the first, a new one, one resumed or
    // forked — arrives with a history someone else already counted. Counting
    // on from the last one's totals would report nothing until the new session
    // outgrew them.
    spent = sessionTotals(ctx)
    seeded = true
    sayVitals(ctx)
  }) as never)
  pi.on('model_select', ((_event: unknown, ctx: PiContext) => sayVitals(ctx)) as never)

  /**
   * What the work is called, so Wilco can name the agent's branch and you can
   * tell agents apart.
   *
   * A name you gave — `/name` here, or renaming it in Wilco — always wins and
   * is never replaced. Otherwise nothing is named until the agent does some
   * work: "who are you?" is a question, not a description of a task. When it
   * first changes something, the request that led there names it at once, and
   * the model it runs on is asked for a better name in a few words, which pi
   * shows as the session's name too.
   */
  let titled: string | null = null
  /** A name a person chose. */
  let chosen: string | null = null
  /** A name this extension gave the session, which is not a person's choice. */
  let generated: string | null = null
  const prompts: string[] = []
  let naming = false

  const sayName = () => {
    const name = pi.getSessionName?.()?.trim()
    if (name && name !== titled && name !== generated) {
      chosen = name
      titled = name
      send({ type: 'titled', title: name, named: true })
    }
  }
  pi.on('session_start', (() => {
    // Renamed in Wilco while this agent was not running: its session takes the name now.
    const given = process.env.WILCO_TITLE?.trim()
    if (given && !pi.getSessionName?.()) {
      pi.setSessionName?.(given)
      chosen = given
      titled = given
    }
    sayName()
  }) as never)
  pi.on('turn_start', (() => sayName()) as never)
  pi.on('input', ((event: { text?: string }) => {
    sayName()
    const text = (event.text ?? '').trim()
    if (text !== '' && !text.startsWith('/') && !text.startsWith('!') && prompts.length < 6) {
      prompts.push(text)
    }
    return { action: 'continue' }
  }) as never)

  const nameFromWork = (ctx: PiContext) => {
    if (chosen || naming || generated) return
    naming = true
    const plain = titleFrom(prompts)
    if (plain && titled === null) {
      titled = plain
      send({ type: 'titled', title: plain, named: false })
    }
    void askForName(ctx, prompts)
      .then((name) => {
        if (!name || chosen) return
        generated = name
        titled = name
        pi.setSessionName?.(name)
        send({ type: 'titled', title: name, named: false })
      })
      .catch(() => {})
  }
  pi.on('tool_call', ((event: ToolCallEvent, ctx: PiContext) => {
    if (CHANGES.has(event.toolName)) nameFromWork(ctx)
    return undefined
  }) as never)

  /** Switch to a model by provider and id, as Wilco asked. */
  const switchModel = async (provider: string, id: string) => {
    const registry = latest?.modelRegistry
    const found =
      (provider ? registry?.find?.(provider, id) : undefined) ??
      registry
        ?.getAvailable?.()
        .find((model) => model.id === id && (!provider || model.provider === provider))
    if (!found || !pi.setModel) return
    await pi.setModel(found).catch(() => false)
  }

  pi.on('turn_end', ((
    event: { message?: { stopReason?: string; errorMessage?: string } },
    ctx: PiContext,
  ) => {
    latest = ctx
    const stop = event?.message?.stopReason
    send({
      type: 'turn_done',
      status: stop === 'error' ? 'error' : stop === 'aborted' ? 'aborted' : 'ok',
      ...(stop === 'error' && event.message?.errorMessage
        ? { reason: event.message.errorMessage }
        : {}),
    })
    const usage = ctx.getContextUsage?.()
    if (usage) send({ type: 'context', tokens: usage.tokens, percent: usage.percent })
    reportSpend(ctx)
  }) as never)

  function modelOf(ctx: PiContext): string | null {
    if (typeof ctx.model === 'string') return ctx.model
    const id = ctx.model?.id
    if (!id) return null
    // With its provider, so the window can say which account is paying for it.
    return ctx.model?.provider ? `${ctx.model.provider}/${id}` : id
  }

  /** Everything the session has spent, counted the way pi counts it. */
  function sessionTotals(ctx: PiContext): Spent {
    let total = nothingSpent()
    for (const entry of ctx.sessionManager?.getEntries?.() ?? []) {
      const cost = spentBy(entry)
      if (cost) total = addSpent(total, cost)
    }
    return total
  }

  /**
   * What this turn cost, in tokens and dollars.
   *
   * The session carries running totals, so each turn reports the difference
   * since the last one and Wilco can simply add them up. Prices come from
   * the harness's own model catalog: it is the only thing that knows what was
   * actually charged, and a table we kept ourselves would be wrong the first
   * time a provider changed anything.
   */
  function reportSpend(ctx: PiContext): void {
    const total = sessionTotals(ctx)
    seeded = true
    const since = {
      input: total.input - spent.input,
      output: total.output - spent.output,
      cacheRead: total.cacheRead - spent.cacheRead,
      cacheWrite: total.cacheWrite - spent.cacheWrite,
      tokens: total.tokens - spent.tokens,
      usd: total.usd - spent.usd,
    }
    // Nothing new to say — a subscription-billed provider reports no cost at
    // all, and a turn that used no tokens is not worth an event.
    if (since.tokens <= 0 && since.usd <= 0) return
    spent = total
    send({ type: 'usage', model: modelOf(ctx), ...since })
  }

  pi.on('agent_settled', ((_event: unknown, ctx: PiContext) => {
    latest = ctx
    send({ type: 'idle' })
  }) as never)

  pi.on('tool_execution_end', ((event: ToolResultEvent) => {
    send({
      type: 'tool_result',
      callId: event.toolCallId,
      ok: !event.isError,
      summary: event.toolName,
    })
  }) as never)

  // The gate. When approvals are on, every tool call is held here until Wilco
  // answers, so policy lives in one place instead of being re-implemented per
  // agent. When they are off — the default — nothing is ever held.
  pi.on('tool_call', (async (event: ToolCallEvent, ctx: PiContext): Promise<ToolCallResult> => {
    latest = ctx
    // Recorded either way, so the journal is honest even when nothing is
    // gated. `send` is a no-op while disconnected: what happened is still in
    // pi's own session, which is where it gets recovered from.
    send({ type: 'tool_call', callId: event.toolCallId, tool: event.toolName, input: event.input })
    if (!GATED) return {}
    if (!connected) {
      return { block: true, reason: 'Wilco is not reachable, and approvals are on' }
    }
    const requestId = `${RUN}-${++counter}`
    const decision = new Promise<ToolCallResult>((resolve) => {
      pending.set(requestId, resolve)
      send({
        type: 'permission_request',
        requestId,
        tool: event.toolName,
        input: event.input,
        summary: describeToolCall(event),
      })
    })
    return decision
  }) as never)
}

/** One line, exact enough to read back before approving. */
export function describeToolCall(event: ToolCallEvent): string {
  const input = event.input ?? {}
  const first = (...keys: string[]): string | null => {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === 'string' && value.length > 0) return value
    }
    return null
  }
  switch (event.toolName) {
    case 'bash':
    case 'powershell':
      return `${event.toolName}: ${truncate(first('command', 'script') ?? '')}`
    case 'edit':
    case 'write':
      return `${event.toolName} ${truncate(first('path', 'file_path', 'filePath') ?? '', 60)}`
    case 'read':
    case 'ls':
    case 'find':
    case 'grep':
      return `${event.toolName} ${truncate(first('path', 'pattern', 'query') ?? '', 60)}`
    default:
      return `${event.toolName} ${truncate(JSON.stringify(input), 60)}`
  }
}

function truncate(text: string, limit = 120): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat
}

/** The start of a request, short enough to be a name: its first line, eight words at most. */
export function firstWords(text: string, words = 8): string {
  const line = text.split('\n').find((part) => part.trim() !== '') ?? ''
  return line.trim().split(/\s+/).slice(0, words).join(' ').slice(0, 60)
}

/** The tools listed for this agent, or none when the list is missing or unreadable. */
export function readTools(path: string | undefined): ToolSpec[] {
  if (!path) return []
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (one): one is ToolSpec =>
        typeof one?.name === 'string' &&
        typeof one?.description === 'string' &&
        typeof one?.parameters === 'object',
    )
  } catch {
    return []
  }
}

/** Tools that change something: the first of these is when there is work to name. */
const CHANGES = new Set(['edit', 'write', 'multi_edit', 'bash'])

/** What people say that is not a description of any work. */
const CHATTER =
  /^(hi|hello|hey|yo|thanks|thank you|ok|okay|who are you|what are you|what can you do|how are you|help)\b[\s!?.,]*$/i

/** What people say before the part that describes the work. */
const PREAMBLE =
  /^(please\s+|can you\s+|could you\s+|would you\s+|will you\s+|i want you to\s+|i'd like you to\s+|i need you to\s+|let's\s+|lets\s+|help me\s+|go ahead and\s+)+/i

/**
 * A name from what was asked, without asking anyone: the first request that
 * describes work, its politeness taken off, in a few words.
 */
export function titleFrom(requests: readonly string[]): string | null {
  for (const request of requests) {
    // A greeting in front of a request is not part of what it asks.
    const line = firstWords(request, 14).replace(/^(hi|hello|hey|yo)\b[\s,!.]*/i, '')
    if (line === '' || CHATTER.test(line) || line.split(/\s+/).length < 2) continue
    const words = line
      .replace(PREAMBLE, '')
      .replace(/[\s,]*(please|thanks|thank you)?[?.!]*$/i, '')
      .split(/\s+/)
      .slice(0, 6)
    if (words.length === 0 || words.join('') === '') continue
    const name = words.join(' ')
    return name.charAt(0).toUpperCase() + name.slice(1)
  }
  return null
}

/**
 * A name for the work in a few words, from the model the agent runs on. One
 * short request, made once, and nothing is lost if it fails: the plain name
 * stands.
 */
async function askForName(ctx: PiContext, requests: readonly string[]): Promise<string | null> {
  const registry = ctx.modelRegistry
  if (!registry?.complete || !ctx.model || typeof ctx.model === 'string' || requests.length === 0) {
    return null
  }
  const answer = await registry.complete(
    ctx.model,
    {
      systemPrompt:
        'You name pieces of software work. Reply with a name of three to six words, in sentence case, saying what is being done — like "Fix double refund on webhook retry". No quotes, no punctuation at the end, nothing else.',
      messages: [
        {
          role: 'user',
          content: `What was asked, in order:\n${requests.map((request) => `- ${request.slice(0, 400)}`).join('\n')}`,
          timestamp: Date.now(),
        },
      ],
    },
    { signal: AbortSignal.timeout(20_000) },
  )
  const text = (answer.content ?? [])
    .map((part) => (part.type === 'text' ? (part.text ?? '') : ''))
    .join(' ')
  return cleanName(text)
}

/** A model's answer as a name: its first line, unquoted, a few words. */
export function cleanName(text: string): string | null {
  const line =
    text
      .split('\n')
      .map((part) => part.trim())
      .find((part) => part !== '') ?? ''
  const name = line
    .replace(/^["'`*_\s]+|["'`*_.\s]+$/g, '')
    .split(/\s+/)
    .slice(0, 8)
    .join(' ')
  return name.length >= 3 ? name.slice(0, 60) : null
}
