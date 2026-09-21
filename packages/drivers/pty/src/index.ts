import { createRequire } from 'node:module'
import { type LaneId, resolveCommand, stringEnv, type Unsubscribe } from '@tade/core'
import {
  type AdoptHint,
  type Availability,
  type CaptureOptions,
  LaneClosedError,
  type LaneExitListener,
  type LaneHandle,
  LaneNotFoundError,
  type LaneOutputListener,
  type LaneScreen,
  type LaneScrolling,
  type LaneSpec,
  UnsupportedCapabilityError,
  type WheelEncoding,
  type WheelTurn,
  type WorkspaceCapabilities,
  type WorkspaceDriver,
  wheelBytes,
} from '@tade/drivers-core'
import { type IPty, spawn } from 'node-pty'

// @xterm/headless is CommonJS with no ESM named exports.
const { Terminal } = createRequire(import.meta.url)(
  '@xterm/headless',
) as typeof import('@xterm/headless')

type XTerm = InstanceType<typeof Terminal>

// The default driver: Tade owns the PTYs and your terminal is just a
// viewer. Imposes nothing on the user's terminal setup.
//
// A headless xterm keeps a real screen buffer per lane, so `capture()` returns
// rendered state instead of a soup of escape sequences.

export interface PtyDriverOptions {
  /** Lines of scrollback kept per lane. */
  scrollback?: number
  /** Bytes of raw output kept for replaying to a new subscriber. */
  replayBytes?: number
  /** How a human is told to view a lane. */
  attachCommand?: (lane: LaneId) => string
  env?: NodeJS.ProcessEnv
}

interface Lane {
  handle: LaneHandle
  pty: IPty
  term: XTerm
  outputs: Set<LaneOutputListener>
  exits: Set<LaneExitListener>
  replay: Buffer[]
  replayBytes: number
  closed: boolean
  /**
   * How the program in it asked to be told about the pointer.
   *
   * The emulator says whether it asked at all (`mouseTrackingMode`) but not
   * in which of the two encodings it wants the answer, so that one mode is
   * read off the stream on its way past. Reading it here rather than through
   * the emulator's insides is the difference between a fact and a guess that
   * survives until the emulator is upgraded.
   */
  encoding: WheelEncoding
  /**
   * The tail of the last chunk, so a sequence cut in half by where the read
   * happened to end is still read. Missing one is not a scroll that goes
   * nowhere: it is a report in the wrong encoding, which is characters typed
   * into the program.
   */
  tail: string
}

const DEFAULTS = {
  scrollback: 10_000,
  replayBytes: 256 * 1024,
  cols: 120,
  rows: 40,
}

export class PtyDriver implements WorkspaceDriver {
  readonly id = 'pty'
  readonly capabilities: WorkspaceCapabilities = {
    // Lanes are Tade's own children: close Tade and they go with it. That
    // is the whole trade this driver makes — nothing to install, nothing left
    // running. Use tmux when the agents should outlive the window.
    detach: false,
    // Nothing here is reachable from another machine; a lane exists only
    // inside the process that opened it.
    remoteAttach: false,
    nativeTabs: false,
    focus: false,
    setTitle: true,
    adopt: false,
    // Lanes are real terminals of our own, so a program in one can be told
    // what the pointer did exactly as the terminal it thinks it is in would.
    pointer: true,
  }

  private readonly lanes = new Map<string, Lane>()
  private readonly opts: Required<Omit<PtyDriverOptions, 'env'>> & { env: NodeJS.ProcessEnv }

  constructor(opts: PtyDriverOptions = {}) {
    this.opts = {
      scrollback: opts.scrollback ?? DEFAULTS.scrollback,
      replayBytes: opts.replayBytes ?? DEFAULTS.replayBytes,
      attachCommand: opts.attachCommand ?? ((lane) => `tade attach ${lane}`),
      env: opts.env ?? process.env,
    }
  }

  /** Node and a pseudo-terminal, which is to say: always. */
  async available(): Promise<Availability> {
    return { ok: true }
  }

  async open(spec: LaneSpec): Promise<LaneHandle> {
    // An id is taken while something runs under it, and free again once that
    // ended or was closed: an agent started again is the same lane.
    const previous = this.lanes.get(spec.id)
    if (previous?.handle.alive && !previous.closed) {
      throw new Error(`lane already exists: ${spec.id}`)
    }
    // node-pty hands the environment straight to posix_spawnp, which fails on
    // any non-string value (test runners inject them).
    const env = stringEnv({ ...this.opts.env, ...spec.env })
    // Resolve up front: node-pty reports a failed exec as a child that exits
    // moments later, which would leave a phantom lane behind.
    const command = resolveCommand(spec.command, env)
    if (!command) throw new Error(`command not found: ${spec.command}`)

    const cols = spec.cols ?? DEFAULTS.cols
    const rows = spec.rows ?? DEFAULTS.rows
    const pty = spawn(command, spec.args, {
      name: env.TERM ?? 'xterm-256color',
      cwd: spec.cwd,
      cols,
      rows,
      env,
    })
    const term = new Terminal({
      cols,
      rows,
      scrollback: this.opts.scrollback,
      allowProposedApi: true,
    })
    const lane: Lane = {
      handle: {
        id: spec.id,
        spec: { ...spec, cols, rows },
        pid: pty.pid,
        startedAt: Date.now(),
        title: spec.title ?? spec.id,
        cols,
        rows,
        alive: true,
        exitCode: null,
        lastOutputAt: null,
      },
      pty,
      term,
      outputs: new Set(),
      exits: new Set(),
      replay: [],
      replayBytes: 0,
      closed: false,
      encoding: 'legacy',
      tail: '',
    }
    // Only once the new one is running: a launch that fails leaves the old
    // screen where it was, to be read.
    if (previous && !previous.closed) {
      previous.closed = true
      previous.term.dispose()
      previous.outputs.clear()
      previous.exits.clear()
    }
    this.lanes.set(spec.id, lane)

    pty.onData((data) => {
      const buf = Buffer.from(data, 'utf8')
      lane.handle.lastOutputAt = Date.now()
      lane.encoding = encodingAfter(lane.tail + data, lane.encoding)
      lane.tail = data.slice(-TAIL)
      term.write(data)
      lane.replay.push(buf)
      lane.replayBytes += buf.byteLength
      while (lane.replayBytes > this.opts.replayBytes && lane.replay.length > 1) {
        lane.replayBytes -= lane.replay.shift()!.byteLength
      }
      for (const listener of lane.outputs) safely(() => listener(buf))
    })
    pty.onExit(({ exitCode, signal }) => {
      lane.handle.alive = false
      lane.handle.exitCode = exitCode
      const event = { code: exitCode, signal: signal ?? null }
      for (const listener of lane.exits) safely(() => listener(event))
    })
    return { ...lane.handle }
  }

  async write(id: LaneId, data: Uint8Array): Promise<void> {
    const lane = this.live(id)
    lane.pty.write(Buffer.from(data).toString('utf8'))
  }

  async capture(id: LaneId, opts: CaptureOptions): Promise<string> {
    const lane = this.live(id)
    await settled(lane.term)
    if (lane.closed) throw new LaneClosedError(id)
    const buffer = lane.term.buffer.active
    // From the bottom up: past the blank rows under the last thing written,
    // then only the rows asked for. Above them can be ten thousand lines of
    // scrollback, and painting every one of them to keep the last forty was
    // most of what echoing a keystroke cost.
    const last = lastWritten(buffer, lane.term.rows)
    const rows: string[] = []
    for (let i = Math.max(0, last - opts.lines + 1); i <= last; i++) {
      const row = buffer.getLine(i)
      rows.push(
        row ? (opts.styled ? styledLine(row, lane.term.cols) : row.translateToString(true)) : '',
      )
    }
    return rows.join('\n')
  }

  async screen(id: LaneId): Promise<LaneScreen> {
    const lane = this.live(id)
    await settled(lane.term)
    if (lane.closed) throw new LaneClosedError(id)
    const buffer = lane.term.buffer.active
    // Measured exactly as `capture` measures it, from the same last row it
    // would end on: a depth and a cursor that disagree with the text draw a
    // scrollbar and a block in the wrong places.
    const last = lastWritten(buffer, lane.term.rows)
    return {
      lines: last + 1,
      cursor: { back: last - (buffer.baseY + buffer.cursorY), column: buffer.cursorX },
      scrolling: scrollingOf(buffer.type, lane.term.modes.mouseTrackingMode),
    }
  }

  async wheel(id: LaneId, turn: WheelTurn): Promise<void> {
    const lane = this.live(id)
    // Nothing at all to a program that never asked for the mouse: what it
    // cannot read as a pointer it reads as somebody typing.
    if (lane.term.modes.mouseTrackingMode === 'none') return
    const bytes = wheelBytes(turn, lane.encoding)
    if (bytes.length > 0) await this.write(id, bytes)
  }

  async resize(id: LaneId, cols: number, rows: number): Promise<void> {
    const lane = this.live(id)
    lane.pty.resize(cols, rows)
    lane.term.resize(cols, rows)
    lane.handle.cols = cols
    lane.handle.rows = rows
  }

  async focus(id: LaneId): Promise<void> {
    this.live(id)
    throw new UnsupportedCapabilityError(this.id, 'focus')
  }

  async setTitle(id: LaneId, title: string): Promise<void> {
    this.live(id).handle.title = title
  }

  attachCommand(id: LaneId): string {
    return this.opts.attachCommand(id)
  }

  async list(): Promise<LaneHandle[]> {
    return [...this.lanes.values()].filter((l) => !l.closed).map((l) => ({ ...l.handle }))
  }

  async get(id: LaneId): Promise<LaneHandle | null> {
    const lane = this.lanes.get(id)
    return lane && !lane.closed ? { ...lane.handle } : null
  }

  async adopt(_hint: AdoptHint): Promise<LaneHandle[]> {
    // This driver owns every PTY it knows about; there is nothing to adopt.
    return []
  }

  async close(id: LaneId): Promise<void> {
    const lane = this.lanes.get(id)
    if (!lane || lane.closed) return
    lane.closed = true
    lane.handle.alive = false
    try {
      lane.pty.kill()
    } catch {
      // already gone
    }
    lane.term.dispose()
    lane.outputs.clear()
    lane.exits.clear()
  }

  onOutput(id: LaneId, listener: LaneOutputListener, opts: { replay?: boolean } = {}): Unsubscribe {
    const lane = this.live(id)
    if (opts.replay && lane.replay.length > 0) {
      safely(() => listener(Buffer.concat(lane.replay)))
    }
    lane.outputs.add(listener)
    return () => lane.outputs.delete(listener)
  }

  onExit(id: LaneId, listener: LaneExitListener): Unsubscribe {
    const lane = this.live(id)
    if (!lane.handle.alive) {
      safely(() => listener({ code: lane.handle.exitCode, signal: null }))
      return () => {}
    }
    lane.exits.add(listener)
    return () => lane.exits.delete(listener)
  }

  /**
   * Let go, which here means end them.
   *
   * `detach: false` and `adopt: false` together say there is nothing to let
   * go into: these lanes are this process's children, nothing else can reach
   * them, and they die when it exits anyway. Leaving them running unwatched
   * in the meantime would mean processes nobody can see, drive or stop — so
   * the honest reading of "release everything" is the same as shutdown.
   */
  async detach(): Promise<void> {
    await this.shutdown()
  }

  async shutdown(): Promise<void> {
    for (const id of [...this.lanes.keys()]) await this.close(id as LaneId)
    this.lanes.clear()
  }

  private live(id: LaneId): Lane {
    const lane = this.lanes.get(id)
    if (!lane) throw new LaneNotFoundError(id)
    if (lane.closed) throw new LaneClosedError(id)
    return lane
  }
}

/** How long a frame being drawn is waited for before the screen is read anyway. */
const FRAME_WAIT_MS = 50

/**
 * Wait until the screen is one its program meant to show: everything that has
 * arrived parsed — the emulator parses in the background — and no redraw half
 * applied. A program that draws in synchronized updates (pi does, every frame)
 * says where a frame begins and ends, and read in between, the screen is the
 * last frame torn by the next: a line blinking, text interleaved with what was
 * there. Bounded, so a program that begins an update and never ends it cannot
 * freeze the window.
 */
async function settled(term: XTerm, ms = FRAME_WAIT_MS): Promise<void> {
  const deadline = Date.now() + ms
  for (;;) {
    const left = Math.max(0, deadline - Date.now())
    // A lane closed meanwhile never answers: the wait is bounded either way.
    await Promise.race([
      new Promise<void>((resolve) => {
        try {
          term.write('', resolve)
        } catch {
          resolve()
        }
      }),
      new Promise((resolve) => setTimeout(resolve, left)),
    ])
    if (Date.now() >= deadline || !term.modes.synchronizedOutputMode) return
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

/**
 * The last row with anything on it, counting the scrollback: where a capture
 * ends, and what the cursor and the depth are both measured against. Read from
 * the bottom up, because under the last thing written is usually blank screen.
 */
function lastWritten(buffer: import('@xterm/headless').IBuffer, rows: number): number {
  let last = buffer.baseY + rows - 1
  while (last >= 0 && (buffer.getLine(last)?.translateToString(true).trim() ?? '') === '') last--
  return last
}

/**
 * Whose the scrolling is, from what the program in the lane has done to its
 * terminal: took the screen for itself, and asked for the mouse or not.
 *
 * The alternate screen is what decides, because it is what says there is no
 * scrollback: a program that prints keeps every line it printed whether or
 * not it also wants the mouse, and those lines are the window's to move.
 */
function scrollingOf(
  buffer: 'normal' | 'alternate',
  mouse: import('@xterm/headless').IModes['mouseTrackingMode'],
): LaneScrolling {
  if (buffer !== 'alternate') return 'window'
  return mouse === 'none' ? 'nobody' : 'lane'
}

/**
 * Which encoding the program is asking for after this much output, given what
 * it was asking for before.
 *
 * Only the encoding: whether it wants the pointer at all is the emulator's to
 * say, and it says it. `1006` is the one anything written this decade turns
 * on, and the one thing here worth reading; a program that turns it off
 * again is back to the encoding every terminal has always understood.
 */
function encodingAfter(data: string, was: WheelEncoding): WheelEncoding {
  let now = was
  for (const [, params, set] of data.matchAll(PRIVATE_MODE)) {
    if ((params ?? '').split(';').includes('1006')) now = set === 'h' ? 'sgr' : 'legacy'
  }
  return now
}

/** How much of a chunk is kept, to read a sequence cut across two of them. */
const TAIL = 64

/**
 * A private mode being turned on or off, as a program says it.
 *
 * Built from a character code, as everywhere else here: an escape written
 * into a regular expression is usually somebody's mistake, and lint says so.
 */
const PRIVATE_MODE = new RegExp(`${String.fromCharCode(27)}\\[\\?([0-9;]+)([hl])`, 'g')

function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // A broken subscriber must never take down a lane.
  }
}

type BufferLine = NonNullable<ReturnType<import('@xterm/headless').IBuffer['getLine']>>
type BufferCell = NonNullable<ReturnType<BufferLine['getCell']>>

/**
 * One row of the screen with its paint, as SGR.
 *
 * Built from the cells rather than kept from the byte stream: the stream is
 * full of cursor moves and clears that would scramble whatever draws it, and
 * the cells are what the screen actually shows. A new sequence is written
 * only where the paint changes, and trailing blank cells go.
 */
function styledLine(row: BufferLine, cols: number): string {
  let out = ''
  let paint = ''
  let pending = ''
  /**
   * The blank cells held back, now that something follows them — and the run
   * before them closed first.
   *
   * A blank cell with no paint of its own is still a cell with no paint on
   * it. Written while the run before it is open, it takes that run's ground:
   * the gap between two buttons comes back as one band of colour with the
   * labels sitting in it, and so does every window drawn from a capture of
   * one. So the reset goes before the spaces, not after them.
   */
  const gap = () => {
    if (pending === '') return
    if (paint !== '') {
      out += '\x1b[0m'
      paint = ''
    }
    out += pending
    pending = ''
  }
  for (let x = 0; x < cols; x++) {
    const cell = row.getCell(x)
    if (!cell || cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    const next = sgrOf(cell)
    if (chars === ' ' && next === '') {
      // Held back: blank cells only count if something follows them.
      pending += ' '
      continue
    }
    gap()
    if (next !== paint) {
      out += `\x1b[0${next}m`
      paint = next
    }
    out += chars
  }
  return paint === '' ? out : `${out}\x1b[0m`
}

function sgrOf(cell: BufferCell): string {
  const codes: string[] = []
  if (cell.isBold()) codes.push('1')
  if (cell.isDim()) codes.push('2')
  if (cell.isItalic()) codes.push('3')
  if (cell.isUnderline()) codes.push('4')
  if (cell.isInverse()) codes.push('7')
  if (cell.isFgPalette()) codes.push(`38;5;${cell.getFgColor()}`)
  else if (cell.isFgRGB()) codes.push(`38;2;${rgb(cell.getFgColor())}`)
  if (cell.isBgPalette()) codes.push(`48;5;${cell.getBgColor()}`)
  else if (cell.isBgRGB()) codes.push(`48;2;${rgb(cell.getBgColor())}`)
  return codes.length === 0 ? '' : `;${codes.join(';')}`
}

function rgb(colour: number): string {
  return `${(colour >> 16) & 255};${(colour >> 8) & 255};${colour & 255}`
}
