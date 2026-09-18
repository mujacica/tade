// What Tade costs the machine it runs on: every process it started, whose it
// is, and what each is using.
//
// Pure: the process table and what Tade is running in, a sample out. Reading
// the table is one `ps` for every process at once, which is what keeps this
// cheap enough to ask every few seconds; everything after that is arithmetic
// on what it printed.

export interface Proc {
  pid: number
  ppid: number
  /** Resident memory, in bytes. */
  rss: number
  /** Percent of one core, as `ps` reports it. */
  cpu: number
  command: string
}

/** Who a process belongs to. */
export type Kind = 'window' | 'orchestrator' | 'agent' | 'terminal' | 'shell' | 'helper'

export interface Group {
  /** The lane id for a lane, or the kind for Tade's own. */
  key: string
  kind: Kind
  project: string | null
  task: string | null
  label: string
  cpu: number
  rss: number
  processes: Proc[]
}

export interface Sample {
  at: number
  /** How long taking it took, in milliseconds: the cost of watching. */
  took: number
  groups: Group[]
  total: { cpu: number; rss: number; processes: number }
}

export interface LaneRef {
  id: string
  task: string
  kind: string
  pid: number | null
  alive: boolean
}

/** `ps -A -o pid=,ppid=,rss=,pcpu=,args=`, read. Lines that are not a process are skipped. */
export function parsePs(text: string): Proc[] {
  const out: Proc[] = []
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.*)$/.exec(line)
    if (!match) continue
    out.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      rss: Number(match[3]) * 1024,
      cpu: Number(match[4]),
      command: match[5] ?? '',
    })
  }
  return out
}

/** Whose each process is: every lane's, the orchestrator's, the window's own, and its helpers. */
export function attribute(
  procs: readonly Proc[],
  where: { window: number | null; lanes: readonly LaneRef[] },
): Group[] {
  const byPid = new Map<number, Proc>()
  const children = new Map<number, Proc[]>()
  for (const proc of procs) {
    byPid.set(proc.pid, proc)
    const siblings = children.get(proc.ppid)
    if (siblings) siblings.push(proc)
    else children.set(proc.ppid, [proc])
  }
  const taken = new Set<number>()
  const subtree = (root: number): Proc[] => {
    const out: Proc[] = []
    const stack = [root]
    while (stack.length > 0) {
      const pid = stack.pop() as number
      const proc = byPid.get(pid)
      if (!proc || taken.has(pid)) continue
      taken.add(pid)
      out.push(proc)
      for (const child of children.get(pid) ?? []) stack.push(child.pid)
    }
    return out
  }
  const group = (
    key: string,
    kind: Kind,
    label: string,
    processes: Proc[],
    task: string | null = null,
  ): Group => ({
    key,
    kind,
    project: task ? (task.split('/')[0] ?? null) : null,
    task,
    label,
    cpu: processes.reduce((sum, proc) => sum + proc.cpu, 0),
    rss: processes.reduce((sum, proc) => sum + proc.rss, 0),
    processes,
  })

  const groups: Group[] = []
  // Lanes first: under tmux they are not the window's children, and under pty
  // they are, but either way an agent's processes are the agent's.
  for (const lane of where.lanes) {
    if (!lane.alive || lane.pid === null) continue
    const processes = subtree(lane.pid)
    if (processes.length === 0) continue
    const kind: Kind =
      lane.kind === 'agent' ? 'agent' : lane.kind === 'terminal' ? 'terminal' : 'shell'
    const name = lane.task.split('/').at(-1) ?? lane.task
    groups.push(
      group(
        lane.id,
        kind,
        kind === 'agent'
          ? name
          : kind === 'terminal'
            ? `terminal ${lane.id.split('/').at(-1)}`
            : `${name} ${lane.kind}`,
        processes,
        lane.task,
      ),
    )
  }
  if (where.window !== null) {
    const window = byPid.get(where.window)
    if (window) {
      taken.add(window.pid)
      groups.push(group('window', 'window', 'the window', [window]))
      const orchestrator: Proc[] = []
      const helpers: Proc[] = []
      for (const child of children.get(window.pid) ?? []) {
        if (taken.has(child.pid)) continue
        if (isOrchestrator(child.command)) orchestrator.push(...subtree(child.pid))
        else helpers.push(...subtree(child.pid))
      }
      if (orchestrator.length > 0) {
        groups.push(group('orchestrator', 'orchestrator', 'the orchestrator', orchestrator))
      }
      if (helpers.length > 0) groups.push(group('helpers', 'helper', 'helpers', helpers))
    }
  }
  return groups
}

/**
 * The window's own pi: started in RPC mode, though pi renames its process to
 * `pi` once it is running, which is all `ps` shows of it on macOS. Lanes are
 * attributed first, so an agent under the window is never mistaken for it.
 */
function isOrchestrator(command: string): boolean {
  return /--mode\s+rpc/.test(command) || /^(\S*\/)?pi(\s|$)/.test(command)
}

/** A sample from groups: their totals, when, and what it cost to take. */
export function sampleOf(groups: Group[], at: number, took: number): Sample {
  return {
    at,
    took,
    groups,
    total: {
      cpu: groups.reduce((sum, one) => sum + one.cpu, 0),
      rss: groups.reduce((sum, one) => sum + one.rss, 0),
      processes: groups.reduce((sum, one) => sum + one.processes.length, 0),
    },
  }
}

/**
 * The last hour of samples, and what they add up to. Bounded, so watching for
 * a week costs what watching for an hour does.
 */
export class History {
  readonly max: number
  private readonly samples: Sample[] = []

  constructor(max = 720) {
    this.max = max
  }

  add(sample: Sample): void {
    this.samples.push(sample)
    if (this.samples.length > this.max) this.samples.splice(0, this.samples.length - this.max)
  }

  get size(): number {
    return this.samples.length
  }

  latest(): Sample | null {
    return this.samples.at(-1) ?? null
  }

  /** The samples within a stretch of time before the newest. */
  within(ms: number): Sample[] {
    const newest = this.latest()
    if (!newest) return []
    return this.samples.filter((sample) => sample.at >= newest.at - ms)
  }

  /** Averages and peaks over a stretch of time: total CPU and memory, and what watching cost. */
  summary(ms: number): {
    samples: number
    cpu: { average: number; peak: number }
    rss: { average: number; peak: number }
    took: { average: number; peak: number }
  } {
    const samples = this.within(ms)
    const stat = (values: number[]) => ({
      average:
        values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : 0,
      peak: values.length > 0 ? Math.max(...values) : 0,
    })
    return {
      samples: samples.length,
      cpu: stat(samples.map((sample) => sample.total.cpu)),
      rss: stat(samples.map((sample) => sample.total.rss)),
      took: stat(samples.map((sample) => sample.took)),
    }
  }
}

export type By = 'project' | 'kind' | 'agent' | 'process'

/** Groups added up by what they are counted by: a row per project, kind or agent, or the processes themselves. */
export function totals(
  sample: Sample,
  by: By,
): { label: string; cpu: number; rss: number; processes: number }[] {
  if (by === 'process') {
    return sample.groups
      .flatMap((group) =>
        group.processes.map((proc) => ({
          label: `${proc.pid} ${shortCommand(proc.command)} (${group.label})`,
          cpu: proc.cpu,
          rss: proc.rss,
          processes: 1,
        })),
      )
      .sort((a, b) => b.cpu - a.cpu || b.rss - a.rss)
  }
  const rows = new Map<string, { label: string; cpu: number; rss: number; processes: number }>()
  for (const group of sample.groups) {
    const label =
      by === 'project'
        ? (group.project ?? 'Tade itself')
        : by === 'kind'
          ? KIND_LABELS[group.kind]
          : group.label
    const row = rows.get(label) ?? { label, cpu: 0, rss: 0, processes: 0 }
    row.cpu += group.cpu
    row.rss += group.rss
    row.processes += group.processes.length
    rows.set(label, row)
  }
  return [...rows.values()].sort((a, b) => b.cpu - a.cpu || b.rss - a.rss)
}

const KIND_LABELS: Record<Kind, string> = {
  window: 'the window',
  orchestrator: 'the orchestrator',
  agent: 'agents',
  terminal: 'terminals',
  shell: 'shells',
  helper: 'helpers (git, ps, …)',
}

/** A command as a person reads it: the program, and what it runs, briefly. */
export function shortCommand(command: string): string {
  const parts = command.split(/\s+/)
  const program = (parts[0] ?? '').split('/').at(-1) ?? ''
  const script = parts.slice(1).find((part) => /\.(m?[jt]s)$/.test(part))
  const named = script
    ? script.split('/').at(-1)
    : parts[1]?.startsWith('-')
      ? ''
      : (parts[1] ?? '')
  return [program, named].filter(Boolean).join(' ').slice(0, 40)
}

export function megabytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

export function percent(cpu: number): string {
  return cpu >= 10 ? `${Math.round(cpu)}%` : `${cpu.toFixed(1)}%`
}

/** Values as a row of bars, lowest to highest. */
export function sparkline(values: readonly number[], cells = 40): string {
  const recent = values.slice(-cells)
  if (recent.length === 0) return ''
  const max = Math.max(...recent)
  const min = Math.min(...recent)
  const bars = '▁▂▃▄▅▆▇█'
  return recent
    .map((value) => bars[max === min ? 0 : Math.round(((value - min) / (max - min)) * 7)] ?? '▁')
    .join('')
}
