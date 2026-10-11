import { Worker } from 'node:worker_threads'
import type { Order, Report } from './protocol.ts'

// The driver's end of the thread the emulators run on.
//
// Only the emulators go there. node-pty stays on the thread that opened it,
// where it already reads on a thread of its own, and that was measured rather
// than assumed (macOS, Node 26, node-pty 1.1, `pty.node` loaded in a worker):
// it loads and runs there — 24 of 24, 2–6ms once warm — but a worker holding
// a pty does not reliably *stop*. Its teardown runs node-pty's exit-callback
// finalizer, which joins the thread waiting on the child, and when the child
// has not gone — a `spawn-helper` caught between fork and exec — that join
// waits for ever: `terminate()` never resolved 15 times in 40 with four
// ptys printing, and `process.exit()` hung 11 times in 20, which is closing
// Tade hanging half the time. A worker that died on its own threw 0 in 30.
// So the bytes cross from that thread to this one as strings — `pty.onData`
// hands over a string, and a pooled `Buffer` transferred would send the
// whole pool — and the screens never cross back unless somebody is looking.

/** The file the emulators' thread runs. */
export const EMULATORS = new URL('./emulator-thread.ts', import.meta.url)

/**
 * How many times the emulators are started again after dying, before they
 * are left dead.
 *
 * Started again, every screen is drawn afresh from what its lane last
 * printed, which is the best there is — and a thread that dies on something
 * a lane printed dies again on being shown it, so this has to stop.
 */
const LIVES = 3

/**
 * How long the emulators may leave a question unanswered before they are taken
 * for stuck — alive, and never going to say anything again — and ended, which
 * is a death like any other: started again, and said.
 *
 * A thread that is only busy answers within its own bound on a parse, fifty
 * milliseconds after it gets to the question, and gets to it within a slice
 * per lane. Seconds is not busy. Without this a thread caught in a loop is
 * every pane frozen where it was with nothing anywhere saying why, which is
 * the one way of failing a dead thread does not have.
 */
const STUCK_MS = 5_000

export interface ThreadOptions {
  entry: URL
  heard: (report: Report) => void
  /**
   * The emulators died: what it was, and whether they were started again.
   * Everything waiting on them is answered by whatever was known before.
   */
  died: (problem: Error, again: boolean) => void
  /** What a thread started in place of a dead one is told first: every live lane again. */
  reopen: () => Order[]
}

export class EmulatorThread {
  private worker: Worker | null = null
  private deaths = 0
  private heard = false
  /** Why the thread running now is going: what it threw, or that it stopped answering. */
  private cause: unknown = null
  /** Since when a question it was asked has gone unanswered, if one has. */
  private unanswered: number | null = null
  private readonly opts: ThreadOptions

  constructor(opts: ThreadOptions) {
    this.opts = opts
  }

  /** True once they have died more often than they are started again. */
  get gone(): boolean {
    return this.deaths > LIVES
  }

  /** True while a thread is there to be told anything. */
  get running(): boolean {
    return this.worker !== null
  }

  /**
   * True once the thread running now has said anything: until then it is
   * still loading xterm, and being slow to answer is being started, not stuck.
   */
  get answering(): boolean {
    return this.heard
  }

  tell(order: Order): void {
    this.started()?.postMessage(order)
  }

  /**
   * Something waited on the emulators and nothing came. Asks them a question
   * they always answer, and when one has gone unanswered for `STUCK_MS`, ends
   * them as stuck.
   */
  late(): void {
    const worker = this.worker
    if (!worker || !this.heard) return
    const now = Date.now()
    if (this.unanswered === null) {
      this.unanswered = now
      // A look at a lane that is not there: answered at once by any thread
      // that is still taking orders, and by nothing about any lane.
      worker.postMessage({ do: 'look', key: 0, ask: 0 } satisfies Order)
      return
    }
    if (now - this.unanswered < STUCK_MS) return
    this.cause = new Error(`they stopped answering for ${STUCK_MS / 1_000}s`)
    void worker.terminate()
  }

  /**
   * Stop the thread, which is every screen gone.
   *
   * Not waited on: it holds nothing native, so it stops when it is told to,
   * and it never kept this process alive in the first place.
   */
  end(): void {
    const worker = this.worker
    this.worker = null
    void worker?.terminate()
  }

  private started(): Worker | null {
    if (this.worker) return this.worker
    if (this.gone) return null
    let worker: Worker
    try {
      worker = new Worker(this.opts.entry, { name: 'tade terminal emulators' })
    } catch (error) {
      // Not started at all is not started again: every lane keeps running, and
      // what it shows is what was known — which for one just opened is nothing.
      this.deaths = LIVES + 1
      this.opts.died(error instanceof Error ? error : new Error(String(error)), false)
      return null
    }
    this.heard = false
    this.cause = null
    this.unanswered = null
    // Dies with this process, as the lanes do (`detach: false`): it is never
    // a reason for the process to stay.
    worker.unref()
    worker.on('message', (report: Report) => {
      if (this.worker !== worker) return
      this.heard = true
      this.unanswered = null
      this.opts.heard(report)
    })
    worker.on('error', (error) => {
      if (this.worker === worker) this.cause = error
    })
    worker.on('exit', (code) => {
      // Ended on purpose, or already replaced: nothing died.
      if (this.worker !== worker) return
      const cause = this.cause
      this.worker = null
      this.deaths++
      const reason = cause instanceof Error ? cause.message : `it exited with ${code}`
      const again = !this.gone
      if (again) {
        const fresh = this.started()
        for (const order of this.opts.reopen()) fresh?.postMessage(order)
      }
      this.opts.died(new Error(reason, { cause }), again)
    })
    this.worker = worker
    return worker
  }
}
