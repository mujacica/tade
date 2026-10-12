import { spawn } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LaneId } from '@tade/core'
import { PtyDriver } from '@tade/drivers-pty'
import { type Span, Timings, table } from '../src/timing.ts'
import {
  benchFrames,
  benchSteady,
  REGIONS,
  SIZES,
  type Size,
  STEADY_FRAMES,
  sizeNamed,
} from '../test/bench.ts'
import { seedHome } from './capture.ts'
import { benchOpen } from './open.ts'

// What the window costs, and what it owes the person typing at it.
//
//   pnpm bench                     both, every size
//   pnpm bench frames              what composing a frame costs — pure, no terminal
//   pnpm bench window              the real window in a real terminal, idle then loaded
//   pnpm bench open                time to the first frame on a seeded home (`scripts/open.ts`)
//   pnpm bench open --journal ~/.tade   the same with that home's journal and index copied in
//   pnpm bench --size 160x45       one size instead of all three
//   pnpm bench --rounds 40         how many times each screen is drawn (frames)
//   pnpm bench --steady 4          how many runs of each screen with a lane printing (frames)
//   pnpm bench --keys 40           how many keystrokes each echo round sends (window)
//   pnpm bench --load 12           how many busy processes "loaded" means
//
// Two instruments, because the question has two halves.
//
// **frames** is pure: `draw` over the 141 scenarios the goldens already hold,
// at three sizes, timed per region and per screen. No terminal, no agent, no
// git. It is the one to run after changing anything about the drawing, and the
// one whose numbers mean the same thing twice.
//
// **window** is the whole program: it opens the real `tade app` in a real pty
// on a disposable home, types at it, and measures two things at once —
// keystroke-to-echo from out here, and the four frame points from inside,
// which the window writes out as JSON on its way down because `TADE_TIMING`
// asked it to. Then it does the same again with the machine loaded.
//
// **Keystroke-to-echo p99 under load is the one number that matters.**
// Everything else is diagnosis. It is measured by content and not by the first
// byte back: the i-th key is echoed when the window has drawn i of them, which
// an unrelated frame cannot satisfy — a spinner tick arriving between the key
// and its echo would otherwise be timed as the echo.
//
// Run it with the machine to itself, and read the loaded half as being about
// this machine. Every number here is milliseconds of this laptop, on this
// day; what carries between machines is the shape — which region is dear,
// whether `write` moves when the machine is loaded and `draw` does not.
//
// **What it does not measure yet**, so nobody reads a green bench as a quiet
// window: agents. Every case here is a window with nothing running in it.
// Thirteen agents streaming flat out, a wheel flick over a pane, a 2 KB paste,
// an alternate-screen agent repainting in place, opening a terminal, one status
// scan of thirteen worktrees, a resize, and thirteen lanes at full scrollback
// are each a case of their own and each wants an agent or a lane this does not
// start. The four probe points are already in the window for all of them —
// `TADE_TIMING` on your own window answers any of them today — and what is
// missing is the driving, not the instrument.

const here = dirname(fileURLToPath(import.meta.url))
const repo = join(here, '..', '..', '..')

const args = process.argv.slice(2)

/** Every flag that takes the word after it, so that word is not read as a mode. */
const TAKES = [
  '--size',
  '--rounds',
  '--warm',
  '--steady',
  '--keys',
  '--load',
  '--runs',
  '--journal',
]

const modes = args.filter((arg, at) => !arg.startsWith('--') && !TAKES.includes(args[at - 1] ?? ''))
const numberArg = (name: string, fallback: number, least = 1): number => {
  const at = args.indexOf(`--${name}`)
  if (at < 0) return fallback
  const said = Number(args[at + 1])
  return Number.isFinite(said) && said >= least ? Math.floor(said) : fallback
}
const sizeArg = (): readonly Size[] => {
  const at = args.indexOf('--size')
  if (at < 0) return SIZES
  const one = sizeNamed(args[at + 1] ?? '')
  if (!one) {
    throw new Error(`--size takes one of ${SIZES.map((size) => size.name).join(', ')}`)
  }
  return [one]
}

/**
 * Rounds of every screen, for the pure bench.
 *
 * Forty is 5,640 draws a size, which is enough samples per region to have a
 * p99 that means something and enough per screen (forty) to compare two of
 * them. It takes a few seconds.
 */
const ROUNDS = numberArg('rounds', 40)

/**
 * Rounds thrown away before any are kept.
 *
 * A first draw of 141 screens is 141 functions being compiled, and the second
 * is V8 deciding which of them to optimise. One warm-up round left a `draw`
 * p99 of 94ms against a p50 of 0.66 — a figure entirely about the compiler,
 * which is the shape a bench is most often wrong in. Three rounds settle it.
 *
 * What is *not* thrown away after that is a slow frame: `worst` on a warm run
 * is usually a garbage collection, and a GC pause is a frame somebody saw.
 */
const WARM = numberArg('warm', 3)

/**
 * Rounds of the steady run, which is `STEADY_FRAMES` frames of every screen a
 * round, both ways: four is thirty-four thousand frames a size, and takes
 * about as long as the forty rounds above.
 */
const STEADY_ROUNDS = numberArg('steady', 4)

/**
 * Keystrokes per round.
 *
 * Every key is one frame and no frame happens without one, so this is also how
 * many samples the four points inside the window get: ten keys gave fourteen
 * frames, and a p99 of fourteen samples is the worst of them wearing a
 * quantile's name. A hundred and twenty is about sixteen seconds a round.
 */
const KEYS = numberArg('keys', 120)

/**
 * Characters typed before the line is cleared and the run starts again.
 *
 * The echo is found by content — i keys typed means i of them drawn — and that
 * only works while the whole run fits on the line. Twenty is inside the
 * narrowest window measured here.
 */
const RUN = 20

/**
 * How many busy processes "loaded" means.
 *
 * Three per core, which is the condition the report this bench exists for was
 * written under — "load average 40.6 on 14 cores". A shell spinning is a
 * couple of megabytes rather than a whole V8 isolate, so forty-two of them
 * load the scheduler without also being a memory experiment.
 *
 * `--load 0` asks for the idle half alone, which is what to use on a machine
 * that is already busy with somebody else's work: the loaded half of this
 * bench is only about load this bench caused.
 */
const LOAD = numberArg('load', cpus().length * 3, 0)

const say = (text: string): void => {
  process.stdout.write(`${text}\n`)
}

/**
 * What the machine was doing while this was measured.
 *
 * Printed under every table rather than left as a courtesy, because the
 * courtesy is what gets forgotten: the pure draw bench measured a 0.67ms p50
 * and a 119ms p99 on this laptop at load 78 on 14 cores, and the p99 was other
 * agents' work with nothing to do with Tade. A figure here that is read
 * without its load is a figure about nothing — so there is no way to get one.
 */
function conditions(): string {
  const [one] = loadavg()
  return `load ${(one ?? 0).toFixed(1)} on ${cpus().length} cores · ${process.platform} · node ${process.versions.node}`
}

/** A heading with a rule under it, so two tables are never read as one. */
function heading(text: string): void {
  say(`\n${text}\n${'─'.repeat(text.length)}`)
  say(conditions())
}

// ─── what composing a frame costs ────────────────────────────────────────────

function frames(sizes: readonly Size[]): void {
  for (const size of sizes) {
    // Thrown away before anything is kept: see `WARM`.
    benchFrames(size, WARM)
    const { timings, drew } = benchFrames(size, ROUNDS)
    const spans = timings.spans()
    heading(
      `frames at ${size.name} — ${spans.draw?.count ?? 0} draws over ${ROUNDS} rounds, after ${WARM} discarded`,
    )
    say(`${drew.rows.toLocaleString('en-US')} rows composed`)
    say('')
    say(
      table({
        ...(spans.draw ? { draw: spans.draw } : {}),
        ...Object.fromEntries(
          Object.entries(spans).filter(([point]) => point.startsWith('region:')),
        ),
      }),
    )
    say('the ten dearest screens')
    say(table(dearest(spans, 'screen:', 10)))
    steady(size)
  }
}

/**
 * The same screens as a run of frames with only the pane moving: every region
 * drawn from nothing, against the last frame's kept (`test/bench.ts` says why
 * this is the case the window is in).
 */
function steady(size: Size): void {
  benchSteady(size, 1)
  const { timings, tally } = benchSteady(size, STEADY_ROUNDS)
  const spans = timings.spans()
  heading(
    `a lane printing at ${size.name} — ${STEADY_FRAMES} frames a screen, each one look later with one line more`,
  )
  say(table(spans))
  say(
    REGIONS.map((region) => {
      const { drawn, kept } = tally[region]
      return `${region} kept ${Math.round((100 * kept) / Math.max(1, drawn + kept))}%`
    }).join(' · '),
  )
}

/** The `many` dearest points with this prefix, by p99. */
function dearest(spans: Record<string, Span>, prefix: string, many: number): Record<string, Span> {
  return Object.fromEntries(
    Object.entries(spans)
      .filter(([point]) => point.startsWith(prefix))
      .sort(([, a], [, b]) => b.p99 - a.p99)
      .slice(0, many),
  )
}

// ─── the real window, idle and loaded ────────────────────────────────────────

/**
 * Busy processes, until the returned function is called.
 *
 * Detached and in its own process group, as everything Tade starts is — and
 * ended on a ctrl+c as well as on the way out, because a bench that leaves
 * forty-two spinning shells behind on a signal is worse than no bench: the
 * next thing anybody measures on this machine is measuring them.
 */
function induce(many: number): { started: number; stop: () => void } {
  const kids = Array.from({ length: many }, () =>
    spawn('sh', ['-c', 'while :; do :; done'], { stdio: 'ignore', detached: true }),
  )
  const started = kids.filter((kid) => kid.pid !== undefined).length
  const stop = () => {
    for (const kid of kids) {
      try {
        kid.kill('SIGKILL')
      } catch {
        // Already gone, which is the outcome wanted.
      }
    }
  }
  const onSignal = () => {
    stop()
    process.exit(130)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)
  return {
    started,
    stop: () => {
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
      stop()
    },
  }
}

/**
 * The window has drawn something, and then stopped.
 *
 * Two waits and not one, because "nothing has come out for 1.2 seconds" is
 * true of a window that has not started yet — and on a loaded machine that is
 * not a corner case: the first byte of the first frame took **thirteen
 * seconds** to arrive at load 70 on this laptop. A bench that began typing at
 * 1.2s measured four keystrokes into a program that did not exist, and then
 * killed it before the CLI had installed the signal handler that turns a
 * SIGTERM into a clean stop — so the timing file was never written either.
 * One missing wait, and both halves of the answer were wrong.
 */
async function opened(driver: PtyDriver, lane: LaneId, most: number): Promise<boolean> {
  let drew = false
  const stop = driver.onOutput(lane, () => {
    drew = true
  })
  const until = Date.now() + most
  try {
    while (!drew && Date.now() < until) await new Promise((done) => setTimeout(done, 20))
  } finally {
    stop()
  }
  return drew
}

/** Nothing has come out of the lane for `quiet` ms: the window has stopped drawing. */
async function settled(
  driver: PtyDriver,
  lane: LaneId,
  quiet: number,
  most: number,
): Promise<boolean> {
  let last = Date.now()
  const stop = driver.onOutput(lane, () => {
    last = Date.now()
  })
  const until = Date.now() + most
  try {
    while (Date.now() < until) {
      if (Date.now() - last >= quiet) return true
      await new Promise((done) => setTimeout(done, 10))
    }
    return false
  } finally {
    stop()
  }
}

const ESC = String.fromCharCode(27)
const SEQUENCES = new RegExp(
  `${ESC}\\[[0-9;?]*[A-Za-z]|${ESC}\\][^${String.fromCharCode(7)}]*`,
  'g',
)

/**
 * Type `keys` characters at the window one at a time, timing each until the
 * window has drawn it.
 *
 * By content, not by the first byte back: after the i-th key the drawn line
 * holds i of them, and nothing else the window draws can say that. A spinner
 * tick landing between the key and its echo would otherwise be timed as the
 * echo, which is exactly the measurement that flatters a loaded machine.
 *
 * `missed` is a key whose echo never arrived inside the deadline. It is
 * reported rather than recorded as a slow frame: a key that was dropped is
 * news of a different kind from a key that was slow. `run` is how many are
 * still on the line at the end, which is what the screen is then checked for.
 */
async function echoes(
  driver: PtyDriver,
  lane: LaneId,
  keys: number,
  timings: Timings,
): Promise<{ missed: number; run: number }> {
  let missed = 0
  let run = 0
  for (let key = 0; key < keys; key++) {
    if (run >= RUN) {
      // Back to an empty line, so the run of x's can start again: the echo is
      // found by content and a line that has filled up has nothing new to say.
      for (let back = 0; back < run; back++) await driver.write(lane, Buffer.from('\x7f', 'utf8'))
      run = 0
      await settled(driver, lane, 200, 5_000)
    }
    run++
    // From quiet, so what is timed is this key and not the tail of the frame
    // before it.
    await settled(driver, lane, 120, 3_000)
    const wanted = 'x'.repeat(run)
    let seen = ''
    let heard: number | null = null
    let release = (): void => {}
    const echoed = new Promise<void>((resolve) => {
      const stop = driver.onOutput(lane, (bytes) => {
        seen += Buffer.from(bytes).toString('utf8').replace(SEQUENCES, '')
        if (heard === null && seen.includes(wanted)) {
          heard = performance.now()
          resolve()
        }
      })
      release = stop
    })
    const at = performance.now()
    await driver.write(lane, Buffer.from('x', 'utf8'))
    await Promise.race([echoed, new Promise((done) => setTimeout(done, 3_000))])
    release()
    if (heard === null) missed++
    else timings.sample('keystroke-to-echo', heard - at)
  }
  return { missed, run }
}

/**
 * Open the real window at `size`, type at it, and bring back both halves: what
 * the keystrokes cost from out here, and what the frames cost from in there.
 *
 * The window is killed with `SIGTERM`, which the CLI turns into the same stop
 * as quitting — and a stopped window is what writes the timing JSON out. A
 * window that is killed outright leaves nothing behind, so a missing file is
 * reported rather than read as zero.
 */
async function window(
  size: Size,
  keys: number,
): Promise<{ echo: Timings; spans: Record<string, Span>; missed: number; note: string | null }> {
  const seeded = seedHome()
  const driver = new PtyDriver({ attachCommand: (id) => `tade attach ${id}` })
  const lane = 'bench/window/app' as LaneId
  const wrote = join(seeded.base, 'timing.json')
  const echo = new Timings(true)
  try {
    const open = await driver.open({
      id: lane,
      cwd: repo,
      command: process.execPath,
      args: [join(repo, 'packages', 'cli', 'src', 'bin.ts'), 'app'],
      cols: size.width,
      rows: size.height,
      env: {
        TADE_HOME: seeded.home,
        TADE_TIMING: wrote,
        TERM: 'xterm-256color',
        COLORTERM: 'truecolor',
        NO_COLOR: '',
      },
    })
    // The first screen takes longest: the workbench opens, the extensions load
    // and the orchestrator is sent for. Nothing is typed until it has drawn
    // and then stopped moving — see `opened`, which is the half that cannot be
    // left out.
    const came = await opened(driver, lane, 120_000)
    if (!came)
      return {
        echo,
        spans: {},
        missed: keys,
        note: 'the window drew nothing in two minutes, so nothing below was measured against a running window',
      }
    await settled(driver, lane, 1_200, 30_000)
    const { missed, run } = await echoes(driver, lane, keys, echo)
    // The floor under every sample above: the window really did draw what was
    // typed at it. A measurement of a window that was ignoring the keyboard
    // would otherwise come back as a beautifully low number of misses.
    const screen = await driver.capture(lane, { lines: size.height, styled: false })
    const drew = run > 0 && screen.includes('x'.repeat(run))
    const pid = open.pid ?? (await driver.get(lane))?.pid ?? null
    if (pid !== null) process.kill(pid, 'SIGTERM')
    for (let waited = 0; waited < 150 && !existsSync(wrote); waited++) {
      await new Promise((done) => setTimeout(done, 100))
    }
    if (!existsSync(wrote))
      return {
        echo,
        spans: {},
        missed,
        note: 'the window wrote no timing file: it did not stop, it stopped before drawing, or TADE_TIMING never reached it',
      }
    const read = JSON.parse(readFileSync(wrote, 'utf8')) as { spans: Record<string, Span> }
    return {
      echo,
      spans: read.spans,
      missed,
      note: drew
        ? null
        : 'what was typed never appeared on screen — read the echo figures as suspect',
    }
  } finally {
    await driver.shutdown().catch(() => {})
    rmSync(seeded.base, { recursive: true, force: true })
  }
}

async function windows(sizes: readonly Size[]): Promise<void> {
  for (const size of sizes) {
    for (const how of ['idle', 'loaded'] as const) {
      if (how === 'loaded' && LOAD === 0) continue
      const load = how === 'loaded' ? induce(LOAD) : { started: 0, stop: () => {} }
      try {
        if (how === 'loaded' && load.started === 0) {
          // Said, never passed over: a loaded half that is secretly the idle
          // half again is the one reading of this bench that could mislead.
          say('\ncould not start a single busy process, so there is no loaded half to report')
          continue
        }
        if (how === 'loaded') {
          // Long enough for the scheduler to have noticed them.
          await new Promise((done) => setTimeout(done, 2_000))
        }
        const { echo, spans, missed, note } = await window(size, KEYS)
        heading(
          `the window at ${size.name}, ${how}${how === 'loaded' ? ` — ${load.started} busy processes on ${cpus().length} cores` : ''}`,
        )
        if (note) say(`! ${note}`)
        if (missed > 0) say(`! ${missed} of ${KEYS} keys were never echoed inside three seconds`)
        say(table(echo.spans()))
        say('inside the window')
        say(
          table({
            ...Object.fromEntries(
              Object.entries(spans).filter(([point]) => !point.startsWith('subject:')),
            ),
          }),
        )
        say('the ten dearest subjects of the frame')
        say(table(dearest(spans, 'subject:', 10)))
      } finally {
        load.stop()
      }
    }
  }
}

// ─── what was asked for ──────────────────────────────────────────────────────

const sizes = sizeArg()
const wanted = modes.length > 0 ? modes : ['frames', 'window']
for (const mode of wanted) {
  if (mode !== 'frames' && mode !== 'window' && mode !== 'open' && mode !== 'all') {
    throw new Error(`no bench called ${mode}: it is frames, window, open or all`)
  }
}
if (wanted.includes('frames') || wanted.includes('all')) frames(sizes)
if (wanted.includes('window') || wanted.includes('all')) await windows(sizes)
if (wanted.includes('open') || wanted.includes('all')) {
  const journal = args.indexOf('--journal')
  await benchOpen({
    // One size, because what is timed is the open and not the drawing.
    size: args.includes('--size') ? (sizes[0] ?? SIZES[1]) : SIZES[1],
    runs: numberArg('runs', 3),
    journal: journal < 0 ? null : (args[journal + 1] ?? null),
    say,
  })
}
