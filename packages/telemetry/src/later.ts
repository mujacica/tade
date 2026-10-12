import { noReporter } from './none.ts'
import type { Attributes, Reporter, Span, Work } from './port.ts'

// A reporter that can be handed out now, and opens the one it stands for
// later — after the window has drawn.
//
// Opening Sentry's SDK is importing it, and that was 250–500 ms of a window
// opening (load 5–22 on 14 cores) spent before anything was drawn, on every
// open of a Tade with a DSN set. Nothing it does is needed for the first
// frame: what is reported in the meantime is kept, in order, and handed over
// when the real one is open — a span timed from the moment it began rather
// than the moment it was handed over, so how long Tade took to open still
// says how long Tade took to open. A crash before then is still reported:
// `flush` and `close` open it, so the fatal hook (`watchProcess`) has its one
// chance to be sent either way.

/** A reporter usable now, and the call that opens the real one behind it. */
export interface Later {
  reporter: Reporter
  /** Open the reporter it stands for and hand it what was kept. Safe twice. */
  open(): Promise<void>
}

/** A span begun before there was a reporter to time it, played onto one once there is. */
class LateSpan implements Span {
  private readonly now: () => number
  private real: Span | null = null
  private kept: ((span: Span) => void)[] = []

  constructor(now: () => number) {
    this.now = now
  }

  about(attributes: Attributes): void {
    this.play((span) => span.about(attributes))
  }

  inside(work: Work): Span {
    const child = new LateSpan(this.now)
    const stamped = stampOf(work, this.now)
    this.play((span) => child.become(span.inside(stamped)))
    return child
  }

  wrong(error: unknown): void {
    this.play((span) => span.wrong(error))
  }

  end(at?: number): void {
    const ended = at ?? this.now()
    this.play((span) => span.end(ended))
  }

  /** The real span, at last: everything said to this one, said again to it in order. */
  become(span: Span): void {
    this.real = span
    const kept = this.kept
    this.kept = []
    for (const one of kept) one(span)
  }

  private play(act: (span: Span) => void): void {
    if (this.real) act(this.real)
    else this.kept.push(act)
  }
}

/** Work with the moment it began written on it, so timing it later still times it from then. */
function stampOf(work: Work, now: () => number): Work {
  return work.startedAt === undefined ? { ...work, startedAt: now() } : work
}

/** How long `close` waits for the reporter to open when it never was: a crash's one chance. */
const OPEN_MS = 2_000

/**
 * A reporter that stands in for `make`'s until `open` is called.
 *
 * `on` is said now, by whoever knows whether there is anywhere to send — the
 * one question a call site asks before reporting at all — so a stand-in for
 * a reporter that turns out to send nothing only ever queues for nothing.
 */
export function later(
  make: () => Promise<Reporter>,
  opts: { on: boolean; now?: () => number },
): Later {
  if (!opts.on) return { reporter: noReporter(), open: async () => {} }
  const now = opts.now ?? Date.now
  let real: Reporter | null = null
  let kept: ((reporter: Reporter) => void)[] = []
  let opening: Promise<void> | null = null
  const open = (): Promise<void> => {
    opening ??= make()
      .catch(() => noReporter())
      .then((reporter) => {
        real = reporter
        const waiting = kept
        kept = []
        for (const one of waiting) one(reporter)
      })
    return opening
  }
  const play = (act: (reporter: Reporter) => void) => {
    if (real) act(real)
    else kept.push(act)
  }
  // Opened, or given up on after `ms`: never a wait without a deadline.
  const opened = (ms: number) =>
    Promise.race([open(), new Promise<void>((done) => setTimeout(done, ms).unref?.())])
  const reporter: Reporter = {
    get id() {
      return real?.id ?? 'later'
    },
    on: true,
    trouble: (trouble) => play((one) => one.trouble(trouble)),
    note: (note) => play((one) => one.note(note)),
    measure: (measure) => play((one) => one.measure(measure)),
    doing(work) {
      if (real) return real.doing(work)
      const span = new LateSpan(now)
      const stamped = stampOf(work, now)
      kept.push((one) => span.become(one.doing(stamped)))
      return span
    },
    async flush(ms = 2_000) {
      const started = now()
      await opened(ms)
      await real?.flush(Math.max(0, ms - (now() - started)))
    },
    async close() {
      // Nothing was ever said and nobody opened it: there is nothing to send,
      // and loading an SDK on the way out to send nothing is the cost this
      // file exists to take off the way in.
      if (!real && !opening && kept.length === 0) return
      await opened(OPEN_MS)
      await real?.close()
    },
  }
  return { reporter, open }
}
