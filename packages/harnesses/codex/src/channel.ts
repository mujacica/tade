import { mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'

// The Tade side of a Codex agent's supervision socket.
//
// Nothing of ours lives inside Codex to hold a connection open: each hook is a
// process of its own that runs, says what happened, waits for an answer when
// it has to, and exits. So this is request and reply — one JSON line each way
// per connection — and a request that waits (a tool call held for a person)
// holds only its own connection.

/** What an agent's side sends: a hook that ran, a task it says is finished, or a tool call. */
export type ChannelRequest =
  | { kind: 'hook'; event: Record<string, unknown> }
  | { kind: 'done'; summary: string }
  | { kind: 'call'; callId: string; tool: string; input: Record<string, unknown> }

export type ChannelHandler = (request: ChannelRequest) => Promise<unknown>

export interface CodexChannelOptions {
  path: string
  onRequest: ChannelHandler
  /** Malformed requests: reported, never thrown. */
  onWarning?: (message: string) => void
}

export class CodexChannel {
  readonly path: string
  private readonly server: Server
  private readonly sockets = new Set<Socket>()

  private constructor(path: string, server: Server) {
    this.path = path
    this.server = server
  }

  static async listen(opts: CodexChannelOptions): Promise<CodexChannel> {
    if (Buffer.byteLength(opts.path) > 100) {
      throw new Error(`supervision socket path is too long: ${opts.path}`)
    }
    await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 })
    await rm(opts.path, { force: true })
    const server = createServer()
    const channel = new CodexChannel(opts.path, server)
    const warn = opts.onWarning ?? (() => {})
    server.on('connection', (socket) => {
      channel.sockets.add(socket)
      let buffer = ''
      let answered = false
      socket.on('data', (chunk: Buffer) => {
        buffer += chunk.toString('utf8')
        const end = buffer.indexOf('\n')
        if (end < 0 || answered) return
        answered = true
        const request = parse(buffer.slice(0, end))
        if (!request) {
          warn('an unreadable request from a Codex agent')
          socket.end('{}\n')
          return
        }
        opts
          .onRequest(request)
          .catch((err: unknown) => {
            warn(`answering a Codex agent failed: ${(err as Error).message}`)
            return {}
          })
          .then((reply) => {
            if (!socket.destroyed) socket.end(`${JSON.stringify(reply ?? {})}\n`)
          })
      })
      const drop = () => {
        channel.sockets.delete(socket)
        socket.destroy()
      }
      socket.on('close', drop)
      socket.on('error', drop)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return channel
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await rm(this.path, { force: true })
  }
}

function parse(line: string): ChannelRequest | null {
  let raw: unknown
  try {
    raw = JSON.parse(line)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const kind = (raw as { kind?: unknown }).kind
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  switch (kind) {
    case 'hook': {
      const event = record((raw as { event?: unknown }).event)
      return event ? { kind, event } : null
    }
    case 'done':
      return { kind, summary: String((raw as { summary?: unknown }).summary ?? '') }
    case 'call': {
      const { callId, tool, input } = raw as { callId?: unknown; tool?: unknown; input?: unknown }
      if (typeof callId !== 'string' || typeof tool !== 'string') return null
      return { kind, callId, tool, input: record(input) ?? {} }
    }
    default:
      return null
  }
}
