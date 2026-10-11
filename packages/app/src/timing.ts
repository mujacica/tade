import { writeFileSync } from 'node:fs'

// What a frame cost, where it went, and nothing until somebody asks.
//
// "The window feels laggy under load" is a p99 statement, and nothing in Tade
// could answer it: the only number anywhere near the frame loop was
// `SLOW_LOOK_MS`, which reports a look that took over two seconds and says
// nothing about the four hundred that did not. A mean would have looked fine
// on every case worth measuring.
//
// So: four points a frame passes through, each with a histogram, and the
// quantiles taken out of it rather than an average.
//
//   frameOf   the fold of the subjects into a `Frame` — plus one per subject
//   draw      the pure composition of the five regions into rows
//   doRender  pi-tui's own pipeline, after Tade hands the rows over
//   write     how long the terminal took to *accept* the bytes
//
// **They nest, and must never be added up.** `doRender` contains `write`, and
// contains the component render, which is `frameOf` and `draw`. Reading them
// is subtraction, not a total.
//
// `write` is the one nobody had looked at. On POSIX a write to a TTY is
// synchronous, so the last act of every frame blocks until the terminal
// drains it — which means a loaded machine's slow emulator is on Tade's event
// loop, and `write`'s p99 against `draw`'s is what says whether Tade or the
// terminal is the limit on a given machine.
//
// **Off by default, and off costs a boolean.** `start()` reads no clock and
// `took()` returns on the first line, so the probes can sit on the hot path
// permanently rather than being wired in by whoever is measuring that week —
// which is how instrumentation ends up measuring something other than what
// shipped. `TADE_TIMING=1` prints a table when the window closes;
// `TADE_TIMING=<path>` writes it there as JSON, which is what
// `packages/app/scripts/bench.ts` reads. The two pi-tui points are measured in
// `wire/paint.ts`, where everything else about the terminal itself lives.
//
// Not the reporter, deliberately: `report.doing` is for Tade's own trouble,
// one span at a time, and sixty frames a second down that path would be a
// cost of its own as well as a flood. What telemetry is allowed to carry is an
// allow-list; this is a developer's instrument and stays on the machine.

/** The four points a frame passes through, in the order it passes them. */
export const POINTS = ['frameOf', 'draw', 'doRender', 'write'] as const

/** What one point cost, over the samples kept of it. */
export interface Span {
  /** Every sample taken, including the ones the ring has since dropped. */
  count: number
  /** How many of them the quantiles were taken over. */
  kept: number
  /**
   * The quickest one ever seen, which the ring never forgets.
   *
   * The one figure here that is about the code rather than about the machine.
   * Everything above the median on a loaded machine is the scheduler: the same
   * pure draw measured a 0.67ms p50 and a 119ms p99 at load 78 on 14 cores,
   * and the p99 was entirely other people's work. A starved process's quickest
   * go is the one where it got the machine — which is the argument
   * `screens.test.ts` already makes for taking the best of several rounds, and
   * the reason it is kept beside the quantiles rather than instead of them.
   */
  best: number
  p50: number
  p95: number
  p99: number
  /** The worst one ever seen, which the ring never forgets. */
  worst: number
}

/**
 * Samples kept per point.
 *
 * A window left open all day at sixty frames a second is twenty million
 * samples, and a probe that grows without bound is a memory leak somebody
 * turned on deliberately. The ring holds the most recent of them — which is
 * also the right window for "how does it feel *now*" — while `count`, `best`
 * and `worst` stay exact over everything ever measured, so neither how much
 * has happened nor either end of it is lost to the bound.
 */
export const KEPT = 4_096

/**
 * The value at `q` of samples already in order, by nearest rank.
 *
 * Nearest rank rather than interpolated: every answer is a frame that really
 * happened, which is what makes "the p99 frame" a thing somebody can go and
 * look at. `q` outside 0..1 is clamped, and no samples is no answer.
 */
export function quantile(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null
  const at = Math.ceil(Math.min(1, Math.max(0, q)) * sorted.length) - 1
  return sorted[Math.min(sorted.length - 1, Math.max(0, at))] ?? null
}

/**
 * The histograms, one per point, and whether anything is being measured at all.
 *
 * One per process rather than one per window: there is one window per home,
 * and a probe threaded through twenty-two subjects to reach the one place it
 * is read would be more wiring than the thing it measures.
 */
export class Timings {
  /** Whether anything is recorded. Read it before building a point's name. */
  readonly on: boolean
  private readonly samples = new Map<string, number[]>()
  private readonly counts = new Map<string, number>()
  private readonly worsts = new Map<string, number>()
  private readonly bests = new Map<string, number>()
  /** Where the next sample goes in each ring, once a ring is full. */
  private readonly next = new Map<string, number>()

  constructor(on: boolean) {
    this.on = on
  }

  /** The moment to measure from. Zero, and no clock read, while off. */
  start(): number {
    return this.on ? performance.now() : 0
  }

  /** What has happened since `at` belongs to `point`. */
  took(point: string, at: number): void {
    if (!this.on) return
    this.sample(point, performance.now() - at)
  }

  /**
   * A measurement somebody else made belongs to `point`.
   *
   * The door a bench comes in by: it has already timed something (and often
   * files the same measurement under two names — the region and the screen it
   * was part of), so timing it again here would be a second clock read and a
   * second answer. It is also what lets the quantiles be checked against
   * numbers somebody wrote down rather than against a machine.
   */
  sample(point: string, ms: number): void {
    if (!this.on) return
    this.counts.set(point, (this.counts.get(point) ?? 0) + 1)
    this.worsts.set(point, Math.max(this.worsts.get(point) ?? 0, ms))
    this.bests.set(point, Math.min(this.bests.get(point) ?? Number.POSITIVE_INFINITY, ms))
    const ring = this.samples.get(point)
    if (ring === undefined) {
      this.samples.set(point, [ms])
      return
    }
    if (ring.length < KEPT) {
      ring.push(ms)
      return
    }
    const at = this.next.get(point) ?? 0
    ring[at] = ms
    this.next.set(point, (at + 1) % KEPT)
  }

  /** Every point anything was recorded for. */
  points(): string[] {
    return [...this.counts.keys()]
  }

  /** What one point cost, or nothing where it was never reached. */
  span(point: string): Span | null {
    const count = this.counts.get(point)
    const ring = this.samples.get(point)
    if (count === undefined || ring === undefined || ring.length === 0) return null
    const sorted = [...ring].sort((a, b) => a - b)
    return {
      count,
      kept: sorted.length,
      best: this.bests.get(point) ?? 0,
      p50: quantile(sorted, 0.5) ?? 0,
      p95: quantile(sorted, 0.95) ?? 0,
      p99: quantile(sorted, 0.99) ?? 0,
      worst: this.worsts.get(point) ?? 0,
    }
  }

  /** Every point that was reached, by name. */
  spans(): Record<string, Span> {
    const out: Record<string, Span> = {}
    for (const point of this.points()) {
      const span = this.span(point)
      if (span) out[point] = span
    }
    return out
  }

  /** Forget everything measured so far, keeping the probes on. */
  clear(): void {
    this.samples.clear()
    this.counts.clear()
    this.worsts.clear()
    this.bests.clear()
    this.next.clear()
  }
}

/**
 * The points in the order somebody reads them: the four of a frame first, in
 * the order a frame passes them, then whatever else was measured, dearest p99
 * first.
 *
 * Dearest first because the subjects are what that ordering is for: twenty-two
 * of them are folded into every frame, and which three to memoise is a
 * question about their p99s rather than about their names.
 */
export function ordered(spans: Record<string, Span>): string[] {
  const named = POINTS.filter((point) => spans[point] !== undefined) as string[]
  const rest = Object.keys(spans)
    .filter((point) => !named.includes(point))
    .sort((a, b) => (spans[b]?.p99 ?? 0) - (spans[a]?.p99 ?? 0))
  return [...named, ...rest]
}

/** Milliseconds, as a column. */
function ms(n: number): string {
  return n.toFixed(n < 10 ? 2 : 1)
}

/** What was measured, as a table somebody reads. */
export function table(spans: Record<string, Span>): string {
  const names = ordered(spans)
  if (names.length === 0) return 'nothing was measured\n'
  const widest = Math.max(5, ...names.map((name) => name.length))
  const column = (text: string) => text.padStart(8)
  const rows = [
    `${'point'.padEnd(widest)}  ${'count'.padStart(7)}  ${['best', 'p50', 'p95', 'p99', 'worst'].map(column).join('  ')}`,
  ]
  for (const name of names) {
    const span = spans[name]
    if (!span) continue
    rows.push(
      `${name.padEnd(widest)}  ${String(span.count).padStart(7)}  ${[span.best, span.p50, span.p95, span.p99, span.worst].map((n) => column(ms(n))).join('  ')}`,
    )
  }
  return `${rows.join('\n')}\n`
}

/**
 * What the flag says: nothing, a table at the end, or a file to put it in.
 *
 * `0`, `false` and `off` turn it off rather than naming a file called `0`,
 * because a flag whose only off switch is unsetting it is one somebody leaves
 * on. Anything that is not a plain yes or no is where the JSON goes.
 */
export function timingFlag(env: NodeJS.ProcessEnv): { on: boolean; to: string | null } {
  const said = env.TADE_TIMING?.trim() ?? ''
  if (said === '' || ['0', 'false', 'off', 'no'].includes(said.toLowerCase()))
    return { on: false, to: null }
  if (['1', 'true', 'on', 'yes'].includes(said.toLowerCase())) return { on: true, to: null }
  return { on: true, to: said }
}

/** Probes as the environment asks for them. */
export function timingsFrom(env: NodeJS.ProcessEnv): Timings {
  return new Timings(timingFlag(env).on)
}

/**
 * Hand the summary over: a file where one was named, and the terminal Tade ran
 * in otherwise.
 *
 * Taking both doors as arguments is what makes the decision testable without
 * writing a file or printing anything, which is the only part of this file
 * that touches the machine.
 */
export function handOver(
  timings: Timings,
  to: string | null,
  say: (text: string) => void,
  save: (path: string, text: string) => void,
): void {
  if (!timings.on) return
  const spans = timings.spans()
  if (Object.keys(spans).length === 0) return
  if (to === null) {
    say(`\ntade timing\n${table(spans)}`)
    return
  }
  save(to, `${JSON.stringify({ spans, order: ordered(spans) }, null, 2)}\n`)
}

/**
 * The probes the window's own frame loop reports to.
 *
 * A function rather than the value, so a bench or a probe test can put its own
 * in front of it for the length of a measurement. Everything on the hot path
 * asks for it per frame, which is one property read.
 */
let current = timingsFrom(process.env)

export function timing(): Timings {
  return current
}

/** Measure into these until the returned function is called. */
export function probing(timings: Timings): () => void {
  const was = current
  current = timings
  return () => {
    current = was
  }
}

// Said on the way out, here rather than in `app.ts`'s `stop()`: every way the
// window ends goes through this — the quit panel, a signal the CLI turns into
// a stop, a throw — and none of them has to remember to. Registered only when
// the flag is on, so a window nobody is measuring gains no handler at all.
const FLAG = timingFlag(process.env)
if (FLAG.on) {
  const asked = current
  const say = (text: string) => process.stderr.write(text)
  process.on('exit', () => handOver(asked, FLAG.to, say, writeFileSync))
}
