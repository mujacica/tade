import { createRequire } from 'node:module'
import { connect, type Socket } from 'node:net'
import type { EventFilter, LaneId, WilcoEvent } from '@wilco/core'
import { type AttachResult, type DaemonInfo, Method, Notification, socketPath } from './protocol.ts'
import type { LaneRecord, SpawnRequest } from './registry.ts'

const { createMessageConnection, SocketMessageReader, SocketMessageWriter } = createRequire(
  import.meta.url,
)('vscode-jsonrpc/node') as typeof import('vscode-jsonrpc/node')

type MessageConnection = ReturnType<typeof createMessageConnection>

export interface AttachHandlers {
  onData(chunk: Buffer): void
  onExit?(exit: { code: number | null; signal: number | null }): void
}

/** Typed client for the daemon socket. */
export class DaemonClient {
  private readonly connection: MessageConnection
  private readonly socket: Socket
  private readonly dataHandlers = new Map<string, AttachHandlers>()
  private readonly eventHandlers = new Map<string, (e: WilcoEvent) => void>()

  private constructor(socket: Socket, connection: MessageConnection) {
    this.socket = socket
    this.connection = connection
    connection.onNotification(
      Notification.laneData,
      ({ subscription, data }: { subscription: string; data: string }) => {
        this.dataHandlers.get(subscription)?.onData(Buffer.from(data, 'base64'))
      },
    )
    connection.onNotification(
      Notification.laneExit,
      (e: { subscription: string; code: number | null; signal: number | null }) => {
        this.dataHandlers.get(e.subscription)?.onExit?.({ code: e.code, signal: e.signal })
      },
    )
    connection.onNotification(
      Notification.event,
      ({ subscription, event }: { subscription: string; event: WilcoEvent }) => {
        this.eventHandlers.get(subscription)?.(event)
      },
    )
    connection.listen()
  }

  static async connect(path = socketPath()): Promise<DaemonClient> {
    const socket = await new Promise<Socket>((resolve, reject) => {
      const s = connect(path)
      s.once('connect', () => {
        s.removeListener('error', reject)
        resolve(s)
      })
      s.once('error', reject)
    })
    const connection = createMessageConnection(
      new SocketMessageReader(socket),
      new SocketMessageWriter(socket),
    )
    return new DaemonClient(socket, connection)
  }

  /** True when a daemon is listening. */
  static async isRunning(path = socketPath()): Promise<boolean> {
    try {
      const client = await DaemonClient.connect(path)
      await client.close()
      return true
    } catch {
      return false
    }
  }

  info(): Promise<DaemonInfo> {
    return this.connection.sendRequest(Method.info)
  }

  stop(): Promise<{ stopping: boolean }> {
    return this.connection.sendRequest(Method.stop)
  }

  spawn(req: SpawnRequest): Promise<LaneRecord> {
    return this.connection.sendRequest(Method.laneSpawn, req)
  }

  relaunch(lane: LaneId): Promise<LaneRecord> {
    return this.connection.sendRequest(Method.laneRelaunch, { lane })
  }

  lanes(task?: string): Promise<LaneRecord[]> {
    return this.connection.sendRequest(Method.laneList, task ? { task } : {})
  }

  lane(lane: LaneId): Promise<LaneRecord | null> {
    return this.connection.sendRequest(Method.laneGet, { lane })
  }

  write(lane: LaneId, data: Uint8Array | string): Promise<void> {
    const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data)
    return this.connection.sendRequest(Method.laneWrite, {
      lane,
      data: buf.toString('base64'),
    })
  }

  capture(lane: LaneId, lines = 100): Promise<string> {
    return this.connection.sendRequest(Method.laneCapture, { lane, lines })
  }

  resize(lane: LaneId, cols: number, rows: number): Promise<void> {
    return this.connection.sendRequest(Method.laneResize, { lane, cols, rows })
  }

  setTitle(lane: LaneId, title: string): Promise<void> {
    return this.connection.sendRequest(Method.laneSetTitle, { lane, title })
  }

  /** Close a lane. To close the connection itself, use `close()`. */
  closeLane(lane: LaneId): Promise<void> {
    return this.connection.sendRequest(Method.laneClose, { lane })
  }

  async attach(lane: LaneId, handlers: AttachHandlers, lines = 200): Promise<AttachResult> {
    const result: AttachResult = await this.connection.sendRequest(Method.laneAttach, {
      lane,
      lines,
    })
    this.dataHandlers.set(result.subscription, handlers)
    return result
  }

  async detach(subscription: string): Promise<void> {
    this.dataHandlers.delete(subscription)
    await this.connection.sendRequest(Method.laneDetach, { subscription })
  }

  events(filter: EventFilter = {}): Promise<WilcoEvent[]> {
    return this.connection.sendRequest(Method.eventsRead, filter)
  }

  async subscribe(handler: (e: WilcoEvent) => void, filter: EventFilter = {}): Promise<string> {
    const { subscription } = await this.connection.sendRequest<{ subscription: string }>(
      Method.eventsSubscribe,
      filter,
    )
    this.eventHandlers.set(subscription, handler)
    return subscription
  }

  async unsubscribe(subscription: string): Promise<void> {
    this.eventHandlers.delete(subscription)
    await this.connection.sendRequest(Method.eventsUnsubscribe, { subscription })
  }

  /** Close this connection. Lanes keep running: the daemon owns them. */
  async close(): Promise<void> {
    this.connection.dispose()
    await new Promise<void>((resolve) => {
      // Wait for 'close', not for end()'s callback: disposing the connection
      // may already have ended the stream, and then end() never calls back.
      if (this.socket.destroyed) {
        resolve()
        return
      }
      this.socket.once('close', () => resolve())
      this.socket.destroy()
    })
  }
}
