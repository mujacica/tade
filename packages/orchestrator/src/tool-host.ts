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
  /** A terminal was opened or used, so the window can put it in front of you. */
  onTerminal?: (terminal: string) => void
  /**
   * Finds the model the orchestrator was asked to think with and keeps it for
   * the next start. Without it, the orchestrator cannot change its own model.
   */
  orchestratorModel?: (said: string) => Promise<{ provider: string; id: string }>
  /** Runs the orchestrator's extension tools. Without it, it has none. */
  extensions?: (call: {
    tool: string
    input: Record<string, unknown>
    callId: string
  }) => Promise<string>
}

type Handler = (params: Record<string, unknown>) => unknown | Promise<unknown>

/** Which terminal a call names, as said: an id, a name, a number, or nothing when there is one. */
const said = (p: Record<string, unknown>): string => (p.terminal ? String(p.terminal) : '')
const project = (p: Record<string, unknown>): string | undefined =>
  p.project ? String(p.project) : undefined

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
          ...(p.context ? { context: String(p.context) } : {}),
          ...(Array.isArray(p.links) ? { links: linksOf(p.links) } : {}),
        }),
      'extension/call': async (p) => {
        if (!opts.extensions) throw new Error('Wilco has no extensions loaded')
        return opts.extensions({
          tool: String(p.tool),
          input: (p.input ?? {}) as Record<string, unknown>,
          callId: String(p.callId ?? ''),
        })
      },
      'task/park': (p) => wilco.parkTask(String(p.worktree), p.parked === true),
      'task/rename': (p) =>
        wilco.renameAgent({
          task: String(p.task),
          worktree: String(p.worktree),
          title: String(p.title),
        }),
      'worker/model': (p) => wilco.setAgentModel(String(p.task), String(p.model)),
      'orchestrator/model': (p) => {
        if (!opts.orchestratorModel)
          throw new Error('this window cannot change the orchestrator model')
        return opts.orchestratorModel(String(p.model))
      },
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
      'terminal/list': (p) => wilco.terminals(p.project ? String(p.project) : undefined),
      'terminal/open': async (p) => {
        const opened = await wilco.openTerminal({
          project: String(p.project),
          ...(p.name ? { name: String(p.name) } : {}),
          ...(p.cwd ? { cwd: String(p.cwd) } : {}),
        })
        opts.onTerminal?.(opened.id)
        return opened
      },
      'terminal/close': (p) => wilco.closeTerminal(said(p), project(p)),
      'terminal/rename': (p) => wilco.renameTerminal(said(p), String(p.name), project(p)),
      'terminal/run': async (p) => {
        const ran = await wilco.runInTerminal(said(p), String(p.command), {
          submit: p.submit !== false,
          ...(project(p) ? { project: project(p) } : {}),
        })
        opts.onTerminal?.(ran.id)
        return ran
      },
      'terminal/read': (p) =>
        wilco.readTerminal(said(p), Number(p.lines) > 0 ? Number(p.lines) : 200, project(p)),
      'terminal/search': (p) => wilco.searchTerminal(said(p), String(p.text), project(p)),
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

/** Links as a model sent them: only the ones with somewhere to go. */
function linksOf(value: unknown[]): { title: string; url: string }[] {
  return value.flatMap((one) => {
    const link = one as { title?: unknown; url?: unknown }
    return typeof link?.url === 'string' && link.url !== ''
      ? [{ title: typeof link.title === 'string' ? link.title : link.url, url: link.url }]
      : []
  })
}
