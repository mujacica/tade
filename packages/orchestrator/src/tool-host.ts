import { chmod, mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import type { LaneId } from '@wilco/core'
import type { PermissionDecision, RunId } from '@wilco/harnesses-core'
import type { Workbench } from '@wilco/workbench'

// How the orchestrator's tools reach the workbench.
//
// The orchestrator is pi, and its tools run inside pi, which is a separate
// process — so `wilco_run_start` has to come back out to whoever is holding
// the lanes and the journal. This is that way back: one socket, hosted by the
// window that owns the workbench, for its own children only.
//
// It is not a daemon and must never grow into one. Nothing discovers it (the
// path is handed to the child in its environment), nothing outside this
// process tree may connect, and it dies with the window. The test is simple:
// if something that is not our own child would ever want to call it, it has
// stopped being a channel and become a service.

export interface ToolHostOptions {
  wilco: Workbench
  /** Where the socket goes. One per host, so two windows never collide. */
  path: string
}

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

export class ToolHost {
  readonly path: string
  private readonly server: Server
  private readonly sockets = new Set<Socket>()
  private readonly methods: Record<string, Handler>

  private constructor(path: string, server: Server, methods: Record<string, Handler>) {
    this.path = path
    this.server = server
    this.methods = methods
  }

  static async listen(opts: ToolHostOptions): Promise<ToolHost> {
    const { wilco } = opts
    const methods: Record<string, Handler> = {
      'task/create': (p) =>
        wilco.createTask({
          project: String(p.project),
          slug: String(p.slug),
          intent: String(p.intent),
          ...(p.root ? { root: String(p.root) } : {}),
          ...(p.base ? { base: String(p.base) } : {}),
        }),
      'task/park': (p) => wilco.parkTask(String(p.worktree), p.parked === true),
      'worker/start': (p) =>
        wilco.startAgent({
          task: String(p.task) as never,
          cwd: String(p.cwd),
          prompt: String(p.prompt),
        }),
      'worker/list': () => wilco.runs(),
      'worker/pending': (p) => wilco.pendingApprovals(p.task ? String(p.task) : undefined),
      'worker/steer': async (p) => {
        await wilco.steerAgent(String(p.task), String(p.message))
        return { ok: true }
      },
      'worker/stop': async (p) => {
        await wilco.stopAgent(String(p.task))
        return { ok: true }
      },
      'worker/decide': async (p) => {
        await wilco.decideApproval(
          String(p.run) as RunId,
          String(p.requestId),
          p.decision as PermissionDecision,
        )
        return { ok: true }
      },
      'memory/remember': (p) =>
        wilco.remember(
          String(p.text),
          p.scope === null || p.scope === undefined ? null : String(p.scope),
          p.by ? String(p.by) : 'wilco',
        ),
      'events/read': (p) => wilco.events(p as never),
      'lane/write': async (p) => {
        await wilco.write(String(p.lane) as LaneId, String(p.data))
        return { ok: true }
      },
    }

    await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 })
    await rm(opts.path, { force: true })
    const server = createServer()
    const host = new ToolHost(opts.path, server, methods)
    server.on('connection', (socket) => host.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    // Only this user, and only ever this user's own agents.
    await chmod(opts.path, 0o600)
    return host
  }

  private accept(socket: Socket): void {
    this.sockets.add(socket)
    let buffer = Buffer.alloc(0)
    socket.on('close', () => this.sockets.delete(socket))
    socket.on('error', () => socket.destroy())
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      for (;;) {
        const split = buffer.indexOf('\r\n\r\n')
        if (split < 0) return
        const header = buffer.subarray(0, split).toString('utf8')
        const length = Number(/content-length:\s*(\d+)/i.exec(header)?.[1] ?? 0)
        const start = split + 4
        if (buffer.byteLength < start + length) return
        const body = buffer.subarray(start, start + length).toString('utf8')
        buffer = buffer.subarray(start + length)
        void this.dispatch(socket, body)
      }
    })
  }

  private async dispatch(socket: Socket, body: string): Promise<void> {
    let id: unknown = null
    try {
      const message = JSON.parse(body) as {
        id?: unknown
        method?: string
        params?: Record<string, unknown>
      }
      id = message.id ?? null
      const handler = this.methods[message.method ?? '']
      if (!handler) throw new Error(`no such method: ${message.method}`)
      reply(socket, { jsonrpc: '2.0', id, result: (await handler(message.params ?? {})) ?? null })
    } catch (err) {
      // A tool that fails must say why in words the model can act on, not
      // drop the connection and leave it guessing.
      reply(socket, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    this.sockets.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await rm(this.path, { force: true })
  }
}

function reply(socket: Socket, message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  socket.write(`Content-Length: ${body.byteLength}\r\n\r\n`)
  socket.write(body)
}
