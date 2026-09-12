import { join } from 'node:path'
import { wilcoHome } from '@wilco/core'

// The daemon's wire protocol: JSON-RPC 2.0 over a Unix socket. Same wire
// format as the agent protocol, so there is one mental model for both.

export const SOCKET_NAME = 'wilco.sock'

export function socketPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WILCO_SOCKET) return env.WILCO_SOCKET
  const runtime = env.XDG_RUNTIME_DIR
  return runtime ? join(runtime, SOCKET_NAME) : join(wilcoHome(env), 'run', SOCKET_NAME)
}

/** Requests. */
export const Method = {
  info: 'daemon/info',
  stop: 'daemon/stop',
  laneSpawn: 'lane/spawn',
  laneRelaunch: 'lane/relaunch',
  laneList: 'lane/list',
  laneGet: 'lane/get',
  laneWrite: 'lane/write',
  laneCapture: 'lane/capture',
  laneResize: 'lane/resize',
  laneSetTitle: 'lane/setTitle',
  laneClose: 'lane/close',
  laneAttach: 'lane/attach',
  laneDetach: 'lane/detach',
  eventsRead: 'events/read',
  eventsSubscribe: 'events/subscribe',
  eventsUnsubscribe: 'events/unsubscribe',
} as const

/** Notifications the daemon sends to a connection. */
export const Notification = {
  /** Output from an attached lane: `{ subscription, data }` (base64). */
  laneData: 'lane/data',
  /** An attached lane exited: `{ subscription, code, signal }`. */
  laneExit: 'lane/exit',
  /** A logged event for a subscriber: `{ subscription, event }`. */
  event: 'event',
} as const

export interface DaemonInfo {
  pid: number
  version: string
  driver: string
  capabilities: Record<string, boolean>
  socket: string
  home: string
  startedAt: number
  lanes: number
}

export interface AttachResult {
  subscription: string
  /** Rendered screen state at the moment of attaching. */
  snapshot: string
  cols: number
  rows: number
}
