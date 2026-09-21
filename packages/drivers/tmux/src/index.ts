import { execFile } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readSync, rmSync, statSync } from 'node:fs'
import { constants, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type LaneId,
  type RequiredProgram,
  resolveCommand,
  stringEnv,
  type Unsubscribe,
} from '@tade/core'
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
  type WheelEncoding,
  type WheelTurn,
  type WorkspaceCapabilities,
  type WorkspaceDriver,
  wheelBytes,
} from '@tade/drivers-core'

// execFile, never exec: tmux is invoked with an argument array and no shell.
// The one place a shell is involved is inside tmux, which runs a lane's
// command and the pipe-pane redirect through sh — both are shell-quoted below.
const run = promisify(execFile)

// Lanes that live in tmux rather than inside Tade.
//
// The reason to want this is that they outlive it: close Tade, open it again,
// and the agents are still running. It also means you can attach to one from
// any terminal, over SSH, with no Tade running at all.
//
// It runs on its own tmux server (`-L tade`), so nothing here disturbs the
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
  /** The signal it ended on, for whoever subscribes after it already has. */
  signal: number | null
  /** When its pane was first seen dead, while tmux had yet to say how. */
  deadAt: number | null
}

const DEFAULTS = {
  socket: 'tade',
  session: 'tade',
  scrollback: 10_000,
  replayBytes: 256 * 1024,
  pollMs: 25,
  cols: 120,
  rows: 40,
}

/**
 * How long a dead pane is given to say how it ended before the lane is
 * reported exited with nothing known about the code. Only a child tmux never
 * reaps takes this long; the answer normally arrives within a poll or two.
 */
const STATUS_GRACE_MS = 2_000

/** Where the lane id is kept, on the window itself. */
const LANE_OPTION = '@tade-lane'
const SPEC_OPTION = '@tade-spec'

/**
 * How the fields of a `list-panes -F` row are separated.
 *
 * Printable, and deliberately not a tab: tmux sanitises control characters
 * out of format output, and not the same way twice — 3.3a turns a tab into
 * `_`, 3.4 into a literal `\037`, and only a newer tmux leaves it alone. A
 * row that never split read as a window with no lane on it, so a reopened
 * window adopted nothing and a finished agent was never reaped, on every
 * machine but the one with the newest tmux on it.
 *
 * Nothing is parsed out of the middle of a value either: the fields before
 * the spec are a window id, a pid and a flag, none of which can hold this,
 * and the spec is whatever is left of the row.
 */
const FIELD = '|'

/**
 * What a pane is like, in one ask: where the cursor is, how tall it is, and
 * what its program has done to the screen and the mouse.
 *
 * One `display-message` for all of it, because every one of these is a
 * process, and the window asks for a pane four times a second.
 */
const PANE_FORMAT =
  '#{cursor_x} #{cursor_y} #{pane_height} #{alternate_on} ' +
  '#{mouse_any_flag} #{mouse_button_flag} #{mouse_standard_flag} #{mouse_sgr_flag}'

/** What `PANE_FORMAT` came back with. */
interface Pane {
  x: number
  y: number
  height: number
  /** The program took the whole screen for itself, so tmux keeps no history of it. */
  own: boolean
  /** It asked for the mouse, in any of the ways there are to ask. */
  mouse: boolean
  encoding: WheelEncoding
}

function readPane(said: string): Pane {
  const [x = 0, y = 0, height = 0, alternate = 0, any = 0, button = 0, standard = 0, sgr = 0] = said
    .trim()
    .split(/\s+/)
    .map(Number)
  return {
    x,
    y,
    height,
    own: alternate === 1,
    mouse: any === 1 || button === 1 || standard === 1,
    encoding: sgr === 1 ? 'sgr' : 'legacy',
  }
}

/**
 * Whose the scrolling is, from what the pane's program has done to it.
 *
 * The alternate screen is what decides, because it is what says there is no
 * history: a program that prints keeps every line it printed whether or not
 * it also wants the mouse, and those lines are the window's to move.
 */
function scrollingOf(pane: Pane): LaneScrolling {
  if (!pane.own) return 'window'
  return pane.mouse ? 'lane' : 'nobody'
}

export class TmuxDriver implements WorkspaceDriver {
  readonly id = 'tmux'
  readonly capabilities: WorkspaceCapabilities = {
    // The point of this driver: lanes are the tmux server's children rather
    // than Tade's, so closing Tade leaves every agent running.
    detach: true,
    remoteAttach: true,
    nativeTabs: true,
    focus: true,
    setTitle: true,
    // The lane id is stored on the window, so they come back exactly.
    adopt: true,
    // tmux tracks what each pane's program asked of its mouse, and `send-keys`
    // puts bytes on that pane's input: between them, a pointer report.
    pointer: true,
  }
  readonly programs: readonly RequiredProgram[] = [
    {
      command: 'tmux',
      title: 'tmux',
      why: 'holding every lane, so agents go on working after Tade closes',
      versionArgs: ['-V'],
    },
  ]

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
    this.dir = mkdtempSync(join(tmpdir(), 'tade-tmux-'))
  }

  async available(): Promise<Availability> {
    try {
      await this.tmux(['-V'])
      return { ok: true }
    } catch {
      return { ok: false, reason: 'tmux is not installed (brew install tmux)' }
    }
  }

  async open(spec: LaneSpec): Promise<LaneHandle> {
    // An id is taken while something runs under it, and free again once that
    // ended or was closed: an agent started again is the same lane.
    const previous = this.lanes.get(spec.id)
    if (previous && !previous.closed && !previous.exited) {
      throw new Error(`lane already exists: ${spec.id}`)
    }
    const env = stringEnv({ ...this.opts.env, ...spec.env })
    // Resolved up front: tmux would happily open a window on a command that
    // does not exist and leave a dead pane behind pretending to be a lane.
    const command = resolveCommand(spec.command, env)
    if (!command) throw new Error(`command not found: ${spec.command}`)
    // A dead pane stays open to be read; the one taking its place ends it, or a
    // later window would adopt two lanes under one id.
    if (previous) await this.close(spec.id)

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
      signal: null,
      deadAt: null,
    }
    this.lanes.set(spec.id, lane)

    // Remembered on the window itself, so a later window can pick it back up.
    // The name is for whoever is looking at the tmux server by hand — `adopt`
    // reads the spec below, which carries the same id and everything else a
    // relaunch needs.
    await this.tmux(['set-option', '-w', '-t', window, LANE_OPTION, spec.id]).catch(() => {})
    await this.tmux([
      'set-option',
      '-w',
      '-t',
      window,
      SPEC_OPTION,
      JSON.stringify(handle.spec),
    ]).catch(() => {})
    // This is also what pins the window to its own size: `resize-window` sets
    // the window's `window-size` to manual, so a lane no longer follows the
    // session. Setting that option globally instead would be the obvious way
    // and is the wrong one — it crashes the tmux server outright on 3.3a and
    // 3.4, which is what Ubuntu ships, and only works on the newer tmux a
    // laptop happens to have.
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
      ...(opts.styled ? ['-e'] : []),
      '-t',
      lane.window,
      '-S',
      `-${this.opts.scrollback}`,
    ])
    const all = out.split('\n')
    while (all.length > 0 && all.at(-1)?.trim() === '') all.pop()
    return all.slice(Math.max(0, all.length - opts.lines)).join('\n')
  }

  async screen(id: LaneId): Promise<LaneScreen> {
    const lane = this.live(id)
    // Two asks, because tmux answers them apart: how much there is to read,
    // and what the pane is like — where the cursor is on the screen at the
    // bottom of it, and what its program has done to its mouse. The cursor is
    // reported against the last line a capture would end on, so it has to be
    // counted against the same trimming capture does.
    const [text, where] = await Promise.all([
      this.tmux(['capture-pane', '-p', '-t', lane.window, '-S', `-${this.opts.scrollback}`]),
      this.tmux(['display-message', '-p', '-t', lane.window, PANE_FORMAT]),
    ])
    const all = text.split('\n')
    // tmux ends its output with a newline; that is not a row of anything.
    if (all.at(-1) === '') all.pop()
    const captured = all.length
    while (all.length > 0 && all.at(-1)?.trim() === '') all.pop()
    const pane = readPane(where)
    const scrolling = scrollingOf(pane)
    const { x, y, height } = pane
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(height) || height <= 0) {
      return { lines: all.length, cursor: { back: 0, column: 0 }, scrolling }
    }
    // Where the visible screen starts in what was captured: everything above
    // it is scrollback, and the cursor's row is counted from there.
    const top = captured - height
    return {
      lines: all.length,
      cursor: { back: all.length - 1 - (top + y), column: x },
      scrolling,
    }
  }

  async wheel(id: LaneId, turn: WheelTurn): Promise<void> {
    const lane = this.live(id)
    // Asked again rather than remembered from the last look: a program that
    // has just let go of the mouse would otherwise be typed at, and what it
    // wants is one short answer from tmux away.
    const pane = readPane(
      await this.tmux(['display-message', '-p', '-t', lane.window, PANE_FORMAT]),
    )
    if (!pane.mouse) return
    const bytes = wheelBytes(turn, pane.encoding)
    if (bytes.length > 0) await this.write(id, bytes)
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

  /** Pick up lanes already running, after a restart or from another window. */
  async adopt(hint: AdoptHint): Promise<LaneHandle[]> {
    if (!(await this.sessionExists())) return []
    this.start()
    const rows = await this.tmux([
      'list-panes',
      '-s',
      '-t',
      this.opts.session,
      '-F',
      [`#{window_id}`, `#{pane_pid}`, `#{pane_dead}`, `#{${SPEC_OPTION}}`].join(FIELD),
    ]).catch(() => '')

    const found: LaneHandle[] = []
    for (const row of rows.split('\n')) {
      const fields = row.split(FIELD)
      const [window, pid, dead] = fields
      // The spec is JSON and may hold the separator, so it is the rest of the
      // row rather than one field. Its own `id` is the lane's: two records of
      // one name is two things to disagree, and the spec is the one a
      // relaunch has to use anyway.
      const specJson = fields.slice(3).join(FIELD)
      if (!window || !specJson) continue
      const spec = parseSpec(specJson)
      if (!spec) continue
      const id = spec.id
      if (this.lanes.has(id)) continue
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
        signal: null,
        deadAt: null,
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
      safely(() => listener({ code: lane.handle.exitCode, signal: lane.signal }))
      return () => {}
    }
    lane.exits.add(listener)
    return () => lane.exits.delete(listener)
  }

  /**
   * Let go of the session without ending it. This is the whole reason to run
   * lanes in tmux: Tade closes, the windows stay, and opening it again
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
        'tade',
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

  /**
   * Notice anything that has ended, and how.
   *
   * A dead pane is not a reaped one. `pane_dead` is tmux's own end of the pty
   * being closed; what the command ended with is a second thing, known only
   * once its child has been waited on, and until then tmux answers
   * `pane_dead_status` and `pane_dead_signal` with nothing at all. Which of
   * the two comes first is not ours to depend on: tmux 3.4 — Ubuntu's, and
   * the runner's — closes the pty first and left a clean exit reading as an
   * exit code nobody knows, where 3.7 and macOS never showed a gap at all.
   * So the pane says *that* it ended, the status says *what with*, and a lane
   * is not reported exited on the first of those alone.
   */
  private async reap(): Promise<void> {
    const live = [...this.lanes.values()].filter((l) => !l.closed && !l.exited)
    if (live.length === 0) return
    const rows = await this.tmux([
      'list-panes',
      '-s',
      '-t',
      this.opts.session,
      '-F',
      ['#{window_id}', '#{pane_dead}', '#{pane_dead_status}', '#{pane_dead_signal}'].join(FIELD),
    ]).catch(() => '')

    const dead = new Map<string, { told: boolean; code: number | null; signal: number | null }>()
    for (const row of rows.split('\n')) {
      const [window, isDead, status = '', signal = ''] = row.split(FIELD)
      if (!window || isDead !== '1') continue
      // One of the two is how tmux says it: a command that exited has a
      // status and no signal, one that was killed has a signal and no status,
      // and one that has not been waited on yet has neither.
      dead.set(window, {
        told: status !== '' || signal !== '',
        code: exitStatus(status),
        signal: signalNumber(signal),
      })
    }

    const now = Date.now()
    for (const lane of live) {
      const end = dead.get(lane.window)
      if (!end) continue
      lane.deadAt ??= now
      // Waiting for ever is its own way of being wrong: only a child tmux
      // never reaps — something that outlived its own terminal — leaves this
      // unanswered, and a lane that says it is still running for the rest of
      // the window is worse than one that says it ended without saying how,
      // which is what a null code has always meant here.
      if (!end.told && now - lane.deadAt < STATUS_GRACE_MS) continue
      // Whatever it printed on the way out still counts.
      this.drain(lane)
      lane.exited = true
      lane.handle.alive = false
      lane.handle.exitCode = end.code
      lane.signal = end.signal
      const event = { code: end.code, signal: end.signal }
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
    const { stdout } = await run(
      'tmux',
      ['-L', this.opts.socket, ...args],
      clientOptions(stringEnv(this.opts.env)),
    )
    return stdout
  }

  private live(id: LaneId): Lane {
    const lane = this.lanes.get(id)
    if (!lane) throw new LaneNotFoundError(id)
    if (lane.closed) throw new LaneClosedError(id)
    return lane
  }
}

/**
 * How a tmux command is run: in its own process group, so the terminal Tade
 * runs in never names its window after one. Lanes are read by polling this,
 * so without it every look retitled the window `tmux`. `execFile` hands
 * `detached` to the spawn beneath it; its types just do not say so.
 */
function clientOptions(env: Record<string, string>): {
  env: Record<string, string>
  maxBuffer: number
} {
  const options = { env, maxBuffer: 32 * 1024 * 1024, detached: true }
  return options
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
    return spec &&
      typeof spec.id === 'string' &&
      spec.id !== '' &&
      typeof spec.cwd === 'string' &&
      typeof spec.command === 'string'
      ? spec
      : null
  } catch {
    // Someone else's window, or a spec from a version that wrote it differently.
    return null
  }
}

/** What a command exited with. Nothing at all is not a zero. */
function exitStatus(status: string): number | null {
  if (status === '') return null
  const code = Number(status)
  return Number.isInteger(code) ? code : null
}

/**
 * What a command was killed by, as a number.
 *
 * tmux names a signal the way the platform it was built on does — `HUP`
 * where that has a name for it, `1` where it does not — and a lane's exit is
 * reported as the number, whichever of the two we were handed.
 */
function signalNumber(signal: string): number | null {
  if (signal === '') return null
  const n = Number(signal)
  if (Number.isInteger(n)) return n > 0 ? n : null
  const known: Record<string, number | undefined> = constants.signals
  return known[signal.startsWith('SIG') ? signal : `SIG${signal}`] ?? null
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
