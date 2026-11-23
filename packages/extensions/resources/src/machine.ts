// What the machine itself is doing — how busy its processors are, how much of
// its memory is used, how much room its disk has left — beside what Tade is
// using of it (`usage.ts`). Tade's own share means little without the whole:
// 40% of a core is nothing on an idle laptop and the last straw on a VPS whose
// two cores an indexer already has.
//
// **Cheap, because it is asked every few seconds**: the processors' times and
// the memory's size are two calls into the kernel with no process spawned;
// each disk is a `stat` and a `statfs`; and on macOS the memory used is one
// `vm_stat`, asked beside the `ps` the watch already runs. Nothing here waits
// without a deadline.
//
// **`null` is "this machine cannot say", never nought** (`UNRECORDED`'s rule):
// the processors' share needs two looks to be a share at all, so the first
// look says nothing of it; a platform with no reading of memory used says
// nothing of that; a disk that cannot be asked is left out, and none left is
// null.
//
// Pure below the readers: what they read in, a look out.

/** One processor's times since boot, as `os.cpus()` reports them, in milliseconds. */
export interface CpuTimes {
  user: number
  nice: number
  sys: number
  idle: number
  irq: number
}

/** A volume's room, in bytes. */
export interface Room {
  free: number
  total: number
}

/** The machine as one look found it. */
export interface MachineLook {
  at: number
  /** Logical processors. Null where it could not say. */
  cores: number | null
  /** Percent of the whole machine busy since the look before, 0–100. Null on the first look. */
  cpu: number | null
  /** The one-minute load average. Null where the platform keeps none. */
  load: number | null
  /** Memory used of the whole, in bytes: what the machine itself calls used. */
  memory: { used: number; total: number } | null
  /**
   * The tightest of the volumes Tade's home and the projects are on — the one
   * with the least room left for its size — and how many volumes there are.
   */
  disk: (Room & { volumes: number }) | null
}

/** How the machine is read: the kernel's own answers, handed in so a test can write them. */
export interface MachineReaders {
  platform: string
  cpus(): readonly { times: CpuTimes }[]
  loadavg(): readonly number[]
  totalmem(): number
  /** What the platform calls available: on Linux, `MemAvailable`. */
  freemem(): number
  /** `vm_stat`'s output, on macOS; null where it could not be read. */
  vmStat(): Promise<string | null>
  /** A volume's device and its room, for one path; null where the path cannot be asked. */
  volume(path: string): Promise<{ dev: number; room: Room } | null>
}

/** The processors' times added up across every core: what a share is worked out from. */
export function cpuTotals(cores: readonly { times: CpuTimes }[]): { busy: number; all: number } {
  let busy = 0
  let all = 0
  for (const { times } of cores) {
    const spent = times.user + times.nice + times.sys + times.irq
    busy += spent
    all += spent + times.idle
  }
  return { busy, all }
}

/** Percent of the machine busy between two totals, or null where no time passed between them. */
export function cpuBusy(
  before: { busy: number; all: number } | null,
  after: { busy: number; all: number },
): number | null {
  if (before === null) return null
  const all = after.all - before.all
  if (all <= 0) return null
  const busy = Math.max(0, Math.min(all, after.busy - before.busy))
  return (busy / all) * 100
}

/**
 * Memory used, out of what `vm_stat` prints, as Activity Monitor counts it:
 * what apps hold (anonymous pages, less the purgeable), what the kernel wired
 * down, and what the compressor occupies. Null where the page size or any of
 * those is missing — a macOS that prints something else says nothing rather
 * than a wrong figure.
 */
export function vmStatUsed(text: string): number | null {
  const page = /page size of (\d+) bytes/.exec(text)
  if (!page) return null
  const pages = (label: string): number | null => {
    const found = new RegExp(`^${label}:\\s+(\\d+)\\.?$`, 'm').exec(text)
    return found ? Number(found[1]) : null
  }
  const wired = pages('Pages wired down')
  const compressor = pages('Pages occupied by compressor')
  const anonymous = pages('Anonymous pages')
  const purgeable = pages('Pages purgeable') ?? 0
  if (wired === null || compressor === null || anonymous === null) return null
  return (Math.max(0, anonymous - purgeable) + wired + compressor) * Number(page[1])
}

/** The volume with the least room for its size, of every one asked; null where none could be. */
export function tightest(rooms: readonly Room[]): (Room & { volumes: number }) | null {
  const sized = rooms.filter((one) => one.total > 0)
  if (sized.length === 0) return null
  const least = sized.reduce((a, b) => (b.free / b.total < a.free / a.total ? b : a))
  return { free: least.free, total: least.total, volumes: sized.length }
}

/** Below this share of a volume free, the strip and the away view warn. */
export const DISK_LOW = 0.1

/** Whether a disk is low: under a tenth of it left. Unknown is not low. */
export function diskLow(disk: Room | null): boolean {
  return disk !== null && disk.total > 0 && disk.free / disk.total < DISK_LOW
}

/**
 * Looking at the machine, keeping the processors' totals between looks so each
 * look's share is of the time since the one before.
 */
export class MachineEye {
  private readonly readers: MachineReaders
  private before: { busy: number; all: number } | null = null

  constructor(readers: MachineReaders) {
    this.readers = readers
  }

  /** One look, at the paths given: Tade's home and every project's root. Never throws. */
  async look(paths: readonly string[], at: number): Promise<MachineLook> {
    const read = this.readers
    const cores = safely(() => read.cpus(), [])
    const totals = cpuTotals(cores)
    const cpu = cores.length > 0 ? cpuBusy(this.before, totals) : null
    if (cores.length > 0) this.before = totals
    const [memory, disk] = await Promise.all([this.memory(), this.disk(paths)])
    const load = safely(() => read.loadavg()[0] ?? null, null)
    return {
      at,
      cores: cores.length > 0 ? cores.length : null,
      cpu,
      // Windows keeps no load average and says nought for it, which would read as idle.
      load: read.platform === 'win32' || load === null || !Number.isFinite(load) ? null : load,
      memory,
      disk,
    }
  }

  private async memory(): Promise<MachineLook['memory']> {
    const read = this.readers
    const total = safely(() => read.totalmem(), 0)
    if (!(total > 0)) return null
    if (read.platform === 'darwin') {
      // `freemem` on macOS is the pages nobody holds at all, which a Mac keeps
      // near none on purpose — a machine "95% used" that is not under any
      // pressure. What it calls used is `vm_stat`'s.
      const text = await read.vmStat().catch(() => null)
      const used = text === null ? null : vmStatUsed(text)
      return used === null ? null : { used: Math.min(used, total), total }
    }
    if (read.platform === 'linux') {
      const free = safely(() => read.freemem(), -1)
      return free < 0 ? null : { used: Math.max(0, total - free), total }
    }
    return null
  }

  private async disk(paths: readonly string[]): Promise<MachineLook['disk']> {
    const seen = new Map<number, Room>()
    const found = await Promise.all(
      [...new Set(paths)].map((path) => this.readers.volume(path).catch(() => null)),
    )
    for (const one of found) if (one !== null && !seen.has(one.dev)) seen.set(one.dev, one.room)
    return tightest([...seen.values()])
  }
}

function safely<T>(read: () => T, otherwise: T): T {
  try {
    return read()
  } catch {
    return otherwise
  }
}

/** Bytes as a person reads room on a disk: `112 GB`, `840 MB`, `1.2 TB`. */
export function room(bytes: number): string {
  if (bytes >= 1024 ** 4) return `${(bytes / 1024 ** 4).toFixed(1)} TB`
  if (bytes >= 10 * 1024 ** 3) return `${Math.round(bytes / 1024 ** 3)} GB`
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}
