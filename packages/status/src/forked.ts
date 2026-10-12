import { type ChildProcess, fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { CLOSED, type StatusAnswer, type StatusAsk, type StatusCollector } from './collector.ts'
import { answeredOf, isReady } from './serve.ts'

// Status, looked at in a process of the window's own.
//
// The window draws four times a second on one thread, and a look at status is
// `ps` and three or four `git`s a worktree, the porcelain they print, every
// task file and the last day's transcripts — every two seconds, all of it
// garbage on the heap of the thread that draws. Here it is the child's: the
// window sends an ask, awaits a promise with a deadline, and reads back one
// workspace. The gate that lets a quiet worktree cost a `stat` instead of four
// forks lives in the child too (`serveStatus`), or the storm would only have
// moved house.
//
// A child rather than a worker thread, because the work *is* starting
// processes and reading files, and because a child can be killed when it
// wedges and started again.
//
// What may never happen:
//
// - **The window waits without a deadline.** An ask not answered in
//   `LOOK_MS` is `unknown` for that ask. The look carries on, and the next ask
//   is answered by it rather than starting another: one look at a time, so a
//   machine too busy to answer is never handed a second fork storm to answer
//   as well.
// - **A dead child is an empty world.** It is `unknown`, with why, and the
//   window keeps the last look that could — never a workspace with nothing in
//   it, which everything above reads as "nothing is running".
// - **A child that keeps dying is started again every beat.** Each one that
//   ends without having answered doubles the wait before the next
//   (`RESTART_MS` to `RESTART_MAX_MS`), and in the wait an ask is `unknown` at
//   once rather than a fork.
// - **It outlives the window.** It is not a daemon: it ends when its channel
//   closes (`child.ts`), which is every way a window can go, killed outright
//   included, and `close()` ends it on the way out.

/** The program a look runs in. */
export const CHILD_PATH = fileURLToPath(new URL('./child.ts', import.meta.url))

/**
 * How long the window waits on one look before that ask is `unknown`.
 *
 * Past what a busy machine takes: `ps` alone may take ten seconds before it is
 * a timeout (`PROBE_MS`), and a cold look at thirteen worktrees is fifty git
 * processes four at a time. A look that runs over is still going, and the next
 * beat is answered by it.
 */
export const LOOK_MS = 15_000

/**
 * How long one look may go unanswered before its child is taken for wedged and
 * ended. Not the deadline: a slow look is a busy machine and is waited out,
 * and only one that cannot be a busy machine any more is killed.
 */
export const WEDGED_MS = 120_000

/** The wait before starting a child again after one ended; doubles for each in a row. */
export const RESTART_MS = 1_000

/** And the most it doubles to, so a child that came back is found within a minute. */
export const RESTART_MAX_MS = 60_000

/**
 * How the child's heap is sized: a young generation of two 2 MiB semi-spaces
 * rather than V8's default, which grows to tens of megabytes of headroom for
 * garbage a look no longer makes, and then holds it for the life of the window.
 *
 * Measured against one laptop's transcripts with the reads kept
 * (`TranscriptReads`): the child ended ten beats at 101–140 MB without it and
 * 65–87 MB with it, and its beat times were inside the noise of a machine at
 * load 10–25, which is all a spawn-bound look can say. Only a flag Node documents
 * as its own, because a flag Node does not take is a child that never starts;
 * the conformance suite forks the real child with it, so a Node that stops
 * taking it fails the suite rather than leaving status `unknown`.
 */
export const CHILD_FLAGS: readonly string[] = ['--max-semi-space-size=2']

/** How much of what a child wrote to stderr is kept, to say why it went. */
const TAIL = 4_096

export interface ChildOptions {
  /** How long one ask waits before it is `unknown` (`LOOK_MS`). */
  deadlineMs?: number
  /** How long one look may go unanswered before the child is ended (`WEDGED_MS`). */
  wedgedMs?: number
  /** The first wait before starting another child (`RESTART_MS`). */
  restartMs?: number
  /** The program to run: the child, or a test's stand-in for it. */
  entry?: string
  args?: readonly string[]
  /**
   * Start the child now rather than at the first ask, so the window's first
   * look does not wait for Node to boot one. True unless said otherwise.
   */
  eager?: boolean
}

/** How long to wait before starting a child again, after this many ended in a row. */
export function restartWait(restartMs: number, deaths: number): number {
  return Math.min(RESTART_MAX_MS, restartMs * 2 ** Math.max(0, deaths - 1))
}

interface Running {
  process: ChildProcess
  /** Whether it got as far as listening: false if it went first. */
  ready: Promise<boolean>
  becameReady: (ready: boolean) => void
  /** Asks sent and not yet answered, by id. */
  pending: Map<number, (answer: StatusAnswer) => void>
  tail: string
  gone: boolean
}

/** A collector whose looks happen in a child process the window owns. */
export function lookInChild(opts: ChildOptions = {}): StatusCollector {
  return new InChild(opts)
}

const unknown = (why: string): StatusAnswer => ({ known: false, why })

class InChild implements StatusCollector {
  readonly id = 'child'
  private readonly deadlineMs: number
  private readonly wedgedMs: number
  private readonly restartMs: number
  private readonly entry: string
  private readonly args: readonly string[]
  private running: Running | null = null
  /** The look under way, which every ask made meanwhile is answered by. */
  private flight: Promise<StatusAnswer> | null = null
  /** Children that ended in a row without answering, which is what the wait doubles on. */
  private deaths = 0
  private restartAt = 0
  private why = ''
  private seq = 0
  private closed = false

  constructor(opts: ChildOptions) {
    this.deadlineMs = opts.deadlineMs ?? LOOK_MS
    this.wedgedMs = opts.wedgedMs ?? WEDGED_MS
    this.restartMs = opts.restartMs ?? RESTART_MS
    this.entry = opts.entry ?? CHILD_PATH
    this.args = opts.args ?? []
    if (opts.eager !== false) this.start()
  }

  async collect(ask: StatusAsk): Promise<StatusAnswer> {
    if (this.closed) return unknown(CLOSED)
    // Let go by the ask that is handed its answer, and never when it settles:
    // a look that lands between asks, with nobody waiting on it, is the
    // answer to the next one rather than thrown away for a second look to
    // start over — which, on a machine slow enough to miss one deadline,
    // missed every one after it.
    if (this.flight === null) this.flight = this.look(ask)
    const flight = this.flight
    const answer = await within<StatusAnswer | null>(flight, this.deadlineMs, null)
    if (answer === null) {
      return unknown(
        `status took longer than ${seconds(this.deadlineMs)} to look, which is a busy machine rather than a broken one: still looking`,
      )
    }
    if (this.flight === flight) this.flight = null
    return answer
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    const child = this.running
    if (!child) return
    const exited = new Promise<void>((resolve) => {
      if (hasExited(child.process)) resolve()
      else child.process.once('exit', () => resolve())
    })
    this.gone(child, CLOSED)
    // Held until it has gone, so whoever awaits this sees it go rather than
    // the loop running out of things to wait on first.
    child.process.ref()
    try {
      child.process.disconnect()
      child.process.kill('SIGTERM')
    } catch {
      // Already gone, which is what was wanted.
    }
    await within(exited, 2_000, undefined)
    if (!hasExited(child.process)) {
      try {
        child.process.kill('SIGKILL')
      } catch {
        // As above.
      }
    }
  }

  private async look(ask: StatusAsk): Promise<StatusAnswer> {
    const child = this.running ?? this.start()
    if (child === null) return unknown(this.later())
    const id = ++this.seq
    const answered = new Promise<StatusAnswer>((resolve) => child.pending.set(id, resolve))
    // From the ask rather than from its sending: a child that never got as far
    // as listening is as wedged as one that stopped answering.
    const wedge = setTimeout(
      () =>
        this.end(
          child,
          `status stopped answering: nothing in ${seconds(this.wedgedMs)}, so its process was ended`,
        ),
      this.wedgedMs,
    )
    wedge.unref?.()
    this.hold(child, true)
    void child.ready.then((ready) => {
      if (ready) this.send(child, { id, ask })
    })
    try {
      return await answered
    } finally {
      clearTimeout(wedge)
      this.hold(child, child.pending.size > 0)
    }
  }

  /** A child, started now, or null while the wait after the last one runs. */
  private start(): Running | null {
    if (this.closed || Date.now() < this.restartAt) return null
    let proc: ChildProcess
    try {
      proc = fork(this.entry, [...this.args], {
        // Never the terminal's: the window is drawing on it.
        stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
        // Its own process group, as every probe is, so the terminal never
        // takes it for the program in front of it. Its life is still the
        // window's: it ends when the channel does.
        detached: true,
        // None of the window's own flags: an inspector port it is holding
        // is not one a second process can open.
        execArgv: [...CHILD_FLAGS],
        serialization: 'json',
      })
    } catch (err) {
      this.died(`status could not start a process to look in: ${String(err)}`)
      return null
    }
    let becameReady: (ready: boolean) => void = () => {}
    const ready = new Promise<boolean>((resolve) => {
      becameReady = resolve
    })
    const child: Running = {
      process: proc,
      ready,
      becameReady,
      pending: new Map(),
      tail: '',
      gone: false,
    }
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      child.tail = (child.tail + chunk).slice(-TAIL)
    })
    proc.on('message', (message) => this.heard(child, message))
    proc.on('error', (err) => this.gone(child, `status's process failed: ${err.message}`))
    // On its exit, once what it last wrote to stderr has been read — and not on
    // `close`, which a channel this side disconnected never sends.
    proc.on('exit', (code, signal) => {
      const said = () => this.gone(child, ended(code, signal, child.tail))
      const err = proc.stderr
      if (!err || err.destroyed || err.readableEnded) return said()
      err.once('close', said)
      setTimeout(said, 250).unref?.()
    })
    this.running = child
    this.hold(child, false)
    return child
  }

  private heard(child: Running, message: unknown): void {
    if (isReady(message)) {
      child.becameReady(true)
      return
    }
    const answered = answeredOf(message)
    if (answered === null) {
      this.end(child, "status's process said something that is not an answer, so it was ended")
      return
    }
    const resolve = child.pending.get(answered.id)
    if (!resolve) return
    child.pending.delete(answered.id)
    if (answered.answer.known) this.deaths = 0
    resolve(answered.answer)
  }

  private send(child: Running, message: { id: number; ask: StatusAsk }): void {
    const failed = (err: unknown) =>
      this.end(
        child,
        `status's process could not be asked: ${err instanceof Error ? err.message : String(err)}`,
      )
    try {
      child.process.send(message, (err) => {
        if (err) failed(err)
      })
    } catch (err) {
      failed(err)
    }
  }

  /** End a child, saying why, before it has said anything else. */
  private end(child: Running, why: string): void {
    this.gone(child, why)
    try {
      child.process.kill('SIGKILL')
    } catch {
      // Already gone.
    }
  }

  /** A child has gone. Once per child: the first reason given is the one that stands. */
  private gone(child: Running, why: string): void {
    if (child.gone) return
    child.gone = true
    child.becameReady(false)
    if (this.running === child) this.running = null
    if (!this.closed) this.died(why)
    for (const resolve of child.pending.values()) resolve(unknown(why))
    child.pending.clear()
  }

  private died(why: string): void {
    this.deaths++
    this.why = why
    this.restartAt = Date.now() + restartWait(this.restartMs, this.deaths)
  }

  /**
   * Why there is no look, while the wait before the next child runs. The same
   * sentence for the whole of one wait — a countdown in it would be a new
   * notice in the window every beat.
   */
  private later(): string {
    return `${this.why}; starting it again after ${seconds(restartWait(this.restartMs, this.deaths))}`
  }

  /**
   * Keep the window's process alive while it is waiting on an answer, and
   * never otherwise: an idle child is no reason for anything not to exit.
   */
  private hold(child: Running, on: boolean): void {
    if (child.gone) return
    const handles = [child.process, child.process.channel]
    for (const handle of handles) {
      if (on) handle?.ref()
      else handle?.unref()
    }
  }
}

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

/** Why a child that ended did, in words: its exit, and the line of stderr that says most. */
function ended(code: number | null, signal: NodeJS.Signals | null, tail: string): string {
  const how = signal ? `was ended by ${signal}` : `exited ${code ?? 'without a code'}`
  const said = lastWords(tail)
  return `status's process ${how}${said ? `: ${said}` : ''}`
}

/** The error a dying Node printed, or else the last thing it said that is not its version. */
export function lastWords(tail: string): string {
  const lines = tail
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
  return (
    lines.find((line) => /^[\w.]*(Error|Exception)\b/.test(line)) ??
    lines.filter((line) => !/^Node\.js v\d/.test(line)).at(-1) ??
    ''
  )
}

function seconds(ms: number): string {
  return `${Math.ceil(ms / 1000)}s`
}

async function within<T>(work: Promise<T>, ms: number, instead: T): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(instead), ms)
        timer.unref?.()
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
