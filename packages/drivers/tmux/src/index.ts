import { execFile } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { type LaneId, resolveCommand, stringEnv, type Unsubscribe } from '@wilco/core'
import {
  type AdoptHint,
  type CaptureOptions,
  LaneClosedError,
  type LaneExitListener,
  type LaneHandle,
  LaneNotFoundError,
  type LaneOutputListener,
  type LaneSpec,
  type WorkspaceCapabilities,
  type WorkspaceDriver,
} from '@wilco/drivers-core'

// execFile, never exec: tmux is invoked with an argument array and no shell.
// The one place a shell is involved is inside tmux, which runs a lane's
// command and the pipe-pane redirect through sh — both are shell-quoted below.
const run = promisify(execFile)

// Lanes that live in tmux rather than in the daemon.
//
// The reason to want this is that they outlive the daemon: kill wilcod, start
// it again, and the agents are still running. It also means you can attach to
// one from any terminal, over SSH, with no Wilco running at all.
//
// It runs on its own tmux server (`-L wilco`), so nothing here disturbs the
// sessions you are using yourself, and one window per lane with the lane id
// stored on the window, so lanes can be recovered exactly rather than guessed
// at from window names.

export interface TmuxDriverOptions {
  /** Server socket name. Its own, so your sessions are never touched. */
  socket?: string
  /** The session holding one window per lane. */
  session?: string
  /** Lines of scrollback tmux keeps per lane. */
  scrollback?: number
  /** Bytes of output kept for replaying to a new subscriber. */
  replayBytes?: number
  /** How often output and dead panes are checked. */
  pollMs?: number
  attachCommand?: (lane: LaneId) => string
  env?: NodeJS.ProcessEnv
}

interface Lane {
  handle: LaneHandle
  /** tmux's own window id, like `@3`: stable across renames. */
  window: string
  /** Where `pipe-pane` is writing this lane's output. */
  pipe: string
  /** Bytes already handed to subscribers. */
  offset: number
  outputs: Set<LaneOutputListener>
  exits: Set<LaneExitListener>
  /** Writes are queued so they reach tmux in the order they were made. */
  queue: Promise<void>
  closed: boolean
  exited: boolean
}

const DEFAULTS = {
  socket: 'wilco',
  session: 'wilco',
  scrollback: 10_000,
  replayBytes: 256 * 1024,
  pollMs: 25,
  cols: 120,
  rows: 40,
}

/** Where the lane id is kept, on the window itself. */
const LANE_OPTION = '@wilco-lane'
const SPEC_OPTION = '@wilco-spec'

export class TmuxDriver implements WorkspaceDriver {
  readonly id = 'tmux'
  readonly capabilities: WorkspaceCapabilities = {
    // The point of this driver: lanes are the tmux server's children, not the
    // daemon's, so restarting Wilco leaves every agent running.
    detach: true,
    remoteAttach: true,
    nativeTabs: true,
    focus: true,
    setTitle: true,
    // The lane id is stored on the window, so they come back exactly.
    adopt: true,
  }

  private readonly lanes = new Map<string, Lane>()
  private readonly opts: Required<Omit<TmuxDriverOptions, 'env'>> & { env: NodeJS.ProcessEnv }
  private readonly dir: string
  private timer: NodeJS.Timeout | null = null
  private started = false
  private polling = false
  private n = 0

  constructor(opts: TmuxDriverOptions = {}) {
    this.opts = {
      socket: opts.socket ?? DEFAULTS.socket,
      session: opts.session ?? DEFAULTS.session,
      scrollback: opts.scrollback ?? DEFAULTS.scrollback,
      replayBytes: opts.replayBytes ?? DEFAULTS.replayBytes,
      pollMs: opts.pollMs ?? DEFAULTS.pollMs,
      attachCommand:
        opts.attachCommand ??
        ((lane) =>
          `tmux -L ${opts.socket ?? DEFAULTS.socket} attach -t ${opts.session ?? DEFAULTS.session}:${windowName(lane)}`),
      env: opts.env ?? process.env,
    }
    this.dir = mkdtempSync(join(tmpdir(), 'wilco-tmux-'))
  }

  async open(spec: LaneSpec): Promise<LaneHandle> {
    if (this.lanes.has(spec.id)) throw new Error(`lane already exists: ${spec.id}`)
    const env = stringEnv({ ...this.opts.env, ...spec.env })
    // Resolved up front: tmux would happily open a window on a command that
    // does not exist and leave a dead pane behind pretending to be a lane.
    const command = resolveCommand(spec.command, env)
    if (!command) throw new Error(`command not found: ${spec.command}`)

    const cols = spec.cols ?? DEFAULTS.cols
    const rows = spec.rows ?? DEFAULTS.rows
    await this.ensureSession(cols, rows)

    const pipe = join(this.dir, `lane-${++this.n}.out`)
    const window = (
      await this.tmux([
        'new-window',
        '-d',
        '-P',
        '-F',
        '#{window_id}',
        '-t',
        `${this.opts.session}:`,
        '-c',
        spec.cwd,
        '-n',
        windowName(spec.id),
        ...Object.entries(spec.env ?? {}).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
        quote([command, ...spec.args]),
      ])
    ).trim()

    const handle: LaneHandle = {
      id: spec.id,
      spec: { ...spec, cols, rows },
      pid: null,
      startedAt: Date.now(),
      title: spec.title ?? spec.id,
      cols,
      rows,
      alive: true,
      exitCode: null,
      lastOutputAt: null,
    }
    const lane: Lane = {
      handle,
      window,
      pipe,
      offset: 0,
      outputs: new Set(),
      exits: new Set(),
      queue: Promise.resolve(),
      closed: false,
      exited: false,
    }
    this.lanes.set(spec.id, lane)

    // Remembered on the window itself, so a later daemon can pick it back up.
    await this.tmux(['set-option', '-w', '-t', window, LANE_OPTION, spec.id]).catch(() => {})
    await this.tmux([
      'set-option',
      '-w',
      '-t',
      window,
      SPEC_OPTION,
      JSON.stringify(handle.spec),
    ]).catch(() => {})
    await this.tmux(['resize-window', '-t', window, '-x', String(cols), '-y', String(rows)]).catch(
      () => {},
    )
    await this.tmux(['pipe-pane', '-O', '-t', window, `cat >> ${shellArg(pipe)}`]).catch(() => {})
    handle.pid = await this.panePid(window)
    return { ...handle }
  }

  async write(id: LaneId, data: Uint8Array): Promise<void> {
    const lane = this.live(id)
    // Queued synchronously, so writes made in order arrive in order however
    // long each one takes: every write here is a separate process.
    const done = lane.queue.then(() => this.send(lane, data))
    lane.queue = done.catch(() => {})
    return done
  }

  async capture(id: LaneId, opts: CaptureOptions): Promise<string> {
    const lane = this.live(id)
    const out = await this.tmux([
      'capture-pane',
      '-p',
      '-t',
      lane.window,
      '-S',
      `-${this.opts.scrollback}`,
    ])
    const all = out.split('\n')
    while (all.length > 0 && all.at(-1)?.trim() === '') all.pop()
    return all.slice(Math.max(0, all.length - opts.lines)).join('\n')
  }

  async resize(id: LaneId, cols: number, rows: number): Promise<void> {
    const lane = this.live(id)
    await this.tmux(['resize-window', '-t', lane.window, '-x', String(cols), '-y', String(rows)])
    lane.handle.cols = cols
    lane.handle.rows = rows
  }

  async focus(id: LaneId): Promise<void> {
    const lane = this.live(id)
    await this.tmux(['select-window', '-t', lane.window])
  }

  async setTitle(id: LaneId, title: string): Promise<void> {
    const lane = this.live(id)
    // Kept here as well as in tmux: tmux sanitises window names, and what was
    // asked for is what `list` and `get` have to report.
    lane.handle.title = title
    await this.tmux(['rename-window', '-t', lane.window, windowName(title)]).catch(() => {})
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

  /** Pick up lanes already running, after a restart or from another daemon. */
  async adopt(hint: AdoptHint): Promise<LaneHandle[]> {
    if (!(await this.sessionExists())) return []
    this.start()
    const rows = await this.tmux([
      'list-panes',
      '-s',
      '-t',
      this.opts.session,
      '-F',
      `#{window_id}\t#{${LANE_OPTION}}\t#{${SPEC_OPTION}}\t#{pane_pid}\t#{pane_dead}`,
    ]).catch(() => '')

    const found: LaneHandle[] = []
    for (const row of rows.split('\n')) {
      const [window, id, specJson, pid, dead] = row.split('\t')
      if (!window || !id || !specJson) continue
      if (this.lanes.has(id)) continue
      const spec = parseSpec(specJson)
      if (!spec) continue
      if (hint.cwd && !under(spec.cwd, hint.cwd)) continue
      if (hint.titlePattern && !new RegExp(hint.titlePattern).test(spec.title ?? id)) continue

      const pipe = join(this.dir, `lane-${++this.n}.out`)
      const handle: LaneHandle = {
        id: id as LaneId,
        spec,
        pid: pid ? Number(pid) : null,
        startedAt: Date.now(),
        title: spec.title ?? id,
        cols: spec.cols ?? DEFAULTS.cols,
        rows: spec.rows ?? DEFAULTS.rows,
        alive: dead !== '1',
        exitCode: null,
        lastOutputAt: null,
      }
      this.lanes.set(id, {
        handle,
        window,
        pipe,
        offset: 0,
        outputs: new Set(),
        exits: new Set(),
        queue: Promise.resolve(),
        closed: false,
        exited: dead === '1',
      })
      await this.tmux(['pipe-pane', '-O', '-t', window, `cat >> ${shellArg(pipe)}`]).catch(() => {})
      found.push({ ...handle })
    }
    return found
  }

  async close(id: LaneId): Promise<void> {
    const lane = this.lanes.get(id)
    if (!lane || lane.closed) return
    lane.closed = true
    lane.handle.alive = false
    await this.tmux(['kill-window', '-t', lane.window]).catch(() => {
      // Already gone, which is the state we wanted.
    })
    lane.outputs.clear()
    lane.exits.clear()
    rmSync(lane.pipe, { force: true })
  }

  onOutput(id: LaneId, listener: LaneOutputListener, opts: { replay?: boolean } = {}): Unsubscribe {
    const lane = this.live(id)
    if (opts.replay) {
      // Only what has already been delivered live, so nothing arrives twice.
      const buffered = this.read(
        lane,
        Math.max(0, lane.offset - this.opts.replayBytes),
        lane.offset,
      )
      if (buffered && buffered.length > 0) safely(() => listener(buffered))
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
   * Let go of the session without ending it. This is the whole reason to run
   * lanes in tmux: Wilco closes, the windows stay, and opening it again
   * adopts them back. Output piping is left in place — the pipe files are
   * this instance's, but tmux keeps writing until the window dies, and the
   * next instance sets up its own.
   */
  async detach(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const lane of this.lanes.values()) {
      lane.outputs.clear()
      lane.exits.clear()
    }
    this.lanes.clear()
    this.started = false
    rmSync(this.dir, { recursive: true, force: true })
  }

  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    for (const id of [...this.lanes.keys()]) await this.close(id as LaneId)
    this.lanes.clear()
    if (this.started) {
      await this.tmux(['kill-session', '-t', this.opts.session]).catch(() => {})
    }
    this.started = false
    rmSync(this.dir, { recursive: true, force: true })
  }

  private async send(lane: Lane, data: Uint8Array): Promise<void> {
    // Hex, so every byte survives exactly: control characters, UTF-8 and all.
    const hex = [...Buffer.from(data)].map((b) => b.toString(16).padStart(2, '0'))
    await this.tmux(['send-keys', '-t', lane.window, '-H', ...hex])
  }

  private async ensureSession(cols: number, rows: number): Promise<void> {
    if (this.started) return
    if (!(await this.sessionExists())) {
      await this.tmux([
        'new-session',
        '-d',
        '-s',
        this.opts.session,
        '-n',
        'wilco',
        '-x',
        String(cols),
        '-y',
        String(rows),
        // A window that stays, so the session outlives any one lane.
        'sh -c "while :; do sleep 3600; done"',
      ])
    }
    // Our own server, so these are safe to set for everything on it.
    await this.tmux(['set-option', '-g', 'history-limit', String(this.opts.scrollback)]).catch(
      () => {},
    )
    // A finished command leaves a dead pane holding its exit status, which is
    // the only way tmux will tell us what it was.
    await this.tmux(['set-option', '-wg', 'remain-on-exit', 'on']).catch(() => {})
    // With no client attached a window otherwise keeps the session's size.
    await this.tmux(['set-option', '-wg', 'window-size', 'manual']).catch(() => {})
    this.start()
  }

  private start(): void {
    this.started = true
    if (this.timer) return
    this.timer = setInterval(() => void this.poll(), this.opts.pollMs)
    this.timer.unref?.()
  }

  private async sessionExists(): Promise<boolean> {
    return this.tmux(['has-session', '-t', this.opts.session]).then(
      () => true,
      () => false,
    )
  }

  private async panePid(window: string): Promise<number | null> {
    const out = await this.tmux(['display-message', '-p', '-t', window, '#{pane_pid}']).catch(
      () => '',
    )
    const pid = Number(out.trim())
    return Number.isFinite(pid) && pid > 0 ? pid : null
  }

  /** One pass: hand out new output, then notice anything that has died. */
  private async poll(): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      for (const lane of this.lanes.values()) {
        if (lane.closed) continue
        this.drain(lane)
      }
      await this.reap()
    } catch {
      // The poller must never die: it is the only thing watching.
    } finally {
      this.polling = false
    }
  }

  private drain(lane: Lane): void {
    const chunk = this.read(lane, lane.offset)
    if (!chunk || chunk.length === 0) return
    lane.offset += chunk.length
    lane.handle.lastOutputAt = Date.now()
    for (const listener of lane.outputs) safely(() => listener(chunk))
  }

  private async reap(): Promise<void> {
    const live = [...this.lanes.values()].filter((l) => !l.closed && !l.exited)
    if (live.length === 0) return
    const rows = await this.tmux([
      'list-panes',
      '-s',
      '-t',
      this.opts.session,
      '-F',
      '#{window_id}\t#{pane_dead}\t#{pane_dead_status}',
    ]).catch(() => '')

    const dead = new Map<string, number | null>()
    for (const row of rows.split('\n')) {
      const [window, isDead, status] = row.split('\t')
      if (!window || isDead !== '1') continue
      dead.set(window, status === undefined || status === '' ? null : Number(status))
    }

    for (const lane of live) {
      if (!dead.has(lane.window)) continue
      // Whatever it printed on the way out still counts.
      this.drain(lane)
      lane.exited = true
      lane.handle.alive = false
      lane.handle.exitCode = dead.get(lane.window) ?? null
      const event = { code: lane.handle.exitCode, signal: null }
      for (const listener of lane.exits) safely(() => listener(event))
    }
  }

  /** Read a lane's output file between two offsets. Missing is not an error. */
  private read(lane: Lane, from: number, to?: number): Buffer | null {
    try {
      const end = to ?? statSync(lane.pipe).size
      if (end <= from) return null
      const fd = openSync(lane.pipe, 'r')
      try {
        const buffer = Buffer.alloc(end - from)
        const read = readSync(fd, buffer, 0, buffer.length, from)
        return read === buffer.length ? buffer : buffer.subarray(0, read)
      } finally {
        closeSync(fd)
      }
    } catch {
      // Nothing has been written yet.
      return null
    }
  }

  private async tmux(args: string[]): Promise<string> {
    const { stdout } = await run('tmux', ['-L', this.opts.socket, ...args], {
      env: stringEnv(this.opts.env),
      maxBuffer: 32 * 1024 * 1024,
    })
    return stdout
  }

  private live(id: LaneId): Lane {
    const lane = this.lanes.get(id)
    if (!lane) throw new LaneNotFoundError(id)
    if (lane.closed) throw new LaneClosedError(id)
    return lane
  }
}

/** tmux window names cannot hold everything a lane id can. */
function windowName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'lane'
}

function quote(argv: string[]): string {
  return argv.map(shellArg).join(' ')
}

function shellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parseSpec(json: string): LaneSpec | null {
  try {
    const spec = JSON.parse(json) as LaneSpec
    return spec && typeof spec.cwd === 'string' && typeof spec.command === 'string' ? spec : null
  } catch {
    // Someone else's window, or a spec from a version that wrote it differently.
    return null
  }
}

function under(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}

function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // A broken subscriber must never take down a lane.
  }
}
