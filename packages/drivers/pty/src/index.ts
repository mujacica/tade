import { createRequire } from 'node:module'
import { type LaneId, resolveCommand, stringEnv, type Unsubscribe } from '@wilco/core'
import {
  type AdoptHint,
  type Availability,
  type CaptureOptions,
  LaneClosedError,
  type LaneExitListener,
  type LaneHandle,
  LaneNotFoundError,
  type LaneOutputListener,
  type LaneSpec,
  UnsupportedCapabilityError,
  type WorkspaceCapabilities,
  type WorkspaceDriver,
} from '@wilco/drivers-core'
import { type IPty, spawn } from 'node-pty'

// @xterm/headless is CommonJS with no ESM named exports.
const { Terminal } = createRequire(import.meta.url)(
  '@xterm/headless',
) as typeof import('@xterm/headless')

type XTerm = InstanceType<typeof Terminal>

// The default driver: Wilco owns the PTYs and your terminal is just a
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
    // Lanes are Wilco's own children: close Wilco and they go with it. That
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
  }

  private readonly lanes = new Map<string, Lane>()
  private readonly opts: Required<Omit<PtyDriverOptions, 'env'>> & { env: NodeJS.ProcessEnv }

  constructor(opts: PtyDriverOptions = {}) {
    this.opts = {
      scrollback: opts.scrollback ?? DEFAULTS.scrollback,
      replayBytes: opts.replayBytes ?? DEFAULTS.replayBytes,
      attachCommand: opts.attachCommand ?? ((lane) => `wilco attach ${lane}`),
      env: opts.env ?? process.env,
    }
  }

  /** Node and a pseudo-terminal, which is to say: always. */
  async available(): Promise<Availability> {
    return { ok: true }
  }

  async open(spec: LaneSpec): Promise<LaneHandle> {
    if (this.lanes.has(spec.id)) throw new Error(`lane already exists: ${spec.id}`)
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
    }
    this.lanes.set(spec.id, lane)

    pty.onData((data) => {
      const buf = Buffer.from(data, 'utf8')
      lane.handle.lastOutputAt = Date.now()
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
    let last = buffer.baseY + lane.term.rows - 1
    while (last >= 0 && (buffer.getLine(last)?.translateToString(true).trim() ?? '') === '') {
      last--
    }
    const rows: string[] = []
    for (let i = Math.max(0, last - opts.lines + 1); i <= last; i++) {
      const row = buffer.getLine(i)
      rows.push(
        row ? (opts.styled ? styledLine(row, lane.term.cols) : row.translateToString(true)) : '',
      )
    }
    return rows.join('\n')
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
    if (next !== paint) {
      out += `${pending}\x1b[0${next}m`
      pending = ''
      paint = next
    }
    out += pending + chars
    pending = ''
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
