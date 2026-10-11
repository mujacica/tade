import { spawn } from 'node:child_process'
import { availableParallelism, cpus, loadavg } from 'node:os'
import type { LaneId } from '@tade/core'
import { niced } from '@tade/core'
import { PtyDriver } from '@tade/drivers-pty'

// How long a keystroke takes to come back, and whether nicing the agents
// changes it.
//
// **The one number that matters** for making the window feel fast is
// keystroke-to-echo p99 under load; everything else is diagnosis. This is the
// probe that measures it, and the measurement is the whole argument for
// `agents.give_way` — a setting whose effect nobody can see is a setting
// nobody should turn on.
//
// **What it measures, exactly.** This process stands in for the window. It
// opens one pty lane running a program that echoes a byte back, writes a byte,
// and times how long until that byte arrives. The round trip therefore holds
// the three things load actually costs: this process being scheduled to write,
// the program in the lane being scheduled to echo, and this process being
// scheduled to read. It is not a measurement of the terminal, of the drawing,
// or of any model.
//
// **The lane is never lowered, and that is the point.** It stands in for what
// a person is typing into, which `givesWay` refuses to lower however high the
// setting (`core/src/priority.ts`). What is lowered is the *load* — the busy
// processes standing in for agents and check suites — which is exactly the
// arrangement the setting creates.
//
// ## Running it
//
//     node packages/app/scripts/echo-latency.ts                  # defaults
//     node packages/app/scripts/echo-latency.ts --load 42 --by 5  # the research's case
//     node packages/app/scripts/echo-latency.ts --keys 400 --gap 10
//
//   `--load N`  busy processes to compete with, standing in for agents.
//               Defaults to one per core. The research's induced-load case is
//               three per core: `--load $(( 3 * $(getconf _NPROCESSORS_ONLN) ))`.
//   `--by N`    nice steps for the lowered arm. Default 5.
//   `--keys N`  keystrokes per arm. Default 200.
//   `--gap MS`  wait between keystrokes. Default 20, which is about as fast as
//               key repeat goes.
//   `--rounds N` how many slices to cut each arm into. Default 4. The arms are
//               interleaved slice by slice, which is what makes the comparison
//               survive a machine with other work in it.
//   `--arms`    comma-separated subset of `quiet,load,load-niced`.
//
// **Read it honestly, or do not read it.** On a shared machine the absolute
// figures are about that machine at that minute and nothing else: what
// survives is the difference between the arms, which is why they are
// interleaved rather than run one after the other. And a difference smaller
// than the spread between rounds is not a difference — raise `--keys` and
// `--rounds`, or go and find a quiet machine.
//
// **It is disruptive by construction.** `--load` pins cores on purpose. Do not
// run it beside a check suite — the suite's own timeouts are what starve first,
// and a starved suite looks exactly like a regression (`CLAUDE.md`). Keep
// `--keys × --gap` small on a machine somebody else is using: the defaults are
// four seconds per arm.

/** A program that reads a byte and writes it straight back, forever. */
const ECHOES = [
  '-e',
  'process.stdin.on("data", (b) => process.stdout.write(b)); process.stdin.resume()',
]

/** A program that wants a core and will never stop wanting one. */
const BUSY = ['-e', 'for (;;) Math.sqrt(Math.random())']

interface Options {
  load: number
  by: number
  keys: number
  gap: number
  rounds: number
  arms: readonly string[]
}

const ARMS = ['quiet', 'load', 'load-niced'] as const

function options(argv: readonly string[]): Options {
  const value = (name: string, fallback: number): number => {
    const at = argv.indexOf(`--${name}`)
    if (at < 0) return fallback
    const said = Number(argv[at + 1])
    return Number.isFinite(said) && said >= 0 ? said : fallback
  }
  const armsAt = argv.indexOf('--arms')
  const arms =
    armsAt < 0
      ? ARMS
      : (argv[armsAt + 1] ?? '')
          .split(',')
          .map((one) => one.trim())
          .filter((one) => (ARMS as readonly string[]).includes(one))
  return {
    load: Math.round(value('load', availableParallelism())),
    by: Math.round(value('by', 5)),
    keys: Math.round(value('keys', 200)),
    gap: Math.round(value('gap', 20)),
    rounds: Math.max(1, Math.round(value('rounds', 4))),
    arms: arms.length > 0 ? arms : ARMS,
  }
}

/** Busy processes, at this priority, and how to end them. */
function compete(count: number, by: number): () => void {
  const children = Array.from({ length: count }, () => {
    const launch = niced({ command: process.execPath, args: BUSY }, by)
    const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true })
    // A spawn that fails does so asynchronously, and an unhandled `error`
    // would take the probe down mid-measurement.
    child.once('error', () => {})
    child.unref()
    return child
  })
  return () => {
    for (const child of children) {
      // The group, because `nice` execs in place and the group leader is the
      // program itself — the same reason a check is signalled by its group.
      try {
        process.kill(-(child.pid ?? 0), 'SIGKILL')
      } catch {
        try {
          child.kill('SIGKILL')
        } catch {
          // Already gone, which is what was wanted.
        }
      }
    }
  }
}

/** `keys` round trips through a lane, in milliseconds each. */
async function roundTrips(opts: Options, keys: number): Promise<number[]> {
  const driver = new PtyDriver()
  const lane = `probe/echo/lane-${process.pid}` as LaneId
  await driver.open({
    id: lane,
    cwd: process.cwd(),
    command: process.execPath,
    args: ECHOES,
    cols: 80,
    rows: 24,
  })
  let answer: (() => void) | null = null
  const stop = driver.onOutput(lane, () => answer?.())
  const times: number[] = []
  try {
    // One throwaway first: the program in the lane has to have started, and
    // the first byte would otherwise be timed against node booting.
    for (let n = -1; n < keys; n++) {
      const at = process.hrtime.bigint()
      const echoed = new Promise<void>((done) => {
        answer = done
      })
      await driver.write(lane, Buffer.from('x'))
      await echoed
      if (n >= 0) times.push(Number(process.hrtime.bigint() - at) / 1e6)
      if (opts.gap > 0) await new Promise((done) => setTimeout(done, opts.gap))
    }
  } finally {
    stop()
    await driver.shutdown().catch(() => {})
  }
  return times
}

/** The nth percentile of `times`, nearest-rank. Empty is nothing to say. */
function percentile(times: readonly number[], share: number): number | null {
  if (times.length === 0) return null
  const sorted = [...times].sort((a, b) => a - b)
  const at = Math.min(sorted.length - 1, Math.ceil(share * sorted.length) - 1)
  return sorted[Math.max(0, at)] ?? null
}

const ms = (value: number | null): string => (value === null ? '—' : `${value.toFixed(2)} ms`)
const load = (): string => loadavg()[0]?.toFixed(1) ?? '—'

async function main(): Promise<void> {
  const opts = options(process.argv.slice(2))
  const slice = Math.max(1, Math.ceil(opts.keys / opts.rounds))
  console.log(
    `${cpus().length} cores, load ${load()} to start. ` +
      `${opts.arms.join(', ')} in ${opts.rounds} rounds of ${slice} keys every ${opts.gap} ms, ` +
      `${opts.load} busy processes, nice +${opts.by}.\n`,
  )
  const pooled = new Map<string, number[]>(opts.arms.map((arm) => [arm, []]))
  // **Interleaved, in short slices, and this is the whole instrument.** Run
  // one arm then the other and what separates them is not only the nicing: on
  // a machine with other work in it the ambient load drifts between the two,
  // and it drifts by more than the effect — measured here, with seven busy
  // processes against an ambient 47, the sign of the difference flipped
  // between three consecutive runs. Alternating in slices gives both arms the
  // same neighbours, because they are a second apart rather than a minute.
  for (let round = 0; round < opts.rounds; round++) {
    for (const arm of opts.arms) {
      const end =
        arm === 'quiet' ? () => {} : compete(opts.load, arm === 'load-niced' ? opts.by : 0)
      // A moment for the load to be load: the processes have to be scheduled
      // before they compete for anything.
      if (arm !== 'quiet') await new Promise((done) => setTimeout(done, 300))
      try {
        pooled.get(arm)?.push(...(await roundTrips(opts, slice)))
      } finally {
        end()
      }
    }
  }
  const rows = opts.arms.map((arm) => {
    const times = pooled.get(arm) ?? []
    return (
      `${arm.padEnd(12)} p50 ${ms(percentile(times, 0.5)).padStart(9)}   ` +
      `p95 ${ms(percentile(times, 0.95)).padStart(9)}   ` +
      `p99 ${ms(percentile(times, 0.99)).padStart(9)}   ` +
      `max ${ms(times.length > 0 ? Math.max(...times) : null).padStart(9)}   ` +
      `n ${times.length}`
    )
  })
  console.log(`${rows.join('\n')}\n\nload ${load()} at the end.`)
}

await main()
