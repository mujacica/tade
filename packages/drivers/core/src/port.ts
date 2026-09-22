import type { LaneId, RequiredProgram, Unsubscribe } from '@tade/core'
import type { LanePointing, PointerReport } from './pointer.ts'

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
  /**
   * Can hand a lane what the pointer did, for a program that asked for it.
   *
   * A program that takes the whole screen keeps no scrollback for anybody
   * else to move, and the ones that do it ask for the mouse so they can
   * answer the wheel themselves. Without this, such a lane cannot be
   * scrolled at all and has to say so.
   */
  pointer: boolean
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
  /**
   * Keep colour and emphasis, as SGR sequences, so a window can draw the lane
   * the way it looks. Still the rendered screen — no cursor movement, no
   * clears — only the paint on it. Plain text when absent.
   */
  styled?: boolean
}

/**
 * Who moves what a lane shows, which is the program in it to decide and
 * nobody else's to guess.
 *
 * - `window`: it prints and the lane keeps what it printed, so the wheel
 *   moves the lines a window holds. Every shell, and every agent that prints
 *   its conversation.
 * - `lane`: it took the whole screen for itself and asked for the mouse.
 *   There is no scrollback to move — what scrolled off was never kept — and
 *   the wheel is its own to answer, so it is handed one.
 * - `nobody`: it took the screen and did not ask for the mouse. Nothing can
 *   scroll it, and saying that is worth more than a wheel that does nothing.
 */
export type LaneScrolling = 'window' | 'lane' | 'nobody'

/**
 * What a lane's screen is like around the text `capture` returns: how far back
 * it can be read, where what you type lands, and whose the scrolling is.
 * None can be read out of the text itself, and they are what a window needs to
 * draw a scrollbar that says where you are, a cursor that says where you are
 * typing, and a wheel that moves what the person meant to move.
 */
export interface LaneScreen {
  /** Lines the screen and everything kept above it hold together: the most `capture` can return. */
  lines: number
  /**
   * Where what you type appears: the column, and how many lines above the last
   * line `capture` returns it sits — 0 on that line. Negative where the cursor
   * is below it, on the empty rows a capture leaves out, which is where a
   * program that has just printed a line leaves it.
   */
  cursor: { back: number; column: number }
  /** Whose the scrolling is, as the program in the lane has left it. */
  scrolling: LaneScrolling
  /**
   * How much of the pointer the program in the lane has asked for.
   *
   * Apart from `scrolling`, because they are two questions and one lane can
   * answer them differently: a program that prints its conversation keeps
   * every line it printed — so the scrolling is the window's — and may still
   * want the click that opens one of them. Read off the lane, never off what
   * was launched into it.
   */
  pointing: LanePointing
}

/**
 * A turn of the wheel over a lane: how far, and where the pointer was.
 *
 * `rows` is signed — negative is up, towards what was printed earlier — and
 * counted in rows rather than detents, so a lane scrolling itself moves as far
 * as a lane the window scrolls. `column` and `row` are zero-based cells of the
 * lane's own screen, because a program with more than one region in it answers
 * the wheel differently depending on which one the pointer is over.
 */
export interface WheelTurn {
  rows: number
  column: number
  row: number
}

export type LaneOutputListener = (chunk: Uint8Array) => void
export type LaneExitListener = (exit: { code: number | null; signal: number | null }) => void

/** Whether this machine can actually provide something, and why not. */
export type Availability = { ok: true } | { ok: false; reason: string }

export interface WorkspaceDriver {
  readonly id: string
  readonly capabilities: WorkspaceCapabilities
  /**
   * The programs this driver needs on the machine, and how to ask each its
   * version. Declared, never sniffed: whoever wants to know whether tmux is
   * here and current asks the driver, and a driver that needs nothing of the
   * machine says nothing.
   */
  readonly programs?: readonly RequiredProgram[]

  /**
   * Whether this machine can run lanes here at all — `tmux` asked for on a
   * machine with no tmux. Asked before anything is opened, so a driver that
   * cannot be provided is a sentence you can act on rather than a failed spawn
   * much later with no explanation attached.
   */
  available(): Promise<Availability>
  open(spec: LaneSpec): Promise<LaneHandle>
  write(lane: LaneId, data: Uint8Array): Promise<void>
  /** A rendered snapshot of the screen, not a soup of escape sequences. */
  capture(lane: LaneId, opts: CaptureOptions): Promise<string>
  /** How far back that snapshot can go, where typing appears in it, and whose the scrolling is. */
  screen(lane: LaneId): Promise<LaneScreen>
  /**
   * Turn the wheel over a lane, for a program that asked for the mouse.
   *
   * Only ever what the program asked for: one that never asked is sent
   * nothing, because bytes it cannot read are bytes typed into it. Throws
   * `UnsupportedCapabilityError` where `capabilities.pointer` is false.
   */
  wheel(lane: LaneId, turn: WheelTurn): Promise<void>
  /**
   * Tell a lane what the pointer did — pressed, moved with a button held,
   * let go — for a program that asked for it.
   *
   * Only ever as much as it asked for: one that never asked is sent nothing,
   * and one that asked only about presses is sent no movement, because bytes
   * it cannot read as a pointer it reads as somebody typing. Throws
   * `UnsupportedCapabilityError` where `capabilities.pointer` is false.
   */
  point(lane: LaneId, report: PointerReport): Promise<void>
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
  /**
   * Let go of every lane without ending it: stop watching, release resources,
   * leave what is running running. This is Tade closing, which is the
   * ordinary way a session ends and must never be what stops your agents.
   *
   * Whether they actually survive is `capabilities.detach`. Where they cannot
   * — lanes that are this process's own children — this is still the right
   * call; it simply has nothing left to promise.
   */
  detach(): Promise<void>
  /**
   * End every lane and release everything. This is "stop the work", not
   * "close the window", and it applies regardless of `capabilities.detach`.
   */
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
