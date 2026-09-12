import { connect, type Socket } from 'node:net'

// The Wilco supervision extension for pi.
//
// pi loads this file directly, so it is deliberately SELF-CONTAINED: no
// imports from the Wilco workspace, because the extension runs inside pi's
// module resolution, not ours. It speaks the same JSONL shapes as
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
}
interface PiApi {
  on(event: string, handler: (event: never, ctx: PiContext) => unknown): void
  sendUserMessage?(
    content: string,
    options?: { deliverAs?: 'steer' | 'followUp' },
  ): Promise<void> | void
}

type Json = Record<string, unknown>

const SOCKET = process.env.WILCO_RUN_SOCKET
const RUN = process.env.WILCO_RUN_ID ?? 'unknown'

export default function wilcoExtension(pi: PiApi): void {
  if (!SOCKET) return

  const pending = new Map<string, (result: ToolCallResult) => void>()
  let socket: Socket | null = null
  let connected = false
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
      case 'abort':
        latest?.abort()
        return
      case 'shutdown':
        latest?.shutdown()
        return
    }
  }

  socket = connect(SOCKET)
  socket.on('connect', () => {
    connected = true
    send({ type: 'started', sessionId: null, model: null })
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
  const drop = () => {
    connected = false
    // Supervisor gone mid-flight: refuse rather than run unsupervised.
    failPending('Wilco is not reachable')
  }
  socket.on('close', drop)
  socket.on('error', drop)
  socket.unref()

  const remember = (_event: unknown, ctx: PiContext) => {
    latest = ctx
  }
  for (const event of ['agent_start', 'turn_start', 'message_end', 'tool_execution_start']) {
    pi.on(event, remember as never)
  }

  pi.on('turn_start', ((_event: unknown, ctx: PiContext) => {
    latest = ctx
    send({ type: 'turn_started' })
  }) as never)

  pi.on('turn_end', ((_event: unknown, ctx: PiContext) => {
    latest = ctx
    send({ type: 'turn_done', status: 'ok' })
    const usage = ctx.getContextUsage?.()
    if (usage) send({ type: 'context', tokens: usage.tokens, percent: usage.percent })
  }) as never)

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

  // The gate. Every tool call is held here until Wilco answers, so policy
  // lives in exactly one place instead of being re-implemented per agent.
  pi.on('tool_call', (async (event: ToolCallEvent, ctx: PiContext): Promise<ToolCallResult> => {
    latest = ctx
    send({ type: 'tool_call', callId: event.toolCallId, tool: event.toolName, input: event.input })
    if (!connected) return {}
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
