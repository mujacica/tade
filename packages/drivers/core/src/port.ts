import type { LaneId, Unsubscribe } from '@wilco/core'

// The WorkspaceDriver port: what decides where a process physically lives.
// It is deliberately NOT the thing that decides where you look at it.
//
// Vocabulary rule: no method here may use one implementation's words. It is
// `write(lane, bytes)`, never `sendKeys`. If a name only makes sense for one
// backend, it is the wrong name.

export interface LaneSpec {
  id: LaneId
  cwd: string
  command: string
  args: string[]
  env?: Record<string, string>
  cols?: number
  rows?: number
  title?: string
}

export interface LaneHandle {
  id: LaneId
  /** Everything needed to launch this lane again after a restart. */
  spec: LaneSpec
  pid: number | null
  startedAt: number
  title: string
  cols: number
  rows: number
  alive: boolean
  exitCode: number | null
  /** Wall-clock ms of the last byte the lane produced. */
  lastOutputAt: number | null
}

/**
 * What a driver can do. Call sites branch on these, never on `driver.id`.
 */
export interface WorkspaceCapabilities {
  /** Lanes survive the client disconnecting. */
  detach: boolean
  /** Lanes are reachable over SSH. */
  remoteAttach: boolean
  /** Tabs are the terminal emulator's own. */
  nativeTabs: boolean
  /** Can raise a specific lane on screen. */
  focus: boolean
  setTitle: boolean
  /** Can discover lanes it did not create. */
  adopt: boolean
}

export interface AdoptHint {
  /** Only adopt lanes whose working directory is at or below this path. */
  cwd?: string
  /** Only adopt lanes whose title matches. */
  titlePattern?: string
}

export interface CaptureOptions {
  /** How many lines back from the bottom of the screen to return. */
  lines: number
}

export type LaneOutputListener = (chunk: Uint8Array) => void
export type LaneExitListener = (exit: { code: number | null; signal: number | null }) => void

export interface WorkspaceDriver {
  readonly id: string
  readonly capabilities: WorkspaceCapabilities

  open(spec: LaneSpec): Promise<LaneHandle>
  write(lane: LaneId, data: Uint8Array): Promise<void>
  /** A rendered snapshot of the screen, not a soup of escape sequences. */
  capture(lane: LaneId, opts: CaptureOptions): Promise<string>
  resize(lane: LaneId, cols: number, rows: number): Promise<void>
  focus(lane: LaneId): Promise<void>
  setTitle(lane: LaneId, title: string): Promise<void>
  /** A string a human can run to see this lane. Always available. */
  attachCommand(lane: LaneId): string
  list(): Promise<LaneHandle[]>
  get(lane: LaneId): Promise<LaneHandle | null>
  adopt(hint: AdoptHint): Promise<LaneHandle[]>
  close(lane: LaneId): Promise<void>

  /** Live output. Replays the buffered scrollback first when `replay` is set. */
  onOutput(lane: LaneId, listener: LaneOutputListener, opts?: { replay?: boolean }): Unsubscribe
  onExit(lane: LaneId, listener: LaneExitListener): Unsubscribe
  /** Release every lane and resource. Lanes may or may not survive, per `capabilities.detach`. */
  shutdown(): Promise<void>
}

export class LaneNotFoundError extends Error {
  readonly code = 'LANE_NOT_FOUND'
  constructor(lane: string) {
    super(`no such lane: ${lane}`)
    this.name = 'LaneNotFoundError'
  }
}

export class LaneClosedError extends Error {
  readonly code = 'LANE_CLOSED'
  constructor(lane: string) {
    super(`lane is closed: ${lane}`)
    this.name = 'LaneClosedError'
  }
}

export class UnsupportedCapabilityError extends Error {
  readonly code = 'UNSUPPORTED_CAPABILITY'
  constructor(driver: string, capability: keyof WorkspaceCapabilities) {
    super(`driver ${driver} cannot ${capability}`)
    this.name = 'UnsupportedCapabilityError'
  }
}
