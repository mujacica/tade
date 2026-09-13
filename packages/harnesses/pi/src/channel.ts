import { mkdir, rm } from 'node:fs/promises'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname } from 'node:path'
import {
  type RunId,
  type WorkerCommand,
  WorkerSignal,
  type WorkerSignalListener,
} from '@wilco/harnesses-core'

// The Wilco side of the supervision channel: one Unix socket per run, strict
// LF-delimited JSONL. The agent's extension connects to it, streams signals
// up, and waits on commands coming down.

export interface SignalChannelOptions {
  path: string
  run: RunId
  onSignal: WorkerSignalListener
  /** Malformed or unknown lines: reported, never thrown. */
  onWarning?: (message: string) => void
}

export class SignalChannel {
  readonly path: string
  private readonly run: RunId
  private readonly onSignal: WorkerSignalListener
  private readonly onWarning: (message: string) => void
  private readonly server: Server
  private readonly clients = new Set<Socket>()

  private constructor(opts: SignalChannelOptions, server: Server) {
    this.path = opts.path
    this.run = opts.run
    this.onSignal = opts.onSignal
    this.onWarning = opts.onWarning ?? (() => {})
    this.server = server
  }

  static async listen(opts: SignalChannelOptions): Promise<SignalChannel> {
    if (Buffer.byteLength(opts.path) > 100) {
      throw new Error(`supervision socket path is too long: ${opts.path}`)
    }
    await mkdir(dirname(opts.path), { recursive: true, mode: 0o700 })
    await rm(opts.path, { force: true })
    const server = createServer()
    const channel = new SignalChannel(opts, server)
    server.on('connection', (socket) => channel.accept(socket))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.path, () => {
        server.removeListener('error', reject)
        resolve()
      })
    })
    return channel
  }

  /** True once the supervised agent has connected. */
  get connected(): boolean {
    return this.clients.size > 0
  }

  send(command: WorkerCommand): void {
    const line = `${JSON.stringify(command)}\n`
    for (const client of this.clients) client.write(line)
  }

  async close(): Promise<void> {
    for (const client of this.clients) client.destroy()
    this.clients.clear()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    await rm(this.path, { force: true })
  }

  private accept(socket: Socket): void {
    this.clients.add(socket)
    let buffer = ''
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        this.receive(buffer.slice(0, index).replace(/\r$/, ''))
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
      }
    })
    const drop = () => {
      this.clients.delete(socket)
      socket.destroy()
    }
    socket.on('close', drop)
    socket.on('error', drop)
  }

  private receive(line: string): void {
    if (!line.trim()) return
    let raw: unknown
    try {
      raw = JSON.parse(line)
    } catch {
      this.onWarning(`${this.run}: unparseable line from agent`)
      return
    }
    const parsed = WorkerSignal.safeParse(raw)
    if (!parsed.success) {
      this.onWarning(`${this.run}: unrecognised signal: ${parsed.error.issues[0]?.message}`)
      return
    }
    try {
      this.onSignal(parsed.data)
    } catch {
      // A broken listener must never take down the channel.
    }
  }
}
