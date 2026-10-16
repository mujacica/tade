import { connect, type Socket } from 'node:net'
import { WorkerCommand, type WorkerSignal } from '@tade/harnesses-core'

// The lane's end of its supervision socket: signals up, commands down, one
// JSON object per line — the same channel pi's extension speaks.
//
// Tade may not be there: a window that closed under a driver whose lanes
// outlive it is an ordinary afternoon. So this dials again every few seconds
// until it is, says nothing while it is not, and says where the agent is the
// moment it is back (`onConnect`), because a window that opens while it works
// would otherwise take it for idle, or idle for working.

const RETRY_MS = 2_000

export interface LinkOptions {
  path: string
  onCommand: (command: WorkerCommand) => void
  /** Connected, again or for the first time: say what is true now. */
  onConnect: () => void
  /** Gone: whatever was waiting on Tade has to be answered without it. */
  onDisconnect: () => void
}

export class Link {
  private socket: Socket | null = null
  private live = false
  private stopped = false
  private buffer = ''

  private readonly opts: LinkOptions

  constructor(opts: LinkOptions) {
    this.opts = opts
    this.dial()
  }

  get connected(): boolean {
    return this.live
  }

  send(signal: WorkerSignal | Record<string, unknown>): void {
    if (this.live) this.socket?.write(`${JSON.stringify(signal)}\n`)
  }

  close(): void {
    this.stopped = true
    this.socket?.destroy()
  }

  private dial(): void {
    if (this.stopped) return
    const socket = connect(this.opts.path)
    this.socket = socket
    socket.on('connect', () => {
      this.live = true
      this.buffer = ''
      this.opts.onConnect()
    })
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8')
      let end = this.buffer.indexOf('\n')
      while (end >= 0) {
        this.receive(this.buffer.slice(0, end))
        this.buffer = this.buffer.slice(end + 1)
        end = this.buffer.indexOf('\n')
      }
    })
    // `error` then `close` on a failed dial: answered once, or every failed
    // dial schedules two more (pi learned this one the hard way).
    const drop = () => {
      if (this.socket !== socket) return
      this.socket = null
      const was = this.live
      this.live = false
      if (was) this.opts.onDisconnect()
      if (this.stopped) return
      const timer = setTimeout(() => this.dial(), RETRY_MS)
      timer.unref?.()
    }
    socket.on('close', drop)
    socket.on('error', drop)
    socket.unref()
  }

  private receive(line: string): void {
    if (!line.trim()) return
    try {
      const parsed = WorkerCommand.safeParse(JSON.parse(line))
      if (parsed.success) this.opts.onCommand(parsed.data)
    } catch {
      // A line that is not a command is no command.
    }
  }
}
