import { stat, statfs } from 'node:fs/promises'
import { cpus, freemem, loadavg, totalmem } from 'node:os'
import { runProgram } from '@tade/core'
import type { ExecResult } from '@tade/extensions-core'
import { MachineEye, type MachineLook, type MachineReaders } from './machine.ts'
import { attribute, History, type LaneRef, parsePs, type Sample, sampleOf } from './usage.ts'

// The one watch of this machine: a `ps` for what Tade is using, a look at the
// machine for what everything is, together, kept for the last hour.
//
// **Shared by whoever asks** — the status bar, the orchestrator's tool, the
// away view's snapshot and what this machine tells the ones it links to — so
// four readers are one `ps` every few seconds and not four
// (`machineWatch`, one per process). A sample younger than the interval is
// handed back as it is; two asking at once share the one being taken.

/** Run a program. Never throws: a failure is its code and what it said. */
export type Exec = (
  command: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Promise<ExecResult>

/** What one ask needs: how fresh, the moment, how to run `ps`, and whose processes are whose. */
export interface WatchAsk {
  /** A sample younger than this, in milliseconds, is handed back rather than taken again. */
  every: number
  now: number
  exec?: Exec
  /** The window's own pid, or null where there is none to ask (a question from the CLI). */
  window: number | null
  lanes: readonly LaneRef[]
  /** Where the disks are asked: Tade's home and every project's root. */
  paths: readonly string[]
}

/** A sample of Tade's processes, and the machine they run on as the same moment found it. */
export interface Watched extends Sample {
  machine: MachineLook
}

export class Watch {
  readonly history: History
  private readonly eye: MachineEye
  private taking: Promise<Watched> | null = null

  constructor(opts: { history?: number; readers?: MachineReaders } = {}) {
    this.history = new History(opts.history ?? 720)
    this.eye = new MachineEye(opts.readers ?? machineReaders)
  }

  /** The newest sample, without asking anything. Null before the first. */
  latest(): Watched | null {
    return (this.history.latest() as Watched | null) ?? null
  }

  /** A sample no older than `every`: taken now only when the last one is stale. */
  sample(ask: WatchAsk): Promise<Watched> {
    const latest = this.latest()
    if (latest && ask.now - latest.at < ask.every) return Promise.resolve(latest)
    this.taking ??= this.take(ask).finally(() => {
      this.taking = null
    })
    return this.taking
  }

  /**
   * The machine's processors and memory over the newest `cells` samples, as
   * shares of the whole: what a sparkline is drawn from. `apart` spaces them
   * — a sample is skipped where it is nearer than that to the one after it —
   * so a trail spans the same stretch whoever was asking how often. A look
   * that could not say is null in its place, so a gap is drawn as one rather
   * than as idle.
   */
  trail(cells: number, apart = 0): { cpu: (number | null)[]; memory: (number | null)[] } {
    const all = this.history.within(Number.POSITIVE_INFINITY) as Watched[]
    const kept: Watched[] = []
    for (let at = all.length - 1; at >= 0 && kept.length < cells; at--) {
      const one = all[at] as Watched
      const after = kept.at(-1)
      if (after === undefined || after.at - one.at >= apart) kept.push(one)
    }
    kept.reverse()
    return {
      cpu: kept.map((one) => (one.machine?.cpu == null ? null : round1(one.machine.cpu))),
      memory: kept.map((one) => {
        const memory = one.machine?.memory
        return memory ? round1((memory.used / memory.total) * 100) : null
      }),
    }
  }

  private async take(ask: WatchAsk): Promise<Watched> {
    const started = performance.now()
    const [listed, machine] = await Promise.all([
      (ask.exec ?? run)('ps', ['-A', '-o', 'pid=,ppid=,rss=,pcpu=,args='], { timeoutMs: 5_000 }),
      this.eye.look(ask.paths, ask.now),
    ])
    if (listed.code !== 0)
      throw new Error(`ps could not be read: ${listed.stderr.trim() || `exit ${listed.code}`}`)
    const groups = attribute(parsePs(listed.stdout), { window: ask.window, lanes: ask.lanes })
    const taken: Watched = {
      ...sampleOf(groups, ask.now, performance.now() - started),
      machine,
    }
    this.history.add(taken)
    return taken
  }
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

/** A program run with a deadline, in a group of its own (`runProgram`). Never throws. */
export async function run(
  command: string,
  args: readonly string[],
  options: { timeoutMs?: number } = {},
): Promise<ExecResult> {
  const ran = await runProgram(command, args, {
    timeoutMs: options.timeoutMs ?? 5_000,
    maxBuffer: 32 * 1024 ** 2,
  })
  return { code: ran.code, stdout: ran.stdout, stderr: ran.stderr }
}

/** The kernel's own answers on this machine. */
export const machineReaders: MachineReaders = {
  platform: process.platform,
  cpus: () => cpus(),
  loadavg: () => loadavg(),
  totalmem: () => totalmem(),
  freemem: () => freemem(),
  vmStat: async () => {
    const read = await run('vm_stat', [], { timeoutMs: 2_000 })
    return read.code === 0 ? read.stdout : null
  },
  volume: async (path) => {
    const [where, room] = await Promise.all([stat(path), statfs(path)])
    return {
      dev: where.dev,
      // What an ordinary user may still write — `bavail`, not `bfree`, which
      // counts the blocks only root may have.
      room: { free: room.bavail * room.bsize, total: room.blocks * room.bsize },
    }
  },
}

/**
 * This process's watch of this machine: the one the window's strip, the
 * orchestrator's tool and the away view all read, so they are one `ps`.
 */
export const machineWatch = new Watch()
