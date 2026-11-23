import { machineWatch, type Watch, type WatchAsk, type Watched } from '@tade/extension-resources'
import { HOST_TRAIL, type Host } from '@tade/web'
import type { Wiring } from './context.ts'

// This machine's own figures, for the away view and for every machine it links
// to: its processors, load, memory, disk, what Tade uses of it, and a short
// trail for a sparkline — out of the one watch of this machine
// (`machineWatch`), which the strip and the orchestrator's tool read too, so
// all of them are one `ps` every few seconds.
//
// **Looked at only while somebody reads**: a phone with the away view open,
// or a link saying this machine is up. Asking hands back the newest look at
// once and, where it is stale, starts the next one without waiting for it —
// the beat goes on drawing, and the next ask has it. A window nobody reads
// from away costs nothing more than its strip already does.

/**
 * How often the figures move on the wire, and so how often a look is started
 * for them — never oftener than the config's own interval. Every move is a
 * delta to every page and, on a machine that links here, a projection that
 * changed and is written down again (`kept.ts`): fifteen seconds is a trail
 * that still moves while it is watched, and a write a quarter as often as
 * the watch's own beat.
 */
export const FIGURES_EVERY_MS = 15_000

/** A look, as the away protocol carries it. Pure. */
export function figuresOf(
  sample: Watched,
  trail: { cpu: (number | null)[]; memory: (number | null)[] },
): Host {
  const { machine, total } = sample
  return {
    at: new Date(sample.at).toISOString(),
    cores: machine.cores,
    cpu: machine.cpu === null ? null : clamp(machine.cpu, 0, 100),
    load: machine.load,
    memory: machine.memory,
    tade: { cpu: total.cpu, memory: total.rss, processes: total.processes },
    disk: machine.disk,
    trail: { cpu: trail.cpu.slice(-HOST_TRAIL), memory: trail.memory.slice(-HOST_TRAIL) },
  }
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value))
}

export interface HereDeps {
  watch: Watch
  /** What one look needs, asked at each ask: the moment, whose lanes, which disks. */
  ask(): WatchAsk
  /** Said where a look failed: once, until one works again. */
  say(said: string): void
}

export class HereFigures {
  private readonly deps: HereDeps
  private shown: { sample: Watched; host: Host } | null = null
  private failed = false

  constructor(deps: HereDeps) {
    this.deps = deps
  }

  /** The newest figures, never waited on; a stale look starts the next. Null before the first. */
  now(): Host | null {
    const watch = this.deps.watch
    const ask = this.deps.ask()
    const latest = watch.latest()
    if (latest === null || ask.now - latest.at >= ask.every) {
      watch.sample(ask).then(
        () => {
          this.failed = false
        },
        (err: unknown) => {
          if (!this.failed)
            this.deps.say(`this machine’s figures could not be read: ${String(err)}`)
          this.failed = true
        },
      )
    }
    if (latest === null) return null
    // A newer look is shown only once the one shown is a whole interval old,
    // so the strip's own looks every few seconds move nothing on the wire.
    if (this.shown === null || latest.at - this.shown.sample.at >= ask.every) {
      this.shown = {
        sample: latest,
        host: figuresOf(latest, watch.trail(HOST_TRAIL, ask.every - 1_000)),
      }
    }
    return this.shown.host
  }
}

/** The window's own: the one watch, its lanes and pid, its home and every project's root. */
export function hereFiguresFor(wire: Wiring, say: (said: string) => void): HereFigures {
  return new HereFigures({
    watch: machineWatch,
    ask: () => {
      const config = wire.opts.config
      const every = (config.extensions as Record<string, { every?: unknown } | undefined>)
        ?.resources?.every
      const tade = wire.opts.extensionWorkbench
      return {
        every: Math.max(
          FIGURES_EVERY_MS,
          typeof every === 'number' && every > 0 ? every * 1000 : 0,
        ),
        now: wire.now(),
        window: tade?.pid ?? process.pid,
        lanes: tade?.lanes() ?? [],
        paths: [wire.opts.home, ...Object.values(config.projects).map((one) => one.root)],
      }
    },
    say,
  })
}
