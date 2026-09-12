import { createRequire } from 'node:module'
import {
  type AdoptHint,
  type CaptureOptions,
  LaneClosedError,
  type LaneExitListener,
  type LaneHandle,
  type LaneId,
  LaneNotFoundError,
  type LaneOutputListener,
  type LaneSpec,
  resolveCommand,
  stringEnv,
  type Unsubscribe,
  UnsupportedCapabilityError,
  type WorkspaceCapabilities,
  type WorkspaceDriver,
} from '@wilco/core'
import { type IPty, spawn } from 'node-pty'

// @xterm/headless is CommonJS with no ESM named exports.
const { Terminal } = createRequire(import.meta.url)(
  '@xterm/headless',
) as typeof import('@xterm/headless')

type XTerm = InstanceType<typeof Terminal>

// The default driver: the daemon owns the PTYs and your terminal is just a
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
    // Lanes are children of the daemon, so they outlive any client that
    // attaches, but not the daemon itself. See the note in the README.
    detach: true,
    remoteAttach: true,
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
    const buffer = lane.term.buffer.active
    const end = buffer.baseY + lane.term.rows
    const all: string[] = []
    for (let i = 0; i < end; i++) {
      all.push(buffer.getLine(i)?.translateToString(true) ?? '')
    }
    while (all.length > 0 && all.at(-1)!.trim() === '') all.pop()
    return all.slice(Math.max(0, all.length - opts.lines)).join('\n')
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

function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // A broken subscriber must never take down a lane.
  }
}
