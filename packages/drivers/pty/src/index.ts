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
  type LaneSpec,
  type PointerReport,
  pointerBytes,
  UnsupportedCapabilityError,
  type WheelEncoding,
  type WheelTurn,
  type WorkspaceCapabilities,
  type WorkspaceDriver,
  wheelBytes,
} from '@tade/drivers-core'
import { type IPty, spawn } from 'node-pty'
import { helperAt, helperProblem } from './helper.ts'
import { type Frame, type Order, type Report, WATCH_MS } from './protocol.ts'
import { EMULATORS, EmulatorThread } from './thread.ts'

// The default driver: Tade owns the PTYs and your terminal is just a
// viewer. Imposes nothing on the user's terminal setup.
//
// A headless xterm keeps a real screen buffer per lane, so `capture()` returns
// rendered state instead of a soup of escape sequences — on a thread of its
// own (`emulator.ts`), so parsing what every agent prints is never the thread
// that draws the window. The processes stay here (`thread.ts` says why).

export interface PtyDriverOptions {
  /** Lines of scrollback kept per lane. */
  scrollback?: number
  /** Bytes of raw output kept for replaying to a new subscriber. */
  replayBytes?: number
  /** How a human is told to view a lane. */
  attachCommand?: (lane: LaneId) => string
  env?: NodeJS.ProcessEnv
  /**
   * Where something that went wrong and was carried on through is said: the
   * emulators stopping, which is every screen redrawn from what its lane last
   * printed, or every screen frozen where it was. Not said is not the same as
   * not happening.
   */
  trouble?: (problem: Error) => void
  /** The file the emulators' thread runs: the real one, unless a test needs one that dies. */
  emulators?: URL
}

/** A frame as it arrived, numbered, so a capture can wait past one it has. */
type Pushed = Frame & { n: number }

interface Asked {
  lines: number
  styled: boolean
}

interface Waiting {
  ready: () => boolean
  done: () => void
}

interface Lane {
  handle: LaneHandle
  pty: IPty
  /**
   * Which screen in the emulators is this lane's. Never used twice, so a lane
   * opened again under the same id is never shown, or answered with, the
   * screen of the one before it.
   */
  key: number
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
  /** The newest order that changed this screen: what a frame must have reached to be current. */
  sent: number
  /** The newest frame the emulators pushed, for the question last asked. */
  frame: Pushed | null
  pushes: number
  /** The newest numbers beside the screen, from a frame or from being asked. */
  view: { seq: number; screen: LaneScreen } | null
  /**
   * The last capture of a lane that draws its own screen that was a whole
   * frame, so a capture that caught one half drawn has something whole to give
   * back.
   *
   * Null once it has been given back: held for one capture and no more. Two
   * frames of a lane nobody can catch settled is a pane that has stopped, and
   * a pane that has stopped is worse than a torn one — that is the bug
   * `frame.probe.test.ts` exists about.
   */
  whole: Pushed | null
  /** What the emulators were last told somebody is looking at, and when. */
  watching: (Asked & { at: number }) | null
  waiting: Set<Waiting>
}

const DEFAULTS = {
  scrollback: 10_000,
  replayBytes: 256 * 1024,
  cols: 120,
  rows: 40,
}

/**
 * How long the emulators are waited on for a frame or an answer, at most.
 *
 * Past every wait they make themselves — fifty milliseconds for a frame being
 * drawn, sixteen between two frames pushed — and well short of a pane that
 * looks stuck. Run out, the answer is the last one known, which is what a
 * screen nobody could read again is: not an empty one.
 */
const ANSWER_MS = 150

/**
 * How long a thread still being started is waited on: it loads xterm before
 * it can say anything, which is some fifty milliseconds here and many times
 * that on a machine with agents running. Only ever the first answer of a
 * thread — the lanes Tade opens as the window opens.
 */
const STARTING_MS = 2_000

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
  /** The lanes that still have a screen, by the key the emulators know them by. */
  private readonly keyed = new Map<number, Lane>()
  private keys = 0
  private readonly asks = new Map<number, (report: Report | null) => void>()
  private asked = 0
  private readonly thread: EmulatorThread
  private readonly opts: Required<Omit<PtyDriverOptions, 'env' | 'trouble' | 'emulators'>> & {
    env: NodeJS.ProcessEnv
    trouble: ((problem: Error) => void) | undefined
  }

  constructor(opts: PtyDriverOptions = {}) {
    this.opts = {
      scrollback: opts.scrollback ?? DEFAULTS.scrollback,
      replayBytes: opts.replayBytes ?? DEFAULTS.replayBytes,
      attachCommand: opts.attachCommand ?? ((lane) => `tade attach ${lane}`),
      env: opts.env ?? process.env,
      trouble: opts.trouble,
    }
    // Started on the first lane, never here: a driver is made just to ask it
    // what it needs of the machine, and that is not a reason for a thread.
    this.thread = new EmulatorThread({
      entry: opts.emulators ?? EMULATORS,
      heard: (report) => this.heard(report),
      died: (problem, again) => this.died(problem, again),
      reopen: () => this.reopen(),
    })
  }

  /**
   * Node and a pseudo-terminal, which is to say: always, as long as node-pty's
   * helper can actually be run. It is the one thing about this driver a
   * machine can get wrong, and it is worth saying before a lane is opened
   * rather than as five words out of the native layer afterwards.
   */
  async available(): Promise<Availability> {
    const problem = helperProblem(helperAt())
    return problem === null ? { ok: true } : { ok: false, reason: problem }
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
    let pty: IPty
    try {
      pty = spawn(command, spec.args, {
        name: env.TERM ?? 'xterm-256color',
        cwd: spec.cwd,
        cols,
        rows,
        env,
      })
    } catch (error) {
      // `available()` says this too, and nothing is obliged to have asked it.
      const problem = helperProblem(helperAt())
      if (problem === null) throw error
      throw new Error(problem, { cause: error })
    }
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
      key: ++this.keys,
      outputs: new Set(),
      exits: new Set(),
      replay: [],
      replayBytes: 0,
      closed: false,
      encoding: 'legacy',
      tail: '',
      sent: 0,
      frame: null,
      pushes: 0,
      view: null,
      whole: null,
      watching: null,
      waiting: new Set(),
    }
    // Only once the new one is running: a launch that fails leaves the old
    // screen where it was, to be read.
    if (previous && !previous.closed) {
      previous.closed = true
      this.release(previous)
    }
    this.lanes.set(spec.id, lane)
    this.keyed.set(lane.key, lane)
    this.thread.tell({
      do: 'open',
      key: lane.key,
      cols,
      rows,
      scrollback: this.opts.scrollback,
      seq: 0,
      seed: '',
    })

    pty.onData((data) => {
      if (lane.closed) return
      const at = Date.now()
      lane.handle.lastOutputAt = at
      lane.encoding = encodingAfter(lane.tail + data, lane.encoding)
      lane.tail = data.slice(-TAIL)
      // To the emulators first, and as the string node-pty handed over: a
      // `Buffer` made from it comes out of Node's shared pool, and posting one
      // copies the pool rather than the chunk.
      this.thread.tell({ do: 'data', key: lane.key, seq: ++lane.sent, at, data })
      const buf = Buffer.from(data, 'utf8')
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

  /**
   * A capture is a whole frame, and where the newest one is half drawn it is
   * the one before it — a frame one beat old reads as smooth where two frames
   * mixed read as broken. The choice is made here because whether the shutter
   * caught a whole frame is known (`Frame.whole`) and cannot be read off the
   * rows.
   *
   * Answered from the frame the emulators pushed, without asking them, when it
   * already holds everything the lane printed before this was asked; otherwise
   * from the next one they push, which they do once it has settled. Either way
   * a capture taken just after a keystroke was echoed shows the echo.
   */
  async capture(id: LaneId, opts: CaptureOptions): Promise<string> {
    const lane = this.live(id)
    const asked: Asked = { lines: opts.lines, styled: opts.styled ?? false }
    const want = lane.sent
    // A frame the wait ran out on is waited past, as a capture always waited
    // for its own try at a whole one.
    const past = lane.frame?.whole === false ? lane.frame.n : 0
    const fresh = () =>
      lane.frame !== null &&
      answers(lane.frame, asked) &&
      lane.frame.seq >= want &&
      lane.frame.n > past
    this.watch(lane, asked, fresh())
    await this.wait(lane, fresh)
    if (lane.closed) throw new LaneClosedError(id)
    const frame = (fresh() ? lane.frame : null) ?? lastKnown(lane, asked)
    if (!frame) throw cannotTell(id)
    if (!frame.whole && lane.whole && answers(lane.whole, asked)) {
      const held = lane.whole.rows
      lane.whole = null
      return held
    }
    // Kept only for a lane that draws its own screen: the only one whose rows
    // can be two frames mixed.
    lane.whole = frame.whole && frame.alternate ? frame : null
    return frame.rows
  }

  /**
   * How deep the screen is, where typing lands, whose the scrolling and the
   * pointer are — from the newest frame where nothing has been printed since,
   * and otherwise asked, and parsed, and never waited on for a whole frame
   * (`Emulators.look` says why).
   */
  async screen(id: LaneId): Promise<LaneScreen> {
    const lane = this.live(id)
    // Never answered on the spot, for the reason `wait` gives.
    if (lane.view && lane.view.seq >= lane.sent) await turn()
    else await this.ask((ask) => ({ do: 'look', key: lane.key, ask }))
    if (lane.closed) throw new LaneClosedError(id)
    // What the emulators did not answer in time is what they said last: the
    // last reading that could, never none.
    const known = lane.view?.screen
    if (!known) throw cannotTell(id)
    return { ...known, cursor: { ...known.cursor } }
  }

  async wheel(id: LaneId, turn: WheelTurn): Promise<void> {
    const lane = this.live(id)
    // Nothing at all to a program that never asked for the mouse: what it
    // cannot read as a pointer it reads as somebody typing.
    const { pointing } = await this.screen(id)
    if (pointing === 'nobody') return
    const bytes = wheelBytes(turn, lane.encoding)
    if (bytes.length > 0) await this.write(id, bytes)
  }

  async point(id: LaneId, report: PointerReport): Promise<void> {
    const lane = this.live(id)
    // As the wheel does, and for the same reason: only ever as much as the
    // program asked for. `pointerBytes` is where that is decided, so a lane
    // that wants presses and no movement is answered the same way by every
    // driver rather than by whichever one remembered to check.
    const { pointing } = await this.screen(id)
    const bytes = pointerBytes(report, lane.encoding, pointing)
    if (bytes.length > 0) await this.write(id, bytes)
  }

  async resize(id: LaneId, cols: number, rows: number): Promise<void> {
    const lane = this.live(id)
    lane.pty.resize(cols, rows)
    this.thread.tell({ do: 'resize', key: lane.key, seq: ++lane.sent, cols, rows })
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
    this.release(lane)
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
    this.thread.end()
  }

  /**
   * Bytes of typed arrays the emulators hold — which is where a screen buffer
   * lives, and none of it in this thread's heap — or null with no thread to
   * ask. Collected first only where the process allows it, which nothing but
   * a test measuring what a closed lane gives back does.
   */
  async held(): Promise<number | null> {
    if (!this.thread.running) return null
    const report = await this.ask((ask) => ({ do: 'held', ask }))
    return report?.is === 'held' ? report.bytes : null
  }

  /**
   * The lane under an id, still open.
   *
   * A closed lane is kept — its id stays taken until something opens it
   * again, and asking about one is `LaneClosedError` rather than a lane that
   * was never there — but it has let go of everything heavy.
   */
  private live(id: LaneId): Lane {
    const lane = this.lanes.get(id)
    if (!lane) throw new LaneNotFoundError(id)
    if (lane.closed) throw new LaneClosedError(id)
    return lane
  }

  /**
   * Tell the emulators what is being looked at, so they push its frames.
   *
   * Said again only when it changed, or before it would run out — a lane on
   * screen is captured several times a second and nothing about it is news.
   */
  private watch(lane: Lane, asked: Asked, have: boolean): void {
    const now = Date.now()
    const was = lane.watching
    if (have && was && answers(was, asked) && now - was.at < WATCH_MS / 2) return
    lane.watching = { ...asked, at: now }
    this.thread.tell({ do: 'watch', key: lane.key, ...asked })
  }

  /**
   * Until a frame is pushed that makes `ready` true, the lane goes, or the
   * emulators do — bounded.
   *
   * Never answered on the spot, even when it already is: a capture that
   * resolves without ever reaching the event loop is one a loop of captures
   * can call for ever while the output it is waiting to see sits unread
   * behind it. A capture always let the lane's output in before; this keeps it.
   */
  private wait(lane: Lane, ready: () => boolean): Promise<void> {
    if (ready() || lane.closed || this.thread.gone) return turn()
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const waiting: Waiting = {
        ready,
        done: () => {
          clearTimeout(timer)
          lane.waiting.delete(waiting)
          resolve()
        },
      }
      timer = setTimeout(waiting.done, this.bound())
      lane.waiting.add(waiting)
    })
  }

  /** Ask the emulators something, bounded: null when they did not answer. */
  private ask(order: (ask: number) => Order): Promise<Report | null> {
    if (this.thread.gone) return Promise.resolve(null)
    const ask = ++this.asked
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined
      const answer = (report: Report | null) => {
        clearTimeout(timer)
        this.asks.delete(ask)
        resolve(report)
      }
      timer = setTimeout(() => answer(null), this.bound())
      this.asks.set(ask, answer)
      this.thread.tell(order(ask))
    })
  }

  private bound(): number {
    return this.thread.answering ? ANSWER_MS : STARTING_MS
  }

  private heard(report: Report): void {
    if (report.is === 'held') {
      this.asks.get(report.ask)?.(report)
      return
    }
    const lane = this.keyed.get(report.key)
    if (report.is === 'view') {
      if (lane && report.view) saw(lane, report.seq, report.view)
      this.asks.get(report.ask)?.(report)
      return
    }
    if (!lane) return
    lane.frame = { ...report, n: ++lane.pushes }
    saw(lane, report.seq, report.view)
    for (const waiting of lane.waiting) if (waiting.ready()) waiting.done()
  }

  /**
   * The emulators died. Everything waiting on them is answered with what was
   * known before — which is what a screen nobody can read any more is — and
   * what happened is said, because a pane redrawn from its replay or frozen
   * where it was looks like nothing at all went wrong.
   */
  private died(problem: Error, again: boolean): void {
    for (const lane of this.keyed.values()) {
      lane.watching = null
      for (const waiting of lane.waiting) waiting.done()
    }
    for (const answer of [...this.asks.values()]) answer(null)
    const kb = Math.round(this.opts.replayBytes / 1024)
    const said = new Error(
      again
        ? `the terminal emulators failed (${problem.message}) and were started again: ` +
            `every terminal was drawn afresh from the last ${kb}KB it printed, and anything before that is gone from it`
        : `the terminal emulators failed (${problem.message}) and were not started again: ` +
            'every terminal shows what it last showed, until Tade is opened again',
      { cause: problem },
    )
    // Said from inside a thread's exit, where a throw would be one nobody
    // catches: whoever listens may fail to hear it, and nothing more.
    safely(() => this.opts.trouble?.(said))
  }

  /** Every lane with a screen, told to emulators started in place of dead ones. */
  private reopen(): Order[] {
    return [...this.keyed.values()].map((lane) => ({
      do: 'open',
      key: lane.key,
      cols: lane.handle.cols,
      rows: lane.handle.rows,
      scrollback: this.opts.scrollback,
      seq: lane.sent,
      seed: Buffer.concat(lane.replay).toString('utf8'),
    }))
  }

  /**
   * Everything a closed lane can never be asked for again.
   *
   * The record itself stays, so the id reads as closed rather than as missing,
   * and so `open` can tell a lane it is replacing from one that was never
   * there. What goes is what costs: the screen — in the emulators, whose
   * `release` is careful about what keeps one alive — and the bytes kept to
   * replay to a subscriber that will never arrive now.
   */
  private release(lane: Lane): void {
    // Told only to a thread that is there: one started just to be told to
    // forget a screen it never had would be a thread for nothing.
    if (this.thread.running) this.thread.tell({ do: 'release', key: lane.key })
    this.keyed.delete(lane.key)
    lane.frame = null
    lane.view = null
    lane.whole = null
    lane.watching = null
    lane.replay = []
    lane.replayBytes = 0
    lane.outputs.clear()
    lane.exits.clear()
    for (const waiting of lane.waiting) waiting.done()
  }
}

/** Once round the event loop, after whatever I/O is waiting. */
function turn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

function answers(frame: Asked, asked: Asked): boolean {
  return frame.lines === asked.lines && frame.styled === asked.styled
}

function saw(lane: Lane, seq: number, screen: LaneScreen): void {
  if (!lane.view || seq >= lane.view.seq) lane.view = { seq, screen }
}

/**
 * The newest frame known, made to answer what was asked, for when the
 * emulators could not say anything newer in time: the rows asked for, without
 * paint where none was wanted. A pane drawn from what was last known is a
 * pane a beat behind; one drawn from nothing is a pane that says the lane is
 * empty, which it is not.
 */
function lastKnown(lane: Lane, asked: Asked): Pushed | null {
  const frame = lane.frame
  if (!frame || answers(frame, asked)) return frame
  const rows = frame.rows.split('\n').slice(-asked.lines)
  return {
    ...frame,
    ...asked,
    rows: (frame.styled && !asked.styled ? rows.map((row) => row.replace(PAINT, '')) : rows).join(
      '\n',
    ),
  }
}

function cannotTell(id: LaneId): Error {
  return new Error(`cannot tell what ${id} shows: its terminal emulator has not answered`)
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

/** Paint, as a styled frame carries it: the only sequence one has in it. */
const PAINT = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

function safely(fn: () => void): void {
  try {
    fn()
  } catch {
    // A broken subscriber must never take down a lane.
  }
}
